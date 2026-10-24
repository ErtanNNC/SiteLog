import { describe, expect, it } from 'vitest';
import {
  abbreviateArea,
  addDays,
  daysBetween,
  formatAudioTimestamp,
  formatDateLong,
  formatDraftDate,
  formatDuration,
  formatHours,
  formatMoneyCents,
  formatPhone,
  formatTimeInTz,
  formatWeekdayMonthDay,
  initials,
  isoWeekOf,
  isoWeekRange,
  normalizeE164,
  weekdayName,
} from './format.ts';

describe('format', () => {
  it('formats dates', () => {
    expect(formatDateLong('2026-10-09')).toBe('Fri, Oct 9, 2026');
    expect(formatDraftDate('2026-10-09')).toBe('FRI OCT 9');
    expect(formatWeekdayMonthDay('2026-10-09')).toBe('Friday, Oct 9');
    expect(weekdayName('2026-10-09')).toBe('Friday');
    expect(addDays('2026-10-31', 1)).toBe('2026-11-01');
    expect(daysBetween('2026-10-01', '2026-10-09')).toBe(8);
  });
  it('formats times in a zone', () => {
    expect(formatTimeInTz('2026-10-09T22:38:00Z', 'America/Chicago')).toBe('17:38');
    expect(formatTimeInTz('2026-10-10T05:10:00Z', 'America/Chicago')).toBe('00:10');
  });
  it('formats hours, durations and timestamps', () => {
    expect(formatHours(184)).toBe('184 h');
    expect(formatHours(3.5)).toBe('3.5 h');
    expect(formatHours(null)).toBe('—');
    expect(formatAudioTimestamp(41)).toBe('0:41');
    expect(formatAudioTimestamp(725.8)).toBe('12:05');
    expect(formatDuration(168)).toBe('2 min 48 s');
    expect(formatDuration(48)).toBe('48 s');
    expect(formatDuration(120)).toBe('2 min');
  });
  it('formats phones and money', () => {
    expect(formatPhone('+15550143378')).toBe('+1 555 014 3378');
    // Was '+447 700 900 123': non-US numbers were grouped in threes (the bug W1-02 fixes).
    expect(formatPhone('+447700900123')).toBe('+44 7700 900123');
    expect(normalizeE164('(555) 014-3378')).toBe('+15550143378');
    expect(normalizeE164('+1 555 014 3378')).toBe('+15550143378');
    expect(normalizeE164('abc')).toBeNull();
    expect(formatMoneyCents(239400)).toBe('$2,394');
    expect(formatMoneyCents(159650)).toBe('$1,596.50');
    expect(initials('Lena Ortiz')).toBe('LO');
  });
  it('abbreviates areas and computes ISO weeks', () => {
    expect(abbreviateArea('Level 4')).toBe('L4');
    expect(abbreviateArea('Exterior — south elevation')).toBe('Ext. south elevation');
    expect(isoWeekRange('2026-W41')).toEqual({
      start: '2026-10-05',
      end: '2026-10-09',
      sunday: '2026-10-11',
    });
    expect(isoWeekOf('2026-10-09')).toBe('2026-W41');
    expect(isoWeekOf('2026-01-01')).toBe('2026-W01');
  });
});
