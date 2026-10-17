import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import type { PGlite } from '@electric-sql/pglite';
import { DEMO_ORG_ID, DEMO_USERS } from '@sitelog/shared/demo/kestrel.ts';
import { demoId } from '@sitelog/shared/demo/ids.ts';
import { OFFICE_CALL_POLICY } from '@sitelog/shared/voice-outbound.ts';
import { asService, asUser, bootDatabase } from './harness.ts';

/**
 * W4-04 (20261017000500_office_call_now.sql; spec F3 edge cases, P10, §19 Q131, Q230, Q330):
 * Team's Call now. office_call_start() for admin and ops of the reporter's org only; the
 * attestation stored as an `auto_call` consent `office_attested` with the office user, audited;
 * the `calls` row (`daily_report`, no ladder attempt) and its `place_call {phase: office}` job;
 * each refusal (no attestation, no calls placed, the reporter's own "off", "not today", the call
 * window, a filed day, a live call, the day's limit) writes nothing; the ladder still ignores the
 * attestation (§19 Q131); Settings' Turn on stores the reporter's own consent beside it;
 * office_call_dial() (the worker's last check).
 *
 * Lena Ortiz (admin) calls Aisha Bello (Hillcrest, Kestrel: a demo org, so the `console`
 * telephony). The call window is set around "now" at the site, since the RPC reads the clock.
 */

const LENA = DEMO_USERS[0]!.id;
const SAM = DEMO_USERS[1]!.id; // pm
const ACCOUNTS = DEMO_USERS[2]!.id;
const OPS = 'eeeeeeee-0404-4404-8404-000000000001';
const OUTSIDER = 'eeeeeeee-0404-4404-8404-000000000002';
const AISHA = demoId('reporter:aisha');
const HILLCREST = demoId('site:hillcrest');
const VERSION = OFFICE_CALL_POLICY.attestVersion;

let db: PGlite;

async function svc<T = Record<string, unknown>>(sql: string, params: unknown[] = []) {
  return (await asService(db, (q) => q<T>(sql, params))).rows;
}

type Answer = { status: string; reason?: string; callId?: string; siteDayId?: string };

async function callNow(user: string, attested = true, site = HILLCREST): Promise<Answer> {
  return asUser(
    db,
    user,
    async (q) =>
      (
        await q<{ r: Answer }>(`select office_call_start($1, $2, $3, $4) as r`, [
          AISHA,
          site,
          VERSION,
          attested,
        ])
      ).rows[0]!.r,
  );
}

async function failure(user: string): Promise<string | null> {
  try {
    await callNow(user);
    return null;
  } catch (err) {
    return (err as { code?: string }).code ?? (err as Error).message;
  }
}

/** The call window from `fromH` to `toH` hours around now at Hillcrest. */
async function windowAround(fromH: number, toH: number) {
  await svc(
    `update org_settings set
       call_window_start = ((now() at time zone s.timezone) + make_interval(hours => $2::int))::time,
       call_window_end = ((now() at time zone s.timezone) + make_interval(hours => $3::int))::time
     from sites s where s.id = $1 and org_settings.org_id = s.org_id`,
    [HILLCREST, fromH, toH],
  );
}

const counts = async () =>
  (
    await svc<{ calls: number; consents: number; jobs: number }>(
      `select (select count(*)::int from calls where reporter_id = $1 and purpose = 'daily_report' and direction = 'outbound') as calls,
              (select count(*)::int from consents where reporter_id = $1 and method = 'office_attested') as consents,
              (select count(*)::int from jobs where type = 'place_call' and payload->>'phase' = 'office') as jobs`,
      [AISHA],
    )
  )[0]!;

/** Ends every open call of Aisha (as a finished call would). */
const endCalls = () =>
  svc(
    `update calls set ended_at = now(), status = 'completed' where reporter_id = $1 and ended_at is null`,
    [AISHA],
  );

beforeAll(async () => {
  db = await bootDatabase({ seed: true });
  await svc(
    `insert into auth.users (id, email) values ($1, 'ops@kestrel.test'), ($2, 'x@other.test')`,
    [OPS, OUTSIDER],
  );
  await svc(`insert into org_members (org_id, user_id, role) values ($1, $2, 'ops')`, [
    DEMO_ORG_ID,
    OPS,
  ]);
  await svc(`update reporters set status = 'active', no_calls_until = null where id = $1`, [AISHA]);
  await windowAround(-1, 1);
});

afterEach(async () => {
  await endCalls();
  await windowAround(-1, 1);
});

describe('office_call_start() (W4-04, §19 Q230)', () => {
  it('is admin and ops of the reporter’s org only', async () => {
    expect(await failure(SAM)).toBe('42501');
    expect(await failure(ACCOUNTS)).toBe('42501');
    expect(await failure(OUTSIDER)).toBe('42501');
    expect(await counts()).toEqual({ calls: 0, consents: 0, jobs: 0 });
  });

  it('refuses without the attestation and writes nothing', async () => {
    expect(await callNow(LENA, false)).toEqual({
      status: 'refused',
      reason: 'attestation_required',
    });
    expect(await counts()).toEqual({ calls: 0, consents: 0, jobs: 0 });
  });

  it('Lena attests and calls Aisha: the consent, the call row, its job, all audited', async () => {
    const res = await callNow(LENA);
    expect(res.status).toBe('requested');
    const callId = res.callId!;

    const [consent] = await svc<{
      type: string;
      method: string;
      text_version: string;
      evidence: Record<string, unknown>;
      revoked_at: string | null;
    }>(
      `select type::text, method, text_version, evidence, revoked_at from consents
        where reporter_id = $1 and method = 'office_attested'`,
      [AISHA],
    );
    expect(consent).toMatchObject({
      type: 'auto_call',
      method: 'office_attested',
      text_version: VERSION,
      revoked_at: null,
      evidence: { user_id: LENA, via: 'office', call_id: callId },
    });

    const [call] = await svc<Record<string, unknown>>(
      `select direction::text, transport::text, purpose, attempt, status::text, provider_call_id,
              site_id, site_day_id, metrics from calls where id = $1`,
      [callId],
    );
    expect(call).toMatchObject({
      direction: 'outbound',
      transport: 'pstn',
      purpose: 'daily_report',
      attempt: null,
      status: 'queued',
      provider_call_id: `call-${callId}`,
      site_id: HILLCREST,
      site_day_id: res.siteDayId,
      metrics: { telephony: 'console', stage: 'office', via: 'office', requested_by: LENA },
    });

    const [job] = await svc<{ dedupe_key: string; payload: unknown }>(
      `select dedupe_key, payload from jobs where type = 'place_call' and payload->>'callId' = $1`,
      [callId],
    );
    expect(job).toEqual({
      dedupe_key: `call:${res.siteDayId}:${AISHA}:office:1`,
      payload: { phase: 'office', callId },
    });

    const audits = await svc<{ action: string; actor_id: string; diff: Record<string, unknown> }>(
      `select action, actor_id, diff from audit_log
        where action in ('consent.given', 'call.requested') and (entity_id = $1::uuid or diff->>'call_id' = $1::text)
        order by id`,
      [callId],
    );
    expect(audits.map((a) => [a.action, a.actor_id, a.diff.via])).toEqual([
      ['consent.given', LENA, 'office'],
      ['call.requested', LENA, 'office'],
    ]);
    expect(audits[0]!.diff).toMatchObject({ type: 'auto_call', method: 'office_attested' });
    // No phone number in the audit rows.
    expect(JSON.stringify(audits)).not.toContain('+1555');
  });

  it('refuses a second call while one is live, then counts the day’s office calls (Q330)', async () => {
    const first = await callNow(OPS);
    expect(first.status).toBe('requested');
    expect(await callNow(OPS)).toEqual({ status: 'refused', reason: 'call_live' });
    await endCalls();
    // The earlier test's call and this one: the day's limit is three.
    const third = await callNow(OPS);
    expect(third.status).toBe('requested');
    const [job] = await svc<{ dedupe_key: string }>(
      `select dedupe_key from jobs where payload->>'callId' = $1`,
      [third.callId],
    );
    expect(job!.dedupe_key).toBe(`call:${third.siteDayId}:${AISHA}:office:3`);
    await endCalls();
    expect(await callNow(OPS)).toEqual({ status: 'refused', reason: 'limit_reached' });
    // The limit is per site-day: tomorrow's calls start again (cleared here instead).
    await svc(
      `delete from calls where reporter_id = $1 and purpose = 'daily_report' and direction = 'outbound'`,
      [AISHA],
    );
  });

  it('refuses outside the call window at the site', async () => {
    await windowAround(2, 3);
    const before = await counts();
    expect(await callNow(LENA)).toEqual({ status: 'refused', reason: 'outside_window' });
    expect(await counts()).toEqual(before);
  });

  it('refuses when today is filed', async () => {
    const res = await callNow(LENA);
    await endCalls();
    await svc(`update site_days set status = 'filed' where id = $1`, [res.siteDayId]);
    expect(await callNow(LENA)).toEqual({ status: 'refused', reason: 'day_filed' });
    await svc(`update site_days set status = 'pending' where id = $1`, [res.siteDayId]);
    await svc(
      `delete from calls where reporter_id = $1 and purpose = 'daily_report' and direction = 'outbound'`,
      [AISHA],
    );
  });

  it('refuses "Don’t call me today", a disabled reporter and calls they turned off', async () => {
    await svc(`update reporters set no_calls_until = now() + interval '2 hours' where id = $1`, [
      AISHA,
    ]);
    expect(await callNow(LENA)).toEqual({ status: 'refused', reason: 'no_calls_today' });
    await svc(`update reporters set no_calls_until = null, status = 'disabled' where id = $1`, [
      AISHA,
    ]);
    expect(await callNow(LENA)).toEqual({ status: 'refused', reason: 'reporter_inactive' });
    await svc(`update reporters set status = 'active' where id = $1`, [AISHA]);

    // Settings' Turn off (her own consent revoked): the office cannot override it.
    await svc(
      `update consents set revoked_at = now() where reporter_id = $1 and type = 'auto_call'
          and method <> 'office_attested' and revoked_at is null`,
      [AISHA],
    );
    expect(await callNow(LENA)).toEqual({ status: 'refused', reason: 'calls_turned_off' });
  });

  it('refuses where the org places no calls', async () => {
    await svc(`update orgs set is_demo = false where id = $1`, [DEMO_ORG_ID]);
    try {
      expect(await callNow(LENA)).toEqual({ status: 'refused', reason: 'no_trunk' });
    } finally {
      await svc(`update orgs set is_demo = true where id = $1`, [DEMO_ORG_ID]);
    }
  });
});

describe('the attestation and the ladder (§19 Q131)', () => {
  it('R1 is still refused without her own auto_call; Turn on stores hers beside it', async () => {
    // Her own consent is off (the test above); the office attests and calls her now.
    await svc(
      `update consents set revoked_at = now() where reporter_id = $1 and type = 'auto_call' and revoked_at is null`,
      [AISHA],
    );
    await svc(
      `insert into consents (reporter_id, type, method, text_version, evidence)
       values ($1, 'auto_call', 'office_attested', $2, jsonb_build_object('user_id', $3::text))`,
      [AISHA, VERSION, LENA],
    );
    const [day] = await svc<{ id: string }>(
      `insert into site_days (site_id, date, deadline_at) values ($1, '2031-06-02', '2031-06-02T22:30:00Z')
       returning id`,
      [HILLCREST],
    );
    const [r1] = await svc<{ r: { status: string; reason: string } }>(
      `select outbound_call_start($1, $2, 'reminder_1', '2031-06-02T22:46:00Z', 'console') as r`,
      [AISHA, day!.id],
    );
    expect(r1!.r).toEqual({ status: 'skipped', reason: 'no_consent' });

    // Settings' Turn on: the office's attestation does not stand in for her own consent.
    const [device] = await svc<{ id: string }>(
      `select id from field_devices where reporter_id = $1 limit 1`,
      [AISHA],
    );
    const [granted] = await svc<{ r: { granted: boolean } }>(
      `select field_grant_consent($1, 'auto_call', 'demo-1', $2, '{}'::jsonb) as r`,
      [AISHA, device?.id ?? null],
    );
    expect(granted!.r.granted).toBe(true);
    const [again] = await svc<{ r: { status: string; attempt: number } }>(
      `select outbound_call_start($1, $2, 'reminder_1', '2031-06-02T22:46:00Z', 'console') as r`,
      [AISHA, day!.id],
    );
    expect(again!.r).toMatchObject({ status: 'placed', attempt: 1 });
  });
});

describe('office_call_dial() (the worker’s last check)', () => {
  it('dials a queued call, and ends one whose day was filed meanwhile', async () => {
    const res = await callNow(LENA);
    expect(res.status).toBe('requested');
    const [go] = await svc<{ r: Record<string, unknown> }>(
      `select office_call_dial($1, 'console') as r`,
      [res.callId],
    );
    expect(go!.r).toMatchObject({ status: 'dial', room: `call-${res.callId}` });
    await endCalls();

    const next = await callNow(LENA);
    await svc(`update site_days set status = 'filed' where id = $1`, [next.siteDayId]);
    const [skip] = await svc<{ r: Record<string, unknown> }>(
      `select office_call_dial($1, 'console') as r`,
      [next.callId],
    );
    expect(skip!.r).toEqual({ status: 'skipped', reason: 'day_filed' });
    const [call] = await svc<{ status: string; outcome: string }>(
      `select status::text, outcome::text from calls where id = $1`,
      [next.callId],
    );
    expect(call).toEqual({ status: 'failed', outcome: 'not_reached' });
    // A second run finds it gone.
    const [gone] = await svc<{ r: Record<string, unknown> }>(
      `select office_call_dial($1, 'console') as r`,
      [next.callId],
    );
    expect(gone!.r).toMatchObject({ status: 'gone' });
    await svc(`update site_days set status = 'pending' where id = $1`, [next.siteDayId]);
  });
});
