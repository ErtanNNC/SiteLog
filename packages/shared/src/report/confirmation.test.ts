import { describe, expect, it } from 'vitest';
import { emptyReportData, type DailyReportData, type ManpowerEntry } from '../schemas/report.ts';
import { answerConfirmation } from './confirmation.ts';
import { applyAnswer } from './validate.ts';

const delta: ManpowerEntry = {
  companyId: null,
  companyNameHeard: 'the Delta guys',
  companyName: 'Delta Mechanical',
  area: 'Level 2',
  workers: null,
  hoursPerWorker: 8,
  totalHours: null,
  hoursBasis: 'full_day_default',
  confidence: 0.85,
  source: [],
};

function draft(manpower: ManpowerEntry[] = [delta]): DailyReportData {
  return {
    ...emptyReportData('2026-10-09', { reportLanguage: 'en', units: 'imperial' }),
    manpower,
  };
}

const ctx = { defaultShiftHours: 8, source: { type: 'answer', questionId: 'q1' } as const };

describe('answerConfirmation (F7 confirmation line)', () => {
  it('reads the crew’s numbers from the draft the answer made: 5 · full day = 40 h', () => {
    const value = { workers: 5, fullDay: true };
    const target = { manpowerIndex: 0 };
    const { data } = applyAnswer(draft(), { field: 'manpower.workers', target }, value, ctx);
    expect(answerConfirmation('manpower.workers', target, data, value)).toEqual({
      kind: 'crew',
      company: 'Delta Mechanical',
      workers: 5,
      hoursPerWorker: 8,
      totalHours: 40,
    });
  });

  it('keeps an unknown number null instead of guessing it', () => {
    const entry = { ...delta, hoursPerWorker: null, hoursBasis: 'unknown' as const };
    const value = { workers: 3 };
    const target = { manpowerIndex: 0 };
    const { data } = applyAnswer(draft([entry]), { field: 'manpower.workers', target }, value, ctx);
    expect(answerConfirmation('manpower.workers', target, data, value)).toMatchObject({
      workers: 3,
      hoursPerWorker: null,
      totalHours: null,
    });
  });

  it('names the crew applyAnswer added to an empty draft', () => {
    const value = { workers: 4, fullDay: true };
    const { data } = applyAnswer(draft([]), { field: 'manpower.workers', target: {} }, value, ctx);
    expect(answerConfirmation('manpower.workers', {}, data, value)).toMatchObject({
      kind: 'crew',
      workers: 4,
      totalHours: 32,
    });
  });

  it('words a company, the weather and the rest', () => {
    const d = draft();
    expect(
      answerConfirmation('company.unknown', { manpowerIndex: 0 }, d, { companyAction: 'add' }),
    ).toEqual({ kind: 'company_added', company: 'Delta Mechanical' });
    expect(
      answerConfirmation('company.unknown', { manpowerIndex: 0 }, d, { companyAction: 'map' }),
    ).toEqual({ kind: 'company_mapped', company: 'Delta Mechanical' });
    expect(answerConfirmation('company.unknown', {}, d, { companyAction: 'add' })).toEqual({
      kind: 'noted',
    });
    expect(answerConfirmation('weather.impact', {}, d, { lostHours: 3.5 })).toEqual({
      kind: 'weather',
      lostHours: 3.5,
    });
    expect(answerConfirmation('weather.impact', {}, d, { impact: 'stopped' })).toEqual({
      kind: 'noted',
    });
    expect(answerConfirmation('safety', {}, d, { noIncidentsStated: true })).toEqual({
      kind: 'noted',
    });
    expect(answerConfirmation('manpower.hours', { manpowerIndex: 4 }, d, {})).toEqual({
      kind: 'noted',
    });
  });
});
