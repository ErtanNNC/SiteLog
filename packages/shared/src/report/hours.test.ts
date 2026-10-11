import { describe, expect, it } from 'vitest';
import {
  deriveTotals,
  hoursBetween,
  hoursFromEndTime,
  recomputeManpowerTotals,
  splitWorkingHours,
} from './hours.ts';
import type { ManpowerEntry } from '../schemas/report.ts';

const entry = (over: Partial<ManpowerEntry>): ManpowerEntry => ({
  companyId: 'c1',
  companyNameHeard: 'Apex',
  companyName: 'Apex Concrete',
  workers: 6,
  hoursPerWorker: 8,
  totalHours: 48,
  hoursBasis: 'stated',
  confidence: 0.95,
  source: [{ type: 'audio', messageId: 'm1', start: 12.4 }],
  ...over,
});

describe('recomputeManpowerTotals', () => {
  it('computes workers × hoursPerWorker and overrides a wrong model total', () => {
    const { entries, discrepancies } = recomputeManpowerTotals([entry({ totalHours: 50 })]);
    expect(entries[0]!.totalHours).toBe(48);
    expect(discrepancies).toEqual([
      { index: 0, companyName: 'Apex Concrete', modelTotal: 50, computedTotal: 48 },
    ]);
  });
  it('keeps a total when only the total was stated', () => {
    const { entries } = recomputeManpowerTotals([
      entry({ workers: null, hoursPerWorker: null, totalHours: 40 }),
    ]);
    expect(entries[0]!.totalHours).toBe(40);
  });
  it('derives the rate when only workers and a stated total are known', () => {
    const { entries } = recomputeManpowerTotals([entry({ hoursPerWorker: null, totalHours: 48 })]);
    expect(entries[0]).toMatchObject({ hoursPerWorker: 8, totalHours: 48 });
  });
  it('sets total to null when nothing can be computed', () => {
    const { entries } = recomputeManpowerTotals([
      entry({ hoursPerWorker: null, totalHours: null }),
    ]);
    expect(entries[0]!.totalHours).toBeNull();
  });
  it('handles fractional hours', () => {
    const { entries } = recomputeManpowerTotals([
      entry({ workers: 7, hoursPerWorker: 8.5, totalHours: null }),
    ]);
    expect(entries[0]!.totalHours).toBe(59.5);
  });
});

describe('deriveTotals', () => {
  it('sums crew, hours, subs and lost hours', () => {
    const totals = deriveTotals(
      {
        manpower: [
          entry({}),
          entry({
            companyId: 'c2',
            companyName: 'Delta Mechanical',
            workers: 5,
            hoursPerWorker: 8,
            totalHours: 40,
          }),
          entry({
            companyId: 'self',
            companyName: 'Kestrel self-perform',
            workers: 12,
            hoursPerWorker: 8,
            totalHours: 96,
          }),
        ],
        weather: {
          conditionsText: 'Rain AM',
          periods: [{ condition: 'Rain', lostHours: 3.5, source: [] }],
        },
      },
      { selfPerformCompanyIds: new Set(['self']) },
    );
    expect(totals).toMatchObject({
      crewOnSite: 23,
      companies: 3,
      subcontractors: 2,
      totalHours: 184,
      hoursKnown: true,
      headcountKnown: true,
      lostHours: 3.5,
      weatherAffected: true,
    });
  });
  it('flags unknown headcount/hours', () => {
    const totals = deriveTotals({
      manpower: [entry({ workers: null, hoursPerWorker: null, totalHours: null })],
      weather: { conditionsText: '', periods: [] },
    });
    expect(totals.headcountKnown).toBe(false);
    expect(totals.hoursKnown).toBe(false);
    expect(totals.weatherAffected).toBe(false);
  });
});

describe('working hours helpers', () => {
  it('splits ranges with different dashes', () => {
    expect(splitWorkingHours('07:00–15:30')).toEqual(['07:00', '15:30']);
    expect(splitWorkingHours('7:00 - 15:30')).toEqual(['07:00', '15:30']);
    expect(splitWorkingHours(null)).toEqual([]);
  });
  it('computes hours between and from an end time', () => {
    expect(hoursBetween('07:00', '15:30')).toBe(8.5);
    expect(hoursFromEndTime('07:00–15:30', '15:00')).toBe(8);
    expect(hoursFromEndTime('07:00–15:30', '15:00', 0.5)).toBe(7.5);
    expect(hoursBetween('15:30', '07:00')).toBeNull();
  });
});
