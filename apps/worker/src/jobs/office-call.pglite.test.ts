import { randomUUID } from 'node:crypto';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  OFFICE_CALL_POLICY,
  createConsoleSmsTransport,
  type JobPayloads,
  type OfficeCallStart,
} from '@sitelog/shared';
import { DEMO_USERS } from '@sitelog/shared/demo/kestrel.ts';
import { demoId } from '@sitelog/shared/demo/ids.ts';
import { testConfig } from '../config';
import { createMetrics, type Ctx } from '../context';
import { silentLogger } from '../log';
import { createWorkerNotifier } from '../messaging';
import type { DialInput, DialResult, Telephony, TelephonyRegistry } from '../telephony';
import { createConsoleTelephony } from '../telephony';
import { startPgliteDatabase, type PgliteDatabase } from '../test/pglite';
import { placeCallJob } from './place_call';

/**
 * W4-04 on PGlite (spec F3 edge cases, P10, §19 Q131, Q230): Team's Call now through the same
 * `place_call` job and telephony as the ladder. Lena Ortiz (admin) attests that Aisha Bello agreed
 * to calls and calls her now: office_call_start() as Lena (the panel's RPC), then the job.
 *
 * - console telephony (Kestrel is a demo org): the Demo phone rings, nobody answers, the call
 *   ends `no_answer` / `not_reached` and no text goes to Aisha (no `missed_call`, no R1 text);
 *   the `calls` row is what Team shows;
 * - the attestation never serves the ladder: that night's R1 for Aisha is refused without her own
 *   `auto_call` (§19 Q131);
 * - a dial outside the call window ends the call `failed`, audited, no text;
 * - LiveKit (a real org with a trunk): dialled on the pack trunk; busy leaves no text either.
 *
 * office_call_start() reads the database clock, so the org's call window is set around now.
 */

let pg: PgliteDatabase;
const LENA = DEMO_USERS[0]!.id;
const AISHA = demoId('reporter:aisha');
const HILLCREST = demoId('site:hillcrest');
const AISHA_PHONE = '+15550149932';
let KESTREL = '';

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

function ctxAt(now: Date): Ctx {
  const config = testConfig({
    LINK_SIGNING_SECRET: 'office-call-link-secret',
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
  } as unknown as Ctx;
}

/** office_call_start() as Lena, the panel's call (RLS role, her JWT claims). */
async function callNowAsLena(): Promise<OfficeCallStart> {
  const claims = JSON.stringify({ sub: LENA, role: 'authenticated', email: 'lena@test' });
  await pg.pg.exec(`
    set role authenticated;
    select set_config('request.jwt.claim.sub', '${LENA}', false);
    select set_config('request.jwt.claim.role', 'authenticated', false);
    select set_config('request.jwt.claims', '${claims}', false);
  `);
  try {
    const [row] = await pg.q<{ r: OfficeCallStart }>(
      `select office_call_start($1, $2, $3, true) as r`,
      [AISHA, HILLCREST, OFFICE_CALL_POLICY.attestVersion],
    );
    return row!.r;
  } finally {
    await pg.pg.exec(`
      reset role;
      select set_config('request.jwt.claim.sub', '', false);
      select set_config('request.jwt.claim.role', '', false);
      select set_config('request.jwt.claims', '', false);
    `);
  }
}

async function requested(): Promise<{ callId: string; siteDayId: string }> {
  const res = await callNowAsLena();
  if (res.status !== 'requested') throw new Error(`refused: ${res.reason}`);
  return res;
}

async function job<T = Record<string, unknown>>(key: string) {
  const [row] = await pg.q<{ payload: T; run_after: string }>(
    `select payload, run_after from jobs where dedupe_key = $1`,
    [key],
  );
  return row;
}

async function officeJob(callId: string): Promise<JobPayloads['place_call']> {
  const [row] = await pg.q<{ payload: JobPayloads['place_call'] }>(
    `select payload from jobs where type = 'place_call' and payload->>'callId' = $1
        and payload->>'phase' = 'office'`,
    [callId],
  );
  expect(row, 'office_call_start() queued the call').toBeTruthy();
  return row!.payload;
}

const call = async (id: string) =>
  (
    await pg.q<{ status: string; outcome: string | null; attempt: number | null; purpose: string }>(
      `select status::text, outcome::text, attempt, purpose from calls where id = $1`,
      [id],
    )
  )[0]!;

/** Every text job for Aisha's day (a missed_call or R1 text would be one). */
const textsFor = (siteDayId: string, callId: string) =>
  pg.q<{ dedupe_key: string }>(
    `select dedupe_key from jobs where type = 'notify' and payload->>'reporterId' = $1
        and (dedupe_key like $2 or dedupe_key like $3)`,
    [AISHA, `%${siteDayId}%`, `%${callId}%`],
  );

beforeAll(async () => {
  pg = await startPgliteDatabase({ seed: true });
  const [org] = await pg.q<{ org_id: string }>(`select org_id from sites where id = $1`, [
    HILLCREST,
  ]);
  KESTREL = org!.org_id;
  // The call window around now at Hillcrest (the RPC reads the database clock).
  await pg.q(
    `update org_settings set
       call_window_start = ((now() at time zone s.timezone) - interval '1 hour')::time,
       call_window_end = ((now() at time zone s.timezone) + interval '1 hour')::time
     from sites s where s.id = $1 and org_settings.org_id = s.org_id`,
    [HILLCREST],
  );
  await pg.q(`update reporters set status = 'active', no_calls_until = null where id = $1`, [
    AISHA,
  ]);
});

beforeEach(() => {
  livekit = new FakeLiveKit();
});

afterEach(async () => {
  await pg.q(
    `update calls set ended_at = now(), status = 'completed' where reporter_id = $1 and ended_at is null`,
    [AISHA],
  );
  // A fresh start for the next test: today's office calls and their jobs (keys count the calls).
  await pg.q(
    `delete from calls where reporter_id = $1 and purpose = 'daily_report' and direction = 'outbound'`,
    [AISHA],
  );
  await pg.q(`delete from jobs where dedupe_key like $1`, [`call:%:${AISHA}:office:%`]);
});

afterAll(async () => {
  await pg?.close();
});

describe('Call now on the console telephony (a demo org, §19 Q132, Q230)', () => {
  it('rings the Demo phone; unanswered it ends not_reached and nothing is texted', async () => {
    const res = await requested();
    const now = new Date();
    await placeCallJob(ctxAt(now), await officeJob(res.callId), {} as never);
    expect(await call(res.callId)).toMatchObject({
      status: 'ringing',
      purpose: 'daily_report',
      attempt: null,
    });

    const ring = await job<JobPayloads['place_call']>(`call_ring:${res.callId}`);
    expect(ring!.payload).toEqual({ phase: 'ring_end', callId: res.callId });
    await placeCallJob(ctxAt(now), ring!.payload, {} as never);
    expect(await call(res.callId)).toMatchObject({ status: 'no_answer', outcome: 'not_reached' });
    // §19 Q230: no missed_call, no R1 text; the office sees the outcome on Team.
    expect(await job(`notify:missed_call:${res.callId}`)).toBeUndefined();
    expect(await textsFor(res.siteDayId, res.callId)).toEqual([]);

    // A voicemail end through voice_call_end()'s missed step leaves no text either.
    await placeCallJob(ctxAt(now), { phase: 'missed', callId: res.callId }, {} as never);
    expect(await textsFor(res.siteDayId, res.callId)).toEqual([]);

    // The consent row: office_attested with Lena as the attester.
    const [consent] = await pg.q<{ method: string; evidence: { user_id: string } }>(
      `select method, evidence from consents where reporter_id = $1 and type = 'auto_call'
          and evidence->>'call_id' = $2`,
      [AISHA, res.callId],
    );
    expect(consent).toMatchObject({ method: 'office_attested', evidence: { user_id: LENA } });
  });

  it('that night’s R1 for Aisha is refused without her own auto_call (§19 Q131)', async () => {
    await pg.q(
      `update consents set revoked_at = now() where reporter_id = $1 and type = 'auto_call'
          and method <> 'office_attested' and revoked_at is null`,
      [AISHA],
    );
    try {
      // With her own consent off, the office cannot call her either (§19 Q230).
      expect(await callNowAsLena()).toEqual({ status: 'refused', reason: 'calls_turned_off' });
      // The office attestation of the call before is held; the ladder still refuses R1.
      const [sd] = await pg.q<{ id: string }>(
        `insert into site_days (site_id, date, deadline_at) values ($1, '2031-07-07', '2031-07-07T22:30:00Z')
         returning id`,
        [HILLCREST],
      );
      await pg.q(
        `select claim_site_day_reminder($1, 'reminder_1', '[]'::jsonb, '[]'::jsonb, null, $2::jsonb)`,
        [sd!.id, JSON.stringify([{ reporterId: AISHA, giveUpAt: null }])],
      );
      const r1 = await job<JobPayloads['place_call']>(`call:${sd!.id}:${AISHA}:reminder_1`);
      await pg.q(
        `update org_settings set call_window_start = '00:00', call_window_end = '23:59'
          where org_id = $1`,
        [KESTREL],
      );
      await placeCallJob(ctxAt(new Date('2031-07-07T22:46:00Z')), r1!.payload, {} as never);
      const [skip] = await pg.q<{ diff: { reason: string } }>(
        `select diff from audit_log where action = 'call.skipped' and diff->>'site_day_id' = $1`,
        [sd!.id],
      );
      expect(skip!.diff.reason).toBe('no_consent');
      const placed = await pg.q(`select id from calls where site_day_id = $1`, [sd!.id]);
      expect(placed).toEqual([]);
    } finally {
      await pg.q(
        `update consents set revoked_at = null where reporter_id = $1 and type = 'auto_call'
            and method <> 'office_attested'`,
        [AISHA],
      );
      await pg.q(
        `update org_settings set
           call_window_start = ((now() at time zone s.timezone) - interval '1 hour')::time,
           call_window_end = ((now() at time zone s.timezone) + interval '1 hour')::time
         from sites s where s.id = $1 and org_settings.org_id = s.org_id`,
        [HILLCREST],
      );
    }
  });

  it('a dial outside the call window ends the call failed, audited, and texts nothing', async () => {
    const res = await requested();
    const later = new Date(Date.now() + 6 * 3_600_000);
    await placeCallJob(ctxAt(later), await officeJob(res.callId), {} as never);
    expect(await call(res.callId)).toMatchObject({ status: 'failed', outcome: 'not_reached' });
    const [skip] = await pg.q<{ diff: Record<string, unknown> }>(
      `select diff from audit_log where action = 'call.skipped' and diff->>'call_id' = $1`,
      [res.callId],
    );
    expect(skip!.diff).toMatchObject({ stage: 'office', reason: 'outside_window' });
    expect(await textsFor(res.siteDayId, res.callId)).toEqual([]);
  });
});

describe('Call now on LiveKit (a real org with a trunk)', () => {
  it('dials on the pack trunk with the pack number; busy leaves no text', async () => {
    await pg.q(`update orgs set is_demo = false where id = $1`, [KESTREL]);
    await pg.q(
      `select set_country_endpoints('US', null, '+15550142290', null, null, 'ST_testTrunk1')`,
    );
    try {
      const res = await requested();
      livekit.next = { kind: 'unanswered', status: 'busy', reason: 'sip_486' };
      await placeCallJob(ctxAt(new Date()), await officeJob(res.callId), {} as never);
      expect(livekit.dials).toEqual([
        {
          callId: res.callId,
          room: `call-${res.callId}`,
          to: AISHA_PHONE,
          from: '+15550142290',
          trunkId: 'ST_testTrunk1',
        },
      ]);
      expect(await call(res.callId)).toMatchObject({ status: 'busy', outcome: 'not_reached' });
      expect(await textsFor(res.siteDayId, res.callId)).toEqual([]);
    } finally {
      await pg.q(`select set_country_endpoints('US', null, null, null, null, null)`);
      await pg.q(`update orgs set is_demo = true where id = $1`, [KESTREL]);
    }
  });
});
