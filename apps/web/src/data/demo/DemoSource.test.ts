import { describe, expect, it } from 'vitest';
import { DemoStore, demoUserFor } from './store';
import { DemoSource, demoPayrollCsv } from './DemoSource';

function source(as: 'admin' | 'pm' | 'ops' | 'accounts' = 'admin', store = new DemoStore()) {
  const u = demoUserFor(as);
  return {
    source: new DemoSource(store, { id: u.id, email: u.email, name: u.name, role: u.role }),
    store,
  };
}

describe('DemoSource aggregations (§18 numbers, Fri Oct 9 2026)', () => {
  it('overview: reports in 4/6 with 1 weather day and 1 missing; crew, hours and weather sites', async () => {
    const { source: s } = source();
    const o = await s.getOverview();
    expect(o.today).toBe('2026-10-09');
    expect(o.siteCount).toBe(6);
    expect(o.kpis.reportsIn).toBe(4);
    expect(o.kpis.total).toBe(6);
    expect(o.kpis.segments).toEqual({ filed: 4, weather: 1, missing: 1, awaiting: 0, noWork: 0 });
    // Riverside 24 + Oakmont 23 + Pier 9 10 + Northgate 11
    expect(o.kpis.crewOnSite).toBe(68);
    expect(o.kpis.laborHours).toBe(544);
    // Riverside (3.5 h), Pier 9 (2 h), Hillcrest (weather day, 5 h)
    expect(o.kpis.weatherAffectedSites).toBe(3);
    expect(o.kpis.weatherLostHours).toBe(10.5);
    expect(o.earliestDeadline).toBe('17:30');
    expect(o.reminder1At).toBe('17:45');
    const byCode = Object.fromEntries(o.sitesToday.map((r) => [r.projectCode, r]));
    expect(byCode['ES-0377']!.chip.variant).toBe('missing');
    expect(byCode['OM-1187']!.chip.variant).toBe('needs_review');
    expect(byCode['HS-0418']!.chip.variant).toBe('weather_day');
    expect(byCode['RL-2041']!.crew).toBe(24);
    expect(byCode['RL-2041']!.hours).toBe(192);
    expect(byCode['RL-2041']!.lostHours).toBe(3.5);
    expect(o.sitesToday[0]!.projectCode).toBe('ES-0377'); // exceptions first
  });

  it('overview: needs-attention order missing → needs_review → invoice_gap → unknown_sender → glossary_review', async () => {
    const { source: s } = source();
    const o = await s.getOverview();
    expect(o.needsAttention.map((a) => a.kind)).toEqual([
      'missing',
      'needs_review',
      'invoice_gap',
      'invoice_gap',
      'unknown_sender',
      'glossary_review',
    ]);
    expect(o.needsAttention[2]!.title).toBe('Invoice gap: BrightLine Electric +16 h');
    expect(o.needsAttention[3]!.title).toBe('Invoice gap: ClearView Glazing +8 h');
    expect(o.needsAttention[0]!.actions.map((a) => a.kind)).toEqual(['call', 'mark_no_work']);
  });

  it('hours matrix W41: Apex 472 match · BrightLine 196 (+16) · ClearView 152 (+8) · total 1,804', async () => {
    const { source: s } = source();
    const h = await s.getHours('2026-W41', null);
    expect(h.days).toEqual(['2026-10-05', '2026-10-06', '2026-10-07', '2026-10-08', '2026-10-09']);
    const row = (name: string) => h.rows.find((r) => r.companyName === name)!;
    expect(row('Apex Concrete').days).toEqual([88, 96, 96, 88, 104]);
    expect(row('Apex Concrete')).toMatchObject({
      reported: 472,
      invoiced: 472,
      gap: 0,
      status: 'match',
    });
    expect(row('BrightLine Electric')).toMatchObject({
      reported: 196,
      invoiced: 212,
      gap: 16,
      status: 'gap',
    });
    expect(row('ClearView Glazing')).toMatchObject({
      reported: 152,
      invoiced: 160,
      gap: 8,
      status: 'gap',
    });
    expect(row('Delta Mechanical')).toMatchObject({ reported: 384, status: 'awaiting' });
    expect(row('Ironclad Steel')).toMatchObject({ reported: 232, status: 'match' });
    expect(row('Summit Drywall')).toMatchObject({ reported: 320, status: 'awaiting' });
    expect(row('Ridgeway')).toMatchObject({
      reported: 48,
      status: 'unconfirmed',
      unconfirmed: true,
    });
    expect(h.totals.reported).toBe(1804);
    expect(h.kpis).toEqual({ subHours: 1804, companies: 7, gapHours: 24, gapSubs: 2 });
    const bl = h.invoices.find((i) => i.invoiceNo === 'BL-3381')!;
    expect(bl.totals).toEqual({ invoiced: 212, reported: 196, gap: 16 });
    expect(bl.days.map((d) => d.gap)).toEqual([0, 4, 4, 4, 4]);
    expect(bl.evidence.length).toBeGreaterThan(0);
    expect(bl.evidence.some((e) => e.quote.includes('five electricians'))).toBe(true);
  });

  it('weather Oct 2026: 10 site-days, 36.5 h, 7 claim-ready', async () => {
    const { source: s } = source();
    const w = await s.getWeather('2026-10', null);
    expect(w.kpis.siteDays).toBe(10);
    expect(w.kpis.hours).toBe(36.5);
    expect(w.kpis.claimReady).toBe(7);
    expect(w.days).toEqual([
      '2026-10-01',
      '2026-10-02',
      '2026-10-05',
      '2026-10-06',
      '2026-10-07',
      '2026-10-08',
      '2026-10-09',
    ]);
    expect(w.maxHours).toBe(8);
    const hillcrest = w.entries.filter((e) => e.siteShort === 'Hillcrest');
    expect(hillcrest.map((e) => e.lostHours).sort()).toEqual([4, 5, 8]);
    expect(hillcrest.find((e) => e.date === '2026-10-09')!.evidence.photoRequested).toBe(true);
  });

  it('site cards: streak counts per site over the last 14 workdays', async () => {
    const { source: s } = source();
    const cards = await s.getSites();
    const by = Object.fromEntries(cards.map((c) => [c.projectCode, c]));
    // Riverside's hero report arrived 17:38, after the 17:30 deadline → late (13 on time)
    expect(by['RL-2041']!.onTime14).toBe(13);
    expect(by['RL-2041']!.streak.at(-1)!.status).toBe('late');
    expect(by['P9-0932']!.onTime14).toBe(14);
    expect(by['OM-1187']!.onTime14).toBe(13);
    expect(by['NG-2210']!.onTime14).toBe(12);
    expect(by['HS-0418']!.onTime14).toBe(12);
    expect(by['HS-0418']!.streak.filter((c) => c.status === 'weather_day')).toHaveLength(2);
    expect(by['ES-0377']!.onTime14).toBe(10);
    expect(by['ES-0377']!.streak.filter((c) => c.status === 'missing')).toHaveLength(2);
    expect(by['ES-0377']!.needsAttention).toBe(true);
    expect(by['OM-1187']!.needsAttention).toBe(true);
    expect(by['RL-2041']!.crewToday).toBe(24);
    expect(by['RL-2041']!.weatherDaysMonth).toBe(2);
    expect(cards.every((c) => c.streak.length === 14)).toBe(true);
  });

  it('report detail: hero report RL-2041-0187 v2 with excerpts, versions and activity', async () => {
    const { source: s, store } = source();
    const hero = store.data.reports.find((r) => r.report_no === 'RL-2041-0187')!;
    const d = await s.getReportDetail(hero.id);
    expect(d.version).toBe(2);
    expect(d.totals).toMatchObject({ crewOnSite: 24, totalHours: 192, lostHours: 3.5 });
    expect(d.versions.map((v) => v.version)).toEqual([1, 2]);
    expect(d.versions[1]!.changeNote).toBe('Apex Concrete 6 → 7 workers');
    expect(d.audio?.durationS).toBe(168);
    expect(d.audio?.peaks).toHaveLength(64);
    expect(d.transcript?.segments.length).toBe(13);
    expect(d.excerpts.length).toBeGreaterThanOrEqual(4);
    expect(d.excerpts.some((e) => e.quote.startsWith('Llovió'))).toBe(true);
    expect(d.questions[0]!.answer).toBe('5 · full day');
    expect(d.activity.map((a) => a.label)).toContain('Question answered');
    expect(d.photos).toHaveLength(2);
    expect(d.delayLogHours).toBe(3.5);
    const v1 = await s.getReportDetail(hero.id, 1);
    expect(v1.totals.crewOnSite).toBe(23);
  });

  it('reports list: filters, flags and pagination', async () => {
    const { source: s } = source();
    const all = await s.listReports({});
    expect(all.pageSize).toBe(50);
    expect(all.total).toBeGreaterThan(50);
    expect(all.items).toHaveLength(50);
    expect(all.items[0]!.date).toBe('2026-10-09');
    const rain = await s.listReports({ hasWeatherDelay: true, from: '2026-10-01' });
    expect(rain.total).toBe(10);
    expect(rain.weatherHours).toBe(36.5);
    const edited = await s.listReports({ edited: true });
    expect(edited.items.map((i) => i.reportNo)).toEqual(['RL-2041-0187']);
    expect(edited.items[0]!.flags.map((f) => f.label)).toEqual(['Rain 3.5 h', 'v2', 'Late 17:38']);
    const review = await s.listReports({ status: 'needs_review' });
    expect(review.items[0]!.flags.some((f) => f.kind === 'unknown_sub')).toBe(true);
    const text = await s.listReports({ q: 'llovió' });
    expect(text.items.map((i) => i.reportNo)).toEqual(['RL-2041-0187']);
  });

  it('team, glossary, settings, billing, badges and search', async () => {
    const { source: s } = source();
    const team = await s.getTeam();
    expect(team.reporters).toHaveLength(7);
    expect(team.reporters.find((r) => r.name === 'Jorge Medina')!.chipStatus).toBe('invite_sent');
    expect(team.unknownSenders[0]!.phone).toBe('+15550194410');
    expect(team.officeUsers.map((u) => u.role)).toEqual(['admin', 'pm', 'ops', 'accounts']);
    const g = await s.getGlossary();
    expect(g.reviewQueue.map((t) => t.heard).sort()).toEqual([
      'colado',
      'mud',
      'the Ridgeway crew',
    ]);
    const settings = await s.getSettings();
    expect(settings.settings.default_deadline).toBe('17:30:00');
    expect(settings.siteRecipients).toHaveLength(6);
    const b = await s.getBilling();
    expect(b.plan.monthlyCents).toBe(239_400);
    expect(b.invoices.map((i) => i.amountCents)).toEqual([239_400, 239_400, 199_500, 159_600]);
    expect(await s.getNavBadges()).toEqual({
      reportsToReview: 1,
      unknownSenders: 1,
      termsToReview: 3,
      unreadNotifications: 4,
    });
    const results = await s.search('ridgeway');
    expect(results.map((r) => r.kind)).toContain('company');
    expect(results.map((r) => r.kind)).toContain('term');
  });

  it('mutations persist in memory: sign off, undo, no work, resolve company, simulate report', async () => {
    const { source: s, store } = source('pm');
    const hero = store.data.reports.find((r) => r.report_no === 'RL-2041-0187')!;
    const events: string[] = [];
    const unsub = s.subscribe((e) => events.push(e.table));
    await s.signOff(hero.id);
    expect(hero.status).toBe('signed_off');
    expect((await s.getReportDetail(hero.id)).report.signedOffByName).toBe('Sam Kowalski');
    await s.undoSignOff(hero.id);
    expect(hero.status).toBe('filed');

    const oak = store.data.reports.find((r) => r.report_no === 'OM-1187-0133')!;
    await s.resolveUnknownCompany({ reportId: oak.id, name: 'Ridgeway', action: 'add' });
    expect(oak.needs_review).toBe(false);
    expect(oak.current_version).toBe(2);
    expect(store.data.companies.find((c) => c.name === 'Ridgeway')!.status).toBe('confirmed');
    const hours = await s.getHours('2026-W41', null);
    expect(hours.rows.find((r) => r.companyName === 'Ridgeway')!.status).toBe('awaiting');

    const res = await s.simulateIncomingReport();
    expect(res.changed).toBe(true);
    const o = await s.getOverview();
    expect(o.kpis.reportsIn).toBe(5);
    expect(o.kpis.segments.missing).toBe(0);
    expect(o.needsAttention.some((a) => a.kind === 'missing')).toBe(false);
    const elm = o.sitesToday.find((r) => r.projectCode === 'ES-0377')!;
    expect(elm.chip.variant).toBe('filed');
    expect(elm.isLate).toBe(true);
    expect((await s.simulateIncomingReport()).changed).toBe(false);
    expect(events).toContain('reports');
    unsub();
  });

  it('payroll CSV has the §F15 columns and one line per manpower entry', () => {
    const { store } = source();
    const csv = demoPayrollCsv(store, '2026-W41', null);
    const lines = csv.trim().split('\n');
    expect(lines[0]).toBe('date,site,project_code,company,trade,workers,hours,report_no,version');
    expect(lines.length).toBeGreaterThan(80);
    expect(
      lines.some((l) => l.includes('BrightLine Electric,Electrical,5,40,RL-2041-0187,2')),
    ).toBe(true);
  });

  it('payroll CSV follows the saved column order', async () => {
    const { source: s, store } = source();
    await s.saveSettings({
      payroll_columns: ['report_no', 'hours', 'company', 'date', 'site'],
    });
    const header = demoPayrollCsv(store, '2026-W41', null).split('\n')[0];
    expect(header).toBe('report_no,hours,company,date,site,project_code,trade,workers,version');
  });

  it('has no rendered PDFs: every selected report comes back as missing', async () => {
    const { source: s, store } = source();
    const filed = store.data.reports.filter((r) => r.status === 'filed').slice(0, 3);
    const picked = await s.getPdfUrls({ reportIds: filed.map((r) => r.id) });
    expect(picked).toEqual({
      files: [],
      missing: filed.map((r) => r.report_no),
      total: 3,
      capped: false,
    });
    const all = await s.getPdfUrls({ filters: { status: 'all', page: 3, pageSize: 10 } });
    const archive = await s.listReports({ status: 'all' });
    // Filters ignore paging: every matching report up to PDF_EXPORT_LIMIT (200).
    expect(all.total).toBe(archive.total);
    expect(all.missing).toHaveLength(archive.total);
    expect(all.capped).toBe(false);
    await expect(s.getBillingPortalUrl()).rejects.toThrow(/Demo mode/);
  });

  it('edits a reporter and promotes the next reporter on a site that loses its primary', async () => {
    const { source: s, store } = source('ops');
    const riverside = store.data.sites.find((x) => x.project_code === 'RL-2041')!;
    const marco = store.data.reporters.find((r) => r.name === 'Marco Ruiz')!;
    const jorge = store.data.reporters.find((r) => r.name === 'Jorge Medina')!;
    const elm = store.data.sites.find((x) => x.project_code === 'ES-0377')!;
    await s.updateReporter({
      reporterId: marco.id,
      name: 'Marco Ruiz',
      role: 'site_manager',
      siteIds: [elm.id],
      languages: ['es', 'en'],
    });
    const link = (rid: string, sid: string) =>
      store.data.siteReporters.find((x) => x.reporter_id === rid && x.site_id === sid);
    expect(link(marco.id, riverside.id)).toBeUndefined();
    expect(link(marco.id, elm.id)!.is_primary).toBe(false);
    expect(link(jorge.id, riverside.id)!.is_primary).toBe(true);
    expect(marco.phone_e164).toBe('+15550143378');
    expect(store.data.audit.at(-1)).toMatchObject({
      action: 'reporter.updated',
      diff: { sites_added: [elm.id], sites_removed: [riverside.id] },
    });
    await expect(
      s.updateReporter({
        reporterId: marco.id,
        name: ' ',
        role: 'site_manager',
        siteIds: [elm.id],
        languages: [],
      }),
    ).rejects.toThrow('Enter a name.');
    await expect(
      s.updateReporter({
        reporterId: marco.id,
        name: 'Marco',
        role: 'site_manager',
        siteIds: [],
        languages: [],
      }),
    ).rejects.toThrow('Pick at least one site.');
  });

  it('keeps an uploaded logo in memory for the settings preview', async () => {
    const { source: s, store } = source();
    await s.setOrgLogo(new File(['<svg/>'], 'logo.svg', { type: 'image/svg+xml' }));
    const settings = await s.getSettings();
    expect(settings.org.logoPath).toBe(`${store.data.org.id}/logo.svg`);
    expect(settings.org.logoUrl).toMatch(/^blob:/);
    await s.setOrgLogo(null);
    expect((await s.getSettings()).org).toMatchObject({ logoPath: null, logoUrl: null });
  });
});
