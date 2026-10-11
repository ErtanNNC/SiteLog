import { describe, expect, it } from 'vitest';
import {
  BUTTON_TITLE_MAX,
  ButtonIds,
  ButtonSets,
  parseButtonId,
  truncateTitle,
} from './buttons.ts';

describe('button ids', () => {
  it('round-trips every id family', () => {
    expect(parseButtonId(ButtonIds.welcomeOk())).toEqual({ kind: 'welcome', action: 'ok' });
    expect(parseButtonId(ButtonIds.question('q1', 1))).toEqual({
      kind: 'question',
      questionId: 'q1',
      option: 1,
    });
    expect(parseButtonId(ButtonIds.question('q1', 'other'))).toEqual({
      kind: 'question',
      questionId: 'q1',
      option: 'other',
    });
    expect(parseButtonId(ButtonIds.draftOk('r1'))).toEqual({
      kind: 'draft',
      reportId: 'r1',
      action: 'ok',
    });
    expect(parseButtonId(ButtonIds.reminderWeather('sd1'))).toEqual({
      kind: 'reminder',
      siteDayId: 'sd1',
      action: 'weather',
    });
    expect(parseButtonId(ButtonIds.weatherPhoto('r1'))).toEqual({
      kind: 'weather',
      reportId: 'r1',
      action: 'photo',
    });
    expect(parseButtonId(ButtonIds.site('s1'))).toEqual({ kind: 'site', siteId: 's1' });
    expect(parseButtonId(ButtonIds.day('2026-10-09'))).toEqual({ kind: 'day', date: '2026-10-09' });
    expect(parseButtonId('garbage')).toEqual({ kind: 'unknown', id: 'garbage' });
    expect(parseButtonId('q:x:notanumber')).toEqual({ kind: 'unknown', id: 'q:x:notanumber' });
  });

  it('keeps titles within 20 characters and at most 3 buttons', () => {
    for (const set of [
      ButtonSets.welcome(),
      ButtonSets.test(),
      ButtonSets.draft('r'),
      ButtonSets.reminder1('s'),
      ButtonSets.weatherFollowup('r'),
    ]) {
      expect(set.length).toBeLessThanOrEqual(3);
      for (const b of set) expect(b.title.length).toBeLessThanOrEqual(BUTTON_TITLE_MAX);
    }
    const q = ButtonSets.question('q1', ['4 · full day', '5 · full day', 'ignored third option']);
    expect(q.map((b) => b.title)).toEqual(['4 · full day', '5 · full day', 'Other…']);
    expect(truncateTitle('A very long button title indeed').length).toBeLessThanOrEqual(
      BUTTON_TITLE_MAX,
    );
    expect(truncateTitle('A very long button title indeed')).toMatch(/…$/);
  });
});
