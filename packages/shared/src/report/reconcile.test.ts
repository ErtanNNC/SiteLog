import { describe, expect, it } from 'vitest';
import {
  emptyReportData,
  type DailyReportData,
  type ManpowerEntry,
  type Source,
} from '../schemas/report.ts';
import {
  CALL_UNRECONCILED,
  LOST_HOURS_TOLERANCE,
  callMismatchReason,
  draftHasReportValue,
  reasonValue,
  reconcileCall,
  withPreciseCallSeconds,
} from './reconcile.ts';

const CALL = 'c0110000-0000-4000-8000-000000000002';
const live = (start: number, end?: number): Source => ({
  type: 'call',
  callId: CALL,
  start,
  ...(end !== undefined ? { end } : {}),
});

function crew(
  name: string,
  workers: number | null,
  hours: number | null,
  source: Source[],
  id: string | null = name.toLowerCase().split(' ')[0]!,
): ManpowerEntry {
  return {
    companyId: id,
    companyNameHeard: name.split(' ')[0]!,
    companyName: name,
    workers,
    hoursPerWorker: hours,
    totalHours: workers !== null && hours !== null ? workers * hours : null,
    hoursBasis: 'stated',
    confidence: 0.9,
    source,
  };
}

/** The Riverside call: four crews and the morning's rain, as the reporter confirmed it. */
function confirmed(): DailyReportData {
  return {
    ...emptyReportData('2026-10-09', { reportLanguage: 'en', units: 'imperial' }),
    weather: {
      conditionsText: 'Rain 07:00–10:30',
      periods: [
        { start: '07:00', end: '10:30', condition: 'Rain', lostHours: 3.5, source: [live(12.2)] },
      ],
    },
    manpower: [
      crew('Apex Concrete', 6, 8, [live(24.9, 32.1)]),
      crew('BrightLine Electric', 5, 8, [live(32.1, 39)]),
      crew('Delta Mechanical', 4, 8, [live(39, 46.5), { type: 'answer', questionId: 'q1' }]),
    ],
  };
}

/** What the recording says: the same day, its own (precise) seconds. */
function heard(): DailyReportData {
  const d = confirmed();
  d.manpower = [
    crew('Apex Concrete', 6, 8, [live(25.3, 31.8)]),
    crew('BrightLine Electric', 5, 8, [live(32.4, 38.6)]),
    crew('Delta Mechanical', 4, 8, [live(39.2, 46.0)]),
  ];
  d.weather.periods = [
    { start: '07:00', end: '10:30', condition: 'Rain', lostHours: 3.5, source: [live(12.5, 24.1)] },
  ];
  return d;
}

describe('reconcileCall (§10.9, §19 Q123)', () => {
  it('equal: no mismatch, every crew and period gets its precise call seconds', () => {
    const r = reconcileCall(heard(), confirmed(), CALL);
    expect(r.mismatches).toEqual([]);
    expect(r.precise).toEqual([
      { path: 'manpower[0]', start: 25.3, end: 31.8 },
      { path: 'manpower[1]', start: 32.4, end: 38.6 },
      { path: 'manpower[2]', start: 39.2, end: 46 },
      { path: 'weather.periods[0]', start: 12.5, end: 24.1 },
    ]);
    expect(r.compared).toEqual({ crews: 3, periods: 1 });
  });

  it('a headcount differs: call_mismatch:manpower[2].workers:5:4, that crew keeps its live seconds', () => {
    const h = heard();
    h.manpower[2]!.workers = 5;
    const r = reconcileCall(h, confirmed(), CALL);
    expect(r.mismatches.map(callMismatchReason)).toEqual(['call_mismatch:manpower[2].workers:5:4']);
    expect(r.precise.map((p) => p.path)).toEqual([
      'manpower[0]',
      'manpower[1]',
      'weather.periods[0]',
    ]);
  });

  it('hours per worker must be exact', () => {
    const h = heard();
    h.manpower[0]!.hoursPerWorker = 9;
    expect(reconcileCall(h, confirmed(), CALL).mismatches.map(callMismatchReason)).toEqual([
      'call_mismatch:manpower[0].hoursPerWorker:9:8',
    ]);
  });

  it('matches crews by company, not by position', () => {
    const h = heard();
    h.manpower.reverse();
    expect(reconcileCall(h, confirmed(), CALL).mismatches).toEqual([]);
  });

  it('matches a crew by name when one side has no company id', () => {
    const h = heard();
    h.manpower[1] = { ...h.manpower[1]!, companyId: null };
    expect(reconcileCall(h, confirmed(), CALL).mismatches).toEqual([]);
  });

  it('a crew missing from the report: the confirmed side is empty (Q152)', () => {
    const h = heard();
    h.manpower.push(crew('Ironclad Steel', 3, 8, [live(46.5, 53.2)]));
    expect(reconcileCall(h, confirmed(), CALL).mismatches.map(callMismatchReason)).toEqual([
      'call_mismatch:manpower[3]:Ironclad Steel 3:',
    ]);
  });

  it('a crew missing from the recording: the heard side is empty', () => {
    const h = heard();
    h.manpower.splice(1, 1);
    expect(reconcileCall(h, confirmed(), CALL).mismatches.map(callMismatchReason)).toEqual([
      'call_mismatch:manpower[1]::BrightLine Electric 5',
    ]);
  });

  it('a number the recording does not state is not compared', () => {
    const h = heard();
    h.manpower[2]!.workers = null;
    const r = reconcileCall(h, confirmed(), CALL);
    expect(r.mismatches).toEqual([]);
    expect(r.precise.map((p) => p.path)).toContain('manpower[2]');
  });

  it('a number the recording states and the report leaves empty is a mismatch', () => {
    const c = confirmed();
    c.manpower[2]!.workers = null;
    expect(reconcileCall(heard(), c, CALL).mismatches.map(callMismatchReason)).toEqual([
      'call_mismatch:manpower[2].workers:4:',
    ]);
  });

  it('lost hours within ±0.25 h agree; beyond it they differ', () => {
    const within = heard();
    within.weather.periods[0]!.lostHours = 3.5 + LOST_HOURS_TOLERANCE;
    expect(reconcileCall(within, confirmed(), CALL).mismatches).toEqual([]);
    const outside = heard();
    outside.weather.periods[0]!.lostHours = 4;
    expect(reconcileCall(outside, confirmed(), CALL).mismatches.map(callMismatchReason)).toEqual([
      'call_mismatch:weather.periods[0].lostHours:4:3.5',
    ]);
  });

  it('a stoppage on one side only is a mismatch; a period without lost hours is not', () => {
    const h = heard();
    h.weather.periods.push({
      start: '14:00',
      end: '15:00',
      condition: 'High wind',
      lostHours: 1,
      source: [live(60)],
    });
    h.weather.periods.push({ condition: 'Overcast', lostHours: 0, source: [live(61)] });
    expect(reconcileCall(h, confirmed(), CALL).mismatches.map(callMismatchReason)).toEqual([
      'call_mismatch:weather.periods[1]:High wind 1:',
    ]);
    const none = heard();
    none.weather.periods = [];
    expect(reconcileCall(none, confirmed(), CALL).mismatches.map(callMismatchReason)).toEqual([
      'call_mismatch:weather.periods[0]::Rain 3.5',
    ]);
  });

  it('pairs periods without times by condition', () => {
    const h = heard();
    h.weather.periods = [{ condition: 'rain', lostHours: 3.5, source: [live(13)] }];
    expect(reconcileCall(h, confirmed(), CALL).mismatches).toEqual([]);
  });

  it('keeps the separator out of the values', () => {
    expect(reasonValue('Rain 07:00 – 10:30\n')).toBe('Rain 07 00 – 10 30');
    expect(
      callMismatchReason({ path: 'manpower[0]', heard: 'A: B 3', confirmed: '' }).split(':'),
    ).toHaveLength(4);
    expect(CALL_UNRECONCILED).toBe('call_unreconciled');
  });
});

describe('draftHasReportValue (§19 Q122)', () => {
  it('an empty draft has none; one crew, a work item or the weather is enough', () => {
    const empty = emptyReportData('2026-10-09', { reportLanguage: 'en', units: 'imperial' });
    expect(draftHasReportValue(empty)).toBe(false);
    expect(draftHasReportValue(confirmed())).toBe(true);
    expect(
      draftHasReportValue({ ...empty, weather: { conditionsText: 'Sunny', periods: [] } }),
    ).toBe(true);
    expect(
      draftHasReportValue({
        ...empty,
        safety: { ...empty.safety, noIncidentsStated: true },
      }),
    ).toBe(true);
  });
});

describe('withPreciseCallSeconds (P7)', () => {
  it('replaces the live seconds of the value at each path, other sources kept', () => {
    const out = withPreciseCallSeconds(confirmed(), [
      { call_id: CALL, value_path: 'manpower[2]', start_s: '39.2', end_s: '46' },
      { call_id: CALL, value_path: 'weather.periods[0]', start_s: 12.5, end_s: null },
      { call_id: CALL, value_path: null, start_s: null, end_s: null },
    ]);
    expect(out.manpower[2]!.source).toEqual([
      { type: 'call', callId: CALL, start: 39.2, end: 46 },
      { type: 'answer', questionId: 'q1' },
    ]);
    expect(out.weather.periods[0]!.source).toEqual([{ type: 'call', callId: CALL, start: 12.5 }]);
    expect(out.manpower[0]!.source).toEqual([live(24.9, 32.1)]);
  });

  it('leaves a value that no longer cites the call alone, and the data as it was with no rows', () => {
    const data = confirmed();
    expect(withPreciseCallSeconds(data, [])).toBe(data);
    expect(
      withPreciseCallSeconds(data, [
        { call_id: 'another', value_path: 'manpower[0]', start_s: 1, end_s: 2 },
        { call_id: CALL, value_path: 'manpower[9]', start_s: 1, end_s: 2 },
      ]),
    ).toBe(data);
  });
});
