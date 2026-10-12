import { describe, expect, it } from 'vitest';
import { kestrelDemo } from '@sitelog/shared/demo/kestrel.ts';
import type { DemoDataset } from '@sitelog/shared/demo/types.ts';
import { emptyReportData } from '@sitelog/shared/schemas/report.ts';
import { DemoSource } from './DemoSource';
import { DemoStore } from './store';

/**
 * A brand-new org (signed up, no sites, reporters, reports or companies yet) through every read
 * of the DataSource. The assemble functions are shared with SupabaseSource, so an empty-data
 * crash here is a crash for a real new customer.
 */
function emptyOrg(): DemoDataset {
  const d = kestrelDemo();
  return {
    ...d,
    sites: [],
    reporters: [],
    siteReporters: [],
    recipients: [],
    companies: [],
    glossary: [],
    conversations: [],
    messages: [],
    transcripts: [],
    unknownSenders: [],
    siteDays: [],
    reports: [],
    versions: [],
    sources: [],
    manpower: [],
    workItems: [],
    weatherEvents: [],
    questions: [],
    invoices: [],
    packs: [],
    notifications: [],
    audit: [],
  };
}

function sourceFor(dataset: DemoDataset) {
  const store = new DemoStore(dataset);
  const admin = dataset.members.find((m) => m.role === 'admin')!;
  const source = new DemoSource(store, {
    id: admin.user_id,
    email: null,
    name: admin.display_name ?? 'Admin',
    role: 'admin',
  });
  return { store, source };
}

async function readEverything(source: DemoSource) {
  const month = '2026-10';
  const week = '2026-W41';
  await source.getOrgs();
  const overview = await source.getOverview();
  const sites = await source.getSites();
  await source.listReports({
    siteId: null,
    from: null,
    to: null,
    status: 'all',
    hasWeatherDelay: false,
    edited: false,
    late: false,
    incident: false,
    q: '',
    page: 1,
  });
  await source.getHours(week, null);
  await source.getWeather(month, null);
  await source.getTeam();
  await source.getGlossary();
  await source.getSettings();
  await source.getBilling();
  await source.getNotifications();
  await source.getNavBadges();
  await source.getSetupState();
  await source.search('framing');
  await source.getPdfUrls({ reportIds: [] });
  for (const s of sites) await source.getSiteDetail(s.siteId, month);
  return { overview, sites };
}

describe('a new org with no data', () => {
  it('reads every page without throwing', async () => {
    const { source } = sourceFor(emptyOrg());
    const { overview, sites } = await readEverything(source);
    expect(sites).toEqual([]);
    expect(JSON.stringify(overview)).not.toMatch(/NaN|null:|undefined/);
  });

  it('one site with no reporter or site-days, then a typed report: every page reads', async () => {
    const d = emptyOrg();
    const site = kestrelDemo().sites[0]!;
    d.sites = [{ ...site, report_seq: 0 }];
    const { source } = sourceFor(d);
    await readEverything(source);
    const today = '2026-10-09';
    const filed = await source.createOfficeReport({
      siteId: site.id,
      date: today,
      data: { ...emptyReportData(today), summary: 'Framing on level 2.' },
    });
    expect(filed.created).toBe(true);
    const { sites } = await readEverything(source);
    expect(sites).toHaveLength(1);
    const detail = await source.getReportDetail(filed.reportId);
    expect(detail.reporter).toBeNull();
    expect(detail.report.reportNo).toBe(`${site.project_code}-0001`);
  });
});
