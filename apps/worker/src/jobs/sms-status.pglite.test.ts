import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  ILETIMERKEZI_REPORT_FIXTURE_ENDPOINT,
  IletimerkeziReportError,
  JobPayloadSchemas,
  SMS_STATUS_POLL_OFFSETS_MS,
  createIletimerkeziReportSource,
  createSmsTransports,
  jobKeys,
  type ChannelRegistration,
  type JobPayloads,
  type JobRow,
} from '@sitelog/shared';
import { DEMIR_ORG_ID } from '@sitelog/shared/demo/demir.ts';
import { testConfig } from '../config';
import type { Ctx } from '../context';
import { silentLogger } from '../log';
import { createWorkerNotifier, workerIletimerkeziReports } from '../messaging';
import { startPgliteDatabase, type PgliteDatabase } from '../test/pglite';
import { notifyJob } from './notify';
import { smsStatusJob } from './sms_status';

/**
 * W4-11 (spec §4.5, §19 Q237): a TR text through a mocked İletimerkezi (the driver's send, then
 * the order's report on the fixture endpoint, `fixtures/iletimerkezi`) on PGlite. The send writes
 * the row `sent`, enqueue_sms_status_poll() (SQL) queues poll 1 at +2 min, and `sms_status` moves
 * the row: `sent → delivered`; not ready or pending → the next poll at +15 min and +2 h; an
 * undelivered text walks to the next channel, or tells the office once when none is left.
 *
 * Demir Yapı (§18.2) is the seed's TR org; here it is made a real org (`is_demo` false) and the TR
 * pack is given the `TALKOLOG` title, so its texts take the İletimerkezi driver, not `console`.
 */

const FIXTURES = join(
  dirname(fileURLToPath(import.meta.url)),
  '..',
  '..',
  '..',
  '..',
  'fixtures',
  'iletimerkezi',
);
const fixture = (name: string): string => readFileSync(join(FIXTURES, `${name}.json`), 'utf8');

const API = 'https://ime.test';
let pg: PgliteDatabase;
let SELIN = '';

/**
 * The mocked İletimerkezi: accepts every order (`send-accepted.json`, a fresh order id each), and
 * answers each report request with the next item of that order's queue (a fixture name, or an
 * HTTP status for an outage). An empty queue is a test error.
 */
const mock = {
  orders: 0,
  sent: [] as Array<{ text: string; sender: string; numbers: string[] }>,
  reports: new Map<string, Array<string | number>>(),
  reportCalls: 0,
};

async function mockFetch(url: string, init: RequestInit): Promise<Response> {
  const body = JSON.parse(String(init.body)) as Record<string, unknown>;
  if (url === `${API}/v1/send-sms/json`) {
    const order = (
      body as {
        request: {
          order: { sender: string; message: { text: string; receipents: { number: string[] } } };
        };
      }
    ).request.order;
    mock.sent.push({
      text: order.message.text,
      sender: order.sender,
      numbers: order.message.receipents.number,
    });
    mock.orders += 1;
    return new Response(fixture('send-accepted').replace('{{order_id}}', `ord-${mock.orders}`), {
      status: 200,
    });
  }
  if (url === `${API}${ILETIMERKEZI_REPORT_FIXTURE_ENDPOINT.path}`) {
    mock.reportCalls += 1;
    const queue = mock.reports.get(String(body.orderId)) ?? [];
    const next = queue.shift();
    if (next === undefined) throw new Error(`no report queued for ${String(body.orderId)}`);
    if (typeof next === 'number') return new Response('{}', { status: next });
    return new Response(fixture(`report-${next}`), { status: 200 });
  }
  throw new Error(`unexpected request ${url}`);
}

/** A fake second channel registered as WhatsApp (as notify.pglite.test.ts does). */
const second: ChannelRegistration = {
  spec: {
    channel: 'whatsapp',
    consent: 'data_processing',
    // A sender here: a real org's channel with none would be console and reach no phone.
    sender: () => 'fake-sender',
    provider: () => 'fakewa',
  },
  transport: (driver) => ({
    channel: 'whatsapp',
    driver,
    async send() {
      return { providerId: `${driver}:${randomUUID()}` };
    },
  }),
};

function ctxOf(reports: Ctx['iletimerkeziReports'] = undefined): Ctx {
  const config = testConfig({ ILETIMERKEZI_API_KEY: 'key-1', ILETIMERKEZI_API_HASH: 'hash-1' });
  const transports = createSmsTransports({
    fetch: mockFetch,
    randomUUID: () => randomUUID(),
    iletimerkezi: { apiKey: 'key-1', apiHash: 'hash-1' },
    apiBase: { iletimerkezi: API },
  });
  return {
    config,
    db: pg.db,
    notifier: createWorkerNotifier(config, pg.db, transports, () => new Date(), [second]),
    iletimerkeziReports:
      reports === undefined
        ? createIletimerkeziReportSource(
            { apiKey: 'key-1', apiHash: 'hash-1' },
            mockFetch,
            ILETIMERKEZI_REPORT_FIXTURE_ENDPOINT,
            API,
          )
        : reports,
    log: silentLogger,
    now: () => new Date(),
  } as unknown as Ctx;
}

interface Sent {
  messageId: string;
  orderId: string;
  dedupeKey: string;
  poll1: { payload: JobPayloads['sms_status']; job: JobRow };
}

/** The `filed` text to Selin through the notify job; returns its row and the queued poll 1. */
async function sendFiled(ctx: Ctx, reports: Array<string | number>): Promise<Sent> {
  const reportId = `w411-${randomUUID().slice(0, 8)}`;
  const payload: JobPayloads['notify'] = {
    reporterId: SELIN,
    key: 'filed',
    vars: { report_no: 'DY-2041-0199', pdf_link: 'https://sl.link/r/AB12CD34EF56/report/1' },
    dedupeKey: jobKeys.filed(reportId),
  };
  await pg.db.enqueueJob('notify', payload, { dedupeKey: payload.dedupeKey });
  await notifyJob(ctx, payload, {} as never);
  const [row] = await pg.q<{ id: string; status: string; provider: string; pmid: string }>(
    `select id, status, provider, provider_message_id as pmid from messages
     where reporter_id = $1 and payload->>'dedupe_key' = $2`,
    [SELIN, payload.dedupeKey],
  );
  expect(row).toMatchObject({ status: 'sent', provider: 'iletimerkezi' });
  const orderId = row!.pmid.replace(/^iletimerkezi:/, '');
  mock.reports.set(orderId, [...reports]);
  return {
    messageId: row!.id,
    orderId,
    dedupeKey: payload.dedupeKey,
    poll1: await poll(row!.id, 1),
  };
}

async function poll(messageId: string, n: number) {
  const [job] = await pg.q<JobRow>(`select * from jobs where dedupe_key = $1`, [
    jobKeys.smsStatus(messageId, n),
  ]);
  if (!job) throw new Error(`no poll ${n} for ${messageId}`);
  return { payload: JobPayloadSchemas.sms_status.parse(job.payload), job };
}

async function pollCount(messageId: string): Promise<number> {
  const [r] = await pg.q<{ n: number }>(
    `select count(*)::int as n from jobs where type = 'sms_status' and payload->>'messageId' = $1`,
    [messageId],
  );
  return r!.n;
}

async function runPoll(ctx: Ctx, p: { payload: JobPayloads['sms_status']; job: JobRow }) {
  await smsStatusJob(ctx, p.payload, p.job);
}

async function messageRow(id: string) {
  const [r] = await pg.q<{ status: string; error: string | null }>(
    `select status, error from messages where id = $1`,
    [id],
  );
  return r!;
}

async function auditOf(id: string) {
  return pg.q<{ action: string; diff: Record<string, unknown> }>(
    `select action, diff from audit_log where entity_id = $1 order by id`,
    [id],
  );
}

beforeAll(async () => {
  pg = await startPgliteDatabase({ seed: true });
  await pg.q(`update orgs set is_demo = false where id = $1`, [DEMIR_ORG_ID]);
  await pg.q(
    `update countries set sms_provider = 'iletimerkezi', sms_sender_type = 'alphanumeric', sms_sender_id = 'TALKOLOG' where code = 'TR'`,
  );
  const [s] = await pg.q<{ id: string }>(`select id from reporters where phone_e164 = $1`, [
    '+905320000512',
  ]);
  SELIN = s!.id;
  await pg.q(`update reporters set message_channel = null, status = 'active' where id = $1`, [
    SELIN,
  ]);
  for (const type of ['sms', 'data_processing'])
    await pg.q(
      `insert into consents (reporter_id, type, method, text_version)
       select $1, $2::consent_type, 'office_attested', 'test'
       where not exists (select 1 from consents where reporter_id = $1 and type = $2::consent_type
                           and revoked_at is null)`,
      [SELIN, type],
    );
});

beforeEach(async () => {
  // SMS only by default; the walk test adds the second channel.
  await pg.q(`update countries set message_channels = '{sms}' where code = 'TR'`);
});

afterAll(async () => {
  await pg?.close();
});

describe('sms_status: İletimerkezi delivery reports (W4-11)', () => {
  it('a TR text goes sent → delivered at the first poll (+2 min)', async () => {
    const ctx = ctxOf();
    const sent = await sendFiled(ctx, ['delivered']);
    // The driver sent the Turkish text as is, from the title, to the number without its +.
    const last = mock.sent.at(-1)!;
    expect(last.sender).toBe('TALKOLOG');
    expect(last.numbers).toEqual(['905320000512']);
    expect(last.text).toBe(
      'Kaydedildi: Günlük Rapor DY-2041-0199. PDF: https://sl.link/r/AB12CD34EF56/report/1',
    );
    // Poll 1 is due at sentAt + 2 min (the trigger's database clock).
    const due = new Date(sent.poll1.job.run_after).getTime();
    expect(due - new Date(sent.poll1.payload.sentAt).getTime()).toBe(SMS_STATUS_POLL_OFFSETS_MS[0]);

    await runPoll(ctx, sent.poll1);
    expect(await messageRow(sent.messageId)).toEqual({ status: 'delivered', error: null });
    const audit = await auditOf(sent.messageId);
    expect(audit.map((a) => a.action)).toEqual(['sms.sent', 'sms.status']);
    expect(audit[1]!.diff).toEqual({
      from: 'sent',
      to: 'delivered',
      error_code: null,
      via: 'report_poll',
    });
    expect(await pollCount(sent.messageId)).toBe(1);
    // A retried poll reads nothing: the row is no longer `sent`.
    const calls = mock.reportCalls;
    await runPoll(ctx, sent.poll1);
    expect(mock.reportCalls).toBe(calls);
  });

  it('not ready, then pending: polls again at +15 min and +2 h, then delivered', async () => {
    const ctx = ctxOf();
    const sent = await sendFiled(ctx, ['not-ready', 'pending', 'delivered']);
    const sentAt = new Date(sent.poll1.payload.sentAt).getTime();
    await runPoll(ctx, sent.poll1);
    expect((await messageRow(sent.messageId)).status).toBe('sent');
    const p2 = await poll(sent.messageId, 2);
    expect(p2.payload).toEqual({ ...sent.poll1.payload, poll: 2 });
    expect(new Date(p2.job.run_after).getTime() - sentAt).toBe(SMS_STATUS_POLL_OFFSETS_MS[1]);
    await runPoll(ctx, p2);
    await runPoll(ctx, p2); // a retry of poll 2 queues no second poll 3 (its key is taken)
    const p3 = await poll(sent.messageId, 3);
    expect(new Date(p3.job.run_after).getTime() - sentAt).toBe(SMS_STATUS_POLL_OFFSETS_MS[2]);
    // The second run of poll 2 read the queued `delivered` already; reset it for poll 3.
    mock.reports.set(sent.orderId, ['delivered']);
    await pg.q(`update messages set status = 'sent' where id = $1`, [sent.messageId]);
    await runPoll(ctx, p3);
    expect((await messageRow(sent.messageId)).status).toBe('delivered');
    expect(await pollCount(sent.messageId)).toBe(3);
  });

  it('never final after +2 h: the row stays sent, audited sms.status_unresolved', async () => {
    const ctx = ctxOf();
    const sent = await sendFiled(ctx, ['unknown', 'pending', 'unknown']);
    await runPoll(ctx, sent.poll1);
    await runPoll(ctx, await poll(sent.messageId, 2));
    await runPoll(ctx, await poll(sent.messageId, 3));
    expect((await messageRow(sent.messageId)).status).toBe('sent');
    expect(await pollCount(sent.messageId)).toBe(3);
    const audit = await auditOf(sent.messageId);
    expect(audit.map((a) => a.action)).toEqual(['sms.sent', 'sms.status_unresolved']);
    expect(audit[1]!.diff).toMatchObject({
      polls: 3,
      delivery: 'unknown',
      code: 'fixture-unknown',
    });
  });

  it('429 and 5xx: the poll throws for the job backoff, nothing changes; then it reads', async () => {
    const ctx = ctxOf();
    const sent = await sendFiled(ctx, [429, 503, 'delivered']);
    for (const status of [429, 503]) {
      const err = await runPoll(ctx, sent.poll1).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(IletimerkeziReportError);
      expect([
        (err as IletimerkeziReportError).retryable,
        (err as IletimerkeziReportError).status,
      ]).toEqual([true, status]);
      expect((await messageRow(sent.messageId)).status).toBe('sent');
      expect(await pollCount(sent.messageId)).toBe(1);
    }
    await runPoll(ctx, sent.poll1);
    expect((await messageRow(sent.messageId)).status).toBe('delivered');
  });

  it('a refused report (401) is audited and polled again later', async () => {
    const ctx = ctxOf();
    const sent = await sendFiled(ctx, [401]);
    await runPoll(ctx, sent.poll1);
    expect((await messageRow(sent.messageId)).status).toBe('sent');
    const audit = await auditOf(sent.messageId);
    expect(audit.at(-1)).toMatchObject({
      action: 'sms.status_poll_failed',
      diff: { poll: 1, http_status: 401 },
    });
    expect(await pollCount(sent.messageId)).toBe(2);
  });

  it('undelivered: the message walks to the next channel', async () => {
    await pg.q(`update countries set message_channels = '{sms,whatsapp}' where code = 'TR'`);
    const ctx = ctxOf();
    const sent = await sendFiled(ctx, ['undelivered']);
    await runPoll(ctx, sent.poll1);
    expect(await messageRow(sent.messageId)).toEqual({
      status: 'undeliverable',
      error: 'iletimerkezi report fixture-undelivered',
    });
    const [fallback] = await pg.q<JobRow>(`select * from jobs where dedupe_key = $1`, [
      jobKeys.notifyAfter(sent.dedupeKey, sent.messageId),
    ]);
    expect(fallback).toBeDefined();
    await notifyJob(ctx, JobPayloadSchemas.notify.parse(fallback!.payload), fallback!);
    const rows = await pg.q<{ channel: string; status: string }>(
      `select channel, status from messages where reporter_id = $1 and payload->>'dedupe_key' = $2
       order by created_at, id`,
      [SELIN, sent.dedupeKey],
    );
    expect(rows.map((r) => [r.channel, r.status])).toEqual([
      ['sms', 'undeliverable'],
      ['whatsapp', 'sent'],
    ]);
    expect((await auditOf(sent.messageId)).map((a) => a.action)).toEqual([
      'sms.sent',
      'sms.status',
      'notify.fallback_queued',
      'notify.attempt_failed',
    ]);
  });

  it('undelivered with no channel left: the office is told once (message_failed)', async () => {
    const ctx = ctxOf();
    const before = await failedNotices();
    const sent = await sendFiled(ctx, ['undelivered']);
    await runPoll(ctx, sent.poll1);
    const [fallback] = await pg.q<JobRow>(`select * from jobs where dedupe_key = $1`, [
      jobKeys.notifyAfter(sent.dedupeKey, sent.messageId),
    ]);
    const payload = JobPayloadSchemas.notify.parse(fallback!.payload);
    await notifyJob(ctx, payload, fallback!);
    // A repeated poll (a retry, or a report read again) moves nothing, so queues nothing more.
    await runPoll(ctx, sent.poll1);
    expect((await failedNotices()) - before).toBe(1);
    // The number's failure: never the account's notice.
    const [fault] = await pg.q(
      `select 1 from audit_log where entity_id = $1 and action = 'sms.provider_fault'`,
      [sent.messageId],
    );
    expect(fault).toBeUndefined();
  });

  it('no report source (ILETIMERKEZI_STATUS=off, or the endpoint unconfirmed): the row stays sent', async () => {
    expect(
      workerIletimerkeziReports(
        testConfig({
          ILETIMERKEZI_API_KEY: 'k',
          ILETIMERKEZI_API_HASH: 'h',
          ILETIMERKEZI_STATUS: 'poll',
        }),
      ),
    ).toBeNull(); // ILETIMERKEZI_REPORT_ENDPOINT is null until spec §19 Q280 is answered
    expect(
      workerIletimerkeziReports(
        testConfig({
          ILETIMERKEZI_API_KEY: 'k',
          ILETIMERKEZI_API_HASH: 'h',
          ILETIMERKEZI_STATUS: 'off',
        }),
        undefined,
        ILETIMERKEZI_REPORT_FIXTURE_ENDPOINT,
      ),
    ).toBeNull();
    const ctx = ctxOf(null);
    const sent = await sendFiled(ctx, []);
    await runPoll(ctx, sent.poll1);
    expect((await messageRow(sent.messageId)).status).toBe('sent');
    expect(await pollCount(sent.messageId)).toBe(1);
  });
});

async function failedNotices(): Promise<number> {
  const [r] = await pg.q<{ n: number }>(
    `select count(*)::int as n from notifications where org_id = $1 and kind = 'message_failed'`,
    [DEMIR_ORG_ID],
  );
  return r!.n;
}
