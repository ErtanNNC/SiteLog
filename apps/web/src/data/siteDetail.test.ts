import { describe, expect, it } from 'vitest';
import { emptyReportData } from '@sitelog/shared/schemas/report.ts';
import { DemoSource } from './demo/DemoSource';
import { DemoStore, demoUserFor } from './demo/store';

/**
 * Site detail "This month" stats for a site added today (Fri Oct 9 2026, Mon–Fri working days)
 * whose earlier days were typed in afterwards from the paper diary. The assembler is shared with
 * SupabaseSource.
 */
async function newSiteWithReports(dates: string[]) {
  const store = new DemoStore();
  const u = demoUserFor('admin');
  const source = new DemoSource(store, { id: u.id, email: u.email, name: u.name, role: u.role });
  const { siteId } = await source.createSite({
    name: 'Cedar Row Duplexes',
    projectCode: 'CR-0101',
    timezone: 'America/Chicago',
  });
  for (const date of dates)
    await source.createOfficeReport({
      siteId,
      date,
      data: { ...emptyReportData(date), summary: `Work on ${date}.` },
    });
  return { source, siteId };
}

describe('site detail workdays so far', () => {
  it('counts back-filled days before the site was added', async () => {
    const { source, siteId } = await newSiteWithReports([
      '2026-10-01',
      '2026-10-02',
      '2026-10-05',
      '2026-10-06',
      '2026-10-07',
    ]);
    const { monthStats } = await source.getSiteDetail(siteId, '2026-10');
    // Oct 1, 2, 5, 6, 7, 8, 9: not "5 of 1".
    expect(monthStats).toMatchObject({ reports: 5, workdaysSoFar: 7 });
  });

  it('counts a report on a non-working day, so reports never exceed workdays', async () => {
    const { source, siteId } = await newSiteWithReports(['2026-10-03', '2026-10-09']);
    const { monthStats } = await source.getSiteDetail(siteId, '2026-10');
    // Sat Oct 3 (reported) + Mon Oct 5 … Fri Oct 9.
    expect(monthStats).toMatchObject({ reports: 2, workdaysSoFar: 6 });
  });

  it('counts a back-filled day in an earlier month', async () => {
    const { source, siteId } = await newSiteWithReports(['2026-09-29', '2026-09-30']);
    const september = await source.getSiteDetail(siteId, '2026-09');
    expect(september.monthStats).toMatchObject({ reports: 2, workdaysSoFar: 2 });
    // October still starts the day the site was added.
    const october = await source.getSiteDetail(siteId, '2026-10');
    expect(october.monthStats).toMatchObject({ reports: 0, workdaysSoFar: 1 });
    expect(october.latest?.date).toBe('2026-09-30');
  });

  it('a site with no back-filled days counts from the day it was added', async () => {
    const { source, siteId } = await newSiteWithReports([]);
    const { monthStats, latest } = await source.getSiteDetail(siteId, '2026-10');
    expect(monthStats).toMatchObject({ reports: 0, workdaysSoFar: 1 });
    expect(latest).toBeNull();
  });
});
