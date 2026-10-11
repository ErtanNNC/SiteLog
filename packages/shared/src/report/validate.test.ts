import { describe, expect, it } from 'vitest';
import { emptyReportData, type DailyReportData, type ManpowerEntry } from '../schemas/report.ts';
import {
  applyAnswer,
  closestCompany,
  parseQuickAnswer,
  pickNextQuestion,
  validateReport,
} from './validate.ts';

const REQUIRED = ['manpower', 'hours', 'weather', 'work_performed', 'safety', 'photo'] as const;

const mp = (over: Partial<ManpowerEntry>): ManpowerEntry => ({
  companyId: 'apex',
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

function complete(): DailyReportData {
  const d = emptyReportData('2026-10-09');
  d.manpower = [mp({})];
  d.weather = {
    conditionsText: 'Light rain AM',
    periods: [
      {
        condition: 'Light rain',
        start: '07:00',
        end: '10:30',
        impact: 'Masonry stopped',
        lostHours: 3.5,
        source: [],
      },
    ],
  };
  d.workPerformed = [{ area: 'Level 4', activity: 'Slab pour', status: 'complete', source: [] }];
  d.safety = {
    incidents: [],
    noIncidentsStated: true,
    visitors: [],
    source: [],
    toolboxTalk: 'Wet-weather access',
  };
  d.photos = [{ messageId: 'p1', takenAt: '2026-10-09T22:40:00Z' }];
  return d;
}

describe('validateReport', () => {
  it('passes a complete report', () => {
    const v = validateReport(complete(), { requiredFields: REQUIRED });
    expect(v.isComplete).toBe(true);
    expect(v.gaps).toEqual([]);
    expect(v.reviewReasons).toEqual([]);
  });

  it('finds missing headcount, hours, unknown company, safety and photo', () => {
    const d = complete();
    d.manpower = [
      mp({}),
      mp({
        companyId: null,
        companyNameHeard: 'the Delta guys',
        companyName: 'Delta Mechanical',
        workers: null,
        hoursPerWorker: null,
        totalHours: null,
        hoursBasis: 'unknown',
      }),
    ];
    d.safety = { incidents: [], noIncidentsStated: false, visitors: [], source: [] };
    d.photos = [];
    const v = validateReport(d, { requiredFields: REQUIRED });
    expect(v.isComplete).toBe(false);
    expect(v.missingRequired).toEqual([
      'manpower.workers:Delta Mechanical',
      'manpower.hours:Delta Mechanical',
      'safety',
      'photo',
    ]);
    expect(v.reviewReasons).toEqual(['unknown_company:Delta Mechanical']);
    expect(v.gaps.map((g) => g.field)).toEqual([
      'manpower.workers',
      'manpower.hours',
      'company.unknown',
      'safety',
      'photo',
    ]);
  });

  it('flags low confidence and missing work performed for review', () => {
    const d = complete();
    d.manpower = [mp({ confidence: 0.5 })];
    d.workPerformed = [];
    const v = validateReport(d, { requiredFields: REQUIRED });
    expect(v.reviewReasons).toEqual(['low_confidence:manpower', 'missing:work_performed']);
    expect(v.gaps[0]).toMatchObject({ field: 'manpower.workers', reason: 'low_confidence' });
  });

  it('only checks the configured required fields', () => {
    const d = complete();
    d.photos = [];
    d.safety = { incidents: [], noIncidentsStated: false, visitors: [], source: [] };
    expect(validateReport(d, { requiredFields: ['manpower', 'hours'] }).isComplete).toBe(true);
  });
});

describe('pickNextQuestion', () => {
  const companies = [
    { id: 'delta', name: 'Delta Mechanical', aliases: ['the Delta guys'] },
    { id: 'apex', name: 'Apex Concrete', aliases: ['Apex'] },
  ];

  it('asks for headcount first, using the model-written question when present', () => {
    const d = complete();
    d.manpower.push(
      mp({
        companyId: 'delta',
        companyNameHeard: 'the Delta guys',
        companyName: 'Delta Mechanical',
        area: 'Level 2',
        workers: null,
        hoursPerWorker: null,
        totalHours: null,
      }),
    );
    d.proposedQuestions = [
      {
        field: 'manpower.workers',
        question:
          "Quick check: you said 'the Delta guys' were on Level 2. How many, and for how long?",
        options: ['4 · full day', '5 · full day'],
        target: { manpowerIndex: 1 },
      },
    ];
    const v = validateReport(d, { requiredFields: REQUIRED });
    const q = pickNextQuestion(d, v, { askedPaths: [], askedCount: 0, maxQuestions: 3, companies });
    expect(q).toMatchObject({
      field: 'manpower.workers',
      path: 'manpower.workers:Delta Mechanical',
      options: ['4 · full day', '5 · full day'],
    });
    expect(q!.prompt).toContain('the Delta guys');
    // After the headcount question, hours for the same crew are covered.
    const q2 = pickNextQuestion(d, v, {
      askedPaths: [q!.path],
      askedCount: 1,
      maxQuestions: 3,
      companies,
    });
    expect(q2).toBeNull();
  });

  it('offers closest match for an unknown company and respects max questions', () => {
    const d = complete();
    d.manpower = [
      mp({ companyId: null, companyNameHeard: 'the Ridgway crew', companyName: 'Ridgway' }),
    ];
    const v = validateReport(d, { requiredFields: REQUIRED });
    const q = pickNextQuestion(d, v, {
      askedPaths: [],
      askedCount: 0,
      maxQuestions: 3,
      companies: [...companies, { id: 'ridge', name: 'Ridgeway' }],
    });
    expect(q).toMatchObject({
      field: 'company.unknown',
      options: ['Add "Ridgway"', "It's Ridgeway"],
    });
    expect(q!.target.closestCompanyId).toBe('ridge');
    expect(pickNextQuestion(d, v, { askedPaths: [], askedCount: 3, maxQuestions: 3 })).toBeNull();
  });

  it('walks priority: weather impact before safety before photo', () => {
    const d = complete();
    d.weather = { conditionsText: '', periods: [] };
    d.safety = { incidents: [], noIncidentsStated: false, visitors: [], source: [] };
    d.photos = [];
    const v = validateReport(d, { requiredFields: REQUIRED });
    const q1 = pickNextQuestion(d, v, { askedPaths: [], askedCount: 0, maxQuestions: 3 });
    expect(q1!.field).toBe('weather.impact');
    const q2 = pickNextQuestion(d, v, { askedPaths: [q1!.path], askedCount: 1, maxQuestions: 3 });
    expect(q2!.field).toBe('safety');
    const q3 = pickNextQuestion(d, v, {
      askedPaths: [q1!.path, q2!.path],
      askedCount: 2,
      maxQuestions: 3,
    });
    expect(q3!.field).toBe('photo');
  });
});

describe('closestCompany', () => {
  it('matches names and aliases above the threshold', () => {
    const cs = [
      { id: 'd', name: 'Delta Mechanical', aliases: ['the Delta guys'] },
      { id: 'b', name: 'BrightLine Electric' },
    ];
    expect(closestCompany('the delta crew', cs)?.id).toBe('d');
    expect(closestCompany('Bright Line', cs)?.id).toBe('b');
    expect(closestCompany('Ridgeway', cs)).toBeNull();
  });
});

describe('parseQuickAnswer', () => {
  it('parses headcount and duration variants', () => {
    expect(parseQuickAnswer('manpower.workers', '5 · full day')).toEqual({
      workers: 5,
      fullDay: true,
    });
    expect(parseQuickAnswer('manpower.workers', 'five guys till 3')).toEqual({
      workers: 5,
      endTime: '15:00',
    });
    expect(parseQuickAnswer('manpower.workers', '4, 6 hours')).toEqual({
      workers: 4,
      hoursPerWorker: 6,
    });
    expect(parseQuickAnswer('manpower.workers', 'cinco, todo el día')).toEqual({
      workers: 5,
      fullDay: true,
    });
    expect(parseQuickAnswer('manpower.workers', 'not sure')).toBeNull();
    expect(parseQuickAnswer('manpower.hours', 'Half day')).toEqual({ hoursPerWorker: 4 });
    expect(parseQuickAnswer('manpower.hours', '8')).toEqual({ hoursPerWorker: 8 });
  });
  it('parses weather, safety and company answers', () => {
    expect(parseQuickAnswer('weather.impact', 'No stoppage')).toEqual({ lostHours: 0 });
    expect(parseQuickAnswer('weather.impact', 'stopped 2 hours')).toEqual({ lostHours: 2 });
    expect(parseQuickAnswer('safety', 'No incidents')).toEqual({ noIncidentsStated: true });
    expect(parseQuickAnswer('safety', 'Toolbox talk held')).toEqual({
      toolboxTalk: 'Toolbox talk held',
      noIncidentsStated: false,
    });
    expect(parseQuickAnswer('company.unknown', 'Add "Ridgeway"')).toEqual({ companyAction: 'add' });
    expect(parseQuickAnswer('company.unknown', "It's Delta Mechanical")).toEqual({
      companyAction: 'map',
    });
  });
});

describe('applyAnswer', () => {
  it('fills workers and full-day hours with default shift and a reply source', () => {
    const d = complete();
    d.manpower.push(
      mp({
        companyId: 'delta',
        companyName: 'Delta Mechanical',
        workers: null,
        hoursPerWorker: null,
        totalHours: null,
        hoursBasis: 'unknown',
        confidence: 0.6,
      }),
    );
    const { data, ackText } = applyAnswer(
      d,
      { field: 'manpower.workers', target: { manpowerIndex: 1 } },
      { workers: 5, fullDay: true },
      { defaultShiftHours: 8, messageId: 'reply1' },
    );
    expect(data.manpower[1]).toMatchObject({
      workers: 5,
      hoursPerWorker: 8,
      totalHours: 40,
      hoursBasis: 'full_day_default',
      confidence: 1,
    });
    expect(data.manpower[1]!.source.at(-1)).toEqual({ type: 'reply', messageId: 'reply1' });
    expect(ackText).toBe('Thanks — Delta Mechanical: 5 workers × 8 h = 40 h.');
    expect(d.manpower[1]!.workers).toBeNull(); // pure
  });
  it('derives hours from an end time using site working hours', () => {
    const d = complete();
    d.manpower = [mp({ hoursPerWorker: null, totalHours: null })];
    const { data } = applyAnswer(
      d,
      { field: 'manpower.hours', target: { manpowerIndex: 0 } },
      { endTime: '15:00' },
      { defaultShiftHours: 8, workingHours: '07:00–15:30', messageId: 'r' },
    );
    expect(data.manpower[0]).toMatchObject({
      hoursPerWorker: 8,
      totalHours: 48,
      hoursBasis: 'reply',
    });
  });
  it('maps an unknown company to an existing one', () => {
    const d = complete();
    d.manpower = [mp({ companyId: null, companyName: 'Ridgway' })];
    const { data, ackText } = applyAnswer(
      d,
      {
        field: 'company.unknown',
        target: { manpowerIndex: 0, closestCompanyId: 'ridge', closestCompanyName: 'Ridgeway' },
      },
      { companyAction: 'map' },
      { defaultShiftHours: 8, messageId: 'r', companies: [{ id: 'ridge', name: 'Ridgeway' }] },
    );
    expect(data.manpower[0]).toMatchObject({ companyId: 'ridge', companyName: 'Ridgeway' });
    expect(ackText).toBe('Thanks — logged as Ridgeway.');
  });
  it('records weather stoppage and safety answers', () => {
    const d = complete();
    d.weather = { conditionsText: 'Rain', periods: [] };
    const w = applyAnswer(
      d,
      { field: 'weather.impact', target: { condition: 'Rain' } },
      { lostHours: 2, impact: 'Exterior work stopped' },
      { defaultShiftHours: 8, messageId: 'r' },
    );
    expect(w.data.weather.periods[0]).toMatchObject({
      condition: 'Rain',
      lostHours: 2,
      impact: 'Exterior work stopped',
    });
    const s = applyAnswer(
      d,
      { field: 'safety', target: {} },
      { noIncidentsStated: true },
      { defaultShiftHours: 8, messageId: 'r' },
    );
    expect(s.data.safety.noIncidentsStated).toBe(true);
  });
});
