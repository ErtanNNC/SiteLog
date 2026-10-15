import { describe, expect, it } from 'vitest';
import { emptyReportDataV1 } from '@sitelog/shared/schemas/report.ts';
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
    // Riverside 24 + Oakmont 23 + Pier 9 13 + Northgate 14 (§18.1: 14 workers, 100.0 h)
    expect(o.kpis.crewOnSite).toBe(74);
    expect(o.kpis.laborHours).toBe(580);
    // Riverside (3.5 h), Pier 9 (2 h), Hillcrest (weather day, 5 h)
    expect(o.kpis.weatherAffectedSites).toBe(3);
    expect(o.kpis.weatherLostHours).toBe(10.5);
    expect(o.earliestDeadline).toBe('17:30');
    expect(o.reminder1At).toBe('17:45');
    expect(o.pausedCount).toBe(0);
    expect(o.hasReporter).toBe(true);
    expect(o.remindersOn).toBe(true);
    const byCode = Object.fromEntries(o.sitesToday.map((r) => [r.projectCode, r]));
    expect(byCode['ES-0377']!.chip.variant).toBe('missing');
    expect(byCode['OM-1187']!.chip.variant).toBe('needs_review');
    expect(byCode['HS-0418']!.chip.variant).toBe('weather_day');
    expect(byCode['RL-2041']!.crew).toBe(24);
    expect(byCode['RL-2041']!.hours).toBe(192);
    expect(byCode['RL-2041']!.lostHours).toBe(3.5);
    expect(o.sitesToday[0]!.projectCode).toBe('ES-0377'); // exceptions first
  });

  it('overview: needs-attention order missing → needs_review → invoice_gap → unknown_contact → glossary_review', async () => {
    const { source: s } = source();
    const o = await s.getOverview();
    expect(o.needsAttention.map((a) => a.kind)).toEqual([
      'missing',
      'needs_review',
      'invoice_gap',
      'invoice_gap',
      'unknown_contact',
      'glossary_review',
    ]);
    // The Web-Overview artboard's cards, as copy keys with their values.
    expect(o.needsAttention[0]!.body).toEqual([
      { key: 'overview.attention.missing.body', vars: { first: 'Priya', count: 2 } },
    ]);
    expect(o.needsAttention[1]!.title).toEqual({
      key: 'overview.attention.needs_review.titleUnknownCompany',
      vars: { site: 'Oakmont', name: 'Ridgeway' },
    });
    expect(o.needsAttention[1]!.body).toEqual([
      { key: 'overview.attention.needs_review.unknownCompany', vars: { count: 6 } },
    ]);
    expect(o.needsAttention[2]!.title).toEqual({
      key: 'overview.attention.invoice_gap.title',
      vars: { company: 'BrightLine Electric', invoiced: { hours: 212 } },
    });
    expect(o.needsAttention[2]!.body).toEqual([
      {
        key: 'overview.attention.invoice_gap.bodyOver',
        vars: { reported: { hours: 196 }, gap: { hours: 16 } },
      },
    ]);
    expect(o.needsAttention[3]!.title.vars).toMatchObject({ company: 'ClearView Glazing' });
    expect(o.needsAttention[4]!.title.key).toBe('overview.attention.unknown_contact.titleCall');
    expect(o.needsAttention[0]!.actions.map((a) => a.kind)).toEqual([
      'call',
      'text_link',
      'mark_no_work',
    ]);
  });

  it('overview: the channel of each site (D35), and Elm St.’s two reminders', async () => {
    const { source: s } = source();
    const o = await s.getOverview();
    const byCode = Object.fromEntries(o.sitesToday.map((r) => [r.projectCode, r]));
    // §18.1: Riverside by the web recorder, Northgate and Hillcrest by call.
    expect(byCode['RL-2041']).toMatchObject({ channel: 'link', channelReported: true });
    expect(byCode['NG-2210']).toMatchObject({ channel: 'call', channelReported: true });
    expect(byCode['HS-0418']).toMatchObject({ channel: 'call', channelReported: true });
    // Elm St. has no report: Priya's preference.
    expect(byCode['ES-0377']).toMatchObject({
      channel: 'link',
      channelReported: false,
      remindersSent: 2,
    });
    expect(byCode['RL-2041']!.remindersSent).toBe(0);
  });

  it('overview: a text that did not arrive today needs attention until a later one does (F17)', async () => {
    const { source: s, store } = source();
    const priya = store.data.reporters.find((r) => r.name === 'Priya Raman')!;
    const reminder = store.data.messages.find(
      (m) => m.reporter_id === priya.id && m.copy_key === 'reminder_2',
    )!;
    reminder.status = 'undeliverable';
    let o = await s.getOverview();
    const item = o.needsAttention.at(-1)!;
    expect(item.kind).toBe('undeliverable');
    expect(item.title).toEqual({
      key: 'overview.attention.undeliverable.title',
      vars: { name: 'Priya Raman' },
    });
    expect(item.actions.map((a) => a.kind)).toEqual(['call', 'open_team']);
    // "Text today's link" reaches her afterwards: the item goes.
    await s.textDailyLink(store.data.sites.find((x) => x.project_code === 'ES-0377')!.id, 'req-1');
    o = await s.getOverview();
    expect(o.needsAttention.some((a) => a.kind === 'undeliverable')).toBe(false);
  });

  it('overview: review reasons, call_mismatch and no_photo included (§10.5, §10.9)', async () => {
    const { source: s, store } = source();
    const oakmont = store.data.reports.find((r) => r.needs_review)!;
    oakmont.review_reasons = ['call_mismatch:manpower[0].workers', 'no_photo', 'unconfirmed'];
    const o = await s.getOverview();
    const item = o.needsAttention.find((a) => a.kind === 'needs_review')!;
    expect(item.title.key).toBe('overview.attention.needs_review.title');
    expect(item.body).toEqual([
      {
        key: 'overview.attention.reasons.call_mismatch',
        vars: { field: 'manpower[0].workers' },
      },
      { key: 'overview.attention.reasons.no_photo' },
      { key: 'overview.attention.reasons.unconfirmed' },
    ]);
  });

  it('texts today’s link once per request, and says why when it cannot (W1-16)', async () => {
    const { source: s, store } = source('pm');
    const elm = store.data.sites.find((x) => x.project_code === 'ES-0377')!;
    const priya = store.data.reporters.find((r) => r.name === 'Priya Raman')!;
    const before = store.data.messages.length;
    expect(await s.textDailyLink(elm.id, 'req-a')).toEqual({ sent: true, channel: 'sms' });
    expect(await s.textDailyLink(elm.id, 'req-a')).toEqual({ sent: true, channel: 'sms' });
    expect(store.data.messages.length).toBe(before + 1);
    const text = store.data.messages.at(-1)!;
    expect(text).toMatchObject({ reporter_id: priya.id, copy_key: 'daily_link', channel: 'sms' });
    expect(text.body).toMatch(/^Today's report for Elm St\. Townhomes: \S+\/r\/[A-Z0-9]{6}/);
    expect(store.data.audit.at(-1)).toMatchObject({
      action: 'daily_link.texted',
      actor_type: 'user',
      entity_id: priya.id,
    });
    // A second tap texts the same link (the seeded 17:00 one).
    await s.textDailyLink(elm.id, 'req-b');
    expect(store.data.messages.at(-1)!.body).toBe(text.body);
    priya.status = 'opted_out';
    expect(await s.textDailyLink(elm.id, 'req-c')).toEqual({
      sent: false,
      reason: 'opted_out',
      detail: null,
    });
    await expect(source('accounts', store).source.textDailyLink(elm.id, 'req-d')).rejects.toThrow(
      'You’re not allowed to do that.',
    );
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

  it('links a caller or texter as invited until consent, a WhatsApp sender as active (W1-16)', async () => {
    const { source: s, store } = source('ops');
    // §18.1: the unknown contact called (W1-06); a caller is linked from W1-16 on.
    const luis = store.data.unknownContacts.find((u) => u.status === 'pending')!;
    expect(luis.channel).toBe('voice');
    const siteId = luis.guessed_site_id!;
    await s.linkUnknownSender({ unknownSenderId: luis.id, siteId, name: 'Luis' });
    expect(luis.status).toBe('linked');
    const caller = store.data.reporters.find((r) => r.phone_e164 === luis.phone_e164)!;
    expect(caller).toMatchObject({ status: 'invited', name: 'Luis', activated_at: null });
    expect(
      store.data.messages.some((m) => m.reporter_id === caller.id && m.copy_key === 'welcome'),
    ).toBe(true);
    expect(store.data.audit.at(-1)).toMatchObject({
      action: 'unknown_contact.linked',
      entity_id: luis.id,
      diff: { channel: 'voice', consent: 'pending' },
    });
    await expect(
      s.linkUnknownSender({ unknownSenderId: luis.id, siteId, name: 'Luis' }),
    ).rejects.toThrow('This contact was already linked');
    const texter = {
      ...luis,
      id: 'unknown:texter',
      phone_e164: '+15550100111',
      channel: 'sms' as const,
      call_id: null,
      status: 'pending' as const,
    };
    store.data.unknownContacts.push(texter);
    await s.linkUnknownSender({ unknownSenderId: texter.id, siteId, name: 'Texter' });
    expect(store.data.reporters.find((r) => r.phone_e164 === texter.phone_e164)!.status).toBe(
      'invited',
    );
    // A number whose reporter opted out stays out (only START brings it back).
    const stopped = {
      ...texter,
      id: 'unknown:stopped',
      phone_e164: store.data.reporters[0]!.phone_e164,
      status: 'pending' as const,
    };
    store.data.reporters[0]!.status = 'opted_out';
    store.data.unknownContacts.push(stopped);
    await expect(
      s.linkUnknownSender({ unknownSenderId: stopped.id, siteId, name: 'X' }),
    ).rejects.toThrow('You’re not allowed to do that.');
    // A WhatsApp sender (no channel) is linked active, as before.
    const sender = {
      ...texter,
      id: 'unknown:wa',
      phone_e164: '+15550100222',
      channel: null,
      status: 'pending' as const,
    };
    store.data.unknownContacts.push(sender);
    await s.linkUnknownSender({ unknownSenderId: sender.id, siteId, name: 'Luis' });
    expect(sender.status).toBe('linked');
    const reporter = store.data.reporters.find((r) => r.phone_e164 === sender.phone_e164)!;
    expect(reporter).toMatchObject({ status: 'active', name: 'Luis' });
    expect(reporter.activated_at).not.toBeNull();
  });

  it('shows each role the notifications §13 addresses to it, as RLS does on Supabase', async () => {
    const titles = async (as: 'admin' | 'pm' | 'ops' | 'accounts') =>
      (await source(as).source.getNotifications()).map((n) => n.kind).sort();
    expect(await titles('admin')).toEqual([
      'glossary_review',
      'invoice_gap',
      'missing_report',
      'needs_review',
      'unknown_contact',
    ]);
    expect(await titles('pm')).toEqual(['glossary_review', 'needs_review', 'pack_ready']);
    expect(await titles('ops')).toEqual([
      'glossary_review',
      'invoice_gap',
      'missing_report',
      'needs_review',
      'unknown_contact',
    ]);
    expect(await titles('accounts')).toEqual(['invoice_gap']);
    expect((await source('accounts').source.getNavBadges()).unreadNotifications).toBe(1);
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

  it("overview: Today's PDFs lists a report typed today that has no stored PDF yet", async () => {
    const { source: s, store } = source();
    const elm = store.data.sites.find((x) => x.project_code === 'ES-0377')!;
    const typed = store.createOfficeReport({
      siteId: elm.id,
      date: '2026-10-09',
      data: { ...emptyReportDataV1('2026-10-09'), summary: 'Typed in the office.' },
      userId: demoUserFor('admin').id,
    });
    expect(store.data.versions.find((v) => v.report_id === typed.reportId)!.pdf_path).toBeNull();
    const o = await s.getOverview();
    // The four filed today in §18 plus the typed one; the zip export renders its PDF.
    expect(o.pdfReportIds).toHaveLength(5);
    expect(o.pdfReportIds).toContain(typed.reportId);
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
    const dateOf = new Map(store.data.siteDays.map((d) => [d.id, d.date]));
    expect(picked).toEqual({
      files: [],
      // The report date and current version name the file (§12, D33).
      missing: filed.map((r) => ({
        reportId: r.id,
        reportNo: r.report_no,
        date: dateOf.get(r.site_day_id),
        version: r.current_version,
      })),
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

  it('stores a browser-rendered PDF on the version, like attach_version_pdf, with an activity row', async () => {
    const { source: s, store } = source();
    const r = store.data.reports.find((x) => x.status === 'filed')!;
    const v = store.data.versions.find(
      (x) => x.report_id === r.id && x.version === r.current_version,
    )!;
    v.pdf_path = null;
    await s.saveReportPdf({
      reportId: r.id,
      reportNo: r.report_no,
      siteId: r.site_id,
      version: r.current_version,
      pdf: new Blob(['%PDF-1.3'], { type: 'application/pdf' }),
    });
    expect(v.pdf_path).toBe(
      `${store.data.org.id}/${r.site_id}/${r.report_no}_v${r.current_version}.pdf`,
    );
    expect(store.data.audit.at(-1)).toMatchObject({
      action: 'report.pdf_rendered',
      entity: 'report',
      entity_id: r.id,
      diff: { version: r.current_version, renderer: 'browser' },
    });
    const picked = await s.getPdfUrls({ reportIds: [r.id] });
    expect(picked.files.map((f) => f.reportNo)).toEqual([r.report_no]);
    const detail = await s.getReportDetail(r.id);
    expect(detail.activity).toContainEqual(
      expect.objectContaining({ label: 'PDF created', detail: `v${r.current_version}` }),
    );
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

describe('DemoSource.getOrgs', () => {
  it('gives the org’s locale and country pack (the setup wizard locks the country)', async () => {
    const { source: s } = source();
    expect(await s.getOrgs()).toEqual([
      expect.objectContaining({ name: 'Kestrel Build Group', locale: 'en-US', country: 'US' }),
    ]);
  });
});

describe('DemoSource.updateOrg (setup wizard company step in an existing org)', () => {
  it('edits the one org, audits only the changed fields and refuses a blank name', async () => {
    const { source: s, store } = source();
    const before = store.data.audit.length;
    await s.updateOrg({
      name: '  Kestrel Build Group LLC ',
      timezone: 'America/Chicago',
      address: '2101 W Fulton St, Chicago, IL 60612',
      licenseNo: '  ',
    });
    expect((await s.getSettings()).org).toMatchObject({
      id: s.orgId,
      name: 'Kestrel Build Group LLC',
      licenseNo: null,
    });
    expect((await s.getOrgs()).map((o) => o.name)).toEqual(['Kestrel Build Group LLC']);
    expect(store.data.audit.at(-1)).toMatchObject({
      action: 'org.updated',
      entity_id: s.orgId,
      diff: {
        name: { from: 'Kestrel Build Group', to: 'Kestrel Build Group LLC' },
        license_no: { from: 'IL GC-104-5582', to: null },
      },
    });
    expect(Object.keys(store.data.audit.at(-1)!.diff ?? {})).toEqual(['name', 'license_no']);
    // Nothing changed: no audit row.
    await s.updateOrg({
      name: 'Kestrel Build Group LLC',
      timezone: 'America/Chicago',
      address: '2101 W Fulton St, Chicago, IL 60612',
    });
    expect(store.data.audit.length).toBe(before + 1);
    await expect(s.updateOrg({ name: ' ', timezone: 'America/Chicago' })).rejects.toThrow(
      'Enter your company name.',
    );
  });

  it('createSite reports no follow-up failure (the in-memory invite cannot fail apart)', async () => {
    const { source: s } = source();
    await expect(
      s.createSite({
        name: 'Westgate Clinic',
        projectCode: 'WG-0100',
        timezone: 'America/Chicago',
      }),
    ).resolves.toMatchObject({ inviteError: null, recipientsError: null });
  });
});
