import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createConsoleSmsTransport, type JobPayloads } from '@sitelog/shared';
import { testConfig } from '../config';
import { createMetrics, type Ctx } from '../context';
import { silentLogger } from '../log';
import { createWorkerNotifier } from '../messaging';
import type { DialInput, DialResult, Telephony, TelephonyRegistry } from '../telephony';
import { createConsoleTelephony } from '../telephony';
import { startPgliteDatabase, type PgliteDatabase } from '../test/pglite';
import { notifyJob } from './notify';
import { placeCallJob } from './place_call';

/**
 * W3-17 on PGlite (spec §7.4, F6 step 1, F11, §9.4 "Calls policy", §10.1 `place_call`, §19
 * Q127–Q132): the `place_call` job from the claim to the Demo phone, on the real SQL
 * (claim_site_day_reminder() with its calls, outbound_call_start(), voice_schedule_callback(),
 * voice_call_end()) and a fake telephony where a real org's LiveKit is needed.
 *
 * Kevin O'Brien (Northgate, Kestrel, a demo org: the `console` telephony, §19 Q132) prefers calls
 * and holds his own `auto_call` consent. Each guard: the call window, the consent, the attempts,
 * "Don't call me today", capacity on LiveKit, and the callback.
 */

let pg: PgliteDatabase;
let KEVIN = '';
let NORTHGATE = '';
let KESTREL = '';
const KEVIN_PHONE = '+15550142087';
let dates = 0;

class FakeLiveKit implements Telephony {
  readonly driver = 'livekit' as const;
  dials: DialInput[] = [];
  next: DialResult = { kind: 'answered' };
  dial(input: DialInput) {
    this.dials.push(input);
    return Promise.resolve(this.next);
  }
}

let livekit: FakeLiveKit;

function ctxAt(now: Date, over: Partial<Ctx> = {}): Ctx {
  const config = testConfig({
    LINK_SIGNING_SECRET: 'place-call-link-secret',
    FIELD_APP_URL: 'https://go.sitelog.test',
    VOICE_MAX_CONCURRENT_CALLS: 4,
  });
  const telephony: TelephonyRegistry = {
    get: (d) => (d === 'console' ? createConsoleTelephony(30) : livekit),
  };
  return {
    config,
    db: pg.db,
    notifier: createWorkerNotifier(
      config,
      pg.db,
      () => createConsoleSmsTransport(() => randomUUID()),
      () => now,
    ),
    telephony,
    log: silentLogger,
    now: () => now,
    metrics: createMetrics(),
    signal: new AbortController().signal,
    ...over,
  } as unknown as Ctx;
}

/** A fresh Northgate site-day on the next Monday–Friday of May 2030, deadline 17:30 Chicago. */
async function freshDay(): Promise<{ id: string; date: string }> {
  const days = ['2030-05-06', '2030-05-07', '2030-05-08', '2030-05-09', '2030-05-10'];
  const weeks = Math.floor(dates / days.length);
  const base = days[dates % days.length]!;
  dates += 1;
  const date = new Date(Date.parse(`${base}T00:00:00Z`) + weeks * 7 * 86_400_000)
    .toISOString()
    .slice(0, 10);
  const [row] = await pg.q<{ id: string }>(
    `insert into site_days (site_id, date, deadline_at) values ($1, $2, $3) returning id`,
    [NORTHGATE, date, `${date}T22:30:00Z`],
  );
  return { id: row!.id, date };
}

/** 17:45 (R1) or 18:30 (R2) Chicago on `date` (CDT, UTC−5). */
const at = (date: string, hhmmZ: string) => new Date(`${date}T${hhmmZ}:00Z`);

async function claim(
  siteDayId: string,
  stage: 'reminder_1' | 'reminder_2',
): Promise<JobPayloads['place_call']> {
  const [ok] = await pg.q<{ ok: boolean }>(
    `select claim_site_day_reminder($1, $2, '[]'::jsonb, '[]'::jsonb, null, $3::jsonb) as ok`,
    [siteDayId, stage, JSON.stringify([{ reporterId: KEVIN, giveUpAt: null }])],
  );
  expect(ok!.ok).toBe(true);
  const [job] = await pg.q<{ payload: JobPayloads['place_call'] }>(
    `select payload from jobs where dedupe_key = $1`,
    [`call:${siteDayId}:${KEVIN}:${stage}`],
  );
  expect(job, 'the claim queued the call').toBeTruthy();
  return job!.payload;
}

async function calls(siteDayId: string) {
  return pg.q<{
    id: string;
    status: string;
    outcome: string | null;
    attempt: number;
    purpose: string;
    direction: string;
    provider_call_id: string;
  }>(
    `select id, status::text, outcome::text, attempt, purpose, direction::text, provider_call_id
       from calls where site_day_id = $1 order by attempt`,
    [siteDayId],
  );
}

async function job<T = Record<string, unknown>>(key: string) {
  const [row] = await pg.q<{ payload: T; run_after: string }>(
    `select payload, run_after from jobs where dedupe_key = $1`,
    [key],
  );
  return row;
}

async function skipsOf(siteDayId: string) {
  return (
    await pg.q<{ diff: { reason: string; stage: string; message: string | null } }>(
      `select diff from audit_log where action = 'call.skipped' and diff->>'site_day_id' = $1
        order by id`,
      [siteDayId],
    )
  ).map((r) => r.diff);
}

beforeAll(async () => {
  pg = await startPgliteDatabase({ seed: true });
  const [k] = await pg.q<{ id: string; site_id: string; org_id: string }>(
    `select r.id, sr.site_id, r.org_id from reporters r join site_reporters sr on sr.reporter_id = r.id
      where r.phone_e164 = $1 and sr.is_primary limit 1`,
    [KEVIN_PHONE],
  );
  KEVIN = k!.id;
  NORTHGATE = k!.site_id;
  KESTREL = k!.org_id;
});

beforeEach(() => {
  livekit = new FakeLiveKit();
});

afterAll(async () => {
  await pg?.close();
});

describe('place_call on the console telephony (a demo org, §19 Q132)', () => {
  it('R1 rings the Demo phone; unanswered it ends not_reached and texts missed_call', async () => {
    const day = await freshDay();
    const payload = await claim(day.id, 'reminder_1');
    expect(payload).toMatchObject({ reporterId: KEVIN, siteDayId: day.id, stage: 'reminder_1' });
    const now = at(day.date, '22:46');
    await placeCallJob(ctxAt(now), payload, {} as never);

    const [call] = await calls(day.id);
    expect(call).toMatchObject({
      status: 'ringing',
      attempt: 1,
      purpose: 'reminder',
      direction: 'outbound',
      provider_call_id: `call-${call!.id}`,
    });
    const [requested] = await pg.q<{ diff: Record<string, unknown> }>(
      `select diff from audit_log where action = 'call.requested' and entity_id = $1`,
      [call!.id],
    );
    expect(requested!.diff).toMatchObject({
      telephony: 'console',
      attempt: 1,
      direction: 'outbound',
    });
    // No phone number in the audit row.
    expect(JSON.stringify(requested!.diff)).not.toContain(KEVIN_PHONE);

    // The ring's end, 30 s later on the queue's clock.
    const ring = await job<JobPayloads['place_call']>(`call_ring:${call!.id}`);
    expect(ring!.payload).toEqual({ phase: 'ring_end', callId: call!.id });
    await placeCallJob(ctxAt(now), ring!.payload, {} as never);
    expect((await calls(day.id))[0]).toMatchObject({ status: 'no_answer', outcome: 'not_reached' });

    const missed = await job<JobPayloads['notify']>(`notify:missed_call:${call!.id}`);
    expect(missed!.payload).toMatchObject({ reporterId: KEVIN, key: 'missed_call' });
    await notifyJob(ctxAt(now), missed!.payload, {} as never);
    const [text] = await pg.q<{ status: string; body: string }>(
      `select status, body from messages where payload->>'dedupe_key' = $1`,
      [`notify:missed_call:${call!.id}`],
    );
    expect(text!.status).toBe('delivered');
    expect(text!.body).toMatch(
      /^Missed you for today's report\. Tap https:\/\/go\.sitelog\.test\/r\//,
    );

    // A ring end that comes again changes nothing (one text per call).
    await placeCallJob(ctxAt(now), ring!.payload, {} as never);
    expect(
      await pg.q(`select 1 from jobs where dedupe_key like $1`, [
        `notify:missed_call:%${call!.id}%`,
      ]),
    ).toHaveLength(1);
  });

  it('R2 is the second attempt; R1 again on the same day is refused (attempts, §19 Q128)', async () => {
    const day = await freshDay();
    const r1 = await claim(day.id, 'reminder_1');
    await placeCallJob(ctxAt(at(day.date, '22:46')), r1, {} as never);
    // A retried R1 job: the attempt is used, nothing more, no text.
    await placeCallJob(ctxAt(at(day.date, '22:47')), r1, {} as never);
    const r2 = await claim(day.id, 'reminder_2');
    await placeCallJob(ctxAt(at(day.date, '23:31')), r2, {} as never);
    expect((await calls(day.id)).map((c) => c.attempt)).toEqual([1, 2]);
    expect(await skipsOf(day.id)).toEqual([
      { stage: 'reminder_1', reason: 'attempt_used', site_day_id: day.id, message: null },
    ]);
  });

  it('outside the call window: no call, no text (§9.4, §19 Q77)', async () => {
    const day = await freshDay();
    const payload = await claim(day.id, 'reminder_1');
    // 20:30 Chicago: the window (07:00–20:00) has closed.
    const late = new Date(Date.parse(`${day.date}T22:30:00Z`) + 3 * 3600_000);
    await placeCallJob(ctxAt(late), payload, {} as never);
    expect(await calls(day.id)).toEqual([]);
    expect(await skipsOf(day.id)).toEqual([
      { stage: 'reminder_1', reason: 'outside_window', site_day_id: day.id, message: null },
    ]);
    expect(await job(`notify:reminder_1:${day.id}:${KEVIN}`)).toBeUndefined();
  });

  it('without his own auto_call consent: no call, R1 by text (§19 Q131)', async () => {
    const day = await freshDay();
    const payload = await claim(day.id, 'reminder_1');
    await pg.q(
      `update consents set revoked_at = now() where reporter_id = $1 and type = 'auto_call'`,
      [KEVIN],
    );
    try {
      await placeCallJob(ctxAt(at(day.date, '22:46')), payload, {} as never);
    } finally {
      await pg.q(
        `update consents set revoked_at = null where reporter_id = $1 and type = 'auto_call'`,
        [KEVIN],
      );
    }
    expect(await calls(day.id)).toEqual([]);
    expect(await skipsOf(day.id)).toEqual([
      { stage: 'reminder_1', reason: 'no_consent', site_day_id: day.id, message: 'reminder_1' },
    ]);
    const text = await job<JobPayloads['notify']>(`notify:reminder_1:${day.id}:${KEVIN}`);
    expect(text!.payload).toMatchObject({
      key: 'reminder_1',
      vars: { site: 'Northgate Parking Structure' },
      guard: { siteDayId: day.id, statuses: ['pending', 'reminded'] },
    });
  });

  it('"Don\'t call me today": no call, R1 by text (§19 Q129)', async () => {
    const day = await freshDay();
    const payload = await claim(day.id, 'reminder_1');
    const now = at(day.date, '22:46');
    await pg.q(`select field_no_calls_today($1, null, $2::timestamptz)`, [
      KEVIN,
      now.toISOString(),
    ]);
    try {
      await placeCallJob(ctxAt(now), payload, {} as never);
    } finally {
      await pg.q(`update reporters set no_calls_until = null where id = $1`, [KEVIN]);
    }
    expect(await calls(day.id)).toEqual([]);
    expect(await skipsOf(day.id)).toEqual([
      { stage: 'reminder_1', reason: 'no_calls_today', site_day_id: day.id, message: 'reminder_1' },
    ]);
  });

  it('a day filed after the claim places no call and sends nothing', async () => {
    const day = await freshDay();
    const payload = await claim(day.id, 'reminder_1');
    await pg.q(`update site_days set status = 'filed' where id = $1`, [day.id]);
    await placeCallJob(ctxAt(at(day.date, '22:46')), payload, {} as never);
    expect(await calls(day.id)).toEqual([]);
    expect((await skipsOf(day.id))[0]).toMatchObject({ reason: 'stale_stage', message: null });
  });
});

describe('place_call on LiveKit (a real org with a trunk, §19 Q125–Q127)', () => {
  async function asRealOrgWithTrunk<T>(fn: () => Promise<T>): Promise<T> {
    await pg.q(`update orgs set is_demo = false where id = $1`, [KESTREL]);
    await pg.q(
      `select set_country_endpoints('US', null, '+15550142290', null, null, 'ST_testTrunk1')`,
    );
    try {
      return await fn();
    } finally {
      await pg.q(`select set_country_endpoints('US', null, null, null, null, null)`);
      await pg.q(`update orgs set is_demo = true where id = $1`, [KESTREL]);
    }
  }

  it('dials on the pack trunk with the pack number as caller id; busy → missed_call', async () => {
    const day = await freshDay();
    const payload = await claim(day.id, 'reminder_1');
    livekit.next = { kind: 'unanswered', status: 'busy', reason: 'sip_486' };
    await asRealOrgWithTrunk(() =>
      placeCallJob(ctxAt(at(day.date, '22:46')), payload, {} as never),
    );
    const [call] = await calls(day.id);
    expect(livekit.dials).toEqual([
      {
        callId: call!.id,
        room: `call-${call!.id}`,
        to: KEVIN_PHONE,
        from: '+15550142290',
        trunkId: 'ST_testTrunk1',
      },
    ]);
    expect(call).toMatchObject({ status: 'busy', outcome: 'not_reached' });
    expect(await job(`notify:missed_call:${call!.id}`)).toBeTruthy();
  });

  it('a dial that failed before ringing sends R1 by text, not "missed you"', async () => {
    const day = await freshDay();
    const payload = await claim(day.id, 'reminder_1');
    livekit.next = { kind: 'unanswered', status: 'failed', reason: 'livekit_503' };
    await asRealOrgWithTrunk(() =>
      placeCallJob(ctxAt(at(day.date, '22:46')), payload, {} as never),
    );
    const [call] = await calls(day.id);
    expect(call).toMatchObject({ status: 'failed', outcome: 'not_reached' });
    expect(await job(`notify:missed_call:${call!.id}`)).toBeUndefined();
    expect(await job(`notify:reminder_1:${day.id}:${KEVIN}`)).toBeTruthy();
  });

  it('no capacity: waits a minute, then gives up into R1 by text (§19 Q127)', async () => {
    const day = await freshDay();
    const payload = await claim(day.id, 'reminder_1');
    // Four calls already open (the default VOICE_MAX_CONCURRENT_CALLS).
    for (let i = 0; i < 4; i++) {
      await pg.q(
        `insert into calls (org_id, direction, transport, status) values ($1, 'inbound', 'pstn', 'in_progress')`,
        [KESTREL],
      );
    }
    const now = at(day.date, '22:46');
    try {
      await asRealOrgWithTrunk(async () => {
        await placeCallJob(
          ctxAt(now),
          { ...payload, giveUpAt: at(day.date, '23:15').toISOString() } as never,
          {} as never,
        );
        const wait = await job<JobPayloads['place_call']>(`call:${day.id}:${KEVIN}:reminder_1:w1`);
        expect(wait!.payload).toMatchObject({ stage: 'reminder_1', wait: 1 });
        // At 18:15 (the give-up time) still full: R1 by text, audited.
        await placeCallJob(ctxAt(at(day.date, '23:15')), wait!.payload, {} as never);
      });
    } finally {
      await pg.q(`update calls set ended_at = now() where org_id = $1 and ended_at is null`, [
        KESTREL,
      ]);
    }
    expect(livekit.dials).toEqual([]);
    expect(await calls(day.id)).toEqual([]);
    expect((await skipsOf(day.id)).map((s) => [s.reason, s.message])).toEqual([
      ['capacity', 'reminder_1'],
    ]);
  });

  it('an answered call is the agent’s: no text', async () => {
    const day = await freshDay();
    const payload = await claim(day.id, 'reminder_1');
    await asRealOrgWithTrunk(() =>
      placeCallJob(ctxAt(at(day.date, '22:46')), payload, {} as never),
    );
    const [call] = await calls(day.id);
    expect(call!.status).toBe('ringing');
    expect(await job(`notify:missed_call:${call!.id}`)).toBeUndefined();
  });
});

describe('a voicemail greeting (F6 step 1) and the callback (§19 Q128)', () => {
  it('the agent ends not_reached as a machine: voicemail, then missed_call', async () => {
    const day = await freshDay();
    const payload = await claim(day.id, 'reminder_1');
    await placeCallJob(ctxAt(at(day.date, '22:46')), payload, {} as never);
    const [call] = await calls(day.id);
    await pg.q(
      `select voice_call_end($1, 'not_reached', '[]'::jsonb, '{"answeredBy":"machine","turns":0}'::jsonb)`,
      [call!.id],
    );
    expect((await calls(day.id))[0]).toMatchObject({ status: 'voicemail', outcome: 'not_reached' });
    // No post-call job (nothing was said); the missed step instead.
    expect(await job(`post_call:${call!.id}`)).toBeUndefined();
    const step = await job<JobPayloads['place_call']>(`call_missed:${call!.id}`);
    await placeCallJob(ctxAt(at(day.date, '22:47')), step!.payload, {} as never);
    expect(await job(`notify:missed_call:${call!.id}`)).toBeTruthy();
  });

  it('"call me back in half an hour": one delayed call (attempt 3), a second is refused', async () => {
    const day = await freshDay();
    // An inbound call of Kevin's on that day.
    const [c] = await pg.q<{ id: string }>(
      `insert into calls (org_id, reporter_id, site_id, site_day_id, direction, transport, status)
       values ($1, $2, $3, $4, 'inbound', 'pstn', 'in_progress') returning id`,
      [KESTREL, KEVIN, NORTHGATE, day.id],
    );
    const when = at(day.date, '23:15');
    const [first] = await pg.q<{ r: { status: string } }>(
      `select voice_schedule_callback($1, $2::timestamptz, 30) as r`,
      [c!.id, when.toISOString()],
    );
    expect(first!.r.status).toBe('scheduled');
    const [again] = await pg.q<{ r: { status: string } }>(
      `select voice_schedule_callback($1, $2::timestamptz, 30) as r`,
      [c!.id, when.toISOString()],
    );
    expect(again!.r.status).toBe('limit_reached');
    const cb = await job<JobPayloads['place_call']>(`call:${day.id}:${KEVIN}:callback`);
    expect(cb!.payload).toMatchObject({ stage: 'callback', requestedOn: c!.id });
    expect(Date.parse(cb!.run_after)).toBe(when.getTime());
    await pg.q(`update calls set ended_at = now(), outcome = 'callback_requested' where id = $1`, [
      c!.id,
    ]);
    await placeCallJob(ctxAt(when), cb!.payload, {} as never);
    expect((await calls(day.id)).filter((x) => x.direction === 'outbound')).toEqual([
      expect.objectContaining({ attempt: 3, purpose: 'callback', status: 'ringing' }),
    ]);
  });
});
