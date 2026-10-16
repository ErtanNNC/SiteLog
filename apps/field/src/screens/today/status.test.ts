import { describe, expect, it } from 'vitest';
import { dayClosed, todayStatus } from './status';

const report = (status: string, kind = 'daily') =>
  ({ id: 'r', reportNo: 'RL-1', status, kind }) as never;

describe('Today status chip (Field-03)', () => {
  it('names the day by its report first, then by the site-day', () => {
    expect(todayStatus({ dayStatus: 'pending', report: null })).toBe('notSent');
    expect(todayStatus({ dayStatus: 'reminded', report: null })).toBe('notSent');
    expect(todayStatus({ dayStatus: 'missing', report: null })).toBe('notSent');
    expect(todayStatus({ dayStatus: 'processing', report: null })).toBe('inProgress');
    expect(todayStatus({ dayStatus: 'processing', report: report('processing') })).toBe(
      'inProgress',
    );
    expect(todayStatus({ dayStatus: 'processing', report: report('awaiting_answer') })).toBe(
      'inProgress',
    );
    expect(todayStatus({ dayStatus: 'filed', report: report('filed') })).toBe('sent');
    expect(todayStatus({ dayStatus: 'filed', report: report('signed_off') })).toBe('sent');
    expect(todayStatus({ dayStatus: 'filed', report: null })).toBe('sent');
    expect(todayStatus({ dayStatus: 'weather_day', report: null })).toBe('weatherDay');
    expect(todayStatus({ dayStatus: 'no_work', report: null })).toBe('noWork');
    // W2-08: the record the F12 buttons made names the day, being filed or filed.
    expect(
      todayStatus({ dayStatus: 'weather_day', report: report('processing', 'weather_day') }),
    ).toBe('weatherDay');
    expect(todayStatus({ dayStatus: 'no_work', report: report('filed', 'no_work') })).toBe(
      'noWork',
    );
  });

  it('closes the day only when nothing more can be recorded', () => {
    expect(dayClosed({ dayStatus: 'pending', report: null })).toBe(false);
    expect(dayClosed({ dayStatus: 'processing', report: report('awaiting_confirmation') })).toBe(
      false,
    );
    expect(dayClosed({ dayStatus: 'filed', report: report('filed') })).toBe(true);
    expect(dayClosed({ dayStatus: 'weather_day', report: null })).toBe(true);
    expect(dayClosed({ dayStatus: 'no_work', report: null })).toBe(true);
    // A live daily report on a weather day (the office reopened it): still open.
    expect(dayClosed({ dayStatus: 'weather_day', report: report('processing') })).toBe(false);
    // W2-08: a weather-day or no-work record closes the day, even while it is being filed.
    expect(
      dayClosed({ dayStatus: 'weather_day', report: report('processing', 'weather_day') }),
    ).toBe(true);
    expect(dayClosed({ dayStatus: 'no_work', report: report('filed', 'no_work') })).toBe(true);
  });
});
