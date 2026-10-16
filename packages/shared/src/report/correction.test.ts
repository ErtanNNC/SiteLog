import { describe, expect, it } from 'vitest';
import { emptyReportData, type DailyReportData, type Source } from '../schemas/report.ts';
import {
  applyCorrectionOps,
  applyCrewEdit,
  correctionChanges,
  reapplyCrewFixes,
  sanitizeCorrectionOps,
} from './correction.ts';

const NOTE: Source = { type: 'voice_note', uploadId: 'note', start: 18.9, end: 26.1 };
const CLIP: Source = { type: 'voice_note', uploadId: 'clip', start: 0, end: 2.3 };
const EDIT: Source = {
  type: 'reporter_edit',
  reporterId: 'marco',
  at: '2026-10-09T21:10:00Z',
  via: 'web',
};

function draft(): DailyReportData {
  return {
    ...emptyReportData('2026-10-09', { reportLanguage: 'en', units: 'imperial' }),
    summary: 'Slab pour on L4.',
    weather: {
      conditionsText: 'Rain 07:00–10:30',
      periods: [{ condition: 'Rain', lostHours: 3.5, source: [NOTE] }],
    },
    manpower: [
      {
        companyId: 'apex',
        companyNameHeard: 'Apex',
        companyName: 'Apex Concrete',
        workers: 6,
        hoursPerWorker: 8,
        totalHours: 48,
        hoursBasis: 'full_day_default',
        confidence: 0.95,
        source: [NOTE],
      },
      {
        companyId: 'iron',
        companyNameHeard: 'Ironclad',
        companyName: 'Ironclad Steel',
        workers: 3,
        hoursPerWorker: 8,
        totalHours: 24,
        hoursBasis: 'full_day_default',
        confidence: 0.9,
        source: [NOTE],
      },
    ],
    workPerformed: [
      { area: 'Level 4', activity: 'Slab pour', status: 'complete', source: [NOTE] },
      {
        area: 'Level 3',
        activity: 'Electrical rough-in',
        status: 'in_progress',
        percentComplete: 60,
        source: [NOTE],
      },
    ],
  };
}

const COMPANIES = [
  { id: 'apex', name: 'Apex Concrete', aliases: ['Apex'] },
  { id: 'iron', name: 'Ironclad Steel', aliases: ['Ironclad'] },
];
const opts = (text: string | null, source: Source = CLIP) => ({
  source,
  text,
  defaultShiftHours: 8,
  companies: COMPANIES,
});

describe('applyCorrectionOps (W2-10, §10.6)', () => {
  it('"Apex had seven, not six": 7 × 8 = 56 h, the clip cited, the other lines untouched', () => {
    const res = applyCorrectionOps(
      draft(),
      [{ op: 'replace', path: '/manpower/0/workers', value: 7 }],
      opts('Apex had seven, not six.'),
    );
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.data.manpower[0]).toMatchObject({
      workers: 7,
      hoursPerWorker: 8,
      totalHours: 56,
      hoursBasis: 'full_day_default',
      confidence: 1,
      source: [NOTE, CLIP],
    });
    expect(res.data.manpower[1]).toEqual(draft().manpower[1]);
    expect(res.changes).toEqual([
      {
        kind: 'crew',
        company: 'Apex Concrete',
        change: 'changed',
        workers: [6, 7],
        hoursPerWorker: [8, 8],
        totalHours: [48, 56],
      },
    ]);
  });

  it('never takes a model total: dropped, recomputed; a total alone changes nothing', () => {
    const res = applyCorrectionOps(
      draft(),
      [
        { op: 'replace', path: '/manpower/0/workers', value: 7 },
        { op: 'replace', path: '/manpower/0/totalHours', value: 60 },
      ],
      opts('Apex had seven guys, sixty hours all in.'),
    );
    expect(res.ok && res.data.manpower[0]!.totalHours).toBe(56);
    expect(res.ok && res.droppedTotals).toBe(1);
    // A whole line replaced with its own total: the total is code's.
    const whole = applyCorrectionOps(
      draft(),
      [
        {
          op: 'replace',
          path: '/manpower/1',
          value: { ...draft().manpower[1], workers: 4, totalHours: 99, source: [] },
        },
      ],
      opts('Ironclad was four.'),
    );
    expect(whole.ok && whole.data.manpower[1]).toMatchObject({ workers: 4, totalHours: 32 });
    expect(whole.ok && whole.data.manpower[1]!.source).toEqual([NOTE, CLIP]);
    expect(
      applyCorrectionOps(
        draft(),
        [{ op: 'replace', path: '/manpower/0/totalHours', value: 60 }],
        opts('sixty hours'),
      ),
    ).toEqual({ ok: false, reason: 'total_only' });
  });

  it('refuses a number the words do not state', () => {
    expect(
      applyCorrectionOps(
        draft(),
        [{ op: 'replace', path: '/manpower/0/workers', value: 8 }],
        opts('Apex had seven, not six.'),
      ),
    ).toMatchObject({ ok: false, reason: 'number_not_stated' });
    expect(
      applyCorrectionOps(
        draft(),
        [{ op: 'replace', path: '/weather/periods/0/lostHours', value: 2 }],
        opts('the rain stopped us less'),
      ),
    ).toMatchObject({ ok: false, reason: 'number_not_stated' });
    expect(
      applyCorrectionOps(
        draft(),
        [{ op: 'replace', path: '/workPerformed/1/percentComplete', value: 80 }],
        opts('the electrical is further along'),
      ),
    ).toMatchObject({ ok: false, reason: 'number_not_stated' });
    // Stated: applied, and the other numbers of the line stand.
    const ok = applyCorrectionOps(
      draft(),
      [{ op: 'replace', path: '/workPerformed/1/percentComplete', value: 80 }],
      opts('L3 electrical is at 80 percent'),
    );
    expect(ok.ok && ok.data.workPerformed[1]).toMatchObject({
      percentComplete: 80,
      source: [NOTE, CLIP],
    });
    expect(ok.ok && ok.changes).toEqual([{ kind: 'section', section: 'work' }]);
  });

  it('a full day said: the shift hours, basis full_day_default', () => {
    const base = draft();
    base.manpower[1] = {
      ...base.manpower[1]!,
      hoursPerWorker: 4,
      totalHours: 12,
      hoursBasis: 'stated',
    };
    const res = applyCorrectionOps(
      base,
      [
        { op: 'replace', path: '/manpower/1/hoursPerWorker', value: 8 },
        { op: 'replace', path: '/manpower/1/hoursBasis', value: 'full_day_default' },
      ],
      opts('Ironclad worked the full day'),
    );
    expect(res.ok && res.data.manpower[1]).toMatchObject({
      hoursPerWorker: 8,
      totalHours: 24,
      hoursBasis: 'full_day_default',
    });
    // Without the words, 8 h is a number nobody said.
    expect(
      applyCorrectionOps(
        base,
        [{ op: 'replace', path: '/manpower/1/hoursPerWorker', value: 8 }],
        opts('Ironclad stayed longer'),
      ),
    ).toMatchObject({ ok: false, reason: 'number_not_stated' });
  });

  it('refuses what a fix may not change; drops sources and confidences the model wrote', () => {
    for (const path of ['/reportDate', '/photos/0', '/weather/observed/precip', '/schemaVersion'])
      expect(
        applyCorrectionOps(draft(), [{ op: 'replace', path, value: 1 }], opts('one')),
      ).toMatchObject({ ok: false, reason: 'path_not_allowed' });
    const clean = sanitizeCorrectionOps([
      { op: 'replace', path: '/manpower/0/source', value: [] },
      { op: 'replace', path: '/manpower/0/confidence', value: 0.1 },
      {
        op: 'add',
        path: '/workPerformed/-',
        value: { area: 'L2', activity: 'Ductwork', status: 'started', source: [CLIP] },
      },
    ]);
    expect(clean.refusal).toBeNull();
    expect(clean.ops).toEqual([
      {
        op: 'add',
        path: '/workPerformed/-',
        value: { area: 'L2', activity: 'Ductwork', status: 'started' },
      },
    ]);
    expect(
      applyCorrectionOps(
        draft(),
        [{ op: 'replace', path: '/manpower/9/workers', value: 7 }],
        opts('7'),
      ),
    ).toMatchObject({ ok: false, reason: 'invalid_patch' });
    expect(applyCorrectionOps(draft(), [], opts('nothing'))).toEqual({
      ok: false,
      reason: 'no_change',
    });
    expect(
      applyCorrectionOps(
        draft(),
        [{ op: 'replace', path: '/manpower/0/workers', value: 6 }],
        opts('Apex had six'),
      ),
    ).toEqual({ ok: false, reason: 'no_change' });
  });

  it('a line replaced whole is matched by the words heard, keeps its sources and cites the fix', () => {
    const res = applyCorrectionOps(
      draft(),
      [
        { op: 'remove', path: '/manpower/1' },
        {
          op: 'add',
          path: '/manpower/-',
          value: {
            companyId: null,
            companyNameHeard: 'Ironclad',
            companyName: 'Ironclad',
            workers: 2,
            hoursPerWorker: 4,
            hoursBasis: 'stated',
          },
        },
      ],
      opts('Ironclad was only two, four hours'),
    );
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.data.manpower[1]).toMatchObject({
      companyId: 'iron',
      companyName: 'Ironclad Steel',
      workers: 2,
      totalHours: 8,
      source: [NOTE, CLIP],
    });
    expect(res.changes).toEqual([
      {
        kind: 'crew',
        company: 'Ironclad Steel',
        change: 'changed',
        workers: [3, 2],
        hoursPerWorker: [8, 4],
        totalHours: [24, 8],
      },
    ]);
  });

  it('a typed fix cites reporter_edit (Q80)', () => {
    const res = applyCorrectionOps(
      draft(),
      [{ op: 'replace', path: '/manpower/0/workers', value: 7 }],
      opts('apex 7', EDIT),
    );
    expect(res.ok && res.data.manpower[0]!.source).toEqual([NOTE, EDIT]);
  });

  it('lost hours: their own preview line', () => {
    const res = applyCorrectionOps(
      draft(),
      [{ op: 'replace', path: '/weather/periods/0/lostHours', value: 2 }],
      opts('we only lost 2 hours to the rain'),
    );
    expect(res.ok && res.changes).toEqual([{ kind: 'lost_hours', lostHours: [3.5, 2] }]);
    expect(res.ok && res.data.weather.periods[0]!.source).toEqual([NOTE, CLIP]);
  });
});

describe('applyCorrectionOps: the observed weather (W2-10 review)', () => {
  it('never takes observed weather from the model (the base has none: none after)', () => {
    const res = applyCorrectionOps(
      draft(),
      [
        {
          op: 'replace',
          path: '/weather',
          value: {
            conditionsText: 'Rain 07:00–10:30, cold',
            periods: draft().weather.periods,
            observed: { tempMin: -5, tempMax: 2, precipitationMm: 40, source: 'open-meteo' },
          },
        },
      ],
      opts('it was cold too'),
    );
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.data.weather.observed).toBeUndefined();
    expect(res.data.weather.conditionsText).toBe('Rain 07:00–10:30, cold');
  });
});

describe('applyCorrectionOps: numbers in times and words are stated (W2-10 review)', () => {
  it('a weather period’s start and end, the working hours and a delivery time name their hour', () => {
    const period = (start: string) =>
      applyCorrectionOps(
        draft(),
        [{ op: 'add', path: '/weather/periods/0/start', value: start }],
        opts('the rain started at seven'),
      );
    expect(period('07:00')).toMatchObject({ ok: true });
    expect(period('09:00')).toMatchObject({ ok: false, reason: 'number_not_stated' });
    const hours = (start: string) =>
      applyCorrectionOps(
        draft(),
        [{ op: 'add', path: '/workingHours', value: { start, end: '15:30' } }],
        opts('we started at 6 and finished at 3:30'),
      );
    expect(hours('06:00')).toMatchObject({ ok: true });
    expect(hours('05:00')).toMatchObject({
      ok: false,
      reason: 'number_not_stated',
      detail: 'workingHours.start',
    });
    const delivery = (time: string, text: string) =>
      applyCorrectionOps(
        draft(),
        [{ op: 'add', path: '/deliveries/-', value: { item: 'Rebar', time, source: [] } }],
        opts(text),
      );
    expect(delivery('10:00', 'rebar came at 10')).toMatchObject({ ok: true });
    expect(delivery('11:00', 'rebar came at 10')).toMatchObject({
      ok: false,
      reason: 'number_not_stated',
      detail: 'time',
    });
  });

  it('figures written in words (a quantity, the summary) are stated ones', () => {
    const quantity = (q: string) =>
      applyCorrectionOps(
        draft(),
        [
          {
            op: 'add',
            path: '/deliveries/-',
            value: { item: 'Rebar', quantity: q, source: [] },
          },
        ],
        opts('two loads of rebar, 2 loads'),
      );
    expect(quantity('2 loads')).toMatchObject({ ok: true });
    expect(quantity('3 loads')).toMatchObject({
      ok: false,
      reason: 'number_not_stated',
      detail: 'quantity',
    });
    const summary = (text: string) =>
      applyCorrectionOps(
        draft(),
        [{ op: 'replace', path: '/summary', value: text }],
        opts('say the pour was on L4 and took 6 hours'),
      );
    // "L4" was in the summary already; 6 is stated.
    expect(summary('Slab pour on L4 took 6 hours.')).toMatchObject({ ok: true });
    expect(summary('Slab pour on L4 took 9 hours.')).toMatchObject({
      ok: false,
      reason: 'number_not_stated',
      detail: 'summary',
    });
  });
});

describe('applyCrewEdit (the draft steppers, Q80)', () => {
  it('sets workers and hours, totals in code, reporter_edit cited, hours stated', () => {
    const res = applyCrewEdit(
      draft(),
      { index: 0, workers: 7, hoursPerWorker: 9 },
      { source: EDIT, defaultShiftHours: 8 },
    );
    expect(res.ok && res.data.manpower[0]).toMatchObject({
      workers: 7,
      hoursPerWorker: 9,
      totalHours: 63,
      hoursBasis: 'stated',
      source: [NOTE, EDIT],
    });
    expect(
      applyCrewEdit(
        draft(),
        { index: 5, workers: 1, hoursPerWorker: 1 },
        { source: EDIT, defaultShiftHours: 8 },
      ),
    ).toMatchObject({ ok: false, reason: 'invalid_patch' });
    expect(
      applyCrewEdit(
        draft(),
        { index: 0, workers: 6, hoursPerWorker: 8 },
        { source: EDIT, defaultShiftHours: 8 },
      ),
    ).toEqual({ ok: false, reason: 'no_change' });
  });
});

describe('reapplyCrewFixes (spec §19 Q96)', () => {
  const fix = {
    source: CLIP,
    changes: correctionChanges(
      draft(),
      (
        applyCorrectionOps(
          draft(),
          [{ op: 'replace', path: '/manpower/0/workers', value: 7 }],
          opts('seven'),
        ) as { data: DailyReportData }
      ).data,
    ),
  };

  it('a re-extraction that brought back 6 gets the fix again (7 × 8 = 56 h, citing the clip)', () => {
    const res = reapplyCrewFixes(draft(), [fix]);
    expect(res.reapplied).toBe(1);
    expect(res.data.manpower[0]).toMatchObject({
      workers: 7,
      totalHours: 56,
      source: [NOTE, CLIP],
    });
  });

  it('a later clip that says 8 wins', () => {
    const base = draft();
    base.manpower[0] = { ...base.manpower[0]!, workers: 8, totalHours: 64 };
    const res = reapplyCrewFixes(base, [fix]);
    expect(res.reapplied).toBe(0);
    expect(res.data).toBe(base);
  });
});
