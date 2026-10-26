import { randomUUID } from 'node:crypto';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  createConsoleSmsTransport,
  settingsTestCallKey,
  type JobPayloads,
  type SettingsTestCallStart,
} from '@sitelog/shared';
import { DEMO_USERS } from '@sitelog/shared/demo/kestrel.ts';
import { testConfig } from '../config';
import { createMetrics, type Ctx } from '../context';
import { silentLogger } from '../log';
import { createWorkerNotifier } from '../messaging';
import type { DialInput, DialResult, Telephony, TelephonyRegistry } from '../telephony';
import { createConsoleTelephony } from '../telephony';
import { startPgliteDatabase, type PgliteDatabase } from '../test/pglite';
import { placeCallJob } from './place_call';

/**
 * W4-05 on PGlite (spec P12, §19 Q232, Q350): Settings' Call me now through the same `place_call`
 * job and telephony as the ladder and Team's Call now. Lena Ortiz (admin of Kestrel) asks for a
 * test call to her own number: settings_test_call_start() as Lena (the panel's RPC), then the job.
 *
 * - console telephony (Kestrel is a demo org): the call rings nowhere real, ends `no_answer` /
 *   `not_reached`, and no text goes to anyone; the number is gone from the row once dialled;
 * - LiveKit (a real org with a trunk): dialled on the pack's trunk with the pack's number;
 * - no LiveKit in this environment, or a request left too long: the call ends `failed` with its
 *   reason, audited, and the number is blanked.
 */

let pg: PgliteDatabase;
const LENA = DEMO_USERS[0]!.id;
const LENA_PHONE = '+15550143378';
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

let livekit: FakeLiveKit | null;

function ctxAt(now: Date): Ctx {
  const config = testConfig({ VOICE_MAX_CONCURRENT_CALLS: 4 });
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

/** settings_test_call_start() as Lena, the panel's call (RLS role, her JWT claims). */
async function callMeNowAsLena(language = 'en'): Promise<SettingsTestCallStart> {
  const claims = JSON.stringify({ sub: LENA, role: 'authenticated', email: 'lena@test' });
  await pg.pg.exec(`
    set role authenticated;
    select set_config('request.jwt.claim.sub', '${LENA}', false);
    select set_config('request.jwt.claim.role', 'authenticated', false);
    select set_config('request.jwt.claims', '${claims}', false);
  `);
  try {
    const [row] = await pg.q<{ r: SettingsTestCallStart }>(
      `select settings_test_call_start($1, $2, $3, true) as r`,
      [KESTREL, LENA_PHONE, language],
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

async function requested(): Promise<string> {
  const res = await callMeNowAsLena();
  if (res.status !== 'requested') throw new Error(`refused: ${res.reason}`);
  return res.callId;
}

async function testJob(callId: string): Promise<JobPayloads['place_call']> {
  const [row] = await pg.q<{ payload: JobPayloads['place_call'] }>(
    `select payload from jobs where dedupe_key = $1`,
    [settingsTestCallKey(callId)],
  );
  expect(row, 'settings_test_call_start() queued the call').toBeTruthy();
  return row!.payload;
}

const call = async (id: string) =>
  (
    await pg.q<{
      status: string;
      outcome: string | null;
      reporter_id: string | null;
      to_e164: string | null;
      purpose: string;
      language: string;
      metrics: Record<string, unknown>;
    }>(
      `select status::text, outcome::text, reporter_id, to_e164, purpose, language, metrics
         from calls where id = $1`,
      [id],
    )
  )[0]!;

const textsAbout = (callId: string) =>
  pg.q<{ dedupe_key: string }>(
    `select dedupe_key from jobs where type = 'notify' and dedupe_key like $1`,
    [`%${callId}%`],
  );

beforeAll(async () => {
  pg = await startPgliteDatabase({ seed: true });
  const [org] = await pg.q<{ id: string }>(
    `select org_id as id from org_members where user_id = $1`,
    [LENA],
  );
  KESTREL = org!.id;
});

beforeEach(() => {
  livekit = new FakeLiveKit();
});

afterEach(async () => {
  // One test call at a time per org: close what a test left open, and the hour's budget.
  await pg.q(
    `update calls set ended_at = now(), status = 'completed'
      where org_id = $1 and purpose = 'settings_test' and ended_at is null`,
    [KESTREL],
  );
  await pg.q(`delete from audit_log where org_id = $1 and action = 'settings.test_call'`, [
    KESTREL,
  ]);
});

afterAll(async () => {
  await pg?.close();
});

describe('Call me now on the console telephony (a demo org, §19 Q132, Q232)', () => {
  it('rings nowhere real; unanswered it ends not_reached, nothing is texted, no number kept', async () => {
    const id = await requested();
    expect(await call(id)).toMatchObject({
      status: 'queued',
      purpose: 'settings_test',
      reporter_id: null,
      to_e164: LENA_PHONE,
      language: 'en-US',
      metrics: { telephony: 'console', stage: 'settings_test', to_masked: '+1555***378' },
    });
    expect(await testJob(id)).toEqual({ phase: 'settings_test', callId: id });

    const now = new Date();
    await placeCallJob(ctxAt(now), await testJob(id), {} as never);
    expect(await call(id)).toMatchObject({ status: 'ringing', to_e164: null });

    const [ring] = await pg.q<{ payload: JobPayloads['place_call'] }>(
      `select payload from jobs where dedupe_key = $1`,
      [`call_ring:${id}`],
    );
    expect(ring!.payload).toEqual({ phase: 'ring_end', callId: id });
    await placeCallJob(ctxAt(now), ring!.payload, {} as never);
    expect(await call(id)).toMatchObject({ status: 'no_answer', outcome: 'not_reached' });
    // A voicemail end through voice_call_end()'s missed step texts nobody either.
    await placeCallJob(ctxAt(now), { phase: 'missed', callId: id }, {} as never);
    expect(await textsAbout(id)).toEqual([]);

    // The audit has the number masked only.
    const rows = await pg.q<{ action: string; diff: Record<string, unknown> }>(
      `select action, diff from audit_log
        where org_id = $1 and (entity_id = $2::uuid or diff->>'call_id' = $2::text)
        order by id`,
      [KESTREL, id],
    );
    expect(rows.map((r) => r.action)).toEqual(
      expect.arrayContaining(['settings.test_call', 'call.requested', 'call.ended']),
    );
    expect(JSON.stringify(rows)).not.toContain(LENA_PHONE);
    expect(rows.find((r) => r.action === 'settings.test_call')!.diff).toMatchObject({
      to: '+1555***378',
      telephony: 'console',
      language: 'en',
    });
  });

  it('a second request while the first is live is refused call_live', async () => {
    await requested();
    expect(await callMeNowAsLena()).toEqual({ status: 'refused', reason: 'call_live' });
  });
});

describe('Call me now on LiveKit (a real org with a trunk)', () => {
  it('dials on the pack trunk with the pack number; the agent takes it from there', async () => {
    await pg.q(`update orgs set is_demo = false where id = $1`, [KESTREL]);
    await pg.q(
      `select set_country_endpoints('US', null, '+15550142290', null, null, 'ST_testTrunk1')`,
    );
    try {
      const id = await requested();
      await placeCallJob(ctxAt(new Date()), await testJob(id), {} as never);
      expect(livekit!.dials).toEqual([
        {
          callId: id,
          room: `call-${id}`,
          to: LENA_PHONE,
          from: '+15550142290',
          trunkId: 'ST_testTrunk1',
        },
      ]);
      expect(await call(id)).toMatchObject({
        status: 'ringing',
        to_e164: null,
        metrics: { telephony: 'livekit' },
      });
    } finally {
      await pg.q(`select set_country_endpoints('US', null, null, null, null, null)`);
      await pg.q(`update orgs set is_demo = true where id = $1`, [KESTREL]);
    }
  });

  it('without LiveKit here, the call ends failed telephony_unavailable, number blanked', async () => {
    await pg.q(`update orgs set is_demo = false where id = $1`, [KESTREL]);
    await pg.q(
      `select set_country_endpoints('US', null, '+15550142290', null, null, 'ST_testTrunk1')`,
    );
    livekit = null;
    try {
      const id = await requested();
      await placeCallJob(ctxAt(new Date()), await testJob(id), {} as never);
      expect(await call(id)).toMatchObject({
        status: 'failed',
        outcome: 'not_reached',
        to_e164: null,
        metrics: { unanswered: 'telephony_unavailable' },
      });
    } finally {
      await pg.q(`select set_country_endpoints('US', null, null, null, null, null)`);
      await pg.q(`update orgs set is_demo = true where id = $1`, [KESTREL]);
    }
  });

  it('a request the worker reaches after ten minutes is dropped as stale', async () => {
    const id = await requested();
    await pg.q(`update calls set created_at = now() - interval '11 minutes' where id = $1`, [id]);
    await placeCallJob(ctxAt(new Date()), await testJob(id), {} as never);
    expect(await call(id)).toMatchObject({
      status: 'failed',
      outcome: 'not_reached',
      to_e164: null,
      metrics: { unanswered: 'stale' },
    });
  });
});
