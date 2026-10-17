import { beforeAll, describe, expect, it } from 'vitest';
import type { PGlite } from '@electric-sql/pglite';
import { DEMO_ORG_ID, DEMO_USERS } from '@sitelog/shared/demo/kestrel.ts';
import { asService, asUser, bootDatabase } from './harness.ts';

/**
 * 20261016000280_weather_call_evidence.sql (W3-07; spec F20, P9): a weather period a call report
 * cites by its call second gets the call as its delay record's voice evidence (P9's *Call ts*
 * chip, claim-ready), and report_archive_weather_hours() sums the lost hours of every archive
 * report matching the Reports filters in one request, for admin, pm and ops of the org only.
 */

const LENA = DEMO_USERS[0]!.id; // admin
const SAM = DEMO_USERS[1]!.id; // pm
const ACCOUNTS = DEMO_USERS[2]!.id; // accounts
const OUTSIDER = 'eeeeeeee-3333-4333-8333-333333333333'; // admin of another org

let db: PGlite;

async function svc<T = Record<string, unknown>>(sql: string, params: unknown[] = []) {
  return (await asService(db, (q) => q<T>(sql, params))).rows;
}

/** The SQL sum over report_archive with a plain where clause: what the RPC must answer. */
async function expectedHours(where = 'true', params: unknown[] = []): Promise<number> {
  const [r] = await svc<{ h: string }>(
    `select coalesce(sum(lost_hours), 0)::text as h from report_archive
     where org_id = $1 and lost_hours > 0 and (${where})`,
    [DEMO_ORG_ID, ...params],
  );
  return Number(r!.h);
}

async function rpcAs(user: string, args: Record<string, unknown>): Promise<number> {
  const names = Object.keys(args);
  const res = await asUser(db, user, (q) =>
    q<{ h: string }>(
      `select report_archive_weather_hours(${names.map((n, i) => `${n} => $${i + 1}`).join(', ')})::text as h`,
      names.map((n) => args[n]),
    ),
  );
  return Number(res.rows[0]!.h);
}

beforeAll(async () => {
  db = await bootDatabase({ seed: true });
  await db.exec(`insert into auth.users (id, email) values ('${OUTSIDER}', 'z@other.test');`);
  await asUser(db, OUTSIDER, (q) => q(`select create_org('Other GC')`), 'z@other.test');
});

describe('weather_events.audio_source from a call (20261016000280)', () => {
  it('records the call second of a call-sourced weather period and makes it claim-ready', async () => {
    // A filed report of the seed with a weather period, re-cited to a call of that report.
    const [r] = await svc<{ id: string; version: number; site_id: string; org_id: string }>(
      `select r.id, r.current_version as version, r.site_id, r.org_id from reports r
       join weather_events w on w.report_id = r.id and w.version = r.current_version
       where r.org_id = $1 and w.lost_hours > 0 and w.photo_count > 0 and w.observed is not null
       order by r.report_no limit 1`,
      [DEMO_ORG_ID],
    );
    const [call] = await svc<{ id: string }>(
      `insert into calls (org_id, site_id, report_id, direction, status)
       values ($1, $2, $3, 'inbound', 'completed') returning id`,
      [r!.org_id, r!.site_id, r!.id],
    );
    await svc(
      `update report_versions
       set data = jsonb_set(data, '{weather,periods,0,source}',
                            jsonb_build_array(jsonb_build_object('type', 'call', 'callId', $3::text, 'start', 135)))
       where report_id = $1 and version = $2`,
      [r!.id, r!.version, call!.id],
    );
    await svc(`select denormalize_report_version($1, $2)`, [r!.id, r!.version]);
    const [wx] = await svc<{ audio_source: Record<string, unknown>; claim_ready: boolean }>(
      `select audio_source, claim_ready from weather_events
       where report_id = $1 and version = $2 order by lost_hours desc limit 1`,
      [r!.id, r!.version],
    );
    expect(wx).toEqual({
      audio_source: { type: 'call', callId: call!.id, start: 135 },
      claim_ready: true,
    });
    // The call becomes a source of the report too (the writers' sync, 20261014000002).
    const src = await svc(`select 1 from report_sources where report_id = $1 and call_id = $2`, [
      r!.id,
      call!.id,
    ]);
    expect(src).toHaveLength(1);

    // A voice note in the same period wins over the call.
    await svc(
      `update report_versions
       set data = jsonb_set(data, '{weather,periods,0,source}',
                            jsonb_build_array(
                              jsonb_build_object('type', 'call', 'callId', $3::text, 'start', 135),
                              jsonb_build_object('type', 'voice_note', 'uploadId', $4::text, 'start', 41)))
       where report_id = $1 and version = $2`,
      [r!.id, r!.version, call!.id, 'aaaaaaaa-0000-4000-8000-000000000001'],
    );
    await svc(`select denormalize_report_version($1, $2)`, [r!.id, r!.version]);
    const [again] = await svc<{ audio_source: Record<string, unknown> }>(
      `select audio_source from weather_events
       where report_id = $1 and version = $2 order by lost_hours desc limit 1`,
      [r!.id, r!.version],
    );
    expect(again!.audio_source).toMatchObject({ type: 'voice_note', start: 41 });
  });
});

describe('report_archive_weather_hours() (20261016000280)', () => {
  it('sums every matching report, as report_archive with the same filters', async () => {
    const all = await expectedHours();
    expect(all).toBeGreaterThan(0);
    expect(await rpcAs(LENA, { p_org: DEMO_ORG_ID })).toBe(all);
    expect(await rpcAs(SAM, { p_org: DEMO_ORG_ID, p_has_weather_delay: true })).toBe(all);
    const [site] = await svc<{ id: string }>(
      `select id from sites where org_id = $1 and project_code = 'RL-2041'`,
      [DEMO_ORG_ID],
    );
    expect(await rpcAs(LENA, { p_org: DEMO_ORG_ID, p_site: site!.id })).toBe(
      await expectedHours('site_id = $2', [site!.id]),
    );
    expect(
      await rpcAs(LENA, { p_org: DEMO_ORG_ID, p_from: '2026-10-01', p_to: '2026-10-09' }),
    ).toBe(await expectedHours(`date between '2026-10-01' and '2026-10-09'`));
    expect(await rpcAs(LENA, { p_org: DEMO_ORG_ID, p_status: 'signed_off' })).toBe(
      await expectedHours(`status = 'signed_off'`),
    );
    expect(await rpcAs(LENA, { p_org: DEMO_ORG_ID, p_status: 'weather_day' })).toBe(
      await expectedHours(`kind = 'weather_day'`),
    );
    expect(await rpcAs(LENA, { p_org: DEMO_ORG_ID, p_late: true })).toBe(
      await expectedHours('is_late'),
    );
    expect(await rpcAs(LENA, { p_org: DEMO_ORG_ID, p_channel: 'call' })).toBe(
      await expectedHours(`channel = 'voice'`),
    );
    // Text: a literal substring of the number, site, code or summary, or a transcript match.
    expect(await rpcAs(LENA, { p_org: DEMO_ORG_ID, p_text: 'riverside' })).toBe(
      await expectedHours(`site_name ilike '%riverside%'`),
    );
    // `%` and `_` are matched literally, not as wildcards.
    expect(await rpcAs(LENA, { p_org: DEMO_ORG_ID, p_text: '%' })).toBe(
      await expectedHours(`strpos(summary, '%') > 0 or strpos(report_no, '%') > 0`),
    );
    expect(await rpcAs(LENA, { p_org: DEMO_ORG_ID, p_text: 'zzz_no_match' })).toBe(0);
    const [one] = await svc<{ id: string; lost_hours: string }>(
      `select id, lost_hours::text from report_archive where org_id = $1 and lost_hours > 0
       and site_name not ilike '%zzz%' order by id limit 1`,
      [DEMO_ORG_ID],
    );
    expect(
      await rpcAs(LENA, { p_org: DEMO_ORG_ID, p_text: 'zzz-no-match', p_ids: [one!.id] }),
    ).toBe(Number(one!.lost_hours));
  });

  it('answers 0 for accounts and for another org (report_archive shows them nothing)', async () => {
    expect(await rpcAs(ACCOUNTS, { p_org: DEMO_ORG_ID })).toBe(0);
    expect(await rpcAs(OUTSIDER, { p_org: DEMO_ORG_ID })).toBe(0);
  });
});
