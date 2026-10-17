import { describe, expect, it } from 'vitest';
import { emptyReportData, type DailyReportData, type ManpowerEntry } from './schemas/report.ts';
import {
  callRecordingPath,
  callRequiredFields,
  loadReportSummary,
  preferenceConfirmation,
  readBack,
  spokenQuestion,
  voiceAnswerConfirmation,
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
      consentTextVersion: 'voice.consent.v1',
    });
    expect(voiceTextVersions({ recording_notice: 'us.rec.2', consent: ' ' })).toEqual({
      recordingNoticeVersion: 'us.rec.2',
      consentTextVersion: 'voice.consent.v1',
    });
    expect(voiceTextVersions(null).consentTextVersion).toBe('voice.consent.v1');
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
