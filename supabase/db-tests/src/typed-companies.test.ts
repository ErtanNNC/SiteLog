import { beforeAll, describe, expect, it } from 'vitest';
import type { PGlite } from '@electric-sql/pglite';
import {
  DailyReportDataV1Schema,
  emptyReportDataV1,
  type DailyReportDataV1,
  type ManpowerEntryV1,
} from '@sitelog/shared';
import { DEMO_ORG_ID, DEMO_USERS } from '@sitelog/shared/demo/kestrel.ts';
import { asService, asUser, bootDatabase } from './harness.ts';

/**
 * 20261013000003_typed_companies.sql: a crew company added with "Add new…" in the panel (New
 * report or Edit) becomes a confirmed company of the org, linked by id, and is audited.
 */

const LENA = DEMO_USERS[0]!.id; // admin
const SAM = DEMO_USERS[1]!.id; // pm
const OUTSIDER = 'ffffffff-2222-4222-8222-222222222222'; // admin of another org

let db: PGlite;
let riverside: string;
let apexId: string;
let ridgewayId: string;

type Company = { id: string; name: string; trade: string | null; status: string };

async function svc<T = Record<string, unknown>>(sql: string, params: unknown[] = []) {
  return (await asService(db, (q) => q<T>(sql, params))).rows;
}

function officeReport(user: string, siteId: string, date: string, data: unknown) {
  return asUser(db, user, async (q) => {
    const res = await q<{ r: { reportId: string; reportNo: string; created: boolean } }>(
      `select create_office_report($1, $2, $3) as r`,
      [siteId, date, JSON.stringify(data)],
    );
    return res.rows[0]!.r;
  });
}

function editReport(user: string, reportId: string, data: unknown, note = 'Crew fixed') {
  return asUser(db, user, async (q) => {
    const res = await q<{ r: { version: number } }>(
      `select create_report_version($1, $2, $3) as r`,
      [reportId, JSON.stringify(data), note],
    );
    return res.rows[0]!.r.version;
  });
}

/** A crew row as toReportData() builds it: "Add new…" rows carry companyId null. */
function crew(
  companyId: string | null,
  name: string,
  workers = 4,
  trade?: string,
): ManpowerEntryV1 {
  return {
    companyId,
    companyNameHeard: name,
    companyName: name,
    trade,
    workers,
    hoursPerWorker: 8,
    totalHours: workers * 8,
    hoursBasis: 'office_edit',
    confidence: 1,
    source: [],
  };
}

function body(date: string, manpower: ManpowerEntryV1[]): DailyReportDataV1 {
  return DailyReportDataV1Schema.parse({ ...emptyReportDataV1(date), summary: 'Typed.', manpower });
}

async function versionData(reportId: string, version: number) {
  return (
    await svc<{ data: DailyReportDataV1 }>(
      `select data from report_versions where report_id = $1 and version = $2`,
      [reportId, version],
    )
  )[0]!.data;
}

async function companiesNamed(name: string) {
  return svc<Company>(
    `select id, name, trade, status::text from companies where org_id = $1 and lower(name) = lower($2)`,
    [DEMO_ORG_ID, name],
  );
}

beforeAll(async () => {
  db = await bootDatabase({ seed: true });
  await db.exec(`insert into auth.users (id, email) values ('${OUTSIDER}', 'z@other.test');`);
  await asUser(db, OUTSIDER, (q) => q(`select create_org('Other GC')`), 'z@other.test');
  riverside = (
    await svc<{ id: string }>(
      `select id from sites where org_id = $1 and project_code = 'RL-2041'`,
      [DEMO_ORG_ID],
    )
  )[0]!.id;
  apexId = (await companiesNamed('Apex Concrete'))[0]!.id;
  ridgewayId = (await companiesNamed('Ridgeway'))[0]!.id;
});

describe('typed companies on create_office_report', () => {
  it('creates each new name once as a confirmed company and links its rows by id', async () => {
    expect(await companiesNamed('Harbor Masonry')).toEqual([]);
    const date = '2026-09-02';
    const res = await officeReport(
      LENA,
      riverside,
      date,
      body(date, [
        crew(null, 'Harbor Masonry', 4, 'Masonry'),
        crew(apexId, 'Apex Concrete', 6),
        crew(null, 'harbor masonry ', 2),
      ]),
    );
    expect(res.created).toBe(true);

    const harbor = await companiesNamed('Harbor Masonry');
    expect(harbor).toEqual([
      { id: expect.any(String), name: 'Harbor Masonry', trade: 'Masonry', status: 'confirmed' },
    ]);
    const id = harbor[0]!.id;

    const v1 = await versionData(res.reportId, 1);
    expect(v1.manpower.map((m) => [m.companyId, m.companyName, m.companyNameHeard])).toEqual([
      [id, 'Harbor Masonry', 'Harbor Masonry'],
      [apexId, 'Apex Concrete', 'Apex Concrete'],
      [id, 'Harbor Masonry', 'harbor masonry '],
    ]);
    // No office_edit provenance is added to a typed version 1 (it would print as EDITED).
    expect(v1.manpower.every((m) => m.source.length === 0)).toBe(true);
    expect(DailyReportDataV1Schema.safeParse(v1).success).toBe(true);

    const rows = await svc<{ company_id: string | null }>(
      `select company_id from manpower_entries where report_id = $1 and version = 1 order by id`,
      [res.reportId],
    );
    expect(rows.every((r) => r.company_id !== null)).toBe(true);
    // Crew hours and invoices read the linked rows.
    const hours = await svc<{ hours: string }>(
      `select sum(hours)::text as hours from current_manpower where report_id = $1 and company_id = $2`,
      [res.reportId, id],
    );
    expect(hours[0]!.hours).toBe('48.00');

    const audit = await svc(
      `select actor_type, actor_id, action, entity, diff from audit_log where entity_id = $1`,
      [id],
    );
    expect(audit).toEqual([
      {
        actor_type: 'user',
        actor_id: LENA,
        action: 'company.created',
        entity: 'company',
        diff: {
          name: 'Harbor Masonry',
          trade: 'Masonry',
          status: 'confirmed',
          report_id: res.reportId,
          trigger: 'office_entry',
        },
      },
    ]);
  });

  it('links an existing company by name or alias, confirming an unconfirmed one', async () => {
    const date = '2026-09-03';
    const before = (await svc<{ n: number }>(`select count(*)::int as n from companies`))[0]!.n;
    const res = await officeReport(
      SAM,
      riverside,
      date,
      body(date, [crew(null, 'apex concrete'), crew(null, 'The Ridgeway Crew')]),
    );
    expect((await svc<{ n: number }>(`select count(*)::int as n from companies`))[0]!.n).toBe(
      before,
    );
    const v1 = await versionData(res.reportId, 1);
    expect(v1.manpower.map((m) => [m.companyId, m.companyName])).toEqual([
      [apexId, 'Apex Concrete'],
      [ridgewayId, 'Ridgeway'],
    ]);
    expect((await companiesNamed('Ridgeway'))[0]!.status).toBe('confirmed');
    const audit = await svc<{ action: string; actor_id: string }>(
      `select action, actor_id from audit_log where entity_id = $1 order by id`,
      [ridgewayId],
    );
    expect(audit).toEqual([{ action: 'company.confirmed', actor_id: SAM }]);
    expect(
      await svc(`select 1 from audit_log where entity_id = $1 and entity = 'company'`, [apexId]),
    ).toEqual([]);
  });

  it('creates nothing when the day already has a report', async () => {
    const date = '2026-09-02';
    const res = await officeReport(LENA, riverside, date, body(date, [crew(null, 'Never Filed')]));
    expect(res.created).toBe(false);
    expect(await companiesNamed('Never Filed')).toEqual([]);
  });

  it('refuses a direct call of the internal helper from another org', async () => {
    await expect(
      asUser(db, OUTSIDER, (q) =>
        q(`select link_typed_companies($1, null, $2)`, [
          DEMO_ORG_ID,
          JSON.stringify({ manpower: [crew(null, 'Intruder Co')] }),
        ]),
      ),
    ).rejects.toMatchObject({ code: '42501' });
    expect(await companiesNamed('Intruder Co')).toEqual([]);
  });
});

describe('typed companies on create_report_version', () => {
  it('links a name added while editing and keeps names pending review unlinked', async () => {
    const date = '2026-09-04';
    const filed = await officeReport(
      LENA,
      riverside,
      date,
      body(date, [crew(apexId, 'Apex Concrete')]),
    );
    // As if the report still had a WhatsApp unknown company waiting in the review banner.
    await svc(
      `update reports set needs_review = true, review_reasons = '{unknown_company:Delta Pending}' where id = $1`,
      [filed.reportId],
    );
    const v1 = await versionData(filed.reportId, 1);
    const version = await editReport(SAM, filed.reportId, {
      ...v1,
      manpower: [...v1.manpower, crew(null, 'Northline Steel'), crew(null, 'Delta Pending')],
    });
    expect(version).toBe(2);

    const northline = await companiesNamed('Northline Steel');
    expect(northline).toMatchObject([{ status: 'confirmed' }]);
    expect(await companiesNamed('Delta Pending')).toEqual([]);
    const v2 = await versionData(filed.reportId, 2);
    expect(v2.manpower.map((m) => [m.companyName, m.companyId])).toEqual([
      ['Apex Concrete', apexId],
      ['Northline Steel', northline[0]!.id],
      ['Delta Pending', null],
    ]);
    const audit = await svc<{ action: string; diff: { report_id: string } }>(
      `select action, diff from audit_log where entity_id = $1`,
      [northline[0]!.id],
    );
    expect(audit).toEqual([
      { action: 'company.created', diff: expect.objectContaining({ report_id: filed.reportId }) },
    ]);
    // The review banner's Add as subcontractor still resolves the pending name.
    await asUser(db, SAM, (q) =>
      q(`select resolve_unknown_company($1, 'Delta Pending', 'add', null)`, [filed.reportId]),
    );
    const v3 = await versionData(filed.reportId, 3);
    expect(v3.manpower[2]!.companyId).toBe((await companiesNamed('Delta Pending'))[0]!.id);
  });
});
