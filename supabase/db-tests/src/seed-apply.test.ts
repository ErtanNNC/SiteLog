import { beforeAll, describe, expect, it } from 'vitest';
import type { PGlite } from '@electric-sql/pglite';
import {
  buildSeedSql,
  OFFICE_PASSWORD_HASH_SQL,
  PRUNED_TABLES,
  pruneSql,
} from '@sitelog/shared/demo/seed-sql.ts';
import { DEMO_ORG_ID, DEMO_USERS } from '@sitelog/shared/demo/kestrel.ts';
import { DEMIR_ORG_ID, DEMIR_USERS } from '@sitelog/shared/demo/demir.ts';
import { bootDatabase } from './harness.ts';

/**
 * GAP D8: `pnpm seed:demo -- --apply` runs buildSeedSql() (the script supabase/seed.sql holds) on a
 * database that may already hold the demo orgs and other orgs. Applying twice gives the same
 * rows, a later apply resets the demo orgs (also to another date, D36), other orgs are never
 * touched, and an org with a demo id that is not a demo org stops it before it writes anything.
 * The real-Postgres run is supabase/db-tests/stack/seed-apply.test.ts.
 */

const TABLES = ['orgs', 'org_members', ...PRUNED_TABLES];

/** Ids of the other org's rows: `other(n)`. */
const other = (n: number) => `0a000000-0000-4000-8000-${n.toString(16).padStart(12, '0')}`;
const OTHER_ORG = other(1);
const OTHER_USER = other(0xaa);
const [SITE, REPORTER, SITE_DAY, COMPANY, REPORT, UPLOAD, CALL] = [2, 3, 4, 5, 6, 8, 14].map(other);
/** Every id the other org's rows carry (a row that names one of them is the other org's). */
const OTHER_IDS = [OTHER_USER, ...Array.from({ length: 0x18 }, (_, i) => other(i + 1))];

let db: PGlite;
const APPLY = buildSeedSql({ globalRows: false });

/** Every row of the seeded tables (and the demo users), as sorted JSON per table. */
async function snapshot(where?: { ids: string[] }): Promise<Record<string, string[]>> {
  const out: Record<string, string[]> = {};
  for (const t of TABLES) {
    const rows = await db.query<{ r: Record<string, unknown> }>(
      `select to_jsonb(x) as r from ${t} x`,
    );
    out[t] = rows.rows
      .map((r) => JSON.stringify(r.r))
      .filter((r) => !where || where.ids.some((id) => r.includes(id)))
      .sort();
  }
  // The demo users (the other org's owner is no demo row: its snapshot leaves auth.users out).
  if (!where) {
    const users = await db.query<{ r: unknown }>(
      `select to_jsonb(u) - 'encrypted_password' as r from auth.users u order by id`,
    );
    out['auth.users'] = users.rows.map((r) => JSON.stringify(r.r));
  }
  return out;
}

/**
 * Another org with a row in every table the prune touches, each reached the way a demo org's is:
 * by org, site, reporter, report, site day, upload, call, message or conversation. A prune that
 * reached past a demo org would delete one of them (or fail on its foreign keys).
 */
async function addOtherOrg(): Promise<void> {
  const [O, SDAY, RPT, UP] = [OTHER_ORG, SITE_DAY, REPORT, UPLOAD];
  await db.exec(`
    insert into auth.users (id, email) values ('${OTHER_USER}', 'owner@other.example');
    insert into orgs (id, name, timezone) values ('${O}', 'Other Builders', 'America/Denver');
    insert into org_members (org_id, user_id, role) values ('${O}', '${OTHER_USER}', 'admin');
    insert into sites (id, org_id, name, project_code, timezone)
      values ('${SITE}', '${O}', 'Other Site', 'OT-0001', 'America/Denver');
    insert into reporters (id, org_id, name, phone_e164, status)
      values ('${REPORTER}', '${O}', 'Other Person', '+15550190001', 'active');
    insert into site_reporters (site_id, reporter_id, is_primary) values ('${SITE}', '${REPORTER}', true);
    insert into site_recipients (site_id, email) values ('${SITE}', 'office@other.example');
    insert into companies (id, org_id, name) values ('${COMPANY}', '${O}', 'Other Concrete');
    insert into site_days (id, site_id, date, deadline_at)
      values ('${SDAY}', '${SITE}', '2026-10-09', '2026-10-09T23:30:00Z');
    insert into reports (id, org_id, site_id, site_day_id, report_no, reporter_id, status, channel, language)
      values ('${RPT}', '${O}', '${SITE}', '${SDAY}', 'OT-0001-0001', '${REPORTER}', 'filed', 'web', 'en');
    insert into report_versions (report_id, version, data, author) values ('${RPT}', 1, '{}'::jsonb, 'agent');
    insert into uploads (id, report_id, reporter_id, site_id, kind, storage_path)
      values ('${UP}', '${RPT}', '${REPORTER}', '${SITE}', 'audio', '${O}/${SITE}/2026-10-09/${UP}.webm');
    insert into report_sources (id, report_id, kind, upload_id) values ('${other(7)}', '${RPT}', 'voice_note', '${UP}');
    insert into transcripts (id, upload_id, text, segments) values ('${other(9)}', '${UP}', 'Other words', '[]'::jsonb);
    insert into manpower_entries (id, report_id, version, company_id, company_name, workers, hours)
      values ('${other(10)}', '${RPT}', 1, '${COMPANY}', 'Other Concrete', 2, 16);
    insert into work_items (id, report_id, version, area, activity, status)
      values ('${other(11)}', '${RPT}', 1, 'Deck', 'Pour', 'complete');
    insert into weather_events (id, report_id, version, site_id, date, condition, lost_hours)
      values ('${other(12)}', '${RPT}', 1, '${SITE}', '2026-10-09', 'Rain', 1);
    insert into questions (id, report_id, channel, field, prompt)
      values ('${other(13)}', '${RPT}', 'web', 'manpower.workers', 'How many?');
    insert into calls (id, org_id, reporter_id, site_id, report_id, direction)
      values ('${CALL}', '${O}', '${REPORTER}', '${SITE}', '${RPT}', 'inbound');
    insert into voice_tool_requests (call_id, request_key, tool, status, response)
      values ('${CALL}', 'other-req', 'end_call', 200, '{"ok": true}'::jsonb);
    insert into unknown_contacts (id, org_id, phone_e164, channel, call_id)
      values ('${other(15)}', '${O}', '+15550190009', 'voice', '${CALL}');
    insert into conversations (id, org_id, reporter_id, phone_e164)
      values ('${other(17)}', '${O}', '${REPORTER}', '+15550190001');
    insert into messages (id, org_id, reporter_id, phone_e164, direction, body, provider, copy_key)
      values ('${other(16)}', '${O}', '${REPORTER}', '+15550190001', 'out', 'Hello', 'console', 'welcome');
    insert into notifications (id, org_id, kind, title) values ('${other(18)}', '${O}', 'test', 'Other');
    insert into console_emails (id, org_id, kind, recipients, subject, body_text)
      values ('${other(25)}', '${O}', 'report_filed', '{office@other.example}', 'Other report', 'Other body');
    insert into sub_invoices (id, org_id, company_id, invoice_no, period_start, period_end)
      values ('${other(19)}', '${O}', '${COMPANY}', 'OT-1', '2026-10-05', '2026-10-09');
    insert into evidence_packs (id, org_id, site_id, period_start, period_end)
      values ('${other(20)}', '${O}', '${SITE}', '2026-10-01', '2026-10-09');
    insert into glossary_terms (id, org_id, heard, official) values ('${other(21)}', '${O}', 'slab', 'Slab');
    insert into consents (id, reporter_id, type, method, text_version)
      values ('${other(22)}', '${REPORTER}', 'sms', 'web_checkbox', 'other-1');
    insert into field_links (id, code_hash, reporter_id, kind) values ('${other(23)}', 'other-hash', '${REPORTER}', 'personal');
    insert into field_devices (id, reporter_id, device_token_hash) values ('${other(24)}', '${REPORTER}', 'other-device');
    insert into test_clips (id, org_id, reporter_id, storage_path, mime)
      values ('${other(26)}', '${O}', '${REPORTER}', 'test/other/clip.webm', 'audio/webm');
    insert into draft_corrections (id, org_id, report_id, reporter_id, via, text)
      values ('${other(27)}', '${O}', '${RPT}', '${REPORTER}', 'text', 'Other fix');
    insert into push_subscriptions (id, org_id, reporter_id, device_id, endpoint, p256dh, auth)
      values ('${other(28)}', '${O}', '${REPORTER}', '${other(24)}', 'https://fcm.googleapis.com/fcm/send/other', 'k', 'a');
    insert into report_costs (report_id, org_id, kind, filed_at, cost_cents)
      values ('${RPT}', '${O}', 'daily', '2026-10-09T23:00:00Z', 12);
    insert into audit_log (org_id, actor_type, action) values ('${O}', 'system', 'other.thing');
    insert into jobs (type, payload) values
      ('render_pdf', '{"reportId":"${RPT}","version":1}'::jsonb),
      ('fetch_weather', '{"siteId":"${SITE}","date":"2026-10-09"}'::jsonb);
  `);
}

beforeAll(async () => {
  db = await bootDatabase();
  await addOtherOrg();
});

describe('seed:demo --apply (D8)', () => {
  it('applies twice with the same rows, and leaves the other org alone', async () => {
    const others = await snapshot({ ids: OTHER_IDS });
    // The other org has a row in every table the prune touches, so a prune that reached past a
    // demo org would show here.
    for (const t of TABLES) expect(others[t]!.length, t).toBeGreaterThan(0);
    await db.exec(APPLY);
    const first = await snapshot();
    expect(first.reports!.length).toBeGreaterThan(60);
    expect(first.audit_log!.filter((r) => r.includes(DEMIR_ORG_ID)).length).toBeGreaterThan(0);
    expect(await snapshot({ ids: OTHER_IDS })).toEqual(others);
    await db.exec(APPLY);
    expect(await snapshot()).toEqual(first);
    expect(await snapshot({ ids: OTHER_IDS })).toEqual(others);
    // The built-in terms belong to every org: an apply writes none.
    expect((await db.query(`select 1 from glossary_terms where org_id is null`)).rows).toHaveLength(
      0,
    );
  });

  it('resets the demo orgs: rows added later go, members added later stay', async () => {
    const seeded = await snapshot();
    const others = await snapshot({ ids: OTHER_IDS });
    const hero = (
      await db.query<{ id: string }>(`select id from reports where report_no = 'RL-2041-0187'`)
    ).rows[0]!.id;
    const site = (
      await db.query<{ id: string }>(
        `select id from sites where org_id = $1 and project_code = 'ES-0377'`,
        [DEMO_ORG_ID],
      )
    ).rows[0]!.id;
    const reporter = (
      await db.query<{ id: string }>(
        `select id from reporters where org_id = $1 and name = 'Priya Raman'`,
        [DEMO_ORG_ID],
      )
    ).rows[0]!.id;
    await db.exec(`
      insert into auth.users (id, email) values ('0b000000-0000-4000-8000-000000000001', 'visitor@example.com');
      insert into org_members (org_id, user_id, role) values ('${DEMIR_ORG_ID}', '0b000000-0000-4000-8000-000000000001', 'pm');
      insert into messages (org_id, reporter_id, phone_e164, direction, body, provider, copy_key)
        values ('${DEMO_ORG_ID}', '${reporter}', '+15550147719', 'out', 'Extra', 'console', 'daily_link');
      insert into field_devices (reporter_id, device_token_hash) values ('${reporter}', 'abc');
      insert into notifications (org_id, kind, title) values ('${DEMO_ORG_ID}', 'test', 'Extra');
      insert into audit_log (org_id, actor_type, action) values ('${DEMO_ORG_ID}', 'system', 'demo.extra');
      update site_days set status = 'no_work' where site_id = '${site}' and date = '2026-10-09';
      -- Jobs of the last rehearsal go with the rows they name, finished ones too: since W1-10 (D16)
      -- a dedupe key is never reused, so a done job would keep the next rehearsal's from running.
      insert into jobs (type, payload, status, dedupe_key) values
        ('render_pdf', '{"reportId":"${hero}","version":2}', 'queued', 'render_pdf:${hero}:2'),
        ('fetch_weather', '{"siteId":"${site}","date":"2026-10-09"}', 'running', null),
        ('send_email', '{"kind":"report_missing","orgId":"${DEMO_ORG_ID}"}', 'queued', null),
        ('render_pdf', '{"reportId":"${hero}","version":1}', 'done', 'render_pdf:${hero}:1');
    `);
    await db.exec(APPLY);
    const after = await snapshot();
    const isVisitor = (row: string) => row.includes('0b000000-0000-4000-8000-000000000001');
    expect(after.org_members!.filter(isVisitor)).toHaveLength(1);
    expect({
      ...after,
      org_members: after.org_members!.filter((m) => !isVisitor(m)),
      'auth.users': after['auth.users']!.filter((u) => !isVisitor(u)),
    }).toEqual(seeded);
    expect(await snapshot({ ids: OTHER_IDS })).toEqual(others);
    // Demir Yapı keeps its seeded admin next to the visitor; Kestrel's members are unchanged.
    const members = await db.query<{ org_id: string; email: string; role: string }>(
      `select m.org_id::text, u.email, m.role::text from org_members m join auth.users u on u.id = m.user_id
       where m.org_id in ($1, $2) order by 1, 2`,
      [DEMO_ORG_ID, DEMIR_ORG_ID],
    );
    expect(members.rows.filter((m) => m.org_id === DEMIR_ORG_ID)).toEqual([
      { org_id: DEMIR_ORG_ID, email: 'elif@demiryapi.example', role: 'admin' },
      { org_id: DEMIR_ORG_ID, email: 'visitor@example.com', role: 'pm' },
    ]);
    expect(members.rows.filter((m) => m.org_id === DEMO_ORG_ID).map((m) => m.email)).toEqual([
      'accounts@kestrelbuild.example',
      'lena@kestrelbuild.example',
      'sam@kestrelbuild.example',
    ]);
    await db.exec(`delete from jobs where status = 'done'`);
    await db.exec(`delete from auth.users where id = '0b000000-0000-4000-8000-000000000001'`);
  });

  it('moves the demo to another date and back (D36)', async () => {
    const oct9 = await snapshot();
    await db.exec(buildSeedSql({ date: '2026-11-06', globalRows: false }));
    const live = await db.query<{ status: string; n: number }>(
      `select sd.status::text as status, count(*)::int as n from site_days sd join sites s on s.id = sd.site_id
       where s.org_id = $1 and sd.date = '2026-11-06' group by 1 order by 1`,
      [DEMO_ORG_ID],
    );
    expect(live.rows).toEqual([
      { status: 'filed', n: 1 },
      { status: 'pending', n: 5 },
    ]);
    const last = await db.query<{ d: string }>(
      `select max(sd.date)::text as d from site_days sd join sites s on s.id = sd.site_id
       where s.org_id = $1 and sd.date < '2026-11-06'`,
      [DEMO_ORG_ID],
    );
    expect(last.rows[0]!.d).toBe('2026-11-05');
    // Wall-clock times survive the end of DST (Nov 1): deadlines are 17:30 Chicago on both sides.
    const deadlines = await db.query<{ t: string }>(
      `select distinct to_char(deadline_at at time zone 'America/Chicago', 'HH24:MI') as t
       from site_days sd join sites s on s.id = sd.site_id where s.org_id = $1`,
      [DEMO_ORG_ID],
    );
    expect(deadlines.rows).toEqual([{ t: '17:30' }]);
    // The next number the live demo hands Marco is §18.1's.
    const seq = await db.query<{ n: string }>(
      `select next_report_no(id) as n from sites where org_id = $1 and project_code = 'RL-2041'`,
      [DEMO_ORG_ID],
    );
    expect(seq.rows[0]!.n).toBe('RL-2041-0187');
    await db.exec(APPLY);
    const back = await snapshot();
    // next_report_no moved the sequence; the apply put it back with the rest.
    expect(back).toEqual(oct9);
  });

  it("sets the apply's office password on the demo users, never seed.sql's", async () => {
    // Every demo office user, Kestrel's and Demir Yapı's TR admin alike.
    const users = [...DEMO_USERS, ...DEMIR_USERS].map((u) => u.id);
    expect(users).toHaveLength(4);
    const matches = async (password: string) => {
      const rows = await db.query<{ ok: boolean }>(
        `select encrypted_password = crypt($1, encrypted_password) as ok from auth.users where id = any($2::uuid[])`,
        [password, users],
      );
      expect(rows.rows).toHaveLength(users.length);
      const ok = new Set(rows.rows.map((r) => r.ok));
      // All four or none: one mechanism for every demo user.
      expect(ok.size).toBe(1);
      return [...ok][0]!;
    };
    // As seed-demo.ts: the database hashes the password from a bind parameter, the script gets
    // only the hash.
    const applyWith = async (password: string) => {
      const hash = (await db.query<{ hash: string }>(OFFICE_PASSWORD_HASH_SQL, [password])).rows[0]!
        .hash;
      const sql = buildSeedSql({ globalRows: false, officePasswordHash: hash });
      expect(sql).not.toContain(password);
      await db.exec(sql);
    };
    expect(await matches('sitelog-demo')).toBe(true);
    await applyWith('rehearsal-password-1');
    expect(await matches('rehearsal-password-1')).toBe(true);
    expect(await matches('sitelog-demo')).toBe(false);
    // seed.sql's script leaves an existing user's password alone; another apply sets its own.
    await db.exec(APPLY);
    expect(await matches('rehearsal-password-1')).toBe(true);
    await applyWith('rehearsal-password-2');
    expect(await matches('rehearsal-password-2')).toBe(true);
    // Only the demo users: the other org's owner keeps no password.
    const owner = await db.query<{ p: string | null }>(
      `select encrypted_password as p from auth.users where id = $1`,
      [OTHER_USER],
    );
    expect(owner.rows[0]!.p).toBeNull();
    await applyWith('sitelog-demo');
  });

  it('refuses an org with a demo id that is not a demo org, and writes nothing', async () => {
    const before = await snapshot();
    await db.exec(`update orgs set is_demo = false where id = '${DEMIR_ORG_ID}'`);
    await expect(db.exec(APPLY)).rejects.toThrow(/is not a demo org \(is_demo = false\)/);
    await db.exec('rollback');
    await db.exec(`update orgs set is_demo = true where id = '${DEMIR_ORG_ID}'`);
    expect(await snapshot()).toEqual(before);
  });

  it('prunes every table that can hold a demo org’s rows', async () => {
    // A table with one of these key columns holds rows of an org, site, reporter, report or
    // their media; each must be emptied for the demo orgs (or be the org or its members).
    const keyed = await db.query<{ table_name: string }>(`
      select distinct table_name::text from information_schema.columns
      where table_schema = 'public'
        and column_name in ('org_id', 'site_id', 'reporter_id', 'report_id', 'site_day_id',
                            'upload_id', 'call_id', 'message_id', 'conversation_id', 'company_id')
        and table_name in (select table_name from information_schema.tables
                           where table_schema = 'public' and table_type = 'BASE TABLE')
      order by 1`);
    const covered = new Set<string>([...PRUNED_TABLES, 'orgs', 'org_members']);
    expect(keyed.rows.map((r) => r.table_name).filter((t) => !covered.has(t))).toEqual([]);
    // …and the SQL the apply runs deletes from each of them, for each demo org.
    for (const org of [DEMO_ORG_ID, DEMIR_ORG_ID]) {
      const deletes = new Set(
        pruneSql(org)
          .split('\n')
          .map((l) => /^delete from (\w+) where /.exec(l)?.[1])
          .filter(Boolean),
      );
      for (const t of keyed.rows.map((r) => r.table_name))
        if (t !== 'orgs' && t !== 'org_members') expect(deletes.has(t), t).toBe(true);
      expect(APPLY).toContain(pruneSql(org));
    }
  });
});
