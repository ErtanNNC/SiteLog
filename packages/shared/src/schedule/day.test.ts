import { describe, expect, it } from 'vitest';
import {
  isWithinEditWindow,
  isWorkingDay,
  localDate,
  previousWorkingDay,
  reportDateForInbound,
  resolveDayReference,
} from './day.ts';

const tz = 'America/Chicago';

describe('site-local days', () => {
  it('computes local dates across midnight UTC', () => {
    expect(localDate(new Date('2026-10-10T03:30:00Z'), tz)).toBe('2026-10-09');
    expect(localDate(new Date('2026-10-10T05:30:00Z'), tz)).toBe('2026-10-10');
  });
  it('knows working days and the previous working day', () => {
    expect(isWorkingDay('2026-10-09', [1, 2, 3, 4, 5])).toBe(true); // Friday
    expect(isWorkingDay('2026-10-10', [1, 2, 3, 4, 5])).toBe(false); // Saturday
    expect(previousWorkingDay('2026-10-12', [1, 2, 3, 4, 5])).toBe('2026-10-09');
  });
  it('asks today-or-yesterday before noon', () => {
    expect(reportDateForInbound(new Date('2026-10-09T22:38:00Z'), tz)).toEqual({
      date: '2026-10-09',
      ambiguous: false,
      alternative: '2026-10-08',
    });
    expect(reportDateForInbound(new Date('2026-10-12T13:00:00Z'), tz)).toEqual({
      date: '2026-10-12',
      ambiguous: true,
      alternative: '2026-10-09',
    });
  });
});

describe('resolveDayReference', () => {
  const now = new Date('2026-10-12T20:00:00Z'); // Monday Oct 12, 15:00 Chicago
  it('resolves relative words and weekdays to the most recent past date', () => {
    expect(resolveDayReference('edit today', now, tz)).toBe('2026-10-12');
    expect(resolveDayReference('edit yesterday — Apex was 7', now, tz)).toBe('2026-10-11');
    expect(resolveDayReference('edit Friday — Apex was 7 guys, not 6', now, tz)).toBe('2026-10-09');
    expect(resolveDayReference('change monday', now, tz)).toBe('2026-10-12');
    expect(resolveDayReference('el viernes', now, tz)).toBe('2026-10-09');
  });
  it('resolves explicit dates', () => {
    expect(resolveDayReference('edit Oct 9', now, tz)).toBe('2026-10-09');
    expect(resolveDayReference('edit 9 October', now, tz)).toBe('2026-10-09');
    expect(resolveDayReference('edit 10/9', now, tz)).toBe('2026-10-09');
    expect(resolveDayReference('edit 2026-10-08', now, tz)).toBe('2026-10-08');
    expect(resolveDayReference('edit Dec 25', now, tz)).toBe('2025-12-25');
  });
  it('returns null when nothing matches', () => {
    expect(resolveDayReference('fix the hours', now, tz)).toBeNull();
  });
  it('enforces the 14-day edit window', () => {
    expect(isWithinEditWindow('2026-10-09', '2026-10-23')).toBe(true);
    expect(isWithinEditWindow('2026-10-09', '2026-10-24')).toBe(false);
    expect(isWithinEditWindow('2026-10-10', '2026-10-09')).toBe(false);
  });
});
