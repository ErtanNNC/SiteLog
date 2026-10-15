import { beforeAll, describe, expect, it } from 'vitest';
import type { PGlite } from '@electric-sql/pglite';
import {
  NOTIFICATION_AUDIENCE_KINDS,
  notificationAudience,
} from '@sitelog/shared/notifications.ts';
import {
  applyMigration,
  asService,
  asUser,
  bootDatabase,
  probeAs,
  type Caller,
} from './harness.ts';
import {
  ORG,
  SHARED,
  SPARE_USER,
  objectName,
  seedTwoOrgs,
  type OrgKey,
  type Role,
} from './fixtures/two-orgs.ts';

/**
 * 20261014000001_queue_rls_fixes.sql (W1-05 step 9; GAP D21, D22): the deferred RLS defects of
 * docs/AUDIT_BACKLOG.md and the accounts role of §2.2, scenario by scenario. The role matrix
 * (role-matrix.test.ts) checks every cell; these tests follow a fix through the writes and
 * readers around it (the service role, cascades, audit rows, realtime, the panel's columns).
 */

let db: PGlite;
const A = ORG.A;
const B = ORG.B;

beforeAll(async () => {
  db = await bootDatabase({ storage: true, realtime: true });
  await seedTwoOrgs(db);
});

const caller = (org: OrgKey, role: Role): Caller => ({
  role: 'authenticated',
  userId: ORG[org].users[role],
  email: `${role}-${org}@matrix.test`,
});

async function svc<T = Record<string, unknown>>(sql: string, params: unknown[] = []) {
  return (await asService(db, (q) => q<T>(sql, params))).rows;
}

/** Runs one statement as a user of the fixture and commits it (no rollback). */
async function as<T = Record<string, unknown>>(
  org: OrgKey,
  role: Role,
  sql: string,
  params: unknown[] = [],
) {
  const user = ORG[org].users[role];
  return asUser(db, user, (q) => q<T>(sql, params), `${role}-${org}@matrix.test`);
}

/** The SQLSTATE a statement fails with (or 'ok'). */
async function codeOf(p: Promise<unknown>): Promise<string> {
  try {
    await p;
    return 'ok';
  } catch (err) {
    return (err as { code?: string }).code ?? String(err);
  }
}

/** Switches the open transaction to `user` (as the API does for a signed-in request). */
async function become(user: string) {
  await db.query(`select set_config('request.jwt.claim.sub', $1, true)`, [user]);
  await db.query(`select set_config('request.jwt.claim.role', 'authenticated', true)`);
  await db.query(`select set_config('request.jwt.claims', $1, true)`, [
    JSON.stringify({ sub: user, role: 'authenticated' }),
  ]);
  await db.exec('set local role authenticated');
}

/** Runs `fn` in a transaction that is always rolled back (setup as the owner, then `become`). */
async function rolledBack<T>(fn: () => Promise<T>): Promise<T> {
  await db.exec('begin');
  try {
    return await fn();
  } finally {
    await db.exec('rollback');
  }
}

/** A's admin is also an admin of B: the policies' org checks pass on both sides. */
const DUAL_ADMIN = `insert into org_members (org_id, user_id, role) values ('${B.org}', '${A.users.admin}', 'admin')`;

describe('site_reporters: reporter and site of one org', () => {
  it('refuses a cross-org link from the panel (RLS) and from the service (trigger)', async () => {
    const insert = `insert into site_reporters (site_id, reporter_id) values ('${A.site}', '${B.reporter2}')`;
    for (const role of ['admin', 'ops'] as const) {
      const res = await probeAs(db, caller('A', role), insert);
      expect(res.ok ? 'ok' : res.code, role).toBe('42501');
    }
    expect(await codeOf(svc(insert))).toBe('23514');
    expect(
      await codeOf(
        svc(
          `update site_reporters set reporter_id = '${B.reporter2}' where site_id = '${A.site}' and reporter_id = '${A.reporter}'`,
        ),
      ),
    ).toBe('23514');
  });

  it('keeps same-org links working for the panel, the service and update_reporter()', async () => {
    const res = await probeAs(
      db,
      caller('A', 'ops'),
      `insert into site_reporters (site_id, reporter_id, is_primary) values ('${A.site}', '${A.reporter2}', false)`,
    );
    expect(res.ok).toBe(true);
    await svc(
      `insert into site_reporters (site_id, reporter_id, is_primary) values ($1, $2, false)`,
      [A.site, A.reporter2],
    );
    await as(
      'A',
      'admin',
      `select update_reporter($1, 'Backup A', 'backup', array[$2]::uuid[], array['en'])`,
      [A.reporter2, A.site],
    );
    await svc(`delete from site_reporters where reporter_id = $1`, [A.reporter2]);
  });

  it('keeps both ends in their org: an admin of both orgs cannot move a site, nor can the service', async () => {
    const move = (sql: string) =>
      rolledBack(async () => {
        await db.exec(DUAL_ADMIN);
        await become(A.users.admin);
        return codeOf(db.query(sql));
      });
    // Before 20261014000001 this moved the site, its links, site days and uploads to B.
    expect(await move(`update sites set org_id = '${B.org}' where id = '${A.site}'`)).toBe('42501');
    expect(await move(`update sites set report_seq = 0 where id = '${A.site}'`)).toBe('42501');
    expect(await move(`update sites set name = 'Site A' where id = '${A.site}'`)).toBe('ok');
    expect(await codeOf(svc(`update sites set org_id = $1 where id = $2`, [B.org, A.site]))).toBe(
      '23514',
    );
    expect(
      await codeOf(svc(`update reporters set org_id = $1 where id = $2`, [B.org, A.reporter])),
    ).toBe('23514');
    // A write that keeps the org passes the guard.
    await svc(`update sites set org_id = org_id, name = name where id = $1`, [A.site]);
    const [site] = await svc<{ org_id: string }>(`select org_id from sites where id = $1`, [
      A.site,
    ]);
    expect(site!.org_id).toBe(A.org);
  });
});

describe('evidence_packs: requested through api-evidence-pack only', () => {
  it('gives API roles read access and no write privilege; the service still files packs', async () => {
    const [priv] = await svc<Record<string, boolean>>(`
      select has_table_privilege('authenticated', 'evidence_packs', 'select') as auth_select,
             has_table_privilege('authenticated', 'evidence_packs', 'insert') as auth_insert,
             has_table_privilege('authenticated', 'evidence_packs', 'update') as auth_update,
             has_table_privilege('authenticated', 'evidence_packs', 'delete') as auth_delete,
             has_table_privilege('anon', 'evidence_packs', 'select') as anon_select`);
    expect(priv).toEqual({
      auth_select: true,
      auth_insert: false,
      auth_update: false,
      auth_delete: false,
      anon_select: false,
    });
    const [pack] = await svc<{ id: string }>(
      `insert into evidence_packs (org_id, site_id, period_start, period_end, status, created_by)
       values ($1, $2, '2026-09-01', '2026-09-30', 'queued', $3) returning id`,
      [A.org, A.site, A.users.pm],
    );
    const seen = await probeAs(
      db,
      caller('A', 'pm'),
      `select 1 from evidence_packs where id = '${pack!.id}'`,
    );
    expect(seen.ok && seen.rows.length).toBe(1);
    await svc(`delete from evidence_packs where id = $1`, [pack!.id]);
  });
});

describe('rows written while the holes were open', () => {
  it('removes cross-org links and clears forged pack paths when the migration runs, with audit rows', async () => {
    const MIGRATION = '20261014000001_queue_rls_fixes.sql';
    const old = await bootDatabase({ storage: true, realtime: true, until: MIGRATION });
    try {
      await seedTwoOrgs(old);
      const own = `${A.org}/${A.site}/eot_2026-09-01_2026-09-30.pdf`;
      const foreign = `${B.org}/${B.site}/eot_2026-10-01_2026-10-09.pdf`;
      await old.exec(`
        insert into site_reporters (site_id, reporter_id) values ('${A.site}', '${B.reporter2}');
        insert into evidence_packs (id, org_id, site_id, period_start, period_end, status, pdf_path) values
          ('aaaaaaaa-2222-4000-8000-000000000001', '${A.org}', '${A.site}', '2026-10-01', '2026-10-09', 'ready', '${foreign}'),
          ('aaaaaaaa-2222-4000-8000-000000000002', '${A.org}', null, '2026-10-01', '2026-10-09', 'ready', '${A.org}/x.pdf'),
          ('aaaaaaaa-2222-4000-8000-000000000003', '${A.org}', '${A.site}', '2026-09-01', '2026-09-30', 'ready', '${own}'),
          ('aaaaaaaa-2222-4000-8000-000000000004', '${A.org}', '${B.site}', '2026-10-01', '2026-10-09', 'queued', null);
      `);
      await applyMigration(old, MIGRATION);
      const links = await old.query<{ reporter_id: string }>(
        `select reporter_id from site_reporters where site_id = $1 order by reporter_id`,
        [A.site],
      );
      expect(links.rows.map((r) => r.reporter_id)).toEqual([A.reporter]);
      const packs = await old.query<{ n: string; status: string; pdf_path: string | null }>(
        `select right(id::text, 1) as n, status::text, pdf_path from evidence_packs
         where id::text like 'aaaaaaaa-2222-%' order by id`,
      );
      expect(packs.rows).toEqual([
        { n: '1', status: 'failed', pdf_path: null },
        { n: '2', status: 'failed', pdf_path: null },
        { n: '3', status: 'ready', pdf_path: own },
        { n: '4', status: 'failed', pdf_path: null }, // another org's site
      ]);
      const log = await old.query<{
        org_id: string;
        action: string;
        diff: Record<string, unknown>;
      }>(
        `select org_id, action, diff from audit_log
         where action in ('site_reporter.removed_cross_org', 'evidence_pack.forged_cleared')
         order by action desc, entity_id`,
      );
      expect(log.rows).toEqual([
        {
          org_id: A.org,
          action: 'site_reporter.removed_cross_org',
          diff: expect.objectContaining({ siteId: A.site, reporterOrgId: B.org }) as unknown,
        },
        {
          org_id: A.org,
          action: 'evidence_pack.forged_cleared',
          diff: expect.objectContaining({ pdfPath: foreign, status: 'ready' }) as unknown,
        },
        {
          org_id: A.org,
          action: 'evidence_pack.forged_cleared',
          diff: expect.objectContaining({ pdfPath: `${A.org}/x.pdf`, siteId: null }) as unknown,
        },
        {
          org_id: A.org,
          action: 'evidence_pack.forged_cleared',
          diff: expect.objectContaining({
            siteId: B.site,
            status: 'queued',
            pdfPath: null,
          }) as unknown,
        },
      ]);
    } finally {
      await old.close();
    }
  }, 60_000);
});

describe('org_members: an org keeps at least one admin', () => {
  /** A fresh org with the given members (user ids are new auth users). */
  async function orgWith(name: string, roles: Role[]): Promise<{ org: string; users: string[] }> {
    const [org] = await svc<{ id: string }>(`insert into orgs (name) values ($1) returning id`, [
      name,
    ]);
    const users: string[] = [];
    for (const [i, role] of roles.entries()) {
      const [u] = await svc<{ id: string }>(
        `insert into auth.users (id, email) values (gen_random_uuid(), $1) returning id`,
        [`${name.replace(/\W/g, '').toLowerCase()}-${i}@guard.test`],
      );
      await svc(`insert into org_members (org_id, user_id, role) values ($1, $2, $3)`, [
        org!.id,
        u!.id,
        role,
      ]);
      users.push(u!.id);
    }
    return { org: org!.id, users };
  }
  const roleOf = async (org: string, user: string) =>
    (
      await svc<{ role: string }>(
        `select role::text from org_members where org_id = $1 and user_id = $2`,
        [org, user],
      )
    )[0]?.role;

  it('hands the admin role over, then refuses to demote the last admin', async () => {
    const { org, users } = await orgWith('Guard handover', ['admin', 'pm']);
    const [first, second] = users as [string, string];
    const run = (user: string, sql: string) => asUser(db, user, (q) => q(sql, [org]));
    await run(
      first,
      `update org_members set role = 'admin' where org_id = $1 and user_id = '${second}'`,
    );
    await run(
      first,
      `update org_members set role = 'ops' where org_id = $1 and user_id = '${first}'`,
    );
    expect(await roleOf(org, first)).toBe('ops');
    expect(
      await codeOf(
        run(
          second,
          `update org_members set role = 'pm' where org_id = $1 and user_id = '${second}'`,
        ),
      ),
    ).toBe('P0001');
    expect(await roleOf(org, second)).toBe('admin');
    // The audit trail of the panel's changes.
    const log = await svc<{ action: string; actor_id: string; entity_id: string; diff: unknown }>(
      `select action, actor_id, entity_id, diff from audit_log where org_id = $1 and entity = 'org_member' order by id`,
      [org],
    );
    expect(log).toEqual([
      {
        action: 'member.role_changed',
        actor_id: first,
        entity_id: second,
        diff: { role: { from: 'pm', to: 'admin' } },
      },
      {
        action: 'member.role_changed',
        actor_id: first,
        entity_id: first,
        diff: { role: { from: 'admin', to: 'ops' } },
      },
    ]);
  });

  it('lets an admin remove another admin, but not the last one, also for the service', async () => {
    const { org, users } = await orgWith('Guard removal', ['admin', 'admin', 'ops']);
    const [a1, a2, ops] = users as [string, string, string];
    await asUser(db, a1, (q) =>
      q(`delete from org_members where org_id = $1 and user_id = $2`, [org, a2]),
    );
    expect(await roleOf(org, a2)).toBeUndefined();
    const [removed] = await svc<{ action: string; diff: unknown }>(
      `select action, diff from audit_log where org_id = $1 and action = 'member.removed'`,
      [org],
    );
    expect(removed).toEqual({ action: 'member.removed', diff: { role: 'admin' } });
    // The service is held to it too (a support fix must promote someone first).
    expect(
      await codeOf(svc(`delete from org_members where org_id = $1 and user_id = $2`, [org, a1])),
    ).toBe('P0001');
    expect(await codeOf(svc(`update org_members set role = 'ops' where org_id = $1`, [org]))).toBe(
      'P0001',
    );
    await svc(`update org_members set role = 'admin' where org_id = $1 and user_id = $2`, [
      org,
      ops,
    ]);
    await svc(`update org_members set role = 'pm' where org_id = $1 and user_id = $2`, [org, a1]);
    expect(await roleOf(org, a1)).toBe('pm');
    // Service writes are not logged by the trigger (the service logs its own).
    const serviceLogged = await svc(
      `select 1 from audit_log where org_id = $1 and entity = 'org_member' and actor_id is null`,
      [org],
    );
    expect(serviceLogged).toEqual([]);
  });

  it('keeps the key of a member row: no seat handed to another account, no move between orgs', async () => {
    const run = (sql: string) =>
      rolledBack(async () => {
        await db.exec(DUAL_ADMIN);
        await become(A.users.admin);
        return codeOf(db.query(sql));
      });
    expect(
      await run(
        `update org_members set user_id = '${SPARE_USER}' where org_id = '${A.org}' and user_id = '${A.users.pm}'`,
      ),
    ).toBe('42501');
    expect(
      await run(
        `update org_members set org_id = '${B.org}' where org_id = '${A.org}' and user_id = '${A.users.ops}'`,
      ),
    ).toBe('42501');
    // The last admin cannot hand the org to another account either.
    expect(
      await run(
        `update org_members set user_id = '${SPARE_USER}' where org_id = '${A.org}' and user_id = auth.uid()`,
      ),
    ).toBe('42501');
  });

  it('logs a key change by a writer that keeps the privilege as a removal plus an addition', async () => {
    const log = await rolledBack(async () => {
      await db.exec(
        `grant update (org_id, user_id) on org_members to authenticated; ${DUAL_ADMIN}`,
      );
      await become(A.users.admin);
      await db.query(`update org_members set user_id = $1 where org_id = $2 and user_id = $3`, [
        SPARE_USER,
        A.org,
        A.users.pm,
      ]);
      await db.query(`update org_members set org_id = $1 where org_id = $2 and user_id = $3`, [
        B.org,
        A.org,
        A.users.ops,
      ]);
      await db.exec('reset role');
      return (
        await db.query<{ org: string; action: string; entity_id: string; diff: unknown }>(
          `select case org_id when $2 then 'A' when $3 then 'B' end as org, action, entity_id, diff
           from audit_log where entity = 'org_member' and actor_id = $1 and org_id in ($2, $3)
           order by id`,
          [A.users.admin, A.org, B.org],
        )
      ).rows;
    });
    expect(log).toEqual([
      { org: 'A', action: 'member.removed', entity_id: A.users.pm, diff: { role: 'pm' } },
      { org: 'A', action: 'member.added', entity_id: SPARE_USER, diff: { role: 'pm' } },
      { org: 'A', action: 'member.removed', entity_id: A.users.ops, diff: { role: 'ops' } },
      { org: 'B', action: 'member.added', entity_id: A.users.ops, diff: { role: 'ops' } },
    ]);
  });

  it('lets a cascade through: deleting the org, or the only admin’s user account', async () => {
    const one = await orgWith('Guard cascade org', ['admin']);
    await svc(`delete from orgs where id = $1`, [one.org]);
    expect(await svc(`select 1 from org_members where org_id = $1`, [one.org])).toEqual([]);
    const two = await orgWith('Guard cascade user', ['admin', 'ops']);
    await svc(`delete from auth.users where id = $1`, [two.users[0]]);
    expect(await roleOf(two.org, two.users[0]!)).toBeUndefined();
    expect(await roleOf(two.org, two.users[1]!)).toBe('ops');
  });
});

describe('shared phone: a tagged message is its org’s (also over realtime)', () => {
  it('message_org() reads messages.org_id before the conversation’s org', async () => {
    const [row] = await svc<{ shared: string; own: string; sms: string }>(
      `select message_org($1) as shared, message_org($2) as own, message_org($3) as sms`,
      [SHARED.message, A.message, A.smsMessage],
    );
    expect(row).toEqual({ shared: B.org, own: A.org, sms: A.org });
  });

  it('publishes messages to realtime under the messages_select policy, so A gets no event for B', async () => {
    const published = await svc<{ tablename: string }>(
      `select tablename from pg_publication_tables where pubname = 'supabase_realtime' order by 1`,
    );
    expect(published.map((r) => r.tablename)).toContain('messages');
    const [rls] = await svc<{ on: boolean }>(
      `select relrowsecurity as on from pg_class where oid = 'public.messages'::regclass`,
    );
    expect(rls!.on).toBe(true);
    // Realtime (walrus) checks each change by selecting the row as the subscriber.
    const visible = async (org: OrgKey, role: Role) => {
      const res = await probeAs(
        db,
        caller(org, role),
        `select 1 from messages where id = '${SHARED.message}'`,
      );
      return res.ok && res.rows.length === 1;
    };
    for (const role of ['admin', 'pm', 'ops', 'accounts'] as const) {
      expect(await visible('A', role), `A ${role}`).toBe(false);
      expect(await visible('B', role), `B ${role}`).toBe(role !== 'accounts');
    }
  });

  it('keeps conversations.context away from API roles and the other columns readable', async () => {
    const [priv] = await svc<Record<string, boolean>>(`
      select has_column_privilege('authenticated', 'conversations', 'context', 'select') as context,
             has_column_privilege('authenticated', 'conversations', 'state', 'select') as state,
             has_column_privilege('anon', 'conversations', 'id', 'select') as anon_id`);
    expect(priv).toEqual({ context: false, state: true, anon_id: false });
    const res = await probeAs(db, caller('A', 'ops'), `select * from conversations`);
    expect(res.ok ? 'ok' : res.code).toBe('42501');
  });
});

describe('org_settings: the panel saves settings, never the grace period', () => {
  it('lets authenticated update exactly the settings columns', async () => {
    const rows = await svc<{ column_name: string; can: boolean }>(
      `select column_name::text,
              has_column_privilege('authenticated', 'org_settings', column_name::text, 'update') as can
       from information_schema.columns
       where table_schema = 'public' and table_name = 'org_settings' order by ordinal_position`,
    );
    const denied = rows.filter((r) => !r.can).map((r) => r.column_name);
    expect(denied.sort()).toEqual(['org_id', 'past_due_grace_days']);
    const [ins] = await svc<{ can: boolean }>(
      `select has_table_privilege('authenticated', 'org_settings', 'insert') as can`,
    );
    expect(ins!.can).toBe(false);
  });

  it('saves a full settings patch as the admin and refuses the grace period', async () => {
    const cols = (
      await svc<{ c: string }>(
        `select column_name::text as c from information_schema.columns
         where table_schema = 'public' and table_name = 'org_settings'
           and column_name not in ('org_id', 'past_due_grace_days') order by ordinal_position`,
      )
    ).map((r) => r.c);
    const value: Record<string, string> = { updated_at: 'now()', default_deadline: `'18:15'` };
    const set = cols.map((c) => `${c} = ${value[c] ?? c}`);
    const ok = await probeAs(
      db,
      caller('A', 'admin'),
      `update org_settings set ${set.join(', ')} where org_id = '${A.org}' returning default_deadline::text as d`,
    );
    expect(ok.ok ? ok.rows : ok.message).toEqual([{ d: '18:15:00' }]);
    for (const role of ['pm', 'ops', 'accounts'] as const) {
      const res = await probeAs(
        db,
        caller('A', role),
        `update org_settings set default_deadline = '18:15' where org_id = '${A.org}'`,
      );
      expect(res.ok && res.affectedRows, role).toBe(0);
    }
    const grace = await probeAs(
      db,
      caller('A', 'admin'),
      `update org_settings set past_due_grace_days = 100000 where org_id = '${A.org}'`,
    );
    expect(grace.ok ? 'ok' : grace.code).toBe('42501');
  });
});

describe('accounts: hours and invoices only (§2.2)', () => {
  it('reads Crew hours, invoices and the site names, but not sites, reports or the audit log', async () => {
    const run = (sql: string) => probeAs(db, caller('A', 'accounts'), sql);
    const count = async (sql: string) => {
      const res = await run(`select count(*)::int as n from (${sql}) x`);
      if (!res.ok) throw new Error(`${sql}: ${res.code} ${res.message}`);
      return Number(res.rows[0]!.n);
    };
    expect(await count(`select * from sites`)).toBe(0);
    expect(await count(`select * from audit_log`)).toBe(0);
    expect(await count(`select * from reports`)).toBe(0);
    expect(await count(`select * from current_manpower`)).toBeGreaterThan(0);
    expect(await count(`select * from sub_invoices`)).toBeGreaterThan(0);
    expect(await count(`select * from companies`)).toBeGreaterThan(0);
    const sites = await run(`select * from site_options order by name`);
    expect(sites.ok && sites.rows).toEqual([
      {
        id: A.site,
        org_id: A.org,
        name: 'Site A',
        project_code: 'A-100',
        timezone: 'America/Chicago',
        status: 'active',
      },
    ]);
    const gaps = await run(`select * from invoice_gaps('${A.org}', '2026-10-01', '2026-10-31')`);
    expect(gaps.ok).toBe(true);
    // The pm keeps the report timeline's audit rows.
    const pm = await probeAs(
      db,
      caller('A', 'pm'),
      `select 1 from audit_log where org_id = '${A.org}'`,
    );
    expect(pm.ok && pm.rows.length).toBeGreaterThan(0);
  });

  it('reads and uploads invoice files, and no other stored file of its org', async () => {
    const run = (sql: string) => probeAs(db, caller('A', 'accounts'), sql);
    const read = await run(
      `select bucket_id from storage.objects where name like '${A.org}/%' order by 1`,
    );
    expect(read.ok && read.rows).toEqual([{ bucket_id: 'invoices' }]);
    const upload = await run(
      `insert into storage.objects (bucket_id, name) values ('invoices', '${A.org}/inv-${Date.now()}.pdf')`,
    );
    expect(upload.ok).toBe(true);
    const office = await probeAs(
      db,
      caller('A', 'ops'),
      `select 1 from storage.objects where bucket_id = 'pdfs' and name = '${objectName(A, 'pdfs')}'`,
    );
    expect(office.ok && office.rows.length).toBe(1);
  });
});

describe('notifications: §13 audiences, also when marking read', () => {
  it('marks only the rows the caller can see', async () => {
    const [missing] = await svc<{ id: string }>(
      `select notify_org($1, 'missing_report', 'Site A: no report') as id`,
      [A.org],
    );
    const [gap] = await svc<{ id: string }>(
      `select notify_org($1, 'invoice_gap', 'Apex A: 8 h gap') as id`,
      [A.org],
    );
    const ids = [missing!.id, gap!.id];
    const readAt = async () =>
      Object.fromEntries(
        (
          await svc<{ id: string; read: boolean }>(
            `select id, read_at is not null as read from notifications where id = any($1::uuid[])`,
            [ids],
          )
        ).map((r) => [r.id, r.read]),
      );
    await as('A', 'accounts', `select mark_notifications_read($1::uuid[])`, [ids]);
    expect(await readAt()).toEqual({ [missing!.id]: false, [gap!.id]: true });
    // Another org's members mark nothing.
    await as('B', 'admin', `select mark_notifications_read($1::uuid[])`, [ids]);
    expect(await readAt()).toEqual({ [missing!.id]: false, [gap!.id]: true });
    await as('A', 'ops', `select mark_notifications_read($1::uuid[])`, [ids]);
    expect(await readAt()).toEqual({ [missing!.id]: true, [gap!.id]: true });
    await svc(`delete from notifications where id = any($1::uuid[])`, [ids]);
  });

  it('lets only the service run notify_org (every overload)', async () => {
    const rows = await svc<{ fn: string; anon: boolean; authenticated: boolean; service: boolean }>(
      `select p.oid::regprocedure::text as fn, has_function_privilege('anon', p.oid, 'execute') as anon,
              has_function_privilege('authenticated', p.oid, 'execute') as authenticated,
              has_function_privilege('service_role', p.oid, 'execute') as service
       from pg_proc p where p.proname = 'notify_org' and p.pronamespace = 'public'::regnamespace`,
    );
    expect(rows.length).toBeGreaterThan(0);
    expect(rows.filter((r) => r.anon || r.authenticated || !r.service)).toEqual([]);
  });

  it('uses the same audiences as packages/shared (the demo data source filters with it)', async () => {
    const kinds = [
      ...NOTIFICATION_AUDIENCE_KINDS,
      'needs_review',
      'glossary_review',
      'pack_ready',
      'report_edited',
      'processing_delayed',
      'some_future_kind',
    ];
    const rows = await svc<{ kind: string; roles: string }>(
      `select k as kind, notification_audience(k)::text as roles from unnest($1::text[]) k`,
      [kinds],
    );
    expect(Object.fromEntries(rows.map((r) => [r.kind, r.roles]))).toEqual(
      Object.fromEntries(kinds.map((k) => [k, `{${notificationAudience(k).join(',')}}`])),
    );
  });

  it('sends a kind it does not know to admin, pm and ops, never accounts', async () => {
    const [row] = await svc<{ known: string; unknown: string }>(
      `select notification_audience('billing')::text as known,
              notification_audience('some_future_kind')::text as unknown`,
    );
    expect(row).toEqual({ known: '{admin}', unknown: '{admin,pm,ops}' });
  });
});
