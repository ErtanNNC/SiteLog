import { describe, expect, it } from 'vitest';
import {
  DEFAULT_LADDER,
  deadlineInstant,
  ladderTimes,
  nextDueStage,
  REMINDER_STAGE,
  reminderVars,
  weatherSlotDue,
} from './reminders.ts';

describe('deadlineInstant (DST-safe)', () => {
  it('converts 17:30 Chicago to UTC in CDT and CST', () => {
    expect(deadlineInstant('2026-10-09', '17:30', 'America/Chicago').toISOString()).toBe(
      '2026-10-09T22:30:00.000Z',
    );
    // After the Nov 1 2026 fall-back, Chicago is UTC−6.
    expect(deadlineInstant('2026-11-02', '17:30:00', 'America/Chicago').toISOString()).toBe(
      '2026-11-02T23:30:00.000Z',
    );
  });
  it('handles the spring-forward day', () => {
    // March 8 2026: 02:00 → 03:00 local. 17:30 is unambiguous and UTC−5.
    expect(deadlineInstant('2026-03-08', '17:30', 'America/Chicago').toISOString()).toBe(
      '2026-03-08T22:30:00.000Z',
    );
    expect(deadlineInstant('2026-03-07', '17:30', 'America/Chicago').toISOString()).toBe(
      '2026-03-07T23:30:00.000Z',
    );
  });
});

describe('nextDueStage', () => {
  const deadlineAt = deadlineInstant('2026-10-09', '17:30', 'America/Chicago');
  const at = (hhmm: string) => deadlineInstant('2026-10-09', hhmm, 'America/Chicago');
  const base = { deadlineAt, settings: DEFAULT_LADDER, weatherObserved: false };

  it('fires nothing before any stage is due', () => {
    expect(nextDueStage({ ...base, now: at('16:00'), currentStage: 0 })).toBeNull();
    expect(nextDueStage({ ...base, now: at('17:40'), currentStage: 0 })).toBeNull();
  });
  it('fires the heads-up only when weather was observed and before R1', () => {
    expect(nextDueStage({ ...base, now: at('16:56'), currentStage: 0 })).toBeNull();
    expect(
      nextDueStage({ ...base, now: at('16:56'), currentStage: 0, weatherObserved: true })?.stage,
    ).toBe(REMINDER_STAGE.headsUp);
    expect(
      nextDueStage({ ...base, now: at('17:46'), currentStage: 0, weatherObserved: true })?.stage,
    ).toBe(REMINDER_STAGE.reminder1);
  });
  it('walks the ladder once per stage', () => {
    expect(nextDueStage({ ...base, now: at('17:46'), currentStage: 0 })?.stage).toBe(2);
    expect(nextDueStage({ ...base, now: at('17:50'), currentStage: 2 })).toBeNull();
    expect(nextDueStage({ ...base, now: at('18:31'), currentStage: 2 })?.stage).toBe(3);
    expect(nextDueStage({ ...base, now: at('18:35'), currentStage: 3 })).toBeNull();
    expect(nextDueStage({ ...base, now: at('19:01'), currentStage: 3 })?.stage).toBe(4);
    expect(nextDueStage({ ...base, now: at('19:30'), currentStage: 4 })).toBeNull();
  });
  it('skips to the latest stage after an outage', () => {
    expect(nextDueStage({ ...base, now: at('18:45'), currentStage: 0 })?.stage).toBe(3);
  });
  it('respects "stop" for reminders but still escalates to the office', () => {
    expect(
      nextDueStage({ ...base, now: at('18:31'), currentStage: 0, remindersPaused: true }),
    ).toBeNull();
    expect(
      nextDueStage({ ...base, now: at('19:05'), currentStage: 0, remindersPaused: true })?.stage,
    ).toBe(4);
  });
  it('respects disabled stages', () => {
    const settings = { ...DEFAULT_LADDER, reminder2Enabled: false };
    expect(nextDueStage({ ...base, settings, now: at('18:40'), currentStage: 2 })).toBeNull();
    expect(nextDueStage({ ...base, settings, now: at('19:00'), currentStage: 2 })?.stage).toBe(4);
  });
  it('computes ladder times with offsets', () => {
    const t = ladderTimes(deadlineAt);
    expect(t.headsUpAt.toISOString()).toBe('2026-10-09T21:55:00.000Z');
    expect(t.missingAt.toISOString()).toBe('2026-10-10T00:00:00.000Z');
  });
  it('builds template vars in site time', () => {
    const t = ladderTimes(deadlineAt);
    expect(
      reminderVars(2, {
        firstName: 'Priya',
        siteName: 'Elm St.',
        deadlineAt,
        missingAt: t.missingAt,
        tz: 'America/Chicago',
      }),
    ).toEqual(['Priya', 'Elm St.']);
    expect(
      reminderVars(3, {
        firstName: 'Priya',
        siteName: 'Elm St.',
        deadlineAt,
        missingAt: t.missingAt,
        tz: 'America/Chicago',
      }),
    ).toEqual(['19:00']);
    expect(
      reminderVars(1, {
        firstName: 'P',
        siteName: 'S',
        deadlineAt,
        missingAt: t.missingAt,
        tz: 'America/Chicago',
        weatherPhrase: 'It rained this morning',
      }),
    ).toEqual(['17:30', 'It rained this morning']);
  });
});

describe('weatherSlotDue', () => {
  const tz = 'America/Chicago';
  it('returns the slot crossed since the previous tick', () => {
    const prev = new Date('2026-10-09T16:55:00Z'); // 11:55 local
    const now = new Date('2026-10-09T17:00:00Z'); // 12:00 local
    expect(weatherSlotDue(prev, now, tz)).toBe('12:00');
    expect(weatherSlotDue(now, new Date('2026-10-09T17:05:00Z'), tz)).toBeNull();
    expect(
      weatherSlotDue(new Date('2026-10-09T21:25:00Z'), new Date('2026-10-09T21:31:00Z'), tz),
    ).toBe('16:30');
  });
  it('runs the earliest due slot when there was no previous tick', () => {
    expect(weatherSlotDue(null, new Date('2026-10-09T22:00:00Z'), tz)).toBe('12:00');
    expect(weatherSlotDue(null, new Date('2026-10-09T10:00:00Z'), tz)).toBeNull();
  });
});
