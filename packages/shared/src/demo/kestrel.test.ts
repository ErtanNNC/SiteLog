import { describe, expect, it } from 'vitest';
import { kestrelDemo, DEMO_TODAY } from './kestrel.ts';
import { deriveTotals } from '../report/hours.ts';
import type { DailyReportData } from '../schemas/report.ts';
import { DailyReportDataSchema } from '../schemas/report.ts';

const demo = kestrelDemo();
const byName = (n: string) => demo.companies.find((c) => c.name === n)!.id;

describe('Kestrel demo data (§18)', () => {
  it('has the six sites, reporters and companies', () => {
    expect(demo.sites.map((s) => s.project_code)).toEqual([
      'RL-2041',
      'OM-1187',
      'P9-0932',
      'NG-2210',
      'HS-0418',
      'ES-0377',
    ]);
    expect(demo.reporters).toHaveLength(7);
    expect(demo.reporters.find((r) => r.name === 'Jorge Medina')!.status).toBe('invited');
    expect(demo.companies.map((c) => c.name)).toContain('Ridgeway');
    expect(demo.companies.find((c) => c.name === 'Ridgeway')!.status).toBe('unconfirmed');
  });

  it('matches the Oct 5–9 hours table exactly', () => {
    const week = ['2026-10-05', '2026-10-06', '2026-10-07', '2026-10-08', '2026-10-09'];
    const current = demo.manpower.filter((m) => {
      const r = demo.reports.find((x) => x.id === m.report_id)!;
      const sd = demo.siteDays.find((x) => x.id === r.site_day_id)!;
      return (
        r.current_version === m.version &&
        week.includes(sd.date) &&
        ['filed', 'signed_off'].includes(r.status)
      );
    });
    const perDay = (name: string) =>
      week.map((d) =>
        current
          .filter(
            (m) =>
              m.company_id === byName(name) &&
              demo.siteDays.find(
                (x) => x.id === demo.reports.find((r) => r.id === m.report_id)!.site_day_id,
              )!.date === d,
          )
          .reduce((a, m) => a + Number(m.hours), 0),
      );
    expect(perDay('Apex Concrete')).toEqual([88, 96, 96, 88, 104]);
    expect(perDay('BrightLine Electric')).toEqual([40, 40, 36, 40, 40]);
    expect(perDay('Delta Mechanical')).toEqual([72, 80, 80, 72, 80]);
    expect(perDay('Ironclad Steel')).toEqual([48, 40, 48, 48, 48]);
    expect(perDay('ClearView Glazing')).toEqual([32, 32, 32, 24, 32]);
    expect(perDay('Summit Drywall')).toEqual([64, 64, 72, 64, 56]);
    const ridgeway = current
      .filter((m) => m.company_name === 'Ridgeway')
      .reduce((a, m) => a + Number(m.hours), 0);
    expect(ridgeway).toBe(48);
    const subsTotal = current
      .filter((m) => m.company_id !== byName('Kestrel self-perform'))
      .reduce((a, m) => a + Number(m.hours), 0);
    expect(subsTotal).toBe(1804);
  });

  it('has the hero report with two versions (23/184 → 24/192)', () => {
    const hero = demo.reports.find((r) => r.report_no === 'RL-2041-0187')!;
    expect(hero.current_version).toBe(2);
    const v1 = demo.versions.find((v) => v.report_id === hero.id && v.version === 1)!
      .data as unknown as DailyReportData;
    const v2 = demo.versions.find((v) => v.report_id === hero.id && v.version === 2)!
      .data as unknown as DailyReportData;
    const self = new Set([byName('Kestrel self-perform')]);
    expect(deriveTotals(v1, { selfPerformCompanyIds: self })).toMatchObject({
      crewOnSite: 23,
      totalHours: 184,
      subcontractors: 4,
      lostHours: 3.5,
    });
    expect(deriveTotals(v2, { selfPerformCompanyIds: self })).toMatchObject({
      crewOnSite: 24,
      totalHours: 192,
    });
    expect(demo.versions.find((v) => v.report_id === hero.id && v.version === 2)!.change_note).toBe(
      'Apex Concrete 6 → 7 workers',
    );
    expect(demo.questions.find((q) => q.report_id === hero.id)!.answer).toEqual({
      workers: 5,
      fullDay: true,
    });
    for (const v of demo.versions) expect(() => DailyReportDataSchema.parse(v.data)).not.toThrow();
  });

  it('matches the weather log: 10 site-days, 36.5 h, 7 claim-ready', () => {
    const events = demo.weatherEvents.filter(
      (w) =>
        w.date >= '2026-10-01' &&
        demo.reports.find((r) => r.id === w.report_id)!.current_version === w.version,
    );
    expect(events).toHaveLength(10);
    expect(events.reduce((a, w) => a + Number(w.lost_hours), 0)).toBe(36.5);
    expect(events.filter((w) => w.claim_ready)).toHaveLength(7);
  });

  it('has the Oct 9 states from §18', () => {
    const state = (code: string) => {
      const site = demo.sites.find((s) => s.project_code === code)!;
      const sd = demo.siteDays.find((x) => x.site_id === site.id && x.date === DEMO_TODAY)!;
      const r = demo.reports.find((x) => x.site_day_id === sd.id);
      return {
        status: sd.status,
        needsReview: r?.needs_review ?? null,
        reasons: r?.review_reasons ?? null,
      };
    };
    expect(state('RL-2041')).toMatchObject({ status: 'filed', needsReview: false });
    expect(state('OM-1187')).toMatchObject({
      status: 'filed',
      needsReview: true,
      reasons: ['unknown_company:Ridgeway'],
    });
    expect(state('HS-0418').status).toBe('weather_day');
    expect(state('ES-0377').status).toBe('missing');
    expect(demo.unknownSenders[0]!.phone_e164).toBe('+15550194410');
    expect(demo.invoices.find((i) => i.invoice_no === 'BL-3381')!.total_hours).toBe(212);
  });

  it('uses valid, unique ids', () => {
    const ids = [...demo.messages, ...demo.reports, ...demo.siteDays, ...demo.manpower].map(
      (r) => r.id,
    );
    expect(new Set(ids).size).toBe(ids.length);
    for (const id of ids.slice(0, 20))
      expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-8[0-9a-f]{3}-[0-9a-f]{12}$/);
  });
});
