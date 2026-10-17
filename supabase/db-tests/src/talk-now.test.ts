import { beforeAll, describe, expect, it } from 'vitest';
import type { PGlite } from '@electric-sql/pglite';
import { DEMO_ORG_ID, DEMO_USERS } from '@sitelog/shared/demo/kestrel.ts';
import { asService, bootDatabase, probeAs } from './harness.ts';

/**
 * 20261016000340_talk_now.sql (W3-13; spec §9.4 "How a call starts", Appendix B
 * `POST /field/voice/token`, §19 Q121, Q157):
 * - field_talk_now_start(): the web call's row before its room (queued, inbound, web, the room
 *   `call-{id}` as provider_call_id), audited `call.requested` as the reporter; refused without the
 *   consents, for another reporter's site, a paused site and a disabled reporter;
 * - voice_call_start() then starts that row by its callId and room (W3-03), once;
 * - field_talk_now_failed(): a room that could not be made ends the call (failed, not_reached), no
 *   job, once;
 * - service role only.
 */

const KEVIN_PHONE = '+15550142087';
const DEVICE = 'cdcd3400-0000-4000-8000-000000000001';
const LENA = DEMO_USERS[0]!.id;

let db: PGlite;
let kevin: string;
let northgate: string;
let otherSite: string;

async function svc<T = Record<string, unknown>>(sql: string, params: unknown[] = []) {
  return (await asService(db, (q) => q<T>(sql, params))).rows;
}

async function failure(sql: string, params: unknown[] = []): Promise<string | null> {
  try {
    await svc(sql, params);
    return null;
  } catch (err) {
    return (err as Error).message;
  }
}

const startTalk = (reporter: string, site: string) =>
  svc<{ r: { callId: string; room: string } }>(`select field_talk_now_start($1, $2, $3) as r`, [
    reporter,
    site,
    DEVICE,
  ]).then((rows) => rows[0]!.r);

const call = (id: string) =>
  svc<Record<string, unknown>>(`select * from calls where id = $1`, [id]).then((r) => r[0]!);

const audits = (id: string, action?: string) =>
  svc<{ action: string; diff: Record<string, unknown>; actor_type: string; actor_id: string }>(
    `select action, diff, actor_type, actor_id from audit_log where entity = 'call' and entity_id = $1
       and ($2::text is null or action = $2) order by id`,
    [id, action ?? null],
  );

beforeAll(async () => {
  db = await bootDatabase({ seed: true });
  kevin = (
    await svc<{ id: string }>(`select id from reporters where phone_e164 = $1 and org_id = $2`, [
      KEVIN_PHONE,
      DEMO_ORG_ID,
    ])
  )[0]!.id;
  northgate = (
    await svc<{ id: string }>(`select site_id as id from site_reporters where reporter_id = $1`, [
      kevin,
    ])
  )[0]!.id;
  otherSite = (
    await svc<{ id: string }>(
      `select id from sites where org_id = $1 and id <> $2 and status = 'active' limit 1`,
      [DEMO_ORG_ID, northgate],
    )
  )[0]!.id;
  // The seed's consents may be any; Kevin gets both required ones, fresh.
  await svc(`delete from consents where reporter_id = $1`, [kevin]);
  await svc(
    `insert into consents (reporter_id, type, method, text_version) values
       ($1, 'recording', 'web_checkbox', 'field.consent.v1'),
       ($1, 'data_processing', 'web_checkbox', 'field.consent.v1')`,
    [kevin],
  );
});

describe('field_talk_now_start', () => {
  it("makes Kevin's web call at Northgate, queued, its room named by the call (Q157)", async () => {
    const r = await startTalk(kevin, northgate);
    expect(r.room).toBe(`call-${r.callId}`);
    const row = await call(r.callId);
    expect(row).toMatchObject({
      org_id: DEMO_ORG_ID,
      reporter_id: kevin,
      site_id: northgate,
      direction: 'inbound',
      transport: 'web',
      purpose: 'daily_report',
      status: 'queued',
      provider_call_id: r.room,
      language: 'en-US',
      from_e164: null,
      call_token_issued_at: null,
      ended_at: null,
    });
    const [a] = await audits(r.callId, 'call.requested');
    expect(a).toMatchObject({ actor_type: 'reporter', actor_id: kevin });
    expect(a!.diff).toMatchObject({ transport: 'web', site_id: northgate, device_id: DEVICE });
    expect(JSON.stringify(a!.diff)).not.toContain(KEVIN_PHONE);
  });

  it('is then started by the agent with its callId and room, once (voice_call_start)', async () => {
    const r = await startTalk(kevin, northgate);
    const started = await svc<{ v: Record<string, unknown> }>(
      `select voice_call_start($1, 'web', $2) as v`,
      [r.room, r.callId],
    );
    expect(started[0]!.v).toMatchObject({ callId: r.callId, reporterId: kevin, repeat: false });
    const row = await call(r.callId);
    expect(row.status).toBe('in_progress');
    expect(row.call_token_issued_at).not.toBeNull();
    const again = await svc<{ v: Record<string, unknown> }>(
      `select voice_call_start($1, 'web', $2) as v`,
      [r.room, r.callId],
    );
    expect(again[0]!.v).toMatchObject({ callId: r.callId, repeat: true });
    expect(await audits(r.callId, 'call.started')).toHaveLength(1);
  });

  it('refuses a site that is not the reporter’s, a paused site and a disabled reporter', async () => {
    expect(
      await failure(`select field_talk_now_start($1, $2, $3)`, [kevin, otherSite, DEVICE]),
    ).toMatch(/site_not_found/);
    await svc(`update sites set status = 'paused' where id = $1`, [northgate]);
    expect(
      await failure(`select field_talk_now_start($1, $2, $3)`, [kevin, northgate, DEVICE]),
    ).toMatch(/wrong_state/);
    await svc(`update sites set status = 'active' where id = $1`, [northgate]);
    await svc(`update reporters set status = 'disabled' where id = $1`, [kevin]);
    expect(
      await failure(`select field_talk_now_start($1, $2, $3)`, [kevin, northgate, DEVICE]),
    ).toMatch(/reporter_disabled/);
    await svc(`update reporters set status = 'active' where id = $1`, [kevin]);
  });

  it('refuses without the recording and data_processing consents', async () => {
    await svc(
      `update consents set revoked_at = now() where reporter_id = $1 and type = 'recording'`,
      [kevin],
    );
    expect(
      await failure(`select field_talk_now_start($1, $2, $3)`, [kevin, northgate, DEVICE]),
    ).toMatch(/consent_required/);
    await svc(
      `insert into consents (reporter_id, type, method, text_version)
         values ($1, 'recording', 'web_checkbox', 'field.consent.v1')`,
      [kevin],
    );
    expect(
      await failure(`select field_talk_now_start($1, $2, $3)`, [kevin, northgate, DEVICE]),
    ).toBeNull();
  });
});

describe('field_talk_now_failed', () => {
  it('ends a call whose room failed: failed, not_reached, audited, no job; once', async () => {
    const r = await startTalk(kevin, northgate);
    const jobsBefore = await svc<{ n: number }>(`select count(*)::int as n from jobs`);
    const first = await svc<{ v: Record<string, unknown> }>(
      `select field_talk_now_failed($1, 'livekit_unavailable') as v`,
      [r.callId],
    );
    expect(first[0]!.v).toMatchObject({ ended: true, outcome: 'not_reached' });
    const row = await call(r.callId);
    expect(row).toMatchObject({ status: 'failed', outcome: 'not_reached' });
    expect(row.ended_at).not.toBeNull();
    expect(row.metrics).toMatchObject({ talkNowFailed: 'livekit_unavailable' });
    const second = await svc<{ v: Record<string, unknown> }>(
      `select field_talk_now_failed($1, 'livekit_unavailable') as v`,
      [r.callId],
    );
    expect(second[0]!.v).toMatchObject({ ended: false });
    expect(await audits(r.callId, 'call.ended')).toHaveLength(1);
    const jobsAfter = await svc<{ n: number }>(`select count(*)::int as n from jobs`);
    expect(jobsAfter[0]!.n).toBe(jobsBefore[0]!.n);
    // An ended call is not started by the agent afterwards.
    expect(await failure(`select voice_call_start($1, 'web', $2)`, [r.room, r.callId])).toMatch(
      /call_ended/,
    );
  });

  it('refuses a reason that is not a code', async () => {
    const r = await startTalk(kevin, northgate);
    expect(await failure(`select field_talk_now_failed($1, 'Bad reason!')`, [r.callId])).toMatch(
      /invalid_request/,
    );
  });
});

describe('access', () => {
  it('is the service role’s only', async () => {
    for (const sql of [
      `select field_talk_now_start('${kevin}', '${northgate}', '${DEVICE}')`,
      `select field_talk_now_failed('${DEVICE}', 'x')`,
    ]) {
      const asUser = await probeAs(db, { role: 'authenticated', userId: LENA }, sql);
      expect(asUser.ok ? 'ran' : asUser.code, sql).toBe('42501');
      const asAnon = await probeAs(db, { role: 'anon' }, sql);
      expect(asAnon.ok ? 'ran' : asAnon.code, sql).toBe('42501');
    }
  });
});
