import { beforeAll, describe, expect, it } from 'vitest';
import type { PGlite } from '@electric-sql/pglite';
import { asService, asUser, bootDatabase } from './harness.ts';

/** 20261012000001_web_gaps.sql: payroll column order, settings audit, logo path, reporter edit. */

const ADMIN = 'aaaaaaaa-1111-4111-8111-111111111111';
const OPS = 'aaaaaaaa-2222-4222-8222-222222222222';
const PM = 'aaaaaaaa-3333-4333-8333-333333333333';
const OUTSIDER = 'aaaaaaaa-4444-4444-8444-444444444444';

let db: PGlite;
let orgId: string;
let otherOrgId: string;
let riverside: string;
let elm: string;
let pier: string;
let foreignSite: string;
let marco: string;
let ana: string;

async function siteIn(org: string, name: string, code: string): Promise<string> {
  const r = await asService(db, (q) =>
    q<{ id: string }>(
      `insert into sites (org_id, name, project_code, timezone) values ($1, $2, $3, 'America/Chicago') returning id`,
      [org, name, code],
    ),
  );
  return r.rows[0]!.id;
}

async function reporterIn(org: string, name: string, phone: string, role: string) {
  const r = await asService(db, (q) =>
    q<{ id: string }>(
      `insert into reporters (org_id, name, phone_e164, role, status) values ($1, $2, $3, $4, 'verified') returning id`,
      [org, name, phone, role],
    ),
  );
  return r.rows[0]!.id;
}

async function links(reporterId: string) {
  const r = await asService(db, (q) =>
    q<{ site_id: string; is_primary: boolean }>(
      `select site_id, is_primary from site_reporters where reporter_id = $1 order by site_id`,
      [reporterId],
    ),
  );
  return r.rows;
}

beforeAll(async () => {
  db = await bootDatabase();
  await db.exec(
    `insert into auth.users (id, email) values ('${ADMIN}', 'lena@kestrel.test'), ('${OPS}', 'ravi@kestrel.test'), ('${PM}', 'sam@kestrel.test'), ('${OUTSIDER}', 'x@other.test');`,
  );
  orgId = await asUser(
    db,
    ADMIN,
    async (q) =>
      (await q<{ r: { id: string } }>(`select create_org('Kestrel Build Group') as r`)).rows[0]!.r
        .id,
    'lena@kestrel.test',
  );
  otherOrgId = await asUser(
    db,
    OUTSIDER,
    async (q) =>
      (await q<{ r: { id: string } }>(`select create_org('Other GC') as r`)).rows[0]!.r.id,
    'x@other.test',
  );
  await asService(db, (q) =>
    q(
      `insert into org_members (org_id, user_id, role, display_name) values ($1, $2, 'ops', 'Ravi'), ($1, $3, 'pm', 'Sam')`,
      [orgId, OPS, PM],
    ),
  );
  riverside = await siteIn(orgId, 'Riverside Lofts — Block B', 'RL-2041');
  elm = await siteIn(orgId, 'Elm St. Townhomes', 'ES-0377');
  pier = await siteIn(orgId, 'Pier 9 Warehouse Retrofit', 'P9-1120');
  foreignSite = await siteIn(otherOrgId, 'Elsewhere', 'X-1');
  marco = await reporterIn(orgId, 'Marco Ruiz', '+13125550143', 'site_manager');
  ana = await reporterIn(orgId, 'Ana Lima', '+13125550188', 'backup');
  await asService(db, (q) =>
    q(
      `insert into site_reporters (site_id, reporter_id, is_primary) values ($1, $3, true), ($2, $3, true), ($1, $4, false)`,
      [riverside, elm, marco, ana],
    ),
  );
});

describe('org_settings.payroll_columns', () => {
  it('defaults to the §F15 order and only accepts known column names', async () => {
    const res = await asUser(db, ADMIN, (q) =>
      q<{ payroll_columns: string[] }>(
        `select payroll_columns from org_settings where org_id = $1`,
        [orgId],
      ),
    );
    expect(res.rows[0]!.payroll_columns).toEqual([
      'date',
      'site',
      'project_code',
      'company',
      'trade',
      'workers',
      'hours',
      'report_no',
      'version',
    ]);
    await expect(
      asUser(db, ADMIN, (q) =>
        q(`update org_settings set payroll_columns = '{date,ssn}' where org_id = $1`, [orgId]),
      ),
    ).rejects.toThrow(/payroll_columns/);
  });

  it('saves a new order (admin only) and writes the diff to audit_log', async () => {
    const order = ['company', 'date', 'site', 'project_code', 'trade', 'workers', 'hours'];
    await asUser(db, ADMIN, (q) =>
      q(`update org_settings set payroll_columns = $2, pdf_paper = 'a4' where org_id = $1`, [
        orgId,
        order,
      ]),
    );
    const audit = await asService(db, (q) =>
      q<{ action: string; actor_id: string; actor_type: string; diff: Record<string, unknown> }>(
        `select action, actor_id, actor_type, diff from audit_log where org_id = $1 and action = 'settings.updated' order by id desc limit 1`,
        [orgId],
      ),
    );
    expect(audit.rows[0]).toMatchObject({ actor_id: ADMIN, actor_type: 'user' });
    expect(audit.rows[0]!.diff).toEqual({ payroll_columns: order, pdf_paper: 'a4' });

    // A pm cannot write settings (RLS), so nothing changes and nothing is logged.
    const before = await asService(db, (q) =>
      q<{ n: number }>(`select count(*)::int as n from audit_log where org_id = $1`, [orgId]),
    );
    await asUser(db, PM, (q) =>
      q(`update org_settings set payroll_columns = '{date}' where org_id = $1`, [orgId]),
    );
    const after = await asService(db, (q) =>
      q<{ n: number; cols: string[] }>(
        `select (select count(*)::int from audit_log where org_id = $1) as n, (select payroll_columns from org_settings where org_id = $1) as cols`,
        [orgId],
      ),
    );
    expect(after.rows[0]!.n).toBe(before.rows[0]!.n);
    expect(after.rows[0]!.cols).toEqual(order);
  });

  it('does not log no-op saves', async () => {
    const before = await asService(db, (q) =>
      q<{ n: number }>(`select count(*)::int as n from audit_log where org_id = $1`, [orgId]),
    );
    await asUser(db, ADMIN, (q) =>
      q(`update org_settings set pdf_paper = 'a4' where org_id = $1`, [orgId]),
    );
    const after = await asService(db, (q) =>
      q<{ n: number }>(`select count(*)::int as n from audit_log where org_id = $1`, [orgId]),
    );
    expect(after.rows[0]!.n).toBe(before.rows[0]!.n);
  });
});

describe('set_org_logo', () => {
  it('lets an admin set and clear the logo path, with audit rows', async () => {
    await asUser(db, ADMIN, (q) => q(`select set_org_logo($1, $2)`, [orgId, `${orgId}/logo.png`]));
    const set = await asService(db, (q) =>
      q<{ logo_path: string | null }>(`select logo_path from orgs where id = $1`, [orgId]),
    );
    expect(set.rows[0]!.logo_path).toBe(`${orgId}/logo.png`);
    await asUser(db, ADMIN, (q) => q(`select set_org_logo($1, null)`, [orgId]));
    const cleared = await asService(db, (q) =>
      q<{ logo_path: string | null }>(`select logo_path from orgs where id = $1`, [orgId]),
    );
    expect(cleared.rows[0]!.logo_path).toBeNull();
    const audit = await asService(db, (q) =>
      q<{ action: string; diff: { from: string | null; to: string | null } }>(
        `select action, diff from audit_log where entity_id = $1 and action like 'org.logo_%' order by id`,
        [orgId],
      ),
    );
    expect(audit.rows).toEqual([
      { action: 'org.logo_updated', diff: { from: null, to: `${orgId}/logo.png` } },
      { action: 'org.logo_removed', diff: { from: `${orgId}/logo.png`, to: null } },
    ]);
  });

  it('refuses non-admins and paths outside {org_id}/logo.png|svg', async () => {
    await expect(
      asUser(db, OPS, (q) => q(`select set_org_logo($1, $2)`, [orgId, `${orgId}/logo.svg`])),
    ).rejects.toThrow(/not allowed/);
    await expect(
      asUser(db, OUTSIDER, (q) => q(`select set_org_logo($1, $2)`, [orgId, `${orgId}/logo.svg`])),
    ).rejects.toThrow(/not allowed/);
    await expect(
      asUser(db, ADMIN, (q) => q(`select set_org_logo($1, $2)`, [orgId, `${otherOrgId}/logo.png`])),
    ).rejects.toThrow(/logo path/);
    await expect(
      asUser(db, ADMIN, (q) => q(`select set_org_logo($1, $2)`, [orgId, `${orgId}/logo.gif`])),
    ).rejects.toThrow(/logo path/);
  });
});

describe('update_reporter', () => {
  it('updates name, role, languages and site links atomically for ops, with an audit diff', async () => {
    const res = await asUser(db, OPS, (q) =>
      q<{ r: { added: string[]; removed: string[]; languages: string[] } }>(
        `select update_reporter($1, '  Marco A. Ruiz ', 'site_manager', $2, '{es, EN ,es}') as r`,
        [marco, [riverside, pier]],
      ),
    );
    expect(res.rows[0]!.r.added).toEqual([pier]);
    expect(res.rows[0]!.r.removed).toEqual([elm]);
    expect(res.rows[0]!.r.languages).toEqual(['es', 'en']);
    const rep = await asService(db, (q) =>
      q<{ name: string; role: string; languages: string[]; phone_e164: string }>(
        `select name, role, languages, phone_e164 from reporters where id = $1`,
        [marco],
      ),
    );
    expect(rep.rows[0]).toEqual({
      name: 'Marco A. Ruiz',
      role: 'site_manager',
      languages: ['es', 'en'],
      phone_e164: '+13125550143',
    });
    const l = await links(marco);
    expect(l).toEqual(
      [
        { site_id: riverside, is_primary: true },
        { site_id: pier, is_primary: true },
      ].sort((a, b) => a.site_id.localeCompare(b.site_id)),
    );
    const audit = await asService(db, (q) =>
      q<{ actor_id: string; diff: Record<string, unknown> }>(
        `select actor_id, diff from audit_log where entity_id = $1 and action = 'reporter.updated' order by id desc limit 1`,
        [marco],
      ),
    );
    expect(audit.rows[0]!.actor_id).toBe(OPS);
    expect(audit.rows[0]!.diff).toEqual({
      name: { from: 'Marco Ruiz', to: 'Marco A. Ruiz' },
      languages: { from: ['en'], to: ['es', 'en'] },
      sites_added: [pier],
      sites_removed: [elm],
    });
    expect(JSON.stringify(audit.rows[0]!.diff)).not.toContain('+1312');
  });

  it('promotes the next reporter when a site loses its primary', async () => {
    // Marco leaves Riverside; Ana (backup, only other reporter there) becomes primary.
    await asUser(db, ADMIN, (q) =>
      q(`select update_reporter($1, 'Marco A. Ruiz', 'site_manager', $2, '{es,en}')`, [
        marco,
        [pier],
      ]),
    );
    expect(await links(ana)).toEqual([{ site_id: riverside, is_primary: true }]);
    // Marco joins Riverside again: the site already has a primary, so he is linked as secondary.
    await asUser(db, ADMIN, (q) =>
      q(`select update_reporter($1, 'Marco A. Ruiz', 'backup', $2, '{es,en}')`, [
        marco,
        [pier, riverside],
      ]),
    );
    const l = await links(marco);
    expect(l.find((x) => x.site_id === riverside)!.is_primary).toBe(false);
    expect(l.find((x) => x.site_id === pier)!.is_primary).toBe(true);
  });

  it('validates input and refuses pm / other orgs', async () => {
    await expect(
      asUser(db, PM, (q) =>
        q(`select update_reporter($1, 'X', 'backup', $2, '{en}')`, [ana, [riverside]]),
      ),
    ).rejects.toThrow(/not allowed/);
    await expect(
      asUser(db, OUTSIDER, (q) =>
        q(`select update_reporter($1, 'X', 'backup', $2, '{en}')`, [ana, [riverside]]),
      ),
    ).rejects.toThrow(/not allowed/);
    await expect(
      asUser(db, ADMIN, (q) =>
        q(`select update_reporter($1, '  ', 'backup', $2, '{en}')`, [ana, [riverside]]),
      ),
    ).rejects.toThrow(/name required/);
    await expect(
      asUser(db, ADMIN, (q) =>
        q(`select update_reporter($1, 'Ana', 'backup', '{}', '{en}')`, [ana]),
      ),
    ).rejects.toThrow(/at least one site/);
    await expect(
      asUser(db, ADMIN, (q) =>
        q(`select update_reporter($1, 'Ana', 'backup', $2, '{en}')`, [
          ana,
          [riverside, foreignSite],
        ]),
      ),
    ).rejects.toThrow(/organisation/);
    await expect(
      asUser(db, ADMIN, (q) =>
        q(`select update_reporter($1, 'Ana', 'backup', $2, '{english}')`, [ana, [riverside]]),
      ),
    ).rejects.toThrow(/language/);
    // Failed calls leave the row and links untouched.
    expect(await links(ana)).toEqual([{ site_id: riverside, is_primary: true }]);
    const rep = await asService(db, (q) =>
      q<{ name: string }>(`select name from reporters where id = $1`, [ana]),
    );
    expect(rep.rows[0]!.name).toBe('Ana Lima');
  });

  it('defaults empty languages to English', async () => {
    const res = await asUser(db, ADMIN, (q) =>
      q<{ r: { languages: string[] } }>(
        `select update_reporter($1, 'Ana Lima', 'backup', $2, '{}') as r`,
        [ana, [riverside]],
      ),
    );
    expect(res.rows[0]!.r.languages).toEqual(['en']);
  });
});
