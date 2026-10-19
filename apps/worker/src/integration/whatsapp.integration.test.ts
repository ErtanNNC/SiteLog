import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  assertE164,
  processInboundSms,
  readReportData,
  toCountryPack,
  type JobRow,
  type StoredReportData,
} from '@sitelog/shared';
import { notifyJob } from '../jobs/notify';
import { workerInboundStore } from '../messaging';
import { runJob } from '../runner';
import { startPgliteDatabase, type PgliteDatabase } from '../test/pglite';
import { createSim, loadFixtureLibrary, manualClock, NO_LATENCY } from './fakes';
import { createWorld, type World } from './world';

/**
 * W2-16's Done-when on a real database (PGlite, every migration and the §18 seed): Selin Kaya on
 * the Demir Yapı demo org (TR pack, one-way SMS, WhatsApp first since 20261016000250) opted in to
 * WhatsApp gets `daily_link` there (console: the Demo phone's WhatsApp thread), replies HELP on
 * WhatsApp and gets the Turkish help text there; Marco Ruiz (Kestrel, US) answers the hero
 * report's question with "5" on WhatsApp and the `whatsapp_answer` job applies it with
 * `field_channel 'whatsapp'`; a US reporter still gets SMS first. The inbound messages go in as
 * the Demo phone stores them (provider console, the org's scope), handled by the same
 * `processInboundSms` the edge function runs inline.
 */

let database: PgliteDatabase;
let world: World;
const clock = manualClock(new Date('2026-10-12T22:35:00Z'));
let MARCO = '';
let MARCO_PHONE = '';
let KESTREL = '';
let RIVERSIDE = '';
let SELIN = '';
let SELIN_PHONE = '';
let DEMIR = '';

beforeAll(async () => {
  database = await startPgliteDatabase({ seed: true });
  world = createWorld({
    db: database.db,
    sql: database.sql,
    clock,
    sim: createSim({ advance: clock, profile: NO_LATENCY }),
    lib: loadFixtureLibrary(['riverside-2026-10-09']),
    config: { CLAUDE_MODEL: 'claude-test' },
    // A WhatsApp "5": a headcount the text states (the golden set is spoken answers).
    claude: {
      parseAnswer: (text, field) =>
        text === '5' ? { field: field as never, value: { workers: 5 }, confidence: 0.95 } : null,
    },
  });
  const [marco] = await database.q<{ id: string; org_id: string; phone_e164: string }>(
    `select id, org_id, phone_e164 from reporters where name = 'Marco Ruiz'`,
  );
  MARCO = marco!.id;
  KESTREL = marco!.org_id;
  MARCO_PHONE = marco!.phone_e164;
  RIVERSIDE = (
    await database.q<{ id: string }>(`select id from sites where project_code = 'RL-2041'`)
  )[0]!.id;
  const [selin] = await database.q<{ id: string; org_id: string; phone_e164: string }>(
    `select id, org_id, phone_e164 from reporters where name = 'Selin Kaya'`,
  );
  SELIN = selin!.id;
  DEMIR = selin!.org_id;
  SELIN_PHONE = selin!.phone_e164;
  // Marco is on the recorder: no question_ready text from decide_next.
  await database.q(
    `insert into field_devices (reporter_id, device_token_hash, verified_at, last_seen_at)
     values ($1, 'w2-16-device', now(), now() + interval '1 day')`,
    [MARCO],
  );
}, 120_000);

afterAll(async () => {
  await database?.close();
});

async function optIn(reporterId: string) {
  await database.q(
    `insert into consents (reporter_id, type, method, text_version) values
       ($1, 'whatsapp', 'web_checkbox', 'field.consent.v1')`,
    [reporterId],
  );
}

async function run(jobId: number) {
  const [row] = await database.q<JobRow>(
    `update jobs set status = 'running', locked_at = now(), locked_by = 'integration',
       attempts = attempts + 1 where id = $1 returning *`,
    [jobId],
  );
  return runJob(world.ctx, row!, 60_000, { workerId: 'integration' });
}

async function runQueued(type: string, reportId: string) {
  const jobs = await database.q<{ id: number }>(
    `select id from jobs where type = $1 and status = 'queued'
       and payload ->> 'reportId' = $2 and not payload ? 'timeout' order by id`,
    [type, reportId],
  );
  expect(jobs, `${type} queued`).toHaveLength(1);
  expect(await run(jobs[0]!.id)).toEqual({ ok: true });
}

/** A WhatsApp message typed in the Demo phone: stored, then handled inline (sms-webhook). */
async function whatsappFrom(orgId: string, phone: string, body: string, packCode: 'US' | 'TR') {
  const [{ r }] = (await database.q<{ r: { id: string } }>(
    `select receive_inbound_message('whatsapp', $1, $2, null, $3, 'console', $4, $5,
       jsonb_build_object('to', 'console', 'keyword', null, 'pack', $6::text,
                          'opt_out_type', null, 'num_media', 0)) as r`,
    [randomUUID(), orgId, phone, `console:${randomUUID()}`, body, packCode],
  )) as [{ r: { id: string } }];
  const row = await world.ctx.db.getCountry(packCode);
  const result = await processInboundSms(
    {
      store: workerInboundStore(world.ctx.db),
      notifier: world.ctx.notifier,
      linkSecret: () => world.ctx.config.LINK_SIGNING_SECRET || 'secret',
      fieldAppUrl: () => world.ctx.config.FIELD_APP_URL || 'https://go.talkolog.com',
      now: () => clock.now(),
      randomUUID,
    },
    {
      text: { messageId: r.id, from: assertE164(phone), body, optOutType: null },
      pack: toCountryPack(row!),
      scope: { orgId },
      applyPhoneOptOut: false,
      channel: 'whatsapp',
    },
  );
  return { messageId: r.id, result };
}

async function lastOut(reporterId: string) {
  const [m] = await database.q<{
    channel: string;
    copy_key: string;
    body: string;
    provider: string;
  }>(
    `select channel, copy_key, body, provider from messages
     where reporter_id = $1 and direction = 'out' order by created_at desc, id desc limit 1`,
    [reporterId],
  );
  return m!;
}

describe('W2-16: WhatsApp inbound and the real channel orders', () => {
  it('a TR demo reporter who opted in gets daily_link on WhatsApp and HELP answered there', async () => {
    await optIn(SELIN);
    await notifyJob(
      world.ctx,
      {
        reporterId: SELIN,
        key: 'daily_link',
        vars: { site: 'Ataşehir Ofis Binası', link: 'https://go.talkolog.com/r/AAAA2222' },
        dedupeKey: 'notify:w2-16:selin-daily',
      },
      {} as never,
    );
    expect(await lastOut(SELIN)).toMatchObject({
      channel: 'whatsapp',
      copy_key: 'daily_link',
      provider: 'console',
    });
    const { result } = await whatsappFrom(DEMIR, SELIN_PHONE, 'HELP', 'TR');
    expect(result.keyword).toBe('help');
    const help = await lastOut(SELIN);
    expect(help).toMatchObject({ channel: 'whatsapp', copy_key: 'help' });
    expect(help.body).toMatch(/^Demir Yapı.* için TalkOlog günlük raporları\. Linkiniz: http/);
  });

  it('answers the open question with "5" on WhatsApp: applied with field_channel whatsapp', async () => {
    const date = '2026-10-12';
    const up = await world.uploadVoiceNote({
      reporterId: MARCO,
      siteId: RIVERSIDE,
      fixtureId: 'es-en-riverside-2026-10-09',
      date,
    });
    expect(await run(up.jobId!)).toEqual({ ok: true });
    await runQueued('extract_report', up.reportId);
    await runQueued('decide_next', up.reportId);
    const [q] = await database.q<{ id: string; target: { manpowerIndex?: number } }>(
      `select id, target from questions where report_id = $1 and answered_at is null`,
      [up.reportId],
    );
    expect(q).toBeDefined();
    await optIn(MARCO);
    const { messageId, result } = await whatsappFrom(KESTREL, MARCO_PHONE, '5', 'US');
    expect(result).toMatchObject({ keyword: null, answer: true });
    const [job] = await database.q<{ id: number }>(
      `select id from jobs where type = 'whatsapp_answer' and dedupe_key = $1`,
      [`whatsapp_answer:${messageId}`],
    );
    expect(await run(job!.id)).toEqual({ ok: true });
    const [answered] = await database.q<{
      answered_at: string | null;
      answered_message_id: string;
      answer: Record<string, unknown>;
    }>(`select answered_at, answered_message_id, answer from questions where id = $1`, [q!.id]);
    expect(answered!.answered_at).not.toBeNull();
    expect(answered!.answered_message_id).toBe(messageId);
    expect(answered!.answer).toMatchObject({ text: '5', parsed: { workers: 5 }, via: 'whatsapp' });
    const [v] = await database.q<{ data: StoredReportData }>(
      `select v.data from report_versions v join reports r on r.id = v.report_id
         and v.version = r.current_version where r.id = $1`,
      [up.reportId],
    );
    const crew = readReportData(v!.data).manpower[q!.target.manpowerIndex ?? 0]!;
    expect(crew.workers).toBe(5);
    const [audit] = await database.q<{ diff: Record<string, unknown> }>(
      `select diff from audit_log where action = 'report.question_answered' and entity_id = $1
       order by id desc limit 1`,
      [up.reportId],
    );
    expect(audit!.diff).toMatchObject({ channel: 'whatsapp', message_id: messageId });
  });

  it('US reporters still get SMS first, opted in to WhatsApp or not', async () => {
    await notifyJob(
      world.ctx,
      {
        reporterId: MARCO,
        key: 'daily_link',
        vars: { site: 'Riverside Lofts', link: 'https://go.talkolog.com/r/AAAA1111' },
        dedupeKey: 'notify:w2-16:marco-daily',
      },
      {} as never,
    );
    expect(await lastOut(MARCO)).toMatchObject({ channel: 'sms', copy_key: 'daily_link' });
  });
});
