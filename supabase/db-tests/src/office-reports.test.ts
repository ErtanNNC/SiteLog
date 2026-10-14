import { beforeAll, describe, expect, it } from 'vitest';
import type { PGlite } from '@electric-sql/pglite';
import {
  DailyReportDataV1Schema,
  emptyReportDataV1,
  pdfStoragePath,
  type DailyReportDataV1,
} from '@sitelog/shared';
import { DEMO_ORG_ID, DEMO_USERS } from '@sitelog/shared/demo/kestrel.ts';
import { asService, asUser, bootDatabase } from './harness.ts';

/**
 * 20261013000001_office_reports.sql: office-entered daily reports (filed at once as version 1,
 * no WhatsApp, no AI) and the browser-rendered PDF attached to a version.
 */

const LENA = DEMO_USERS[0]!.id; // admin
const SAM = DEMO_USERS[1]!.id; // pm
const ACCOUNTS = DEMO_USERS[2]!.id; // accounts
const RAVI = 'dddddddd-1111-4111-8111-111111111111'; // ops, added below
const OUTSIDER = 'dddddddd-2222-4222-8222-222222222222'; // admin of another org

let db: PGlite;
let otherOrgId: string;
let riverside: string;
let oakmont: string;
let pier: string;
let apexId: string;

type Result = { reportId: string; reportNo: string; created: boolean };

async function svc<T = Record<string, unknown>>(sql: string, params: unknown[] = []) {
  return (await asService(db, (q) => q<T>(sql, params))).rows;
}

function officeReport(user: string, siteId: string, date: string, data: unknown) {
  return asUser(db, user, async (q) => {
    const res = await q<{ r: Result }>(`select create_office_report($1, $2, $3) as r`, [
      siteId,
      date,
      JSON.stringify(data),
    ]);
    return res.rows[0]!.r;
  });
}

function attachPdf(user: string, reportId: string, version: number, path: string) {
  return asUser(db, user, async (q) => {
    const res = await q<{ r: { path: string } }>(`select attach_version_pdf($1, $2, $3) as r`, [
      reportId,
      version,
      path,
    ]);
    return res.rows[0]!.r;
  });
}

/** What the panel's office entry form sends: a full DailyReportData. */
function body(date: string, summary = 'Level 2 deck formwork; Apex Concrete on site.') {
  const data: DailyReportDataV1 = {
    ...emptyReportDataV1(date),
    languageDetected: ['en'],
    summary,
    weather: { conditionsText: 'Clear, 68°F', periods: [] },
    manpower: [
      {
        companyId: apexId,
        companyNameHeard: 'Apex Concrete',
        companyName: 'Apex Concrete',
        trade: 'Concrete',
        area: 'Level 2',
        workers: 6,
        hoursPerWorker: 8,
        totalHours: 48,
        hoursBasis: 'office_edit',
        confidence: 1,
        source: [{ type: 'office_edit', userId: LENA, at: '2026-10-12T15:00:00Z' }],
      },
    ],
    workPerformed: [
      {
        area: 'Level 2',
        activity: 'Deck formwork',
        status: 'in_progress',
        percentComplete: 60,
        quantity: { value: 1200, unit: 'sq ft' },
        source: [{ type: 'office_edit', userId: LENA, at: '2026-10-12T15:00:00Z' }],
      },
    ],
    safety: {
      toolboxTalk: 'Fall protection',
      incidents: [],
      noIncidentsStated: true,
      visitors: [],
      source: [],
    },
  };
  return DailyReportDataV1Schema.parse(data);
}

async function siteDay(siteId: string, date: string) {
  return (
    await svc<{
      id: string;
      status: string;
      report_id: string | null;
      is_late: boolean;
      deadline_at: Date;
    }>(
      `select id, status::text, report_id, is_late, deadline_at from site_days where site_id = $1 and date = $2`,
      [siteId, date],
    )
  )[0];
}

async function reportSeq(siteId: string) {
  return (await svc<{ n: number }>(`select report_seq as n from sites where id = $1`, [siteId]))[0]!
    .n;
}

async function localDate(offsetDays: number) {
  return (
    await svc<{ d: string }>(
      `select to_char((now() at time zone 'America/Chicago')::date + $1::int, 'YYYY-MM-DD') as d`,
      [offsetDays],
    )
  )[0]!.d;
}

beforeAll(async () => {
  db = await bootDatabase({ seed: true });
  await db.exec(
    `insert into auth.users (id, email) values ('${RAVI}', 'ravi@kestrelbuild.example'), ('${OUTSIDER}', 'x@other.test');`,
  );
  await svc(
    `insert into org_members (org_id, user_id, role, display_name) values ($1, $2, 'ops', 'Ravi')`,
    [DEMO_ORG_ID, RAVI],
  );
  otherOrgId = await asUser(
    db,
    OUTSIDER,
    async (q) =>
      (await q<{ r: { id: string } }>(`select create_org('Other GC') as r`)).rows[0]!.r.id,
    'x@other.test',
  );
  const sites = await svc<{ project_code: string; id: string }>(
    `select project_code, id from sites where org_id = $1`,
    [DEMO_ORG_ID],
  );
  const byCode = Object.fromEntries(sites.map((s) => [s.project_code, s.id]));
  riverside = byCode['RL-2041']!;
  oakmont = byCode['OM-1187']!;
  pier = byCode['P9-0932']!;
  apexId = (
    await svc<{ id: string }>(`select id from companies where org_id = $1 and name = $2`, [
      DEMO_ORG_ID,
      'Apex Concrete',
    ])
  )[0]!.id;
});

describe('create_office_report', () => {
  let reportId: string;

  it('files a past day with no site-day as version 1 by the office user', async () => {
    const date = '2026-09-15';
    expect(await siteDay(riverside, date)).toBeUndefined();
    const seq = await reportSeq(riverside);
    const jobsBefore = (await svc<{ n: number }>(`select count(*)::int as n from jobs`))[0]!.n;

    const res = await officeReport(LENA, riverside, date, body(date));
    expect(res.created).toBe(true);
    expect(res.reportNo).toBe(`RL-2041-${String(seq + 1).padStart(4, '0')}`);
    expect(await reportSeq(riverside)).toBe(seq + 1);
    reportId = res.reportId;

    const report = (
      await svc<Record<string, unknown>>(
        `select org_id, site_id, report_no, status::text, kind, current_version, reporter_id, is_late,
                needs_review, received_at is not null as received, confirmed_at,
                filed_at is not null as filed
         from reports where id = $1`,
        [reportId],
      )
    )[0];
    expect(report).toEqual({
      org_id: DEMO_ORG_ID,
      site_id: riverside,
      report_no: res.reportNo,
      status: 'filed',
      kind: 'daily',
      current_version: 1,
      reporter_id: null,
      is_late: true,
      needs_review: false,
      received: true,
      confirmed_at: null,
      filed: true,
    });

    const versions = await svc<{
      version: number;
      author: string;
      author_user_id: string;
      summary: string;
      data: DailyReportDataV1;
      pdf_path: string | null;
    }>(
      `select version, author::text, author_user_id, summary, data, pdf_path from report_versions where report_id = $1`,
      [reportId],
    );
    expect(versions).toHaveLength(1);
    expect(versions[0]).toMatchObject({
      version: 1,
      author: 'office_user',
      author_user_id: LENA,
      summary: 'Level 2 deck formwork; Apex Concrete on site.',
      pdf_path: null,
    });
    expect(versions[0]!.data).toEqual(body(date));
    expect(DailyReportDataV1Schema.safeParse(versions[0]!.data).success).toBe(true);

    // Site-day created by the RPC: deadline = org default 17:30 in America/Chicago (CDT, UTC−5).
    const day = await siteDay(riverside, date);
    expect(day).toMatchObject({ status: 'filed', report_id: reportId, is_late: true });
    expect(new Date(day!.deadline_at).toISOString()).toBe('2026-09-15T22:30:00.000Z');

    const manpower = await svc(
      `select version, company_id, company_name, trade, area, workers, hours::text, hours_basis
       from manpower_entries where report_id = $1`,
      [reportId],
    );
    expect(manpower).toEqual([
      {
        version: 1,
        company_id: apexId,
        company_name: 'Apex Concrete',
        trade: 'Concrete',
        area: 'Level 2',
        workers: 6,
        hours: '48.00',
        hours_basis: 'office_edit',
      },
    ]);
    const work = await svc(
      `select version, area, activity, status, percent, quantity from work_items where report_id = $1`,
      [reportId],
    );
    expect(work).toEqual([
      {
        version: 1,
        area: 'Level 2',
        activity: 'Deck formwork',
        status: 'in_progress',
        percent: 60,
        quantity: '1200 sq ft',
      },
    ]);
    // The office hours show up where payroll reads them.
    const hours = await asUser(db, SAM, (q) =>
      q<{ hours: string }>(`select hours::text from current_manpower where report_id = $1`, [
        reportId,
      ]),
    );
    expect(hours.rows).toEqual([{ hours: '48.00' }]);

    const audit = await svc(
      `select org_id, actor_type, actor_id, action, entity, diff from audit_log where entity_id = $1`,
      [reportId],
    );
    expect(audit).toEqual([
      {
        org_id: DEMO_ORG_ID,
        actor_type: 'user',
        actor_id: LENA,
        action: 'report.filed',
        entity: 'report',
        diff: { trigger: 'office_entry', version: 1, is_late: true, date, photos: 0 },
      },
    ]);
    // The browser renders the PDF: nothing is queued for the worker.
    expect((await svc<{ n: number }>(`select count(*)::int as n from jobs`))[0]!.n).toBe(
      jobsBefore,
    );
  });

  it('returns the existing report for a day that already has one and changes nothing', async () => {
    const date = '2026-09-15';
    const seq = await reportSeq(riverside);
    const res = await officeReport(SAM, riverside, date, body(date, 'A second submit.'));
    expect(res).toEqual({
      reportId,
      reportNo: `RL-2041-${String(seq).padStart(4, '0')}`,
      created: false,
    });
    expect(await reportSeq(riverside)).toBe(seq);
    const reports = await svc(`select id from reports where site_day_id = $1`, [
      (await siteDay(riverside, date))!.id,
    ]);
    expect(reports).toEqual([{ id: reportId }]);
    const versions = await svc<{ summary: string }>(
      `select summary from report_versions where report_id = $1`,
      [reportId],
    );
    expect(versions).toEqual([{ summary: 'Level 2 deck formwork; Apex Concrete on site.' }]);
    const audit = await svc(`select action from audit_log where entity_id = $1`, [reportId]);
    expect(audit).toHaveLength(1);

    // A WhatsApp report already on a seeded day wins too.
    const seeded = (
      await svc<{ id: string; report_no: string }>(
        `select r.id, r.report_no from reports r join site_days sd on sd.id = r.site_day_id
         where sd.site_id = $1 and sd.date = '2026-10-08' and r.status <> 'void'`,
        [riverside],
      )
    )[0]!;
    expect(await officeReport(LENA, riverside, '2026-10-08', body('2026-10-08'))).toEqual({
      reportId: seeded.id,
      reportNo: seeded.report_no,
      created: false,
    });
  });

  it("uses the site's own deadline, overwrites reportDate / schemaVersion and accepts ops", async () => {
    await svc(`update sites set deadline = '15:00' where id = $1`, [oakmont]);
    const date = '2026-09-14';
    expect(await siteDay(oakmont, date)).toBeUndefined();
    const sent = { ...body(date), reportDate: '2026-01-01', schemaVersion: 7 };
    const res = await officeReport(RAVI, oakmont, date, sent);
    expect(res.created).toBe(true);
    expect(res.reportNo).toMatch(/^OM-1187-\d{4}$/);
    const day = await siteDay(oakmont, date);
    expect(new Date(day!.deadline_at).toISOString()).toBe('2026-09-14T20:00:00.000Z');
    const v = await svc<{ data: DailyReportDataV1; author_user_id: string }>(
      `select data, author_user_id from report_versions where report_id = $1 and version = 1`,
      [res.reportId],
    );
    expect(v[0]!.data.reportDate).toBe(date);
    expect(v[0]!.data.schemaVersion).toBe(1);
    expect(v[0]!.author_user_id).toBe(RAVI);
  });

  it("accepts the site's local today and refuses tomorrow", async () => {
    const today = await localDate(0);
    const tomorrow = await localDate(1);
    const res = await officeReport(SAM, pier, today, body(today));
    expect(res.created).toBe(true);
    await expect(officeReport(LENA, pier, tomorrow, body(tomorrow))).rejects.toThrow(
      /date is in the future/,
    );
    expect(await siteDay(pier, tomorrow)).toBeUndefined();
  });

  it('refuses other orgs and accounts members (42501), archived sites and non-object data', async () => {
    const date = '2026-09-16';
    const seq = await reportSeq(riverside);
    for (const user of [OUTSIDER, ACCOUNTS]) {
      await expect(officeReport(user, riverside, date, body(date))).rejects.toMatchObject({
        code: '42501',
        message: expect.stringMatching(/not allowed/),
      });
    }
    await expect(
      asUser(db, LENA, (q) =>
        q(`select create_office_report($1, $2, '[]'::jsonb)`, [riverside, date]),
      ),
    ).rejects.toThrow(/JSON object/);
    await expect(
      officeReport(LENA, '00000000-0000-4000-8000-000000000000', date, body(date)),
    ).rejects.toThrow(/site not found/);

    const archived = (
      await svc<{ id: string }>(
        `insert into sites (org_id, name, project_code, timezone, status)
         values ($1, 'Closed job', 'CJ-0001', 'America/Chicago', 'archived') returning id`,
        [DEMO_ORG_ID],
      )
    )[0]!.id;
    await expect(officeReport(LENA, archived, date, body(date))).rejects.toThrow(
      /site is archived/,
    );
    // An outsider learns nothing about the site's state.
    await expect(officeReport(OUTSIDER, archived, date, body(date))).rejects.toThrow(/not allowed/);

    expect(await siteDay(riverside, date)).toBeUndefined();
    expect(await reportSeq(riverside)).toBe(seq);
  });

  it('files a new report when the only report on the day is void', async () => {
    const date = '2026-09-17';
    const day = (
      await svc<{ id: string }>(
        `insert into site_days (site_id, date, status, deadline_at) values ($1, $2, 'missing', '2026-09-17T22:30:00Z') returning id`,
        [riverside, date],
      )
    )[0]!.id;
    const voidId = (
      await svc<{ id: string }>(
        `insert into reports (org_id, site_id, site_day_id, report_no, status, language) values ($1, $2, $3, 'RL-2041-VOID-1', 'void', 'en') returning id`,
        [DEMO_ORG_ID, riverside, day],
      )
    )[0]!.id;
    await svc(`update site_days set report_id = $1 where id = $2`, [voidId, day]);

    const res = await officeReport(LENA, riverside, date, body(date));
    expect(res.created).toBe(true);
    expect(res.reportId).not.toBe(voidId);
    expect(await siteDay(riverside, date)).toMatchObject({
      id: day,
      status: 'filed',
      report_id: res.reportId,
      is_late: true,
    });
    const statuses = await svc<{ id: string; status: string }>(
      `select id, status::text from reports where site_day_id = $1 order by created_at`,
      [day],
    );
    expect(statuses).toEqual([
      { id: voidId, status: 'void' },
      { id: res.reportId, status: 'filed' },
    ]);
  });
});

describe('attach_version_pdf', () => {
  let reportId: string;
  let reportNo: string;

  beforeAll(async () => {
    const res = await officeReport(LENA, riverside, '2026-09-18', body('2026-09-18'));
    reportId = res.reportId;
    reportNo = res.reportNo;
  });

  it('records the pdfStoragePath() path on the version, with an audit row', async () => {
    const path = pdfStoragePath(DEMO_ORG_ID, riverside, reportNo, 1);
    expect(await attachPdf(SAM, reportId, 1, path)).toEqual({ path });
    const v = await svc<{ pdf_path: string }>(
      `select pdf_path from report_versions where report_id = $1 and version = 1`,
      [reportId],
    );
    expect(v[0]!.pdf_path).toBe(path);
    const audit = await svc(
      `select actor_type, actor_id, diff from audit_log where entity_id = $1 and action = 'report.pdf_rendered'`,
      [reportId],
    );
    expect(audit).toEqual([
      { actor_type: 'user', actor_id: SAM, diff: { version: 1, path, renderer: 'browser' } },
    ]);
  });

  it('rejects any other path, a missing version and callers without an office role', async () => {
    for (const path of [
      pdfStoragePath(otherOrgId, riverside, reportNo, 1),
      pdfStoragePath(DEMO_ORG_ID, oakmont, reportNo, 1),
      pdfStoragePath(DEMO_ORG_ID, riverside, reportNo, 2),
      `${pdfStoragePath(DEMO_ORG_ID, riverside, reportNo, 1)}.exe`,
      `../${pdfStoragePath(DEMO_ORG_ID, riverside, reportNo, 1)}`,
    ]) {
      await expect(attachPdf(LENA, reportId, 1, path)).rejects.toThrow(/unexpected pdf path/);
    }
    await expect(
      attachPdf(LENA, reportId, 2, pdfStoragePath(DEMO_ORG_ID, riverside, reportNo, 2)),
    ).rejects.toThrow(/version not found/);
    await expect(
      attachPdf(
        LENA,
        '00000000-0000-4000-8000-000000000000',
        1,
        pdfStoragePath(DEMO_ORG_ID, riverside, reportNo, 1),
      ),
    ).rejects.toThrow(/report not found/);
    for (const user of [OUTSIDER, ACCOUNTS]) {
      await expect(
        attachPdf(user, reportId, 1, pdfStoragePath(DEMO_ORG_ID, riverside, reportNo, 1)),
      ).rejects.toMatchObject({ code: '42501' });
    }
    const audit = await svc(
      `select 1 from audit_log where entity_id = $1 and action = 'report.pdf_rendered'`,
      [reportId],
    );
    expect(audit).toHaveLength(1);
  });
});
