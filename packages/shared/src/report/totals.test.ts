import { describe, expect, it } from 'vitest';
import { kestrelDemo } from '../demo/kestrel.ts';
import { StoredReportDataSchema, type DailyReportData } from '../schemas/report.ts';
import { computeTotals, deriveTotals, recomputeManpowerTotals } from './hours.ts';
import { readReportData } from './upgrade.ts';

/** The §18.1 hero report RL-2041-0187 (Fri Oct 9): v1 as drafted, v2 after "Apex 6 → 7". */
function heroVersions(): Map<number, DailyReportData> {
  const demo = kestrelDemo();
  const report = demo.reports.find((r) => r.report_no === 'RL-2041-0187');
  if (!report) throw new Error('hero report missing from the demo data');
  return new Map(
    demo.versions
      .filter((v) => v.report_id === report.id)
      .map((v) => [v.version, readReportData(StoredReportDataSchema.parse(v.data))]),
  );
}

describe('computeTotals', () => {
  const hero = heroVersions();

  it('gives the hero numbers: v1 23 on site · 184 h, v2 24 · 192 h, 3.5 h lost', () => {
    const v1 = computeTotals(hero.get(1)!);
    expect(v1.totals).toMatchObject({
      crewOnSite: 23,
      totalHours: 184,
      lostHours: 3.5,
      hoursKnown: true,
      headcountKnown: true,
      weatherAffected: true,
    });
    expect(v1.discrepancies).toEqual([]);
    const v2 = computeTotals(hero.get(2)!);
    expect(v2.totals).toMatchObject({ crewOnSite: 24, totalHours: 192, lostHours: 3.5 });
  });

  it('equals recomputeManpowerTotals followed by deriveTotals', () => {
    for (const data of hero.values()) {
      const { entries, discrepancies } = recomputeManpowerTotals(data.manpower);
      expect(computeTotals(data)).toEqual({
        manpower: entries,
        discrepancies,
        totals: deriveTotals({ manpower: entries, weather: data.weather }),
      });
    }
  });

  it('never trusts a model total: the report total comes from workers × hours', () => {
    const data = hero.get(1)!;
    const tampered = {
      ...data,
      manpower: data.manpower.map((m, i) => (i === 0 ? { ...m, totalHours: 500 } : m)),
    };
    const out = computeTotals(tampered);
    expect(out.totals.totalHours).toBe(184);
    expect(out.discrepancies).toHaveLength(1);
    expect(out.discrepancies[0]).toMatchObject({ index: 0, modelTotal: 500 });
    expect(out.manpower[0]!.totalHours).toBe(out.discrepancies[0]!.computedTotal);
  });

  it('marks hours unknown instead of inventing them', () => {
    const data = hero.get(1)!;
    const missing = {
      ...data,
      manpower: data.manpower.map((m, i) =>
        i === 0 ? { ...m, workers: null, hoursPerWorker: null, totalHours: null } : m,
      ),
    };
    const out = computeTotals(missing);
    expect(out.totals.hoursKnown).toBe(false);
    expect(out.totals.headcountKnown).toBe(false);
    expect(out.manpower[0]!.totalHours).toBeNull();
  });

  it('passes the self-perform companies through', () => {
    const data = hero.get(1)!;
    const kestrel = data.manpower.find((m) => /kestrel/i.test(m.companyName))!;
    const all = computeTotals(data).totals;
    const own = computeTotals(data, {
      selfPerformCompanyIds: new Set([kestrel.companyId!]),
    }).totals;
    expect(own.subcontractors).toBe(all.subcontractors - 1);
    expect(own.companies).toBe(all.companies);
  });
});
