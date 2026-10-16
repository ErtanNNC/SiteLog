import { describe, expect, it } from 'vitest';
import { DailyReportDataSchema } from '../schemas/report.ts';
import { DAY_OFF_POLICY, dayOffReportData, weatherDayHours } from './day-off.ts';

const Q = {
  since: '00000000-0000-4000-8000-0000000000a1',
  workersBefore: '00000000-0000-4000-8000-0000000000a2',
};
const base = {
  date: '2026-10-13',
  siteName: 'Riverside Lofts',
  org: { reportLanguage: 'en' as const, units: 'imperial' as const },
  questionIds: Q,
  workingHours: '07:00–15:30',
  defaultShiftHours: 8,
};

describe('weatherDayHours (computed in code, every channel)', () => {
  const at = (releasedAt: string | null, workingHours: string | null = '07:00–15:30') =>
    weatherDayHours({
      releasedAt,
      fullDay: releasedAt === null,
      workingHours,
      defaultShiftHours: 8,
    });

  it('splits the working day at the stop', () => {
    expect(at('09:00')).toEqual({
      start: '07:00',
      end: '15:30',
      lostHours: 6.5,
      workedHours: 2,
      fullDay: false,
    });
  });

  it('loses the whole span for a stop at or before the start, nothing after the end', () => {
    expect(at('07:00')).toMatchObject({ lostHours: 8.5, workedHours: 0 });
    expect(at('06:00')).toMatchObject({ lostHours: 8.5, workedHours: 0 });
    expect(at('16:00')).toMatchObject({ lostHours: 0, workedHours: 8.5 });
  });

  it('a full day loses the default shift; without working hours a partial one half of it (Q62)', () => {
    expect(at(null)).toMatchObject({ lostHours: 8, workedHours: null, fullDay: true });
    expect(at('11:00', null)).toMatchObject({ lostHours: 4, workedHours: null, fullDay: false });
  });
});

describe('dayOffReportData (F12, spec §19 Q41; W2-08)', () => {
  it('Weather from 09:00 with 12 on site: lost hours and crew hours in code, sourced to the two answers', () => {
    const data = dayOffReportData({
      ...base,
      kind: 'weather_day',
      details: { since: '09:00', workersBefore: 12 },
    });
    expect(DailyReportDataSchema.parse(data)).toEqual(data);
    expect(data.weather.periods).toEqual([
      {
        start: '09:00',
        end: '15:30',
        condition: 'Weather',
        impact: 'Work stopped at 09:00; site closed for weather',
        lostHours: 6.5,
        fullDay: false,
        source: [{ type: 'answer', questionId: Q.since }],
      },
    ]);
    expect(data.manpower).toEqual([
      expect.objectContaining({
        companyName: 'Site crew',
        workers: 12,
        hoursPerWorker: 2,
        totalHours: 24,
        hoursBasis: 'answer',
        source: [
          { type: 'answer', questionId: Q.workersBefore },
          { type: 'answer', questionId: Q.since },
        ],
      }),
    ]);
    expect(data.summary).toBe(
      'Weather day: work stopped at 09:00 and the site was closed; 6.5 h lost. 12 on site before the stop; 78 crew-hours lost.',
    );
    expect(data.workingHours).toEqual({ start: '07:00', end: '15:30' });
  });

  it('Never started: a full day from the working day’s start, 0 h worked; Turkish texts', () => {
    const data = dayOffReportData({
      ...base,
      org: { reportLanguage: 'tr', units: 'metric' },
      kind: 'weather_day',
      details: { since: 'never_started', workersBefore: 5 },
    });
    expect(data.weather.periods[0]).toMatchObject({
      start: '07:00',
      fullDay: true,
      lostHours: 8,
      impact: 'Ekip işe başlamadı; şantiye hava nedeniyle kapalı',
    });
    expect(data.manpower[0]).toMatchObject({ workers: 5, hoursPerWorker: 0, totalHours: 0 });
    expect(data.summary).toContain('40 adam-saat kayıp');
  });

  it('invents no crew without a headcount, and needs since for a weather day', () => {
    const data = dayOffReportData({ ...base, kind: 'weather_day', details: { since: '11:00' } });
    expect(data.manpower).toEqual([]);
    expect(data.summary).not.toMatch(/crew-hours/);
    expect(() => dayOffReportData({ ...base, kind: 'weather_day', details: {} })).toThrow(/since/);
  });

  it('No work: the summary only, no manpower or weather period', () => {
    const data = dayOffReportData({ ...base, kind: 'no_work', details: {} });
    expect(data).toMatchObject({
      summary: 'No work at Riverside Lofts today.',
      manpower: [],
      weather: { conditionsText: 'Not recorded (no work)', periods: [] },
    });
  });

  it('keeps refusing the buttons while a report is live (spec §19 Q79 default)', () => {
    expect(DAY_OFF_POLICY).toEqual({ liveReport: 'refuse' });
  });
});
