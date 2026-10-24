import { describe, expect, it } from 'vitest';
import { formatWhen } from './format';

describe('formatWhen (activity and notification times, in the site tz)', () => {
  const tz = 'America/Chicago';
  const today = '2026-10-09';

  it('shows only the time for today', () => {
    expect(formatWhen('2026-10-09T22:38:00Z', tz, today)).toBe('17:38');
    expect(formatWhen('2026-10-09T22:38:00Z', tz, today, 'tr')).toBe('17:38');
  });

  it('adds the day before today, in the panel’s language', () => {
    expect(formatWhen('2026-10-07T14:12:00Z', tz, today)).toBe('Oct 7 · 09:12');
    expect(formatWhen('2026-10-07T14:12:00Z', tz, today, 'en')).toBe('Oct 7 · 09:12');
    expect(formatWhen('2026-10-07T14:12:00Z', tz, today, 'tr')).toBe('7 Eki · 09:12');
  });
});
