import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createConsoleSmsTransport, type JobPayloads } from '@sitelog/shared';
import { testConfig, type Config } from './config';
import type { Ctx } from './context';
import { notifyJob } from './jobs/notify';
import { smsInbound } from './jobs/sms_inbound';
import { silentLogger } from './log';
import { createWorkerNotifier, workerWhatsappRegistration } from './messaging';
import { startPgliteDatabase, type PgliteDatabase } from './test/pglite';

/**
 * WhatsApp through Twilio on PGlite (W2-15; spec §19 Q25, Q39, Q84): the worker's `notify` job on
 * the migrated schema. A demo reporter who opted in gets `daily_link` as a WhatsApp row in the Demo
 * phone (console); one without the opt-in gets SMS; for a real org the approved template goes
 * out (mocked Twilio) and a template Twilio refuses falls back to SMS; with no WhatsApp sender
 * here a real org's message goes by SMS with no WhatsApp row (§19 Q84).
 */

let pg: PgliteDatabase;
let MARCO = '';
let ORG = '';
const MARCO_PHONE = '+15550143378';
const SID = `HX${'c'.repeat(32)}`;

const twilio: { status: number; json: unknown; forms: URLSearchParams[] } = {
  status: 201,
  json: { sid: 'SMwa1' },
  forms: [],
};
const fakeFetch: typeof fetch = async (_url, init) => {
  twilio.forms.push(new URLSearchParams(String(init?.body)));
  return new Response(JSON.stringify(twilio.json), { status: twilio.status });
};

function ctxOf(config: Config = testConfig()): Ctx {
  return {
    config,
    db: pg.db,
    notifier: createWorkerNotifier(
      config,
      pg.db,
      () => createConsoleSmsTransport(() => randomUUID()),
      () => new Date(),
      [workerWhatsappRegistration(config, pg.db, fakeFetch)],
    ),
    log: silentLogger,
    now: () => new Date(),
  } as unknown as Ctx;
}

const daily = (key: string): JobPayloads['notify'] => ({
  reporterId: MARCO,
  key: 'daily_link',
  vars: { site: 'Riverside Lofts', link: 'https://go.talkolog.com/r/ABCDEF' },
  dedupeKey: `notify:daily:${key}`,
});

async function rows(dedupeKey: string) {
  return pg.q<{
    channel: string;
    provider: string;
    status: string;
    body: string;
    payload: Record<string, unknown>;
  }>(
    `select channel, provider, status, body, payload from messages
     where reporter_id = $1 and payload->>'dedupe_key' = $2 order by created_at, id`,
    [MARCO, dedupeKey],
  );
}

async function optIn(on: boolean) {
  await pg.q(`delete from consents where reporter_id = $1 and type = 'whatsapp'`, [MARCO]);
  if (on)
    await pg.q(
      `insert into consents (reporter_id, type, method, text_version) values ($1, 'whatsapp', 'web_checkbox', 'v1')`,
      [MARCO],
    );
}

beforeAll(async () => {
  pg = await startPgliteDatabase({ seed: true });
  const [m] = await pg.q<{ id: string; org_id: string }>(
    `select id, org_id from reporters where phone_e164 = $1`,
    [MARCO_PHONE],
  );
  MARCO = m!.id;
  ORG = m!.org_id;
  await pg.q(
    `insert into consents (reporter_id, type, method, text_version)
     select $1, 'sms', 'web_checkbox', 'v1'
     where not exists (select 1 from consents where reporter_id = $1 and type = 'sms' and revoked_at is null)`,
    [MARCO],
  );
});

afterAll(async () => {
  await pg?.close();
});

beforeEach(async () => {
  twilio.status = 201;
  twilio.json = { sid: `SMwa-${randomUUID()}` };
  twilio.forms = [];
  await pg.q(`update orgs set is_demo = true where id = $1`, [ORG]);
  await pg.q(
    `update countries set message_channels = '{push,whatsapp,sms}', sms_sender_id = null,
       whatsapp_sender_id = null, whatsapp_templates = null where code = 'US'`,
  );
  await optIn(true);
});

const LIVE = testConfig({ TWILIO_ACCOUNT_SID: 'AC1', TWILIO_AUTH_TOKEN: 'tok' });

async function goLive(templates: boolean) {
  await pg.q(`update orgs set is_demo = false where id = $1`, [ORG]);
  await pg.q(
    `select set_country_endpoints('US', '+18885550142', null, '+15550142299', $1::jsonb)`,
    [templates ? JSON.stringify({ daily_link: { en: SID } }) : null],
  );
}

describe('WhatsApp (W2-15)', () => {
  it('a demo reporter who opted in gets daily_link as a WhatsApp row in the Demo phone', async () => {
    const payload = daily('demo');
    await notifyJob(ctxOf(), payload, {} as never);
    const [row] = await rows(payload.dedupeKey);
    expect(row).toMatchObject({ channel: 'whatsapp', provider: 'console', status: 'delivered' });
    expect(row!.body).toContain('https://go.talkolog.com/r/ABCDEF');
    expect(twilio.forms).toEqual([]);
    // What the Demo phone reads (SupabaseSource.getDemoPhoneThread).
    const thread = await pg.q<{ n: number }>(
      `select count(*)::int as n from messages where org_id = $1 and reporter_id = $2
         and channel in ('sms', 'push', 'whatsapp') and payload->>'dedupe_key' = $3`,
      [ORG, MARCO, payload.dedupeKey],
    );
    expect(thread).toEqual([{ n: 1 }]);
  });

  it('one without the opt-in (or who turned it off) gets SMS', async () => {
    await optIn(false);
    const payload = daily('no-opt-in');
    await notifyJob(ctxOf(), payload, {} as never);
    expect((await rows(payload.dedupeKey)).map((r) => r.channel)).toEqual(['sms']);
  });

  it('a real org: the approved template, outside the window, through Twilio', async () => {
    await goLive(true);
    const payload = daily('live');
    await notifyJob(ctxOf(LIVE), payload, {} as never);
    const [row] = await rows(payload.dedupeKey);
    expect(row).toMatchObject({
      channel: 'whatsapp',
      provider: 'twilio',
      status: 'sent',
      payload: { whatsapp_mode: 'template', content_sid: SID },
    });
    expect(twilio.forms[0]!.get('From')).toBe('whatsapp:+15550142299');
    expect(twilio.forms[0]!.get('ContentSid')).toBe(SID);
  });

  it('a mocked template failure falls back to SMS under the same key', async () => {
    await goLive(true);
    twilio.status = 400;
    twilio.json = { code: 63027, message: 'Template does not exist' };
    const payload = daily('refused');
    await notifyJob(ctxOf(LIVE), payload, {} as never);
    expect((await rows(payload.dedupeKey)).map((r) => [r.channel, r.status])).toEqual([
      ['whatsapp', 'undeliverable'],
      ['sms', 'sent'],
    ]);
    const [audit] = await pg.q<{ diff: Record<string, unknown> }>(
      `select diff from audit_log where action = 'notify.attempt_failed'
         and diff->>'dedupe_key' = $1`,
      [payload.dedupeKey],
    );
    expect(audit!.diff).toMatchObject({ channel: 'whatsapp', next_channel: 'sms' });
  });

  it('§19 Q84: no WhatsApp sender here, a real org’s message goes by SMS, no WhatsApp row', async () => {
    await pg.q(`update orgs set is_demo = false where id = $1`, [ORG]);
    await pg.q(`select set_country_endpoints('US', '+18885550142', null, null, null)`);
    const payload = daily('no-sender');
    await notifyJob(ctxOf(LIVE), payload, {} as never);
    expect((await rows(payload.dedupeKey)).map((r) => r.channel)).toEqual(['sms']);
  });

  it('W2-16: STOP on WhatsApp through Twilio revokes the WhatsApp consent only, confirmed there', async () => {
    await goLive(false);
    const [{ r }] = (await pg.q<{ r: { id: string; jobId: number } }>(
      `select receive_inbound_message('whatsapp', $1, $2, $3, $4, 'twilio', $5, 'STOP',
         '{"to":"+15550142299","keyword":"stop","pack":"US","opt_out_type":null,"num_media":0}'::jsonb) as r`,
      [randomUUID(), ORG, MARCO, MARCO_PHONE, `SMwa-${randomUUID()}`],
    )) as [{ r: { id: string; jobId: number } }];
    await smsInbound(ctxOf(LIVE), { messageId: r.id }, {} as never);
    const held = await pg.q<{ type: string }>(
      `select distinct type::text from consents where reporter_id = $1 and revoked_at is null
         and type in ('sms', 'whatsapp')`,
      [MARCO],
    );
    expect(held).toEqual([{ type: 'sms' }]);
    const [status] = await pg.q<{ status: string }>(`select status from reporters where id = $1`, [
      MARCO,
    ]);
    expect(status!.status).not.toBe('opted_out');
    // The message just opened the 24-hour window: the confirmation goes free-form.
    expect(twilio.forms.at(-1)!.get('Body')).toBe(
      "You won't get more WhatsApp messages from TalkOlog. Reply START to resume.",
    );
    expect(twilio.forms.at(-1)!.get('To')).toBe(`whatsapp:${MARCO_PHONE}`);
    // Handled once: a redelivery runs nothing.
    await smsInbound(ctxOf(LIVE), { messageId: r.id }, {} as never);
    expect(twilio.forms).toHaveLength(1);
  });
});
