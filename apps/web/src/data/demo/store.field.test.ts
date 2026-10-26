import { emptyReportDataV1 } from '@sitelog/shared/schemas/report.ts';
import { describe, expect, it } from 'vitest';
import { makeSource } from '@/test/render';
import { DemoStore } from './store';

/** DemoStore methods behind the /try field simulator. */
describe('DemoStore field-simulator writes', () => {
  const setup = () => {
    const store = new DemoStore();
    const site = store.data.sites.find((s) => s.project_code === 'RL-2041')!;
    const marco = store.data.reporters.find((r) => r.name === 'Marco Ruiz')!;
    return { store, site, marco };
  };

  it('fieldDay describes today and what replacing it leaves', () => {
    const { store, site } = setup();
    const info = store.fieldDay(site.id);
    expect(info).toMatchObject({
      date: '2026-10-09',
      status: 'filed',
      reportNo: 'RL-2041-0187',
      needsReset: true,
      // 19:05 is past deadline + 90 min: an unreported day is Missing on the ladder.
      statusAfterReset: 'missing',
      reportSeqAfterReset: 186,
    });
    const elm = store.data.sites.find((s) => s.project_code === 'ES-0377')!;
    expect(store.fieldDay(elm.id)).toMatchObject({
      status: 'missing',
      reportNo: null,
      needsReset: false,
      reportSeqAfterReset: 24,
    });
  });

  it('resetFieldDay removes the day’s report, rows and messages, rolls the number back, emits', () => {
    const { store, site, marco } = setup();
    const events: string[] = [];
    store.subscribe((e) => events.push(e.table));
    const before = store.fieldDay(site.id);
    const hero = before.reportId!;
    const convo = store.data.conversations.find((c) => c.reporter_id === marco.id)!;
    store.resetFieldDay(site.id, marco.id);
    expect(store.data.reports.some((r) => r.id === hero)).toBe(false);
    expect(store.data.versions.some((v) => v.report_id === hero)).toBe(false);
    expect(store.data.manpower.some((m) => m.report_id === hero)).toBe(false);
    expect(store.data.sources.some((s) => s.report_id === hero)).toBe(false);
    expect(
      store.data.messages.some(
        (m) => m.conversation_id === convo.id && m.created_at.startsWith('2026-10-09T2'),
      ),
    ).toBe(false);
    expect(site.report_seq).toBe(186);
    expect(store.fieldDay(site.id)).toMatchObject({ status: 'missing', reportId: null });
    expect(store.data.audit.at(-1)).toMatchObject({ action: 'site_day.reset', entity: 'site_day' });
    expect(events).toContain('site_days');
  });

  it('open → file: the Overview row flips to Filed with crew and hours, audit + notification', async () => {
    const { store, site, marco } = setup();
    store.resetFieldDay(site.id, marco.id);
    const at = store.nowIso();
    store.openFieldReport({
      id: 'sim-r1',
      siteId: site.id,
      reporterId: marco.id,
      reportNo: 'RL-2041-0187',
      kind: 'daily',
      at,
    });
    store.setFieldDayStatus(site.id, 'processing');
    const source = makeSource('admin', store);
    let row = (await source.getOverview()).sitesToday.find((r) => r.siteId === site.id)!;
    expect(row.chip.label).toBe('Awaiting');

    const data = emptyReportDataV1('2026-10-09');
    data.summary = 'Test day.';
    data.manpower = [
      {
        companyId: store.data.companies.find((c) => c.name === 'Apex Concrete')!.id,
        companyNameHeard: 'Apex',
        companyName: 'Apex Concrete',
        workers: 6,
        hoursPerWorker: 8,
        totalHours: 48,
        hoursBasis: 'stated',
        confidence: 0.95,
        source: [{ type: 'audio', messageId: 'sim-m1', start: 0 }],
      },
    ];
    store.fileFieldReport({
      reportId: 'sim-r1',
      kind: 'daily',
      data,
      trigger: 'confirm',
      reasons: [],
      at,
      sources: [{ messageId: 'sim-m1', kind: 'audio', caption: null, at }],
      questions: [],
    });
    row = (await source.getOverview()).sitesToday.find((r) => r.siteId === site.id)!;
    expect(row.chip.label).toBe('Filed');
    expect(row.reportNo).toBe('RL-2041-0187');
    expect(row.crew).toBe(6);
    expect(row.hours).toBe(48);
    const report = store.data.reports.find((r) => r.id === 'sim-r1')!;
    expect(report).toMatchObject({ status: 'filed', current_version: 1, is_late: true });
    expect(store.data.audit.slice(-2)).toMatchObject([
      { action: 'report.filed', actor_type: 'reporter' },
      { action: 'report.pdf_rendered', diff: { version: 1 } },
    ]);
    // Nothing to review: the panel is not notified (pipeline/file.ts; "Report filed" is email).
    expect(store.data.notifications.some((n) => n.target_path === '/reports/sim-r1')).toBe(false);

    store.addFieldVersion({
      reportId: 'sim-r1',
      version: 2,
      data: { ...data, manpower: [{ ...data.manpower[0]!, workers: 7, totalHours: 56 }] },
      author: 'reporter',
      changeNote: 'Apex Concrete 7 workers · 56 h (was 6 · 48 h)',
      messageId: 'sim-m9',
      source: null,
      at,
    });
    const detail = await source.getReportDetail('sim-r1');
    expect(detail.version).toBe(2);
    expect(detail.versions.map((v) => v.author)).toEqual(['agent', 'reporter']);
  });

  it('no work flips the site-day without a report; a weather day files its own record', () => {
    const { store, site, marco } = setup();
    store.resetFieldDay(site.id, marco.id);
    store.markFieldNoWork(site.id);
    expect(store.fieldDay(site.id)).toMatchObject({ status: 'no_work', reportId: null });

    store.resetFieldDay(site.id, marco.id);
    const at = store.nowIso();
    store.openFieldReport({
      id: 'sim-wx',
      siteId: site.id,
      reporterId: marco.id,
      reportNo: 'RL-2041-0187',
      kind: 'weather_day',
      at,
    });
    const data = emptyReportDataV1('2026-10-09');
    data.weather.periods = [{ condition: 'Rain', fullDay: true, lostHours: 8, source: [] }];
    store.fileFieldReport({
      reportId: 'sim-wx',
      kind: 'weather_day',
      data,
      trigger: 'weather_day',
      reasons: [],
      at,
      sources: [],
      questions: [],
    });
    expect(store.fieldDay(site.id)).toMatchObject({
      status: 'weather_day',
      reportId: 'sim-wx',
      reportStatus: 'filed',
    });
    expect(store.data.reports.find((r) => r.id === 'sim-wx')!.kind).toBe('weather_day');
  });

  it('resetFieldDay can keep the current chat’s messages; removeFieldMessages drops them', () => {
    const { store, site, marco } = setup();
    const at = store.nowIso();
    store.recordFieldMessages(marco.id, [
      { id: 'tryX-m1', direction: 'in', type: 'text', body: 'help', at },
    ]);
    store.resetFieldDay(site.id, marco.id, { keepMessageIdPrefix: 'tryX-' });
    expect(store.data.messages.some((m) => m.id === 'tryX-m1')).toBe(true);
    store.removeFieldMessages(marco.id, 'tryX-');
    expect(store.data.messages.some((m) => m.id === 'tryX-m1')).toBe(false);
  });

  it('a company added twice from the field is one unconfirmed company', () => {
    const { store } = setup();
    const at = store.nowIso();
    const a = store.addFieldCompany({ id: 'c1', name: 'Prairie Roofing', at });
    const b = store.addFieldCompany({ id: 'c2', name: 'prairie roofing', at });
    expect(b).toBe(a);
    expect(store.data.companies.filter((c) => /prairie/i.test(c.name))).toHaveLength(1);
  });
});
