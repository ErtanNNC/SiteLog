import { describe, expect, it } from 'vitest';
import type { CorrectionChange } from './report/correction.ts';
import { emptyReportData, type DailyReportData, type ManpowerEntry } from './schemas/report.ts';
import {
  READ_BACK_MAX_WORDS,
  callRecordingPath,
  callRequiredFields,
  loadReportSummary,
  preferenceConfirmation,
  readBack,
  spokenQuestion,
  voiceAnswerConfirmation,
  voiceCorrectionLines,
  voiceDraftStateOf,
  voiceNumber,
  voiceTextVersions,
  voiceWeekday,
} from './voice-tools.ts';

const crew = (workers: number | null, hoursPerWorker: number | null, totalHours: number | null) =>
  ({
    companyId: null,
    companyNameHeard: 'Apex',
    companyName: 'Apex Concrete',
    workers,
    hoursPerWorker,
    totalHours,
    hoursBasis: 'stated',
    confidence: 0.9,
    source: [],
  }) as unknown as ManpowerEntry;

const report = (manpower: ManpowerEntry[]): DailyReportData => ({
  ...emptyReportData('2026-10-09', { reportLanguage: 'en', units: 'imperial' }),
  manpower,
});

describe('voice tool answers (W3-03)', () => {
  it('speaks the weekday and numbers in the call language', () => {
    expect(voiceWeekday('2026-10-09', 'en')).toBe('Friday');
    expect(voiceWeekday('2026-10-09', 'es')).toBe('viernes');
    expect(voiceWeekday('2026-10-09', 'tr')).toBe('Cuma');
    expect(voiceNumber(7.5, 'en')).toBe('7.5');
    expect(voiceNumber(7.5, 'tr')).toBe('7,5');
  });

  it("summarises a filed report with code's totals, never the stored ones", () => {
    // The stored total (99) is wrong: 6 × 8 = 48, plus 2 × 8 = 16.
    const data = report([crew(6, 8, 99), crew(2, 8, 16)]);
    expect(
      loadReportSummary({ data, date: '2026-10-09', reportNo: 'NG-0069', language: 'en' }),
    ).toBe("Friday's report, NG-0069: 8 on site, 64 hours.");
    expect(
      loadReportSummary({ data, date: '2026-10-09', reportNo: 'NG-0069', language: 'tr' }),
    ).toBe('Cuma raporu, NG-0069: sahada 8 kişi, 64 saat.');
  });

  it('names only the report when a number is missing or there is no crew', () => {
    const unknownHeadcount = report([crew(null, 8, null)]);
    expect(
      loadReportSummary({
        data: unknownHeadcount,
        date: '2026-10-09',
        reportNo: 'NG-0069',
        language: 'es',
      }),
    ).toBe('Encontré el reporte del viernes, NG-0069.');
    expect(
      loadReportSummary({ data: null, date: '2026-10-09', reportNo: 'NG-0069', language: 'en' }),
    ).toBe("I've found Friday's report, NG-0069.");
  });

  it('confirms a preference change in the call language', () => {
    expect(preferenceConfirmation('call', 'en')).toBe(
      'OK, your daily report is now set to a call.',
    );
    expect(preferenceConfirmation('link', 'tr')).toContain('linkle');
  });

  it("uses the pack's legal keys, else the agent's own wording versions", () => {
    expect(voiceTextVersions({})).toEqual({
      recordingNoticeVersion: 'voice.recording_notice.v1',
      consentTextVersion: 'voice.consent.v2',
    });
    expect(voiceTextVersions({ recording_notice: 'us.rec.2', consent: ' ' })).toEqual({
      recordingNoticeVersion: 'us.rec.2',
      consentTextVersion: 'voice.consent.v2',
    });
    expect(voiceTextVersions(null).consentTextVersion).toBe('voice.consent.v2');
  });

  it('puts a recording at calls/{org}/{call}.ogg', () => {
    expect(callRecordingPath('o', 'c')).toBe('o/c.ogg');
  });
});

describe('the live draft on a call (W3-09)', () => {
  it('never asks for the photo on a call (§10.5 step 2)', () => {
    expect(
      callRequiredFields(['manpower', 'hours', 'weather', 'work_performed', 'safety', 'photo']),
    ).toEqual(['manpower', 'hours', 'weather', 'work_performed', 'safety']);
  });

  it('speaks the question with at most two choices worded for the ear', () => {
    expect(
      spokenQuestion({
        prompt:
          '  Quick one — the Delta guys on Level 2: was that four or five people, and the full day? ',
        options: [
          { id: 'o1', label: '4 · full day' },
          { id: 'o2', label: '5 · full day' },
          { id: 'o3', label: 'Other' },
        ],
      }),
    ).toEqual({
      text: 'Quick one — the Delta guys on Level 2: was that four or five people, and the full day?',
      choices: ['4, full day', '5, full day'],
    });
    expect(spokenQuestion({ prompt: 'x'.repeat(500), options: [] }).text).toHaveLength(400);
  });

  it("says F7's confirmation from code's numbers, in the call language", () => {
    const delta = {
      kind: 'crew',
      company: 'Delta Mechanical',
      workers: 5,
      hoursPerWorker: 8,
      totalHours: 40,
    } as const;
    expect(voiceAnswerConfirmation(delta, 'en')).toBe(
      'Delta Mechanical: 5 workers, 8 hours each — 40 hours.',
    );
    expect(voiceAnswerConfirmation(delta, 'es')).toBe(
      'Delta Mechanical: 5 trabajadores, 8 horas cada uno — 40 horas.',
    );
    expect(
      voiceAnswerConfirmation(
        { ...delta, company: 'Demirci ekibi', hoursPerWorker: 7.5, totalHours: 37.5 },
        'tr',
      ),
    ).toBe('Demirci ekibi: 5 kişi, kişi başı 7,5 saat — toplam 37,5 saat.');
    expect(
      voiceAnswerConfirmation({ ...delta, hoursPerWorker: null, totalHours: null }, 'en'),
    ).toBe('Delta Mechanical: 5 workers.');
    expect(voiceAnswerConfirmation({ kind: 'weather', lostHours: 3.5 }, 'en')).toBe(
      'Noted: 3.5 hours lost to weather.',
    );
    expect(voiceAnswerConfirmation({ kind: 'weather', lostHours: 0 }, 'en')).toBe(
      'Noted: no weather stoppage.',
    );
    expect(voiceAnswerConfirmation({ kind: 'company_added', company: 'Ridgeway' }, 'en')).toMatch(
      /^Noted: Ridgeway, a new subcontractor/,
    );
    expect(voiceAnswerConfirmation({ kind: 'noted' }, 'tr')).toBe('Not aldım.');
  });

  it('reads back numbers first, every one recomputed in code (§19 Q118)', () => {
    const data = report([
      crew(6, 8, 999),
      { ...crew(4, 8, 32), companyId: 'k', companyName: 'Kestrel' },
    ]);
    data.weather.periods.push({ condition: 'Rain', lostHours: 3.5, source: [] });
    // The stored 999 is not spoken: 6 × 8 + 4 × 8 = 80.
    expect(readBack(data, 'en')).toBe(
      "Here's what I've got: 10 on site from 2 companies, 80 hours. Weather stopped work for 3.5 hours. Shall I file it?",
    );
    expect(readBack(report([crew(6, 8, 48)]), 'en')).toBe(
      "Here's what I've got: 6 on site from one company, 48 hours. Shall I file it?",
    );
    // A headcount not known: no partial total is spoken.
    expect(readBack(report([crew(null, 8, null), crew(4, 8, 32)]), 'en')).toBe('Shall I file it?');
  });
});

/** The Riverside hero draft (§18.1, fixtures/expected/call-riverside-2026-10-09-en) after F7. */
function hero(reportLanguage: 'en' | 'tr' = 'en'): DailyReportData {
  const named = (name: string, workers: number) => ({
    ...crew(workers, 8, workers * 8),
    companyId: name,
    companyName: name,
  });
  const work = (
    area: string,
    activity: string,
    status: 'complete' | 'in_progress' | 'stopped',
    percentComplete?: number,
  ) => ({
    area,
    activity,
    status,
    ...(percentComplete !== undefined ? { percentComplete } : {}),
    source: [],
  });
  const data = {
    ...emptyReportData('2026-10-09', { reportLanguage, units: 'imperial' }),
    manpower: [
      named('Apex Concrete', 6),
      named('BrightLine Electric', 5),
      named('Delta Mechanical', 5),
      named('Ironclad Steel', 3),
      named('Kestrel self-perform', 4),
    ],
    workPerformed: [
      work('Level 4', 'Slab pour', 'complete'),
      work('Level 3', 'Electrical rough-in', 'in_progress', 60),
      work('Level 2', 'Ductwork, east wing', 'in_progress'),
      work('Exterior — south elevation', 'CMU blockwork', 'stopped'),
      work('Level 2', 'Interior CMU blockwork', 'in_progress'),
      work('Level 5 deck', 'Rebar tying', 'in_progress'),
    ],
    deliveries: [{ item: 'Rebar', quantity: '2 loads', supplier: 'Ironclad Steel', source: [] }],
  } as DailyReportData;
  data.weather.periods.push({ condition: 'Rain', lostHours: 3.5, source: [] });
  data.safety = {
    toolboxTalk: 'Wet-weather access and slippery decks',
    incidents: [],
    noIncidentsStated: true,
    visitors: [],
    source: [],
  };
  return data;
}

const words = (s: string) => s.split(/\s+/).filter(Boolean).length;

describe('readBack golden texts (W3-10, §19 Q118, Q161)', () => {
  it('EN: numbers first, then the work, the delivery and safety, within 75 words', () => {
    const text = readBack(hero(), 'en');
    expect(text).toBe(
      "Here's what I've got: 23 on site from 5 companies, 184 hours. Weather stopped work for 3.5 hours. " +
        'Done: Level 4 slab pour complete, Level 3 electrical rough-in about 60 percent, Level 2 ductwork, east wing, ' +
        'Exterior — south elevation CMU blockwork, Level 2 interior CMU blockwork, Level 5 deck rebar tying. ' +
        'Delivered: 2 loads of rebar from Ironclad Steel. Toolbox talk. No incidents. Shall I file it?',
    );
    expect(words(text)).toBeLessThanOrEqual(READ_BACK_MAX_WORDS);
  });

  it('TR: Turkish numbers and word order, one incident', () => {
    const data: DailyReportData = {
      ...emptyReportData('2026-10-09', { reportLanguage: 'tr', units: 'metric' }),
      manpower: [
        { ...crew(4, 8, 32), companyName: 'Usta Beton' },
        { ...crew(3, 7.5, 22.5), companyId: 'v', companyName: 'Volt Elektrik' },
      ],
      workPerformed: [
        { area: '3. Kat', activity: 'Döşeme betonu dökümü', status: 'complete', source: [] },
        { area: '', activity: 'Havalandırma kanalı montajı', status: 'in_progress', source: [] },
      ],
      deliveries: [{ item: 'İnşaat demiri', supplier: 'Demir Yapı', source: [] }],
    };
    data.safety.toolboxTalk = 'İskele güvenliği';
    data.safety.incidents.push({
      description: 'Bir işçi kaydı',
      severity: 'first_aid',
      source: [],
    });
    expect(readBack(data, 'tr')).toBe(
      'Elimdeki bilgiler: 2 firmadan sahada 7 kişi, toplam 54,5 saat. ' +
        'Yapılanlar: 3. Kat döşeme betonu dökümü tamamlandı, Havalandırma kanalı montajı. ' +
        'Teslimatlar: Demir Yapı firmasından İnşaat demiri. İş güvenliği konuşması yapıldı. Bir olay bildirildi. Kaydedeyim mi?',
    );
  });

  it('§19 Q161: an ES call of an EN report speaks the counts, never the English lines', () => {
    expect(readBack(hero('en'), 'es')).toBe(
      'Esto es lo que tengo: 23 en la obra de 5 empresas, 184 horas. El clima detuvo el trabajo 3.5 horas. ' +
        'Trabajos anotados: 6. Entregas anotadas: 1. Charla de seguridad. Sin incidentes. ¿Lo registro?',
    );
  });

  it('cuts the lists at about 75 words, numbers and the question always said', () => {
    const data = hero();
    data.workPerformed = Array.from({ length: 30 }, (_, i) => ({
      area: `Level ${i + 1}`,
      activity: 'Formwork stripping and cleanup',
      status: 'in_progress' as const,
      source: [],
    }));
    const text = readBack(data, 'en');
    expect(words(text)).toBeLessThanOrEqual(READ_BACK_MAX_WORDS);
    expect(text).toMatch(/^Here's what I've got: 23 on site from 5 companies, 184 hours\./);
    expect(text).toMatch(/Shall I file it\?$/);
    expect(text).toContain('Done: Level 1 formwork stripping and cleanup');
    expect(text).not.toContain('Level 30');
  });
});

describe('voiceCorrectionLines (F8 on a call)', () => {
  it("speaks the change's new values from code's numbers", () => {
    const apex: Extract<CorrectionChange, { kind: 'crew' }> = {
      kind: 'crew',
      company: 'Apex Concrete',
      change: 'changed',
      workers: [6, 7],
      hoursPerWorker: [8, 8],
      totalHours: [48, 56],
    };
    expect(voiceCorrectionLines([apex], 'en')).toEqual([
      'Apex Concrete: 7 workers, 8 hours each — 56 hours.',
    ]);
    expect(voiceCorrectionLines([apex], 'es')).toEqual([
      'Apex Concrete: 7 trabajadores, 8 horas cada uno — 56 horas.',
    ]);
    expect(
      voiceCorrectionLines(
        [
          { ...apex, change: 'removed' },
          { kind: 'lost_hours', lostHours: [3.5, 2] },
          { kind: 'section', section: 'deliveries' },
        ],
        'tr',
      ),
    ).toEqual([
      'Apex Concrete rapordan çıkarıldı.',
      'Not aldım: hava nedeniyle 2 saat kayıp.',
      'Değişti: Teslimat.',
    ]);
  });
});

describe('voiceDraftStateOf (file_report draft_changed)', () => {
  it("reads back the draft as stored, with code's missing list (never the photo)", () => {
    const state = voiceDraftStateOf({
      reportId: '00000000-0000-4000-8000-000000000001',
      draftRev: 3,
      data: hero(),
      requiredFields: ['manpower', 'hours', 'photo', 'unknown_key'],
      question: null,
      awaitingConfirmation: true,
      language: 'en',
    });
    expect(state).toMatchObject({ draftRev: 3, missing: [], question: null });
    expect(state.readBack).toBe(readBack(hero(), 'en'));
    const asking = voiceDraftStateOf({
      reportId: '00000000-0000-4000-8000-000000000001',
      draftRev: 3,
      data: report([crew(null, 8, null)]),
      requiredFields: ['manpower', 'hours'],
      question: {
        id: '00000000-0000-4000-8000-000000000002',
        prompt: 'How many from Apex?',
        options: [{ id: 'o1', label: '5 · full day' }],
      },
      awaitingConfirmation: false,
      language: 'en',
    });
    expect(asking.readBack).toBeNull();
    expect(asking.question).toEqual({
      id: '00000000-0000-4000-8000-000000000002',
      text: 'How many from Apex?',
      choices: ['5, full day'],
    });
    expect(asking.missing).toEqual([
      'manpower.workers:Apex Concrete',
      'manpower.hours:Apex Concrete',
    ]);
  });
});
