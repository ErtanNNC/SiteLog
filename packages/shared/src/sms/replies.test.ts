import { describe, expect, it } from 'vitest';
import { weatherDayData } from '../report/day-off.ts';
import { progressSteps } from '../report/progress.ts';
import { emptyReportDataV1 } from '../schemas/report.ts';
import { looksLikeDayOff, quickClassify, quickDayOff, stripDayReference } from './replies.ts';

const now = new Date('2026-10-09T23:00:00Z');
const tz = 'America/Chicago';

describe('deterministic reply handling (worker + field simulator)', () => {
  it('classifies the §9.5 short grammar and leaves the rest to the model', () => {
    expect(quickClassify('OK', now, tz)?.intent).toBe('confirm');
    expect(quickClassify('no work today', now, tz)?.intent).toBe('no_work');
    expect(quickClassify('edit Friday — Apex was 7 guys, not 6', now, tz)).toMatchObject({
      intent: 'edit_request',
      entities: { dayReference: '2026-10-09' },
      correctionText: 'Apex was 7 guys, not 6',
    });
    expect(quickClassify('rained out, sent everyone home at 11', now, tz)).toBeNull();
    expect(stripDayReference('Friday — Apex was 7')).toBe('Apex was 7');
  });

  it('strips every day word it resolves: pzt, cmt, anteayer, day before yesterday (W2-14 review)', () => {
    expect(stripDayReference('pzt Apex 7 kişi')).toBe('Apex 7 kişi');
    expect(stripDayReference('CMT: Apex 7')).toBe('Apex 7');
    expect(stripDayReference('anteayer Apex eran 7')).toBe('Apex eran 7');
    expect(stripDayReference('the day before yesterday - Apex was 7')).toBe('Apex was 7');
    expect(stripDayReference('day  before yesterday Apex was 7')).toBe('Apex was 7');
    // Whole words only: "Pztx" or "cmtech" start with no day.
    expect(stripDayReference('cmtech 4 not 3')).toBe('cmtech 4 not 3');
    expect(quickClassify('edit the day before yesterday Apex was 7', now, tz)).toMatchObject({
      entities: { dayReference: '2026-10-07' },
      correctionText: 'Apex was 7',
    });
    expect(quickClassify('edita anteayer Apex eran 7', now, tz)).toMatchObject({
      entities: { dayReference: '2026-10-07' },
      correctionText: 'Apex eran 7',
    });
  });

  it('day-off fallback and the "nobody worked" check', () => {
    expect(quickDayOff('rained out, sent everyone home at 11')).toMatchObject({
      kind: 'weather_day',
      releasedAt: '11:00',
      fullDay: false,
      cause: 'rain',
    });
    expect(quickDayOff('No work today, the city closed the street').kind).toBe('no_work');
    const empty = emptyReportDataV1('2026-10-09');
    expect(looksLikeDayOff(empty, 'Nobody worked today, told everyone to stay home.')).toBe(true);
    expect(looksLikeDayOff(empty, 'Quiet day.')).toBe(false);
  });

  it('weather-day data and progress lines', () => {
    const data = weatherDayData('2026-10-09', quickDayOff('rained out, sent everyone home at 11'), {
      defaultShiftHours: 8,
      workingHours: '07:00–15:30',
      source: { type: 'reply', messageId: 'm' },
    });
    expect(data.weather.periods[0]).toMatchObject({
      lostHours: 4.5,
      fullDay: false,
      start: '11:00',
    });
    expect(progressSteps({ transcribed: true })).toEqual([
      'Transcribed, site noise removed',
      'Checking subcontractor hours…',
    ]);
  });
});
