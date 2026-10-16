import { describe, expect, it } from 'vitest';
import {
  emptyReportDataV1,
  type DailyReportData,
  type DailyReportDataV1,
  type ManpowerEntryV1,
} from '../schemas/report.ts';
import { upgradeV1toV2 } from './upgrade.ts';
import {
  applyAnswer,
  closestCompany,
  numberAnswer,
  optionAnswer,
  parseQuickAnswer,
  pickNextQuestion,
  statedNumbers,
  unstatedAnswerNumber,
  validateReport,
} from './validate.ts';

const REQUIRED = ['manpower', 'hours', 'weather', 'work_performed', 'safety', 'photo'] as const;

const mp = (over: Partial<ManpowerEntryV1>): ManpowerEntryV1 => ({
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

function complete(): DailyReportDataV1 {
  const d = emptyReportDataV1('2026-10-09');
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
      options: [
        { id: 'o1', label: '4 · full day' },
        { id: 'o2', label: '5 · full day' },
      ],
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
    });
    expect(q!.options.map((o) => o.label)).toEqual(['Add "Ridgway"', "It's Ridgeway"]);
    expect(q!.options[1]!.value).toEqual({
      companyAction: 'map',
      companyId: 'ridge',
      companyName: 'Ridgeway',
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
    // A headcount question answered without a number is not an answer (model / re-ask).
    expect(parseQuickAnswer('manpower.workers', 'they were here all day')).toBeNull();
    expect(parseQuickAnswer('manpower.workers', 'Jim plus his four guys')).toEqual({ workers: 5 });
    expect(parseQuickAnswer('manpower.workers', '4 guys and the foreman, full day')).toEqual({
      workers: 5,
      fullDay: true,
    });
    expect(parseQuickAnswer('manpower.workers', 'three plus two, till 3')).toEqual({
      workers: 5,
      endTime: '15:00',
    });
    // Spec §19 Q62: "Half day" is half of the org's default shift, resolved by applyAnswer.
    expect(parseQuickAnswer('manpower.hours', 'Half day')).toEqual({ halfDay: true });
    expect(parseQuickAnswer('manpower.workers', 'beş kişi, yarım gün')).toEqual({
      workers: 5,
      halfDay: true,
    });
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
      { defaultShiftHours: 8, source: { type: 'reply', messageId: 'reply1' } },
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
  it('reads "Half day" as half of the default shift (spec §19 Q62)', () => {
    const d = complete();
    d.manpower = [
      mp({ workers: 6, hoursPerWorker: null, totalHours: null, hoursBasis: 'unknown' }),
    ];
    const answer = (shift: number) =>
      applyAnswer(
        d,
        { field: 'manpower.hours', target: { manpowerIndex: 0 } },
        { halfDay: true },
        { defaultShiftHours: shift, source: { type: 'reply', messageId: 'reply1' } },
      ).data.manpower[0];
    expect(answer(8)).toMatchObject({ hoursPerWorker: 4, totalHours: 24, hoursBasis: 'reply' });
    expect(answer(10)).toMatchObject({ hoursPerWorker: 5, totalHours: 30 });
  });
  it('derives hours from an end time using site working hours', () => {
    const d = complete();
    d.manpower = [mp({ hoursPerWorker: null, totalHours: null })];
    const { data } = applyAnswer(
      d,
      { field: 'manpower.hours', target: { manpowerIndex: 0 } },
      { endTime: '15:00' },
      {
        defaultShiftHours: 8,
        workingHours: '07:00–15:30',
        source: { type: 'reply', messageId: 'r' },
      },
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
      {
        defaultShiftHours: 8,
        source: { type: 'reply', messageId: 'r' },
        companies: [{ id: 'ridge', name: 'Ridgeway' }],
      },
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
      { defaultShiftHours: 8, source: { type: 'reply', messageId: 'r' } },
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
      { defaultShiftHours: 8, source: { type: 'reply', messageId: 'r' } },
    );
    expect(s.data.safety.noIncidentsStated).toBe(true);
  });
});

describe('W1-12: v2 data, channel-neutral options, D28, EN/ES/TR', () => {
  const v2 = (): DailyReportData => {
    const d = upgradeV1toV2(complete());
    d.manpower.push({
      companyId: 'delta',
      companyNameHeard: 'the Delta guys',
      companyName: 'Delta Mechanical',
      area: 'Level 2',
      workers: null,
      hoursPerWorker: 8,
      totalHours: null,
      hoursBasis: 'full_day_default',
      confidence: 0.85,
      source: [{ type: 'voice_note', uploadId: 'u1', start: 33 }],
    });
    return d;
  };

  it('matches a v2 proposed question (no target) by its gap path', () => {
    const d = v2();
    d.proposedQuestions = [
      {
        field: 'manpower.workers:Delta Mechanical',
        question: 'Quick check: the Delta guys on Level 2. How many?',
        options: ['4 · full day', '5 · full day'],
      },
    ];
    const v = validateReport(d, { requiredFields: REQUIRED });
    const q = pickNextQuestion(d, v, { askedPaths: [], askedCount: 0, maxQuestions: 3 });
    expect(q).toMatchObject({
      path: 'manpower.workers:Delta Mechanical',
      prompt: 'Quick check: the Delta guys on Level 2. How many?',
      options: [
        { id: 'o1', label: '4 · full day' },
        { id: 'o2', label: '5 · full day' },
      ],
    });
  });

  it('matches a v2 proposed question by field when it names the crew', () => {
    const d = v2();
    d.proposedQuestions = [
      {
        field: 'manpower.workers',
        question: '¿Cuántos eran los de Delta en el nivel 2?',
        options: ['4 · todo el día'],
      },
    ];
    const v = validateReport(d, { requiredFields: REQUIRED });
    const q = pickNextQuestion(d, v, { askedPaths: [], askedCount: 0, maxQuestions: 3 });
    expect(q!.prompt).toBe('¿Cuántos eran los de Delta en el nivel 2?');
  });

  it('D28: a headcount with no model options has no options; code proposes no number', () => {
    const d = v2();
    const v = validateReport(d, { requiredFields: REQUIRED });
    for (const language of ['en-US', 'es-US', 'tr-TR']) {
      const q = pickNextQuestion(d, v, {
        askedPaths: [],
        askedCount: 0,
        maxQuestions: 3,
        language,
      });
      expect(q!.options).toEqual([]);
    }
  });

  it('writes the fallback questions in the reporter language', () => {
    const d = v2();
    d.photos = [];
    const v = validateReport(d, { requiredFields: REQUIRED });
    const at = (language: string) =>
      pickNextQuestion(d, v, { askedPaths: [], askedCount: 0, maxQuestions: 3, language })!;
    expect(at('en-US').prompt).toBe(
      'Quick check: you said "the Delta guys" on Level 2. How many, and for how long?',
    );
    expect(at('es-US').prompt).toContain('¿Cuántos eran');
    expect(at('tr-TR').prompt).toContain('Kaç kişiydiler');
    const photo = (language: string) =>
      pickNextQuestion(d, v, {
        askedPaths: ['manpower.workers:Delta Mechanical'],
        askedCount: 1,
        maxQuestions: 3,
        language,
      })!;
    expect(photo('tr-TR').field).toBe('photo');
    expect(photo('tr-TR').options.map((o) => o.label)).toEqual([
      'Şimdi gönderiyorum',
      'Bugün fotoğraf yok',
    ]);
    expect(photo('es-US').options.map((o) => o.label)).toEqual(['Enviando ahora', 'Sin foto hoy']);
  });

  it('a fallback option carries the value code applies, whatever the language', () => {
    const d = v2();
    d.manpower[1]!.workers = 5;
    d.manpower[1]!.hoursPerWorker = null;
    d.manpower[1]!.hoursBasis = 'unknown';
    const v = validateReport(d, { requiredFields: REQUIRED });
    const q = pickNextQuestion(d, v, {
      askedPaths: [],
      askedCount: 0,
      maxQuestions: 3,
      language: 'tr-TR',
    })!;
    expect(q.field).toBe('manpower.hours');
    expect(q.options[0]).toEqual({ id: 'o1', label: 'Tam gün', value: { fullDay: true } });
    expect(optionAnswer(q.field, q.options[0]!)).toEqual({ fullDay: true });
    // A model option has no value: its label is parsed.
    expect(optionAnswer('manpower.workers', { label: '5 · tam gün' })).toEqual({
      workers: 5,
      fullDay: true,
    });
  });

  it('applies an answer to v2 data with an answer source and hours basis "answer"', () => {
    const d = v2();
    const { data, ackText } = applyAnswer(
      d,
      { field: 'manpower.workers', target: { manpowerIndex: 1 } },
      { workers: 5 },
      { defaultShiftHours: 8, source: { type: 'answer', questionId: 'q1' } },
    );
    expect(data.schemaVersion).toBe(2);
    expect(data.manpower[1]).toMatchObject({ workers: 5, hoursPerWorker: 8, totalHours: 40 });
    expect(data.manpower[1]!.source.at(-1)).toEqual({ type: 'answer', questionId: 'q1' });
    expect(ackText).toBe('Thanks — Delta Mechanical: 5 workers × 8 h = 40 h.');
    const h = applyAnswer(
      d,
      { field: 'manpower.hours', target: { manpowerIndex: 1 } },
      { workers: 4, hoursPerWorker: 6 },
      { defaultShiftHours: 8, source: { type: 'answer', questionId: 'q2' } },
    );
    expect(h.data.manpower[1]).toMatchObject({
      workers: 4,
      hoursPerWorker: 6,
      totalHours: 24,
      hoursBasis: 'answer',
    });
  });

  it('"Dry, no impact" fills the conditions without a 0 h stoppage period', () => {
    const d = v2();
    d.weather = { conditionsText: '', periods: [] };
    const { data } = applyAnswer(
      d,
      { field: 'weather.impact', target: {} },
      { lostHours: 0, text: 'Kuru, etkisi yok' },
      { defaultShiftHours: 8, source: { type: 'answer', questionId: 'q' } },
    );
    expect(data.weather).toEqual({ conditionsText: 'Kuru, etkisi yok', periods: [] });
    expect(validateReport(data, { requiredFields: ['weather'] }).isComplete).toBe(true);
  });

  it('D28 numberAnswer: a typed number for the field it answers, nothing else', () => {
    expect(numberAnswer('manpower.workers', 5)).toEqual({ workers: 5 });
    expect(numberAnswer('manpower.workers', 5, 'full_day')).toEqual({ workers: 5, fullDay: true });
    expect(numberAnswer('manpower.workers', 5, 6)).toEqual({ workers: 5, hoursPerWorker: 6 });
    expect(numberAnswer('manpower.workers', 4.5)).toBeNull();
    expect(numberAnswer('manpower.hours', 7.5)).toEqual({ hoursPerWorker: 7.5 });
    expect(numberAnswer('manpower.hours', 30)).toBeNull();
    expect(numberAnswer('weather.impact', 2)).toEqual({ lostHours: 2 });
    expect(numberAnswer('safety', 1)).toBeNull();
    expect(numberAnswer('photo', 1)).toBeNull();
    expect(numberAnswer('company.unknown', 1)).toBeNull();
  });

  it('parses Turkish and Spanish quick answers', () => {
    expect(parseQuickAnswer('manpower.workers', 'Beş kişi, tam gün')).toEqual({
      workers: 5,
      fullDay: true,
    });
    expect(parseQuickAnswer('manpower.workers', 'dört kişi 6 saat')).toEqual({
      workers: 4,
      hoursPerWorker: 6,
    });
    expect(parseQuickAnswer('manpower.hours', 'Yarım gün')).toEqual({ halfDay: true });
    expect(parseQuickAnswer('weather.impact', 'Duruş yok')).toEqual({ lostHours: 0 });
    expect(parseQuickAnswer('weather.impact', 'Sin paro')).toEqual({ lostHours: 0 });
    expect(parseQuickAnswer('safety', 'Olay yok')).toEqual({ noIncidentsStated: true });
    expect(parseQuickAnswer('company.unknown', '"Yıldız İnşaat" ekle')).toEqual({
      companyAction: 'add',
    });
    expect(parseQuickAnswer('company.unknown', 'Agregar "Ridgeway"')).toEqual({
      companyAction: 'add',
    });
    // English stays as it was ("I" is not lower-cased the Turkish way).
    expect(parseQuickAnswer('company.unknown', "It's Delta Mechanical")).toEqual({
      companyAction: 'map',
    });
  });
});

describe('W2-09: spoken answers (never invent numbers; the clip is a source)', () => {
  it('statedNumbers: digits and EN, ES, TR words, and a crew said as a sum', () => {
    expect([...statedNumbers('Five, all day.')]).toEqual([5]);
    expect([...statedNumbers('Eran cinco, todo el día.')]).toEqual([5]);
    expect([...statedNumbers('Demirciler altı kişiydi, tam gün çalıştılar.')]).toEqual([6]);
    expect([...statedNumbers('4 guys and the foreman till 3:30')].sort()).toEqual([3, 30, 4, 5]);
    expect([...statedNumbers("I'll check with the foreman later")]).toEqual([]);
  });

  it('unstatedAnswerNumber: a number the answer does not state is refused; full day and no stoppage are code’s', () => {
    expect(unstatedAnswerNumber({ workers: 5, fullDay: true }, 'Five, all day.')).toBeNull();
    expect(
      unstatedAnswerNumber({ workers: 5, fullDay: true, hoursPerWorker: 8 }, 'Five, all day.'),
    ).toBeNull();
    expect(unstatedAnswerNumber({ workers: 6 }, 'Five, all day.')).toBe('workers');
    expect(unstatedAnswerNumber({ workers: 5, hoursPerWorker: 9 }, 'five guys')).toBe(
      'hoursPerWorker',
    );
    expect(unstatedAnswerNumber({ workers: 5, endTime: '15:00' }, 'five till three')).toBeNull();
    expect(unstatedAnswerNumber({ workers: 5, endTime: '16:00' }, 'five till three')).toBe(
      'endTime',
    );
    expect(unstatedAnswerNumber({ lostHours: 0 }, 'no stoppage')).toBeNull();
    expect(unstatedAnswerNumber({ lostHours: 2.5 }, 'lost two and a half hours')).toBe('lostHours');
    expect(unstatedAnswerNumber({ totalHours: 40 }, 'five full day')).toBe('totalHours');
  });

  it('unstatedAnswerNumber: a full day, half day, no stoppage or time only when the answer says it', () => {
    // Full day / half day: the phrase in EN, ES or TR, never the model's guess.
    expect(
      unstatedAnswerNumber({ workers: 5, fullDay: true }, 'yeah Delta was here, five, same crew'),
    ).toBe('fullDay');
    expect(unstatedAnswerNumber({ fullDay: true }, 'Eran cinco, todo el día.')).toBeNull();
    expect(unstatedAnswerNumber({ fullDay: true }, 'beş kişi, tam gün')).toBeNull();
    expect(unstatedAnswerNumber({ fullDay: true }, 'a full-day crew')).toBeNull();
    expect(unstatedAnswerNumber({ halfDay: true }, 'they left a bit early')).toBe('halfDay');
    expect(unstatedAnswerNumber({ halfDay: true }, 'half a day')).toBeNull();
    expect(unstatedAnswerNumber({ halfDay: true }, 'medio día')).toBeNull();
    expect(unstatedAnswerNumber({ halfDay: true }, 'yarım gün çalıştılar')).toBeNull();
    // Weather times name their hour, as an end time does.
    expect(unstatedAnswerNumber({ start: '09:00', end: '13:00' }, 'it rained in the morning')).toBe(
      'start',
    );
    expect(unstatedAnswerNumber({ end: '13:00' }, 'it rained in the morning')).toBe('end');
    expect(unstatedAnswerNumber({ start: '09:00', end: '13:00' }, 'from nine to one')).toBeNull();
    expect(unstatedAnswerNumber({ start: 'morning' }, 'it rained in the morning')).toBeNull();
    // 0 lost hours: a no-stoppage phrase or "zero", never by default.
    expect(unstatedAnswerNumber({ lostHours: 0 }, 'it rained in the morning')).toBe('lostHours');
    expect(unstatedAnswerNumber({ lostHours: 0 }, 'we didn’t stop')).toBeNull();
    expect(unstatedAnswerNumber({ lostHours: 0 }, 'zero')).toBeNull();
    expect(unstatedAnswerNumber({ lostHours: 0 }, 'sin impacto')).toBeNull();
    expect(unstatedAnswerNumber({ lostHours: 0 }, 'etkisi yok')).toBeNull();
  });

  it('applyAnswer: the answer and the clip are the value’s sources, totals in code', () => {
    const d = upgradeV1toV2(complete());
    d.manpower.push({
      companyId: 'delta',
      companyNameHeard: 'the Delta guys',
      companyName: 'Delta Mechanical',
      workers: null,
      hoursPerWorker: 8,
      totalHours: null,
      hoursBasis: 'full_day_default',
      confidence: 0.85,
      source: [{ type: 'voice_note', uploadId: 'u1', start: 33 }],
    });
    const i = d.manpower.length - 1;
    const out = applyAnswer(
      d,
      { field: 'manpower.workers', target: { manpowerIndex: i } },
      { workers: 5, fullDay: true },
      {
        defaultShiftHours: 8,
        source: { type: 'answer', questionId: 'q1' },
        extraSources: [{ type: 'voice_note', uploadId: 'clip', start: 0, end: 2.1 }],
      },
    ).data.manpower[i]!;
    expect(out).toMatchObject({ workers: 5, hoursPerWorker: 8, totalHours: 40 });
    expect(out.source).toEqual([
      { type: 'voice_note', uploadId: 'u1', start: 33 },
      { type: 'answer', questionId: 'q1' },
      { type: 'voice_note', uploadId: 'clip', start: 0, end: 2.1 },
    ]);
  });
});
