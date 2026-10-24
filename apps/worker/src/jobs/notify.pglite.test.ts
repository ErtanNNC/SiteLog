import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  createConsoleSmsTransport,
  jobKeys,
  lateFallback,
  MessageSendError,
  type ChannelRegistration,
  type JobPayloads,
} from '@sitelog/shared';
import { testConfig } from '../config';
import type { Ctx } from '../context';
import { silentLogger } from '../log';
import { createWorkerNotifier } from '../messaging';
import { startPgliteDatabase, type PgliteDatabase } from '../test/pglite';
import { createNotifyJob, notifyJob } from './notify';

/**
 * The fallback after a late status callback (W2-01, spec §19 Q22) on PGlite: the `notify` job of a
 * `filed` text sends it by SMS; a callback marks that attempt undeliverable (what sms-webhook's
 * `/status` writes); the fallback job (`lateFallback`, keyed `jobKeys.notifyAfter`) re-runs the
 * message and the Notifier sends it once on a fake second channel registered as `whatsapp`.
 */

let pg: PgliteDatabase;
let MARCO = '';
let ORG = '';
const MARCO_PHONE = '+15550143378';
const faults: { whatsapp: Error | null } = { whatsapp: null };

const second: ChannelRegistration = {
  spec: {
    channel: 'whatsapp',
    // The WhatsApp consent label is W2-15's; a held consent stands in for it here.
    consent: 'data_processing',
    sender: () => null,
    provider: () => 'fakewa',
  },
  transport: (driver) => ({
    channel: 'whatsapp',
    driver,
    async send() {
      if (faults.whatsapp) throw faults.whatsapp;
      return { providerId: `${driver}:${randomUUID()}` };
    },
  }),
};

function ctxOf(): Ctx {
  const config = testConfig();
  return {
    config,
    db: pg.db,
    notifier: createWorkerNotifier(
      config,
      pg.db,
      () => createConsoleSmsTransport(() => randomUUID()),
      () => new Date(),
      [second],
    ),
    log: silentLogger,
    now: () => new Date(),
  } as unknown as Ctx;
}

/**
 * What sms-webhook's `/status` does for a late callback on a row: `undelivered` with 30005 (the
 * number) by default; `account` makes it a Twilio row refused for the account (`failed`, or
 * `undelivered` 30032).
 */
async function lateCallback(
  messageId: string,
  account: { status: 'failed' | 'undeliverable'; error: string | null } | null = null,
): Promise<{ jobId: number; dedupeKey: string }> {
  if (account) {
    await pg.q(
      `update messages set status = $2, error = $3, provider = 'twilio',
         provider_message_id = coalesce(provider_message_id, 'SM' || replace(id::text, '-', ''))
       where id = $1`,
      [messageId, account.status, account.error],
    );
  } else {
    await pg.q(
      `update messages set status = 'undeliverable', error = 'twilio 30005' where id = $1`,
      [messageId],
    );
  }
  const [row] = await pg.q<{
    id: string;
    reporter_id: string;
    copy_key: string;
    payload: unknown;
  }>(`select id, reporter_id, copy_key, payload from messages where id = $1`, [messageId]);
  const dedupeKey = (row!.payload as { dedupe_key: string }).dedupe_key;
  const [job] = await pg.q<{ payload: JobPayloads['notify'] }>(
    `select payload from jobs where type = 'notify' and payload->>'dedupeKey' = $1 order by id limit 1`,
    [dedupeKey],
  );
  const fallback = lateFallback(row!, account?.status ?? 'undeliverable', job?.payload ?? null);
  if (fallback.kind !== 'enqueue') throw new Error(`no fallback: ${fallback.reason}`);
  const jobId = await pg.db.enqueueJob('notify', fallback.payload, {
    dedupeKey: fallback.dedupeKey,
  });
  return { jobId, dedupeKey: fallback.dedupeKey };
}

async function jobPayload(id: number): Promise<JobPayloads['notify']> {
  const [job] = await pg.q<{ payload: JobPayloads['notify'] }>(
    `select payload from jobs where id = $1`,
    [id],
  );
  return job!.payload;
}

async function attempts(dedupeKey: string) {
  return pg.q<{
    id: string;
    channel: string;
    provider: string;
    status: string;
    payload: Record<string, unknown>;
  }>(
    `select id, channel, provider, status, payload from messages
     where reporter_id = $1 and payload->>'dedupe_key' = $2 order by created_at, id`,
    [MARCO, dedupeKey],
  );
}

async function filedJob(reportKey: string): Promise<JobPayloads['notify']> {
  const payload: JobPayloads['notify'] = {
    reporterId: MARCO,
    key: 'filed',
    vars: { report_no: 'RL-2041-0199', pdf_link: 'https://go.talkolog.com/r/ABCDEF/report/1' },
    dedupeKey: `notify:filed:${reportKey}`,
  };
  const id = await pg.db.enqueueJob('notify', payload, { dedupeKey: payload.dedupeKey });
  return jobPayload(id);
}

beforeAll(async () => {
  pg = await startPgliteDatabase({ seed: true });
  const [m] = await pg.q<{ id: string; org_id: string }>(
    `select id, org_id from reporters where phone_e164 = $1`,
    [MARCO_PHONE],
  );
  MARCO = m!.id;
  ORG = m!.org_id;
  // Q19's US order from M6 (W2-16 ships it); SMS first, then the second channel.
  await pg.q(`update countries set message_channels = '{sms,whatsapp}' where code = 'US'`);
});

afterAll(async () => {
  await pg?.close();
});

describe('notify: the fallback after a late status callback (W2-01)', () => {
  it('goes out once on the next channel, each attempt a row with its audit', async () => {
    const ctx = ctxOf();
    const first = await filedJob('w201-a');
    await notifyJob(ctx, first, {} as never);
    const [sms] = await attempts(first.dedupeKey);
    expect(sms).toMatchObject({
      channel: 'sms',
      provider: 'console',
      status: 'delivered',
      payload: { dedupe_key: first.dedupeKey, attempt: 1 },
    });

    const { jobId, dedupeKey } = await lateCallback(sms!.id);
    expect(dedupeKey).toBe(jobKeys.notifyAfter(first.dedupeKey, sms!.id));
    // A repeated callback joins the same job (the key names it for good, D16).
    expect((await lateCallback(sms!.id)).jobId).toBe(jobId);
    const fallback = await jobPayload(jobId);
    expect(fallback).toEqual({ ...first, afterMessageId: sms!.id });

    await notifyJob(ctx, fallback, {} as never);
    await notifyJob(ctx, fallback, {} as never); // a retry sends nothing again
    const rows = await attempts(first.dedupeKey);
    expect(rows.map((r) => [r.channel, r.status, r.payload.attempt])).toEqual([
      ['sms', 'undeliverable', 1],
      ['whatsapp', 'delivered', 2],
    ]);
    // Kestrel is a demo org: console on the second channel too.
    expect(rows[1]!.provider).toBe('console');
    const audit = await pg.q<{ action: string; entity_id: string; diff: Record<string, unknown> }>(
      `select action, entity_id, diff from audit_log
       where entity_id = any($1::uuid[]) and action in ('notify.attempt_failed', 'whatsapp.sent', 'sms.sent')
       order by id`,
      [rows.map((r) => r.id)],
    );
    expect(audit.map((a) => [a.action, a.entity_id])).toEqual([
      ['sms.sent', rows[0]!.id],
      ['notify.attempt_failed', rows[0]!.id],
      ['whatsapp.sent', rows[1]!.id],
    ]);
    expect(audit[1]!.diff).toMatchObject({
      reason: 'undeliverable',
      error: 'twilio 30005',
      channel: 'sms',
      next_channel: 'whatsapp',
      attempt: 1,
    });
  });

  it("drops the fallback when the key's guard says the message is no longer useful", async () => {
    const ctx = ctxOf();
    const first = await filedJob('w201-b');
    await notifyJob(ctx, first, {} as never);
    const [sms] = await attempts(first.dedupeKey);
    const { jobId } = await lateCallback(sms!.id);
    await createNotifyJob({ filed: async () => false })(ctx, await jobPayload(jobId), {} as never);
    expect((await attempts(first.dedupeKey)).map((r) => r.channel)).toEqual(['sms']);
    const [dropped] = await pg.q<{ action: string }>(
      `select action from audit_log where entity_id = $1 and action = 'notify.fallback_dropped'`,
      [sms!.id],
    );
    expect(dropped).toBeDefined();
  });

  it('every channel failed: the office is told once (message_failed)', async () => {
    const ctx = ctxOf();
    const first = await filedJob('w201-c');
    await notifyJob(ctx, first, {} as never);
    const [sms] = await attempts(first.dedupeKey);
    const { jobId } = await lateCallback(sms!.id);
    faults.whatsapp = new MessageSendError('fakewa: no template', 'whatsapp', {
      driver: 'console',
      retryable: false,
      undeliverable: true,
    });
    try {
      await notifyJob(ctx, await jobPayload(jobId), {} as never);
    } finally {
      faults.whatsapp = null;
    }
    expect((await attempts(first.dedupeKey)).map((r) => [r.channel, r.status])).toEqual([
      ['sms', 'undeliverable'],
      ['whatsapp', 'undeliverable'],
    ]);
    const notices = await pg.q<{ kind: string; data: { key: string; params: unknown } }>(
      `select kind, data from notifications where org_id = $1 and data->>'key' = 'message_channels_failed'`,
      [ORG],
    );
    expect(notices).toEqual([
      {
        kind: 'message_failed',
        data: {
          key: 'message_channels_failed',
          params: { name: 'Marco Ruiz', channels: 'sms, whatsapp', error: 'fakewa: no template' },
        },
      },
    ]);
  });

  describe('an account fault (Twilio 30032, 30034, 30002, 30007, failed)', () => {
    const notices = (key: string) =>
      pg.q<{ kind: string; data: { key: string; params: Record<string, unknown> } }>(
        `select kind, data from notifications where org_id = $1 and data->>'key' = $2`,
        [ORG, key],
      );

    it('still tries the next channel', async () => {
      const ctx = ctxOf();
      const first = await filedJob('w201-acct-a');
      await notifyJob(ctx, first, {} as never);
      const [sms] = await attempts(first.dedupeKey);
      const { jobId } = await lateCallback(sms!.id, {
        status: 'undeliverable',
        error: 'twilio 30032',
      });
      await notifyJob(ctx, await jobPayload(jobId), {} as never);
      expect((await attempts(first.dedupeKey)).map((r) => [r.channel, r.status])).toEqual([
        ['sms', 'undeliverable'],
        ['whatsapp', 'delivered'],
      ]);
    });

    it('posts no per-message message_failed when no channel is left (the provider-fault notice covers it)', async () => {
      const ctx = ctxOf();
      const before = (await notices('message_refused')).length;
      const beforeAll = (
        await pg.q(`select id from notifications where org_id = $1 and kind = 'message_failed'`, [
          ORG,
        ])
      ).length;
      await pg.q(`update countries set message_channels = '{sms}' where code = 'US'`);
      try {
        for (const [n, account] of [
          ['1', { status: 'undeliverable' as const, error: 'twilio 30034' }],
          ['2', { status: 'failed' as const, error: 'twilio 30002' }],
          ['3', { status: 'failed' as const, error: null }],
        ] as const) {
          const first = await filedJob(`w201-acct-b${n}`);
          await notifyJob(ctx, first, {} as never);
          const [sms] = await attempts(first.dedupeKey);
          const { jobId } = await lateCallback(sms!.id, account);
          await notifyJob(ctx, await jobPayload(jobId), {} as never);
          const [audit] = await pg.q<{ diff: Record<string, unknown> }>(
            `select diff from audit_log where action = 'notify.failed' and diff->>'dedupe_key' = $1`,
            [first.dedupeKey],
          );
          expect(audit!.diff).toMatchObject({ account_fault: true, notice: null });
        }
      } finally {
        await pg.q(`update countries set message_channels = '{sms,whatsapp}' where code = 'US'`);
      }
      expect((await notices('message_refused')).length).toBe(before);
      expect(
        (
          await pg.q(`select id from notifications where org_id = $1 and kind = 'message_failed'`, [
            ORG,
          ])
        ).length,
      ).toBe(beforeAll);
    });

    it('a per-recipient failure on SMS alone still posts message_failed', async () => {
      const ctx = ctxOf();
      const before = (await notices('message_refused')).length;
      await pg.q(`update countries set message_channels = '{sms}' where code = 'US'`);
      try {
        const first = await filedJob('w201-acct-c');
        await notifyJob(ctx, first, {} as never);
        const [sms] = await attempts(first.dedupeKey);
        const { jobId } = await lateCallback(sms!.id);
        await notifyJob(ctx, await jobPayload(jobId), {} as never);
      } finally {
        await pg.q(`update countries set message_channels = '{sms,whatsapp}' where code = 'US'`);
      }
      const after = await notices('message_refused');
      expect(after.length).toBe(before + 1);
      expect(after.at(-1)!.data.params).toMatchObject({ error: 'twilio 30005' });
    });

    it('an account fault on SMS and a refusal of the number on the next channel: message_failed', async () => {
      const ctx = ctxOf();
      const first = await filedJob('w201-acct-d');
      await notifyJob(ctx, first, {} as never);
      const [sms] = await attempts(first.dedupeKey);
      const { jobId } = await lateCallback(sms!.id, { status: 'failed', error: 'twilio 30007' });
      faults.whatsapp = new MessageSendError('fakewa: not on WhatsApp', 'whatsapp', {
        driver: 'console',
        retryable: false,
        undeliverable: true,
      });
      try {
        await notifyJob(ctx, await jobPayload(jobId), {} as never);
      } finally {
        faults.whatsapp = null;
      }
      const failed = (await notices('message_channels_failed')).filter(
        (n) => n.data.params.error === 'fakewa: not on WhatsApp',
      );
      expect(failed).toHaveLength(1);
    });
  });
});
