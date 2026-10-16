import { describe, expect, it } from 'vitest';
import { emptyReportData, type DailyReportData, type ManpowerEntry } from './schemas/report.ts';
import {
  callRecordingPath,
  loadReportSummary,
  preferenceConfirmation,
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
