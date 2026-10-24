import { describe, expect, it } from 'vitest';
import { dayOffReportData } from './report/day-off.ts';
import {
  UNKNOWN_CALLER_SNIPPET_MAX,
  callbackPlan,
  dayOffConfirmKey,
  dayOffReadBack,
  unknownCallRecordingPath,
  unknownCallerSnippet,
} from './voice-special.ts';
import { SetDayStatusRequestSchema, VoiceCallStartResponseSchema } from './voice.ts';

const CALL = '0b8f6a4e-2c1d-4f3a-9e7b-5d6c8a9b0c1d';

/** W3-14: the pure pieces of the special requests on a call. */
describe('day off on a call (F12 call, §19 Q136)', () => {
  const weather = (since: string, workersBefore?: number) =>
    dayOffReportData({
      kind: 'weather_day',
      date: '2026-10-12',
      siteName: 'Hillcrest',
      org: { reportLanguage: 'en', units: 'imperial' },
      details: { since, ...(workersBefore !== undefined ? { workersBefore } : {}) },
      questionIds: { since: null, workersBefore: null },
      workingHours: '07:00–15:30',
      defaultShiftHours: 8,
      detailSource: { type: 'call', callId: CALL, start: 4.5, end: 9 },
    });

  it('reads the day back with code’s lost hours, in the call language', () => {
    expect(
      dayOffReadBack({
        status: 'weather_day',
        siteName: 'Hillcrest',
        details: { since: '11:00', workersBefore: 12 },
        data: weather('11:00', 12),
        language: 'en',
      }),
    ).toBe(
      'Weather day at Hillcrest: work stopped at 11:00, 12 on site before, 4.5 hours lost. Shall I log it?',
    );
    expect(
      dayOffReadBack({
        status: 'weather_day',
        siteName: 'Hillcrest',
        details: { since: 'never_started' },
        data: weather('never_started'),
        language: 'tr',
      }),
    ).toBe(
      'Hillcrest için hava nedeniyle kayıp gün: ekip hiç başlamadı, 8 saat kayıp. Kaydedeyim mi?',
    );
    expect(
      dayOffReadBack({
        status: 'no_work',
        siteName: 'Hillcrest',
        details: {},
        data: null,
        language: 'es',
      }),
    ).toBe('¿Hoy no hay trabajo en Hillcrest? Diga sí o no.');
  });

  it('cites the call seconds for every value said on the call', () => {
    const data = weather('11:00', 12);
    const said = { type: 'call', callId: CALL, start: 4.5, end: 9 };
    expect(data.weather.periods[0]!.source).toEqual([said]);
    expect(data.manpower[0]!.source).toEqual([said]);
    expect(data.manpower[0]).toMatchObject({ workers: 12, hoursPerWorker: 4, totalHours: 48 });
  });

  it('keys the read-back by the call, the status and the details', async () => {
    const a = await dayOffConfirmKey({
      callId: CALL,
      status: 'weather_day',
      details: { since: '11:00', workersBefore: 12 },
    });
    expect(a).toMatch(/^[0-9a-f]{64}$/);
    expect(
      await dayOffConfirmKey({
        callId: CALL.toUpperCase(),
        status: 'weather_day',
        details: { workersBefore: 12, since: '11:00' },
      }),
    ).toBe(a);
    expect(
      await dayOffConfirmKey({ callId: CALL, status: 'weather_day', details: { since: '11:00' } }),
    ).not.toBe(a);
    // A no-work day has no details: whatever the model sends, the key is the same.
    expect(
      await dayOffConfirmKey({ callId: CALL, status: 'no_work', details: { since: '11:00' } }),
    ).toBe(await dayOffConfirmKey({ callId: CALL, status: 'no_work', details: {} }));
  });

  it('takes the yes only with the key of its read-back', () => {
    const base = { callId: CALL, status: 'no_work' as const };
    expect(SetDayStatusRequestSchema.safeParse(base).success).toBe(true);
    expect(SetDayStatusRequestSchema.safeParse({ ...base, utterance: 'yes' }).success).toBe(false);
    expect(
      SetDayStatusRequestSchema.safeParse({ ...base, utterance: 'yes', confirmKey: 'a'.repeat(64) })
        .success,
    ).toBe(true);
  });
});

describe('unknown callers (F13, §19 Q124)', () => {
  it('keeps at most 160 characters, cut at a word', () => {
    expect(unknownCallerSnippet('  Sam   from Apex\n at Northgate ')).toBe(
      'Sam from Apex at Northgate',
    );
    const long = unknownCallerSnippet('Sam Ortiz from Apex Concrete at Northgate. '.repeat(10));
    expect(long.length).toBeLessThanOrEqual(UNKNOWN_CALLER_SNIPPET_MAX);
    expect(long.endsWith('…')).toBe(true);
    expect(long.startsWith('Sam Ortiz from Apex Concrete')).toBe(true);
  });

  it('records outside every org’s folder, and starts with the pack’s language', () => {
    expect(unknownCallRecordingPath(CALL)).toBe(`unknown/${CALL}.ogg`);
    const answer = {
      callId: CALL,
      callToken: 'A'.repeat(43),
      unknown: true,
      locale: 'en-US',
    };
    expect(VoiceCallStartResponseSchema.parse(answer)).toEqual(answer);
  });
});

describe('callbackPlan (§19 Q128, for W3-17)', () => {
  const window = { start: '07:00', end: '20:00' };
  const now = new Date('2026-10-12T22:00:00Z'); // 17:00 in Chicago

  it('one callback a site-day, inside the call window, before the missing step', () => {
    expect(
      callbackPlan({ now, minutes: 30, timezone: 'America/Chicago', window, requestedToday: 0 }),
    ).toEqual({ status: 'scheduled', at: '2026-10-12T22:30:00.000Z', localTime: '17:30' });
    expect(
      callbackPlan({ now, minutes: 30, timezone: 'America/Chicago', window, requestedToday: 1 }),
    ).toEqual({ status: 'limit_reached' });
    expect(
      callbackPlan({ now, minutes: 240, timezone: 'America/Chicago', window, requestedToday: 0 }),
    ).toEqual({ status: 'outside_window', windowEnd: '20:00' });
    expect(
      callbackPlan({
        now,
        minutes: 120,
        timezone: 'America/Chicago',
        window,
        requestedToday: 0,
        notAfter: new Date('2026-10-12T23:30:00Z'),
      }).status,
    ).toBe('outside_window');
  });
});
