import { beforeAll, describe, expect, it } from 'vitest';
import type { PGlite } from '@electric-sql/pglite';
import { DEMO_ORG_ID, DEMO_SITELOG_NUMBER, DEMO_USERS } from '@sitelog/shared/demo/kestrel.ts';
import { asService, bootDatabase, probeAs } from './harness.ts';

/**
 * 20261016000300_voice_calls.sql (W3-03; spec §4.6, §6.3 `calls`, §9.4, §19 Q44):
 * - countries_voice_number_key: one pack per voice number;
 * - voice_call_start(): a SIP call finds the pack by the number called and the caller among the
 *   pack's real orgs (a demo org never; two orgs: the site is asked), unknown callers kept org-less,
 *   Talk now / outbound calls by their row; one row per room, idempotent, audited without the number;
 * - voice_call_update() (never backwards), voice_call_pick_site(), voice_call_fallback(),
 *   voice_call_recording(), voice_call_end() (one post_call_reconcile job, idempotent);
 * - service role only; office users read their own org's calls, never another's.
 */

const ID = (n: number) => `cdcd3030-0000-4000-8000-${n.toString(16).padStart(12, '0')}`;
const room = (n: number) => `call-${ID(n)}`;
const KEVIN_PHONE = '+15550142087';
const OTHER_ORG = ID(1);
const OTHER_SITE = ID(2);
const OTHER_KEVIN = ID(3);
const STRANGER = '+15550199999';
const LENA = DEMO_USERS[0]!.id;

let db: PGlite;
let kevin: string;
let northgate: string;

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

type StartResult = {
  callId: string;
  reporterId: string | null;
  orgId: string | null;
  siteId: string | null;
  repeat: boolean;
};

const start = (
  r: string,
  from: string | null,
  opts: { to?: string; transport?: string; callId?: string } = {},
) =>
  svc<{ r: StartResult }>(`select voice_call_start($1, $2::call_transport, $3, $4, $5) as r`, [
    r,
    opts.transport ?? 'pstn',
    opts.callId ?? null,
    from,
    opts.to ?? DEMO_SITELOG_NUMBER,
  ]).then((rows) => rows[0]!.r);

const call = (id: string) =>
  svc<Record<string, unknown>>(`select * from calls where id = $1`, [id]).then((r) => r[0]!);

const audits = (id: string, action?: string) =>
  svc<{ action: string; diff: Record<string, unknown>; actor_type: string; org_id: string | null }>(
    `select action, diff, actor_type, org_id from audit_log where entity = 'call' and entity_id = $1
       and ($2::text is null or action = $2) order by id`,
    [id, action ?? null],
  );

beforeAll(async () => {
  db = await bootDatabase({ seed: true });
  await svc(`update countries set voice_number = $1 where code = 'US'`, [DEMO_SITELOG_NUMBER]);
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
});

describe('countries_voice_number_key', () => {
  it('gives a voice number to one pack only', async () => {
    expect(
      await failure(`update countries set voice_number = $1 where code = 'TR'`, [
        DEMO_SITELOG_NUMBER,
      ]),
    ).toMatch(/countries_voice_number_key|duplicate key/);
    // Null on many packs is fine (Talk now only).
    expect(await failure(`update countries set voice_number = null where code = 'TR'`)).toBeNull();
  });
});

describe('voice_call_start: SIP calls (§19 Q44)', () => {
  it('never reaches a demo org: the caller is unknown, kept org-less', async () => {
    const r = await start(room(100), KEVIN_PHONE);
    expect(r).toMatchObject({ reporterId: null, orgId: null, siteId: null, repeat: false });
    expect(r.callId).toBe(ID(100));
    const row = await call(r.callId);
    expect(row).toMatchObject({
      direction: 'inbound',
      transport: 'pstn',
      status: 'in_progress',
      from_e164: KEVIN_PHONE,
      to_e164: DEMO_SITELOG_NUMBER,
      provider_call_id: room(100),
    });
    expect(row.call_token_issued_at).not.toBeNull();
    const [a] = await audits(r.callId, 'call.started');
    expect(a!.diff).toMatchObject({ unknown: true, pack: 'US' });
    expect(JSON.stringify(a!.diff)).not.toContain(KEVIN_PHONE);
  });

  it("finds Kevin in a real org of the pack, with Northgate as the call's site", async () => {
    await svc(`update orgs set is_demo = false where id = $1`, [DEMO_ORG_ID]);
    const r = await start(room(101), KEVIN_PHONE);
    expect(r).toMatchObject({ reporterId: kevin, orgId: DEMO_ORG_ID, siteId: northgate });
    const row = await call(r.callId);
    expect(row).toMatchObject({ language: 'en-US', purpose: 'daily_report', org_id: DEMO_ORG_ID });
    const [a] = await audits(r.callId, 'call.started');
    expect(a).toMatchObject({ actor_type: 'agent', org_id: DEMO_ORG_ID });
    expect(JSON.stringify(a!.diff)).not.toContain(KEVIN_PHONE);
  });

  it('answers a repeat for the same room with the same call, once audited', async () => {
    const again = await start(room(101), KEVIN_PHONE);
    expect(again).toMatchObject({ callId: ID(101), reporterId: kevin, repeat: true });
    expect(await svc(`select 1 from calls where provider_call_id = $1`, [room(101)])).toHaveLength(
      1,
    );
    expect(await audits(ID(101), 'call.started')).toHaveLength(1);
    // Another number in the same room is not the same call.
    expect(
      await failure(`select voice_call_start($1, 'pstn', null, $2, $3)`, [
        room(101),
        STRANGER,
        DEMO_SITELOG_NUMBER,
      ]),
    ).toMatch(/call_conflict/);
  });

  it('refuses a number no pack has, a malformed room, and a SIP start without its numbers', async () => {
    expect(
      await failure(`select voice_call_start($1, 'pstn', null, $2, '+15550100000')`, [
        room(102),
        KEVIN_PHONE,
      ]),
    ).toMatch(/voice_number_unknown/);
    expect(
      await failure(`select voice_call_start('room-1', 'pstn', null, $1, $2)`, [
        KEVIN_PHONE,
        DEMO_SITELOG_NUMBER,
      ]),
    ).toMatch(/invalid_request/);
    expect(
      await failure(`select voice_call_start($1, 'pstn', null, null, $2)`, [
        room(103),
        DEMO_SITELOG_NUMBER,
      ]),
    ).toMatch(/invalid_request/);
  });

  it('keeps an unknown number org-less (F13)', async () => {
    const r = await start(room(104), STRANGER);
    expect(r).toMatchObject({ reporterId: null, orgId: null });
  });

  it('asks the site for a number in two orgs: no site until pick_site, which can move the call', async () => {
    await svc(
      `insert into orgs (id, name, country, is_demo) values ($1, 'Second Build', 'US', false)`,
      [OTHER_ORG],
    );
    await svc(
      `insert into sites (id, org_id, name, project_code, timezone) values ($1, $2, 'Lakeview', 'LV-1', 'America/Chicago')`,
      [OTHER_SITE, OTHER_ORG],
    );
    await svc(
      `insert into reporters (id, org_id, name, phone_e164, status) values ($1, $2, 'Kevin O''Brien', $3, 'invited')`,
      [OTHER_KEVIN, OTHER_ORG, KEVIN_PHONE],
    );
    await svc(`insert into site_reporters (site_id, reporter_id) values ($1, $2)`, [
      OTHER_SITE,
      OTHER_KEVIN,
    ]);
    const r = await start(room(105), KEVIN_PHONE);
    // Active before invited (§19 Q44's order): the Kestrel row is the call's until a site is picked.
    expect(r).toMatchObject({ reporterId: kevin, orgId: DEMO_ORG_ID, siteId: null });
    const [a] = await audits(r.callId, 'call.started');
    expect(a!.diff).toMatchObject({ orgs: 2 });

    const picked = await svc<{ r: Record<string, unknown> }>(
      `select voice_call_pick_site($1, $2, $3) as r`,
      [r.callId, OTHER_SITE, OTHER_KEVIN],
    );
    expect(picked[0]!.r).toMatchObject({ siteId: OTHER_SITE, changed: true });
    expect(await call(r.callId)).toMatchObject({
      site_id: OTHER_SITE,
      reporter_id: OTHER_KEVIN,
      org_id: OTHER_ORG,
    });
    expect(await audits(r.callId, 'call.site_picked')).toHaveLength(1);
    // The same pick again changes nothing.
    const again = await svc<{ r: Record<string, unknown> }>(
      `select voice_call_pick_site($1, $2, $3) as r`,
      [r.callId, OTHER_SITE, OTHER_KEVIN],
    );
    expect(again[0]!.r).toMatchObject({ changed: false });
  });

  it("refuses a site that is not the caller's, and a reporter with another number", async () => {
    const r = await start(room(106), KEVIN_PHONE);
    const otherSite = (
      await svc<{ id: string }>(
        `select id from sites where org_id = $1 and id <> $2 order by name limit 1`,
        [DEMO_ORG_ID, northgate],
      )
    )[0]!.id;
    expect(
      await failure(`select voice_call_pick_site($1, $2, $3)`, [r.callId, otherSite, kevin]),
    ).toMatch(/site_not_found/);
    const someoneElse = (
      await svc<{ id: string }>(
        `select reporter_id as id from site_reporters where site_id = $1 limit 1`,
        [otherSite],
      )
    )[0]!.id;
    expect(
      await failure(`select voice_call_pick_site($1, $2, $3)`, [r.callId, otherSite, someoneElse]),
    ).toMatch(/site_not_found/);
  });
});

describe('voice_call_start: Talk now and outbound calls', () => {
  it('starts the row it has: in progress, the token issued, the site-day set', async () => {
    const id = ID(200);
    await svc(
      `insert into calls (id, org_id, reporter_id, site_id, direction, transport, purpose)
       values ($1, $2, $3, $4, 'inbound', 'web', 'daily_report')`,
      [id, DEMO_ORG_ID, kevin, northgate],
    );
    const r = await start(room(201), null, { transport: 'web', callId: id });
    expect(r).toMatchObject({ callId: id, reporterId: kevin, siteId: northgate, repeat: false });
    const row = await call(id);
    expect(row).toMatchObject({ status: 'in_progress', provider_call_id: room(201) });
    expect(row.answered_at).not.toBeNull();
    // A repeat is the same call; another room or transport is not.
    expect(await start(room(201), null, { transport: 'web', callId: id })).toMatchObject({
      repeat: true,
    });
    expect(await failure(`select voice_call_start($1, 'web', $2)`, [room(202), id])).toMatch(
      /call_conflict/,
    );
    expect(await failure(`select voice_call_start($1, 'pstn', $2)`, [room(201), id])).toMatch(
      /call_conflict/,
    );
    expect(await failure(`select voice_call_start($1, 'web', $2)`, [room(203), ID(299)])).toMatch(
      /call_not_found/,
    );
  });
});

describe('voice_call_update / fallback / recording / end', () => {
  it('moves the status forward only, keeps the disclosure, audits changes', async () => {
    const r = await start(room(300), KEVIN_PHONE);
    const up = (status: string | null, disclosure: boolean | null) =>
      svc<{ r: Record<string, unknown> }>(
        `select voice_call_update($1, $2::call_status, $3) as r`,
        [r.callId, status, disclosure],
      ).then((rows) => rows[0]!.r);
    expect(await up('ringing', null)).toMatchObject({ status: 'in_progress', changed: false });
    expect(await up(null, true)).toMatchObject({ disclosurePlayed: true, changed: true });
    expect(await up(null, false)).toMatchObject({ disclosurePlayed: true, changed: false });
    expect(await up('failed', null)).toMatchObject({ status: 'failed', changed: true });
    expect(await up('completed', null)).toMatchObject({ status: 'failed', changed: false });
    expect(await audits(r.callId, 'call.updated')).toHaveLength(2);
  });

  it('marks the fallback once, and the recording at its own path only', async () => {
    const r = await start(room(301), KEVIN_PHONE);
    const fb = () =>
      svc<{ r: { marked: boolean } }>(
        `select voice_call_fallback($1, 'not_understood', 42.5) as r`,
        [r.callId],
      ).then((rows) => rows[0]!.r);
    expect(await fb()).toEqual({ marked: true });
    expect(await fb()).toEqual({ marked: false });
    expect((await call(r.callId)).fallback).toEqual({ reason: 'not_understood', at: 42.5 });
    expect(await failure(`select voice_call_fallback($1, 'bored', 1)`, [r.callId])).toMatch(
      /invalid_request/,
    );

    const path = `${DEMO_ORG_ID}/${r.callId}.ogg`;
    expect(await failure(`select voice_call_recording($1, 'x/y.ogg')`, [r.callId])).toMatch(
      /invalid_request/,
    );
    await svc(`select voice_call_recording($1, $2)`, [r.callId, path]);
    await svc(`select voice_call_recording($1, $2)`, [r.callId, path]);
    expect((await call(r.callId)).recording_path).toBe(path);
    expect(await audits(r.callId, 'call.recording_requested')).toHaveLength(1);
  });

  it('ends a call once: outcome, log, metrics, duration and one post_call_reconcile job', async () => {
    const r = await start(room(302), KEVIN_PHONE);
    const end = () =>
      svc<{ r: { ended: boolean; jobId: number | null; outcome: string } }>(
        `select voice_call_end($1, 'draft_saved', $2, $3) as r`,
        [
          r.callId,
          JSON.stringify([{ t: 1, speaker: 'agent', text: 'Hi' }]),
          JSON.stringify({ turns: 1, interruptions: 0 }),
        ],
      ).then((rows) => rows[0]!.r);
    const first = await end();
    expect(first).toMatchObject({ ended: true, outcome: 'draft_saved' });
    expect(first.jobId).not.toBeNull();
    const second = await end();
    expect(second).toMatchObject({ ended: false, jobId: null });
    const row = await call(r.callId);
    expect(row).toMatchObject({ status: 'completed', outcome: 'draft_saved' });
    expect(row.ended_at).not.toBeNull();
    expect(row.duration_s).toBeGreaterThanOrEqual(0);
    expect(row.dialog_log).toEqual([{ t: 1, speaker: 'agent', text: 'Hi' }]);
    const jobs = await svc<{ type: string; dedupe_key: string }>(
      `select type, dedupe_key from jobs where payload ->> 'callId' = $1`,
      [r.callId],
    );
    expect(jobs).toEqual([{ type: 'post_call_reconcile', dedupe_key: `post_call:${r.callId}` }]);
    expect(await audits(r.callId, 'call.ended')).toHaveLength(1);
    // An ended call takes no new start, site or fallback.
    expect(
      await failure(`select voice_call_start($1, 'pstn', null, $2, $3)`, [
        room(302),
        KEVIN_PHONE,
        DEMO_SITELOG_NUMBER,
      ]),
    ).toMatch(/call_ended/);
    expect(await failure(`select voice_call_fallback($1, 'agent_error', 1)`, [r.callId])).toMatch(
      /call_ended/,
    );
  });

  it('queues nothing for an unknown caller', async () => {
    const r = await start(room(303), STRANGER);
    await svc(`select voice_call_end($1, 'abandoned', '[]', '{}')`, [r.callId]);
    expect(await svc(`select 1 from jobs where payload ->> 'callId' = $1`, [r.callId])).toEqual([]);
  });
});

describe('access', () => {
  it('lets no signed-in user or anon run the voice RPCs', async () => {
    for (const sql of [
      `select voice_call_start('${room(400)}', 'pstn', null, '${KEVIN_PHONE}', '${DEMO_SITELOG_NUMBER}')`,
      `select voice_call_update('${ID(101)}', 'completed')`,
      `select voice_call_end('${ID(101)}', 'filed', '[]', '{}')`,
      `select voice_call_pick_site('${ID(101)}', '${northgate}', '${kevin}')`,
      `select voice_call_fallback('${ID(101)}', 'agent_error', 1)`,
      `select voice_call_recording('${ID(101)}', 'x')`,
    ]) {
      const asUser = await probeAs(db, { role: 'authenticated', userId: LENA }, sql);
      expect(asUser.ok ? 'ran' : asUser.code, sql).toBe('42501');
      const asAnon = await probeAs(db, { role: 'anon' }, sql);
      expect(asAnon.ok ? 'ran' : asAnon.code, sql).toBe('42501');
    }
  });

  it("shows Kestrel's office its own calls and never another org's; anon none", async () => {
    const own = await probeAs(
      db,
      { role: 'authenticated', userId: LENA },
      `select id from calls where id = '${ID(101)}'`,
    );
    expect(own.ok && own.rows.length).toBe(1);
    const other = await probeAs(
      db,
      { role: 'authenticated', userId: LENA },
      `select id from calls where org_id = '${OTHER_ORG}'`,
    );
    expect(other.ok && other.rows.length).toBe(0);
    const anon = await probeAs(db, { role: 'anon' }, `select id from calls`);
    expect(anon.ok).toBe(false);
  });
});
