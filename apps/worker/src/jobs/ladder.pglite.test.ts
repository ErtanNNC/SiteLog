import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createConsoleSmsTransport, lateFallback, type JobPayloads } from '@sitelog/shared';
import { testConfig } from '../config';
import type { Ctx } from '../context';
import { silentLogger } from '../log';
import { createWorkerNotifier } from '../messaging';
import { startPgliteDatabase, type PgliteDatabase } from '../test/pglite';
import { notifyJob } from './notify';

/**
 * W2-06: the reminder ladder's `notify` jobs on PGlite, from the claim to the text. The jobs come
 * from claim_site_day_reminder() itself (what scheduler-tick calls), so the payload, the key and
 * the guard are the SQL's. The worker re-checks the guard before it sends: a day filed (or moved
 * on) after the claim sends nothing (`notify.skipped`, `stale_stage`; docs/AUDIT_BACKLOG.md
 * "Reminder templates are sent without re-checking the site-day…", "Ladder claim and reminder
 * send are not guarded by the site-day status"), and so does a job still waiting when the call
 * window has closed (spec §19 Q77, `quiet_hours`).
 */

let pg: PgliteDatabase;
let MARCO = '';
let SITE = '';
const MARCO_PHONE = '+15550143378';

function ctxAt(now: Date): Ctx {
  const config = testConfig();
  return {
    config,
    db: pg.db,
    notifier: createWorkerNotifier(
      config,
      pg.db,
      () => createConsoleSmsTransport(() => randomUUID()),
      () => now,
    ),
    log: silentLogger,
    now: () => now,
  } as unknown as Ctx;
}

async function siteDay(date: string): Promise<string> {
  const [row] = await pg.q<{ id: string }>(
    `insert into site_days (site_id, date, deadline_at) values ($1, $2, $3) returning id`,
    [SITE, date, `${date}T22:30:00Z`],
  );
  return row!.id;
}

/** Claims R1 for Marco through the SQL and returns the job it queued. */
async function claimR1(id: string, notAfter: string | null = null): Promise<JobPayloads['notify']> {
  const messages = [
    {
      reporterId: MARCO,
      key: 'reminder_1',
      vars: { site: 'Riverside Lofts', link: 'https://go.talkolog.com/r/ABCDEFGHJKMN' },
    },
  ];
  const [claimed] = await pg.q<{ ok: boolean }>(
    `select claim_site_day_reminder($1, 'reminder_1', $2::jsonb, '[]'::jsonb, $3::timestamptz) as ok`,
    [id, JSON.stringify(messages), notAfter],
  );
  expect(claimed!.ok).toBe(true);
  const [job] = await pg.q<{ payload: JobPayloads['notify'] }>(
    `select payload from jobs where dedupe_key = $1`,
    [`notify:reminder_1:${id}:${MARCO}`],
  );
  return job!.payload;
}

async function sent(dedupeKey: string) {
  return pg.q<{ id: string; status: string; copy_key: string; body: string }>(
    `select id, status, copy_key, body from messages where payload->>'dedupe_key' = $1`,
    [dedupeKey],
  );
}

async function skips(dedupeKey: string) {
  return pg.q<{ diff: Record<string, unknown> }>(
    `select diff from audit_log where action = 'notify.skipped' and diff->>'dedupe_key' = $1`,
    [dedupeKey],
  );
}

beforeAll(async () => {
  pg = await startPgliteDatabase({ seed: true, smsOrder: true });
  const [m] = await pg.q<{ id: string; site_id: string }>(
    `select r.id, sr.site_id from reporters r join site_reporters sr on sr.reporter_id = r.id
      where r.phone_e164 = $1 and sr.is_primary limit 1`,
    [MARCO_PHONE],
  );
  MARCO = m!.id;
  SITE = m!.site_id;
});

afterAll(async () => {
  await pg?.close();
});

describe('notify: the reminder ladder’s guard (W2-06)', () => {
  it('sends R1 while the day still waits for a report', async () => {
    const payload = await claimR1(await siteDay('2030-05-06'));
    await notifyJob(ctxAt(new Date('2030-05-06T22:46:00Z')), payload, {} as never);
    const rows = await sent(payload.dedupeKey);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ status: 'delivered', copy_key: 'reminder_1' });
    expect(rows[0]!.body).toContain('No report yet for Riverside Lofts today');
  });

  it('a day filed after the claim sends nothing (stale_stage), also on a retry', async () => {
    const id = await siteDay('2030-05-07');
    const payload = await claimR1(id);
    // The reporter's note is filed at 17:50; the job (retried after a provider outage) runs later.
    await pg.q(`update site_days set status = 'filed' where id = $1`, [id]);
    const ctx = ctxAt(new Date('2030-05-07T22:58:00Z'));
    await notifyJob(ctx, payload, {} as never);
    await notifyJob(ctx, payload, {} as never);
    expect(await sent(payload.dedupeKey)).toHaveLength(0);
    const audit = await skips(payload.dedupeKey);
    expect(audit).toHaveLength(2);
    expect(audit[0]!.diff).toMatchObject({
      copy_key: 'reminder_1',
      reason: 'stale_stage',
      site_day_id: id,
    });
  });

  it('a report in processing, a no-work day or paused reminders send nothing either', async () => {
    for (const [i, patch] of [
      "status = 'processing'",
      "status = 'no_work'",
      "status = 'weather_day'",
      'reminders_paused = true',
    ].entries()) {
      const id = await siteDay(`2030-05-1${i + 3}`); // Mon 13 – Thu 16
      const payload = await claimR1(id);
      await pg.q(`update site_days set ${patch} where id = $1`, [id]);
      await notifyJob(ctxAt(new Date(`2030-05-1${i + 3}T22:46:00Z`)), payload, {} as never);
      expect(await sent(payload.dedupeKey), patch).toHaveLength(0);
      expect((await skips(payload.dedupeKey))[0]!.diff, patch).toMatchObject({
        reason: 'stale_stage',
      });
    }
  });

  it('a job still waiting when the call window closes sends nothing (§19 Q77)', async () => {
    const payload = await claimR1(await siteDay('2030-05-20'), '2030-05-21T01:00:00Z');
    await notifyJob(ctxAt(new Date('2030-05-21T01:00:00Z')), payload, {} as never);
    expect(await sent(payload.dedupeKey)).toHaveLength(0);
    expect((await skips(payload.dedupeKey))[0]!.diff).toMatchObject({ reason: 'quiet_hours' });
  });

  it('the late fallback carries the guard and is dropped once the day is filed', async () => {
    const id = await siteDay('2030-05-21');
    const payload = await claimR1(id);
    await notifyJob(ctxAt(new Date('2030-05-21T22:46:00Z')), payload, {} as never);
    const [row] = await sent(payload.dedupeKey);
    await pg.q(
      `update messages set status = 'undeliverable', error = 'twilio 30005' where id = $1`,
      [row!.id],
    );
    await pg.q(`update site_days set status = 'filed' where id = $1`, [id]);
    const [msg] = await pg.q<{
      id: string;
      reporter_id: string;
      copy_key: string;
      payload: unknown;
    }>(`select id, reporter_id, copy_key, payload from messages where id = $1`, [row!.id]);
    const fallback = lateFallback(msg!, 'undeliverable', payload);
    if (fallback.kind !== 'enqueue') throw new Error(fallback.reason);
    expect(fallback.payload.guard).toEqual(payload.guard);
    await notifyJob(ctxAt(new Date('2030-05-21T22:55:00Z')), fallback.payload, {} as never);
    const dropped = await pg.q<{ diff: Record<string, unknown> }>(
      `select diff from audit_log where action = 'notify.fallback_dropped' and entity_id = $1`,
      [row!.id],
    );
    expect(dropped).toHaveLength(1);
    expect(await sent(payload.dedupeKey)).toHaveLength(1);
  });
});
