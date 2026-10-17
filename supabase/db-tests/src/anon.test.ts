import { beforeAll, describe, expect, it } from 'vitest';
import type { PGlite } from '@electric-sql/pglite';
import { bootDatabase, probeAs, type ProbeResult } from './harness.ts';
import { BUCKETS, ORG, objectName, seedTwoOrgs } from './fixtures/two-orgs.ts';
import { TABLES, VIEWS } from './fixtures/role-matrix.ts';

/**
 * The anonymous API role (the `anon` key, no session; W1-05 step 9 test base): it reads nothing,
 * writes nothing and cannot run any function in `public`. Field users never get a database
 * session (§6.5), so nothing in `public` is for anon.
 *
 * ANON_GAPS records every function anon can execute today, with the reason and the step that
 * closes it. The test lists the functions anon can execute (Supabase's default privileges and
 * PUBLIC give it every new function unless a migration revokes it) and fails on one missing from
 * ANON_GAPS (a new function that forgot its revoke) and on an entry anon can no longer execute
 * (remove it in the commit that revokes it).
 */

const A = ORG.A;

/**
 * The org lookup helpers (granted to anon in 20261011000004_rls.sql:49-51, and the v1.2 ones),
 * each with a call that hits a row.
 */
const LOOKUP_HELPERS: Record<string, string> = {
  is_member: `select is_member('${A.org}') as v`,
  has_role: `select has_role('${A.org}', '{admin}') as v`,
  my_org_ids: `select * from my_org_ids() as v`,
  site_org: `select site_org('${A.site}') as v`,
  report_org: `select report_org('${A.report}') as v`,
  conversation_org: `select conversation_org('${A.conversation}') as v`,
  message_org: `select message_org('${A.message}') as v`,
  reporter_org: `select reporter_org('${A.reporter}') as v`,
  // 20261013000007: revoked from public and anon when created.
  upload_org: `select upload_org('${A.upload}') as v`,
  call_org: `select call_org('${A.call}') as v`,
};

interface AnonGap {
  reason: string;
  /** The step that revokes execute from public, anon. */
  closes: string;
}

/**
 * Every function in `public` anon can execute today (`regprocedure`, so overloads are distinct),
 * except trigger functions and extension members. Empty since W1-05 step 9
 * (20261014000001_queue_rls_fixes.sql revoked the lookup helpers, is_service(), job_priority()
 * and the office RPCs): a new entry needs a reason and the step that closes it.
 */
const ANON_GAPS: Record<string, AnonGap> = {};

/**
 * What 20261014000001 revoked from anon, which signed-in office users still run: the lookup
 * helpers inside RLS and storage policies, is_service() inside the owner-privileged views, and
 * the office RPCs of the panel (create_org in the setup wizard, after sign-in).
 */
const AUTHENTICATED_KEEPS = [
  'conversation_org(uuid)',
  'has_role(uuid,member_role[])',
  'is_member(uuid)',
  'message_org(uuid)',
  'my_org_ids()',
  'report_org(uuid)',
  'reporter_org(uuid)',
  'site_org(uuid)',
  'notification_audience(text)',
  'is_service()',
  'add_glossary_term(uuid,text,text,term_kind,text,uuid)',
  'create_org(text,text,text,text,text)',
  'invoice_gaps(uuid,date,date)',
  'report_archive_weather_hours(uuid,uuid,date,date,text,boolean,boolean,boolean,boolean,text,text,uuid[])',
  'mark_no_work(uuid)',
  'mark_notifications_read(uuid[])',
  'resolve_unknown_company(uuid,text,text,uuid)',
  'review_glossary_term(uuid,text,text,uuid)',
  'sign_off_report(uuid)',
  'undo_sign_off(uuid)',
  // W4-03: Team on v1.2.
  'update_reporter_contact(uuid,contact_pref,message_channel,text,boolean)',
  'revoke_reporter_devices(uuid)',
  'clear_reporter_opt_out(uuid,text,boolean)',
  'team_reporter_states(uuid)',
  // W4-04: Team's Call now.
  'office_call_start(uuid,uuid,text,boolean)',
  // W4-05: the report language and units (§19 Q233).
  'update_org(uuid,text,text,text,text,text,text)',
] as const;

let db: PGlite;

beforeAll(async () => {
  db = await bootDatabase({ storage: true });
  await seedTwoOrgs(db);
});

const anon = (sql: string) => probeAs(db, { role: 'anon' }, sql);
const denied = (res: ProbeResult) => !res.ok && res.code === '42501';

describe('anon (no session)', () => {
  it('reads no row of any table or view, and no stored file', async () => {
    const seen: string[] = [];
    for (const name of [...Object.keys(TABLES), ...Object.keys(VIEWS), 'storage.objects']) {
      const res = await anon(`select count(*)::int as n from ${name}`);
      if (res.ok ? Number(res.rows[0]!.n) > 0 : !denied(res))
        seen.push(`${name}: ${res.ok ? `${String(res.rows[0]!.n)} rows` : res.message}`);
    }
    expect(seen).toEqual([]);
  });

  it('uploads no file to any bucket', async () => {
    const wrote: string[] = [];
    for (const bucket of BUCKETS) {
      const res = await anon(
        `insert into storage.objects (bucket_id, name) values ('${bucket}', '${objectName(A, bucket)}.anon')`,
      );
      if (!denied(res)) wrote.push(`${bucket}: ${res.ok ? 'accepted' : res.message}`);
    }
    expect(wrote).toEqual([]);
  });

  it('inserts, updates and deletes nothing', async () => {
    const wrote: string[] = [];
    for (const [table, t] of Object.entries(TABLES)) {
      const ins = await anon(t.insert(A).replaceAll('auth.uid()', `'${A.users.admin}'`));
      if (!denied(ins)) wrote.push(`insert ${table}: ${ins.ok ? 'accepted' : ins.message}`);
      for (const sql of [
        `update ${table} set ${t.set} where ${t.where(A)}`,
        `delete from ${table} where ${t.where(A)}`,
      ]) {
        const res = await anon(sql);
        if (res.ok ? res.affectedRows > 0 : !denied(res))
          wrote.push(`${sql}: ${res.ok ? `${res.affectedRows} rows` : res.message}`);
      }
    }
    expect(wrote).toEqual([]);
  });

  it('executes no function in public beyond the known gaps', async () => {
    const res = await db.query<{ fn: string }>(`
      select p.oid::regprocedure::text as fn
      from pg_proc p join pg_namespace n on n.oid = p.pronamespace and n.nspname = 'public'
      where has_function_privilege('anon', p.oid, 'execute')
        and p.prorettype <> 'trigger'::regtype
        and not exists (select 1 from pg_depend d
                        where d.classid = 'pg_proc'::regclass and d.objid = p.oid and d.deptype = 'e')
      order by 1`);
    const executable = res.rows.map((r) => r.fn);
    const problems = [
      ...executable
        .filter((fn) => !ANON_GAPS[fn])
        .map((fn) => `anon can execute ${fn}: revoke execute from public, anon in its migration`),
      ...Object.keys(ANON_GAPS)
        .filter((fn) => !executable.includes(fn))
        .map((fn) => `${fn} is no longer executable by anon: remove it from ANON_GAPS`),
    ];
    expect(problems).toEqual([]);
  });

  it.each(Object.entries(LOOKUP_HELPERS))('cannot run %s()', async (fn, sql) => {
    const res = await anon(sql);
    const gap = Object.entries(ANON_GAPS).find(([sig]) => sig.startsWith(`${fn}(`))?.[1];
    if (gap) {
      expect(
        res.ok,
        `known gap (${gap.closes}: ${gap.reason}): if fixed, remove ${fn} from ANON_GAPS`,
      ).toBe(true);
    } else {
      expect(denied(res), res.ok ? 'anon ran it' : res.message).toBe(true);
    }
  });

  it('cannot call the office RPCs it could call before step 9', async () => {
    const calls = [
      `select create_org('Anon Co') as v`,
      `select sign_off_report('${A.report}') as v`,
      `select undo_sign_off('${A.report}') as v`,
      `select mark_no_work('${A.siteDay2}') as v`,
      `select mark_notifications_read(array['${A.notification}']::uuid[]) as v`,
      `select * from invoice_gaps('${A.org}', '2026-10-01', '2026-10-31')`,
    ];
    const ran: string[] = [];
    for (const sql of calls) {
      const res = await anon(sql);
      if (!denied(res)) ran.push(`${sql}: ${res.ok ? 'ran' : res.message}`);
    }
    expect(ran).toEqual([]);
  });

  it('leaves signed-in users and the service the functions it revoked from anon', async () => {
    const res = await db.query<{ fn: string; authenticated: boolean; service: boolean }>(
      `select f as fn, has_function_privilege('authenticated', f, 'execute') as authenticated,
              has_function_privilege('service_role', f, 'execute') as service
       from unnest($1::text[]) f order by 1`,
      [[...AUTHENTICATED_KEEPS]],
    );
    const missing = res.rows.filter((r) => !r.authenticated || !r.service).map((r) => r.fn);
    expect(missing).toEqual([]);
    expect(res.rows).toHaveLength(AUTHENTICATED_KEEPS.length);
  });

  it('gives every gap a reason and the step that closes it', () => {
    for (const [fn, gap] of Object.entries(ANON_GAPS)) {
      expect(gap.reason.length, fn).toBeGreaterThan(20);
      expect(gap.closes, fn).toMatch(/^(W1-\d\d( step \d+)?|step \d+)$/);
    }
  });

  it('calls only real lookup helpers', async () => {
    // A typo in LOOKUP_HELPERS would turn its "cannot run" test into a 42883 that proves nothing.
    const res = await db.query<{ name: string }>(
      `select distinct p.proname as name from pg_proc p
       join pg_namespace n on n.oid = p.pronamespace and n.nspname = 'public'
       where p.proname = any($1::text[]) order by 1`,
      [Object.keys(LOOKUP_HELPERS)],
    );
    expect(res.rows.map((r) => r.name)).toEqual(Object.keys(LOOKUP_HELPERS).sort());
  });
});
