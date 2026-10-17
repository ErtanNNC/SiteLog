import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import type { PGlite } from '@electric-sql/pglite';
import { DEMO_ORG_ID, DEMO_USERS } from '@sitelog/shared/demo/kestrel.ts';
import { asService, asUser, bootDatabase } from './harness.ts';

/**
 * W4-05 (20261017000530_settings_test_call.sql; spec P12, §19 Q232, Q350): Settings' Call me now.
 * settings_test_call_start() for the org's admin only; each refusal (no attestation, a number not
 * E.164, an org placing no calls, a test call still live, five an hour) writes nothing; a request
 * writes the `calls` row (outbound, `settings_test`, no reporter, the number held until the dial),
 * its audits with the number masked and one `place_call {phase: settings_test}`;
 * settings_test_call_dial() (service only) hands the number over and blanks it, or ends the call
 * with its reason; voice_call_start() starts a test call with no reporter and names its purpose,
 * and still refuses any other call without a reporter.
 *
 * Lena Ortiz (admin of Kestrel, a demo org: `console` telephony).
 */

const LENA = DEMO_USERS[0]!.id;
const SAM = DEMO_USERS[1]!.id; // pm
const ACCOUNTS = DEMO_USERS[2]!.id;
const OPS = 'eeeeeeee-0505-4505-8505-000000000001';
const OUTSIDER = 'eeeeeeee-0505-4505-8505-000000000002';
const PHONE = '+15550143378';

let db: PGlite;

async function svc<T = Record<string, unknown>>(sql: string, params: unknown[] = []) {
  return (await asService(db, (q) => q<T>(sql, params))).rows;
}

type Answer = {
  status: string;
  reason?: string;
  callId?: string;
  telephony?: string;
  retry_at?: string;
};

function callMeNow(
  user: string,
  opts: { phone?: string; attested?: boolean; language?: string } = {},
): Promise<Answer> {
  return asUser(
    db,
    user,
    async (q) =>
      (
        await q<{ r: Answer }>(`select settings_test_call_start($1, $2, $3, $4) as r`, [
          DEMO_ORG_ID,
          opts.phone ?? PHONE,
          opts.language ?? 'en',
          opts.attested ?? true,
        ])
      ).rows[0]!.r,
  );
}

async function failure(user: string): Promise<string | null> {
  try {
    await callMeNow(user);
    return null;
  } catch (err) {
    return (err as { code?: string }).code ?? (err as Error).message;
  }
}

const counts = async () =>
  (
    await svc<{ calls: number; jobs: number; audits: number }>(
      `select (select count(*)::int from calls where org_id = $1 and purpose = 'settings_test') as calls,
              (select count(*)::int from jobs where type = 'place_call' and payload->>'phase' = 'settings_test') as jobs,
              (select count(*)::int from audit_log where org_id = $1 and action = 'settings.test_call') as audits`,
      [DEMO_ORG_ID],
    )
  )[0]!;

const endTestCalls = () =>
  svc(
    `update calls set ended_at = now(), status = 'completed'
      where org_id = $1 and purpose = 'settings_test' and ended_at is null`,
    [DEMO_ORG_ID],
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
});

afterEach(async () => {
  await endTestCalls();
});

describe('settings_test_call_start() (W4-05, §19 Q232, Q350)', () => {
  it('is the org’s admin’s only', async () => {
    for (const user of [SAM, ACCOUNTS, OPS, OUTSIDER]) expect(await failure(user)).toBe('42501');
    expect(await counts()).toEqual({ calls: 0, jobs: 0, audits: 0 });
  });

  it('refuses without the attestation, a number not E.164, or an org placing no calls', async () => {
    expect(await callMeNow(LENA, { attested: false })).toEqual({
      status: 'refused',
      reason: 'attestation_required',
    });
    expect(await callMeNow(LENA, { phone: '555 0143' })).toEqual({
      status: 'refused',
      reason: 'invalid_phone',
    });
    await svc(`update orgs set is_demo = false where id = $1`, [DEMO_ORG_ID]);
    try {
      expect(await callMeNow(LENA)).toEqual({ status: 'refused', reason: 'no_trunk' });
    } finally {
      await svc(`update orgs set is_demo = true where id = $1`, [DEMO_ORG_ID]);
    }
    expect(await counts()).toEqual({ calls: 0, jobs: 0, audits: 0 });
    await expect(callMeNow(LENA, { language: 'fr' })).rejects.toThrow(/invalid_language/);
  });

  it('places one test call: the row, its job, audited with the number masked', async () => {
    const res = await callMeNow(LENA, { language: 'es' });
    expect(res).toMatchObject({ status: 'requested', telephony: 'console' });
    const [call] = await svc<Record<string, unknown>>(
      `select direction::text, transport::text, purpose, reporter_id, site_id, attempt,
              status::text, language, to_e164, provider_call_id, metrics
         from calls where id = $1`,
      [res.callId],
    );
    expect(call).toMatchObject({
      direction: 'outbound',
      transport: 'pstn',
      purpose: 'settings_test',
      reporter_id: null,
      site_id: null,
      attempt: null,
      status: 'queued',
      // The US pack's Spanish field locale.
      language: 'es-US',
      to_e164: PHONE,
      provider_call_id: `call-${res.callId}`,
      metrics: { telephony: 'console', stage: 'settings_test', requested_by: LENA },
    });
    const [job] = await svc<{ payload: unknown }>(
      `select payload from jobs where dedupe_key = $1`,
      [`call:settings_test:${res.callId}`],
    );
    expect(job!.payload).toEqual({ phase: 'settings_test', callId: res.callId });
    const audits = await svc<{ action: string; actor_id: string; diff: Record<string, unknown> }>(
      `select action, actor_id, diff from audit_log
        where org_id = $1 and (entity_id = $2::uuid or diff->>'call_id' = $2::text) order by id`,
      [DEMO_ORG_ID, res.callId],
    );
    expect(audits.map((a) => [a.action, a.actor_id])).toEqual([
      ['settings.test_call', LENA],
      ['call.requested', LENA],
    ]);
    expect(audits[0]!.diff).toEqual({
      to: '+1555***378',
      telephony: 'console',
      language: 'es',
      call_id: res.callId,
    });
    expect(JSON.stringify(audits)).not.toContain(PHONE);
  });

  it('one at a time, and five an hour per org', async () => {
    await svc(`delete from audit_log where org_id = $1 and action = 'settings.test_call'`, [
      DEMO_ORG_ID,
    ]);
    expect((await callMeNow(LENA)).status).toBe('requested');
    expect(await callMeNow(LENA)).toEqual({ status: 'refused', reason: 'call_live' });
    for (let i = 0; i < 4; i++) {
      await endTestCalls();
      expect((await callMeNow(LENA)).status).toBe('requested');
    }
    await endTestCalls();
    const sixth = await callMeNow(LENA);
    expect(sixth).toMatchObject({ status: 'refused', reason: 'rate_limited' });
    expect(typeof sixth.retry_at).toBe('string');
    expect((await counts()).audits).toBe(5);
  });
});

describe('settings_test_call_dial() (the worker’s last check)', () => {
  async function fresh(): Promise<string> {
    await svc(`delete from audit_log where org_id = $1 and action = 'settings.test_call'`, [
      DEMO_ORG_ID,
    ]);
    const res = await callMeNow(LENA);
    return res.callId!;
  }
  const dial = async (id: string, telephony: string | null, skip: string | null = null) =>
    (
      await svc<{ r: Record<string, unknown> }>(
        `select settings_test_call_dial($1, $2, null, $3) as r`,
        [id, telephony, skip],
      )
    )[0]!.r;
  const row = async (id: string) =>
    (
      await svc<Record<string, unknown>>(
        `select status::text, outcome::text, to_e164, metrics from calls where id = $1`,
        [id],
      )
    )[0]!;

  it('hands the number over once and blanks it', async () => {
    const id = await fresh();
    expect(await dial(id, 'console')).toEqual({
      status: 'dial',
      callId: id,
      room: `call-${id}`,
      to: PHONE,
      from: null,
    });
    expect(await row(id)).toMatchObject({ status: 'queued', to_e164: null });
  });

  it('ends a skipped or stale call failed / not_reached, number blanked, audited', async () => {
    const skipped = await fresh();
    expect(await dial(skipped, null, 'telephony_unavailable')).toEqual({
      status: 'skipped',
      reason: 'telephony_unavailable',
    });
    expect(await row(skipped)).toMatchObject({
      status: 'failed',
      outcome: 'not_reached',
      to_e164: null,
    });
    await endTestCalls();
    const stale = await fresh();
    await svc(`update calls set created_at = now() - interval '11 minutes' where id = $1`, [stale]);
    expect(await dial(stale, 'console')).toEqual({ status: 'skipped', reason: 'stale' });
    const [ended] = await svc<{ diff: Record<string, unknown> }>(
      `select diff from audit_log where action = 'call.ended' and entity_id = $1`,
      [stale],
    );
    expect(ended!.diff).toMatchObject({ stage: 'settings_test', reason: 'stale' });
    // Gone: nothing more to dial.
    expect(await dial(stale, 'console')).toMatchObject({ status: 'gone' });
  });

  it('is the service role’s only', async () => {
    const id = await fresh();
    await expect(
      asUser(db, LENA, (q) => q(`select settings_test_call_dial($1, 'console')`, [id])),
    ).rejects.toThrow(/permission denied/);
  });
});

describe('voice_call_start() for a test call', () => {
  it('starts it with no reporter and names its purpose; other reporterless calls conflict', async () => {
    await svc(`delete from audit_log where org_id = $1 and action = 'settings.test_call'`, [
      DEMO_ORG_ID,
    ]);
    const { callId } = await callMeNow(LENA);
    const [r] = await svc<{ r: Record<string, unknown> }>(
      `select voice_call_start($1, 'pstn', $2) as r`,
      [`call-${callId}`, callId],
    );
    expect(r!.r).toEqual({
      callId,
      reporterId: null,
      orgId: DEMO_ORG_ID,
      siteId: null,
      purpose: 'settings_test',
      repeat: false,
    });
    const [again] = await svc<{ r: Record<string, unknown> }>(
      `select voice_call_start($1, 'pstn', $2) as r`,
      [`call-${callId}`, callId],
    );
    expect(again!.r).toMatchObject({ callId, purpose: 'settings_test', repeat: true });

    // An outbound call with no reporter that is not a test call stays a conflict.
    const [other] = await svc<{ id: string }>(
      `insert into calls (org_id, direction, transport, purpose, status)
       values ($1, 'outbound', 'pstn', 'reminder', 'queued') returning id`,
      [DEMO_ORG_ID],
    );
    await expect(
      svc(`select voice_call_start($1, 'pstn', $2)`, [`call-${other!.id}`, other!.id]),
    ).rejects.toThrow(/call_conflict/);
  });
});
