import { describe, expect, it } from 'vitest';
import {
  emptyReportDataV1,
  type DailyReportDataV1,
  type ManpowerEntryV1,
} from '@sitelog/shared/schemas/report.ts';
import { upgradeV1toV2 } from '@sitelog/shared/report/upgrade.ts';
import { storedV1 } from '@/test/storedData';
import { unlinkedCompanyReasons } from '../assemble';
import { DemoSource } from './DemoSource';
import { DemoStore, demoUserFor } from './store';

/**
 * Mirror of 20261013000003_typed_companies.sql: crew companies added with "Add new…" while typing
 * or editing a report become confirmed companies of the org, linked by id and audited.
 */

const admin = demoUserFor('admin');

function setup() {
  const store = new DemoStore();
  const s = new DemoSource(store, {
    id: admin.id,
    email: admin.email,
    name: admin.name,
    role: admin.role,
  });
  // Elm St. has no report on Fri Oct 9 (the demo's missing site).
  const site = store.data.sites.find((x) => x.name === 'Elm St. Townhomes')!;
  return { store, s, site };
}

/** A crew row as toReportData() builds it: "Add new…" rows carry companyId null. */
function crew(companyId: string | null, name: string, workers = 4): ManpowerEntryV1 {
  return {
    companyId,
    companyNameHeard: name,
    companyName: name,
    workers,
    hoursPerWorker: 8,
    totalHours: workers * 8,
    hoursBasis: 'office_edit',
    confidence: 1,
    source: [],
  };
}

function body(date: string, manpower: ManpowerEntryV1[]): DailyReportDataV1 {
  return { ...emptyReportDataV1(date), summary: 'Typed in the office.', manpower };
}

const company = (store: DemoStore, name: string) =>
  store.data.companies.filter((c) => c.name.toLowerCase() === name.toLowerCase());

describe('demo: companies typed in the panel', () => {
  it('files "Add new…" companies as confirmed companies linked by id, so nothing is unconfirmed', async () => {
    const { store, s, site } = setup();
    const apex = company(store, 'Apex Concrete')[0]!;
    const res = await s.createOfficeReport({
      siteId: site.id,
      date: '2026-10-09',
      data: body('2026-10-09', [
        crew(null, 'Harbor Masonry'),
        crew(apex.id, 'Apex Concrete', 6),
        crew(null, 'harbor masonry', 2),
      ]),
    });
    expect(res.created).toBe(true);

    const harbor = company(store, 'Harbor Masonry');
    expect(harbor).toEqual([
      expect.objectContaining({ name: 'Harbor Masonry', status: 'confirmed', org_id: site.org_id }),
    ]);
    expect(store.data.audit).toContainEqual(
      expect.objectContaining({
        action: 'company.created',
        entity: 'company',
        entity_id: harbor[0]!.id,
        actor_id: admin.id,
        diff: expect.objectContaining({ report_id: res.reportId, trigger: 'office_entry' }),
      }),
    );

    const detail = await s.getReportDetail(res.reportId);
    expect(detail.data.manpower.map((m) => [m.companyId, m.companyName])).toEqual([
      [harbor[0]!.id, 'Harbor Masonry'],
      [apex.id, 'Apex Concrete'],
      [harbor[0]!.id, 'Harbor Masonry'],
    ]);
    // The panel and the PDF mark a crew UNCONFIRMED when its company is missing or unconfirmed.
    const byId = new Map(detail.companies.map((c) => [c.id, c]));
    expect(
      detail.data.manpower.every(
        (m) => m.companyId && byId.get(m.companyId)?.status === 'confirmed',
      ),
    ).toBe(true);
    expect(unlinkedCompanyReasons(detail.data, [])).toEqual([]);

    // Crew hours: the typed subcontractor is a confirmed row, ready for an invoice.
    const hours = await s.getHours('2026-W41', site.id);
    expect(hours.rows.find((r) => r.companyName === 'Harbor Masonry')).toMatchObject({
      companyId: harbor[0]!.id,
      unconfirmed: false,
      reported: 48,
    });
  });

  it('links an existing company by name or alias and confirms an unconfirmed one', async () => {
    const { store, s, site } = setup();
    const before = store.data.companies.length;
    const ridgeway = company(store, 'Ridgeway')[0]!;
    expect(ridgeway.status).toBe('unconfirmed');
    const res = await s.createOfficeReport({
      siteId: site.id,
      date: '2026-10-09',
      data: body('2026-10-09', [crew(null, 'apex concrete'), crew(null, 'The Ridgeway Crew')]),
    });
    expect(store.data.companies).toHaveLength(before);
    const detail = await s.getReportDetail(res.reportId);
    expect(detail.data.manpower.map((m) => [m.companyId, m.companyName])).toEqual([
      [company(store, 'Apex Concrete')[0]!.id, 'Apex Concrete'],
      [ridgeway.id, 'Ridgeway'],
    ]);
    expect(ridgeway.status).toBe('confirmed');
    expect(store.data.audit.at(-2)).toMatchObject({
      action: 'company.confirmed',
      entity_id: ridgeway.id,
    });
  });

  it('links companies added while editing, leaving names pending review to the banner', async () => {
    const { store, s } = setup();
    const oakmont = store.data.reports.find((r) => r.report_no === 'OM-1187-0133')!;
    expect(oakmont.review_reasons).toEqual(['unknown_company:Ridgeway']);
    const cur = storedV1(await s.getReportDetail(oakmont.id));
    const { version } = await s.createReportVersion(
      oakmont.id,
      { ...cur, manpower: [...cur.manpower, crew(null, 'Northline Steel')] },
      'Northline was on site too',
    );
    const next = await s.getReportDetail(oakmont.id, version);
    const northline = company(store, 'Northline Steel')[0]!;
    expect(northline.status).toBe('confirmed');
    expect(next.data.manpower.at(-1)).toMatchObject({ companyId: northline.id });
    const ridgewayRow = next.data.manpower.find((m) => m.companyName === 'Ridgeway')!;
    expect(ridgewayRow.companyId).toBeNull();
    expect(company(store, 'Ridgeway')[0]!.status).toBe('unconfirmed');
    // Already a review reason: the banner does not list it twice.
    expect(unlinkedCompanyReasons(next.data, next.report.reviewReasons)).toEqual([]);
  });
});

describe('unlinkedCompanyReasons', () => {
  it('lists each unlinked crew company once that is not a review reason already', () => {
    const data = upgradeV1toV2(
      body('2026-10-09', [
        crew('c-apex', 'Apex Concrete'),
        crew(null, 'Harbor Masonry'),
        crew(null, 'harbor masonry'),
        { ...crew(null, 'Ridgeway'), companyNameHeard: 'the Ridgeway crew' },
        { ...crew(null, ''), companyNameHeard: 'Some crew' },
        { ...crew(null, ''), companyNameHeard: ' ' },
      ]),
    );
    expect(unlinkedCompanyReasons(data, [])).toEqual([
      'unknown_company:Harbor Masonry',
      'unknown_company:Ridgeway',
      'unknown_company:Some crew',
    ]);
    expect(
      unlinkedCompanyReasons(data, ['unknown_company:the ridgeway crew', 'low_confidence:x']),
    ).toEqual(['unknown_company:Harbor Masonry', 'unknown_company:Some crew']);
  });
});
