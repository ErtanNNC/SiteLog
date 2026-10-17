import { describe, expect, it } from 'vitest';
import { liveKitConfigFrom, parseTwirpError, createSipParticipantBody } from './livekit/twirp.ts';
import { JobPayloadSchemas } from './schemas/jobs.ts';
import {
  afterUnanswered,
  CALL_SKIP_REASONS,
  missedCallJobKey,
  noCallsToday,
  OUTBOUND_CALL_ATTEMPT,
  outboundCallKey,
  outboundCallShare,
  outboundRoomMetadata,
  placesCalls,
  skipSendsMessage,
  telephonyFor,
  unansweredStatusOf,
} from './voice-outbound.ts';

/** W3-17: the outbound call rules (spec §19 Q51, Q125–Q132). */
describe('who places calls (§19 Q51, Q125, Q132)', () => {
  const noTrunk = { outboundTrunkId: null };
  const trunk = { outboundTrunkId: 'ST_abc123' };
  it.each([
    [false, noTrunk, false, null],
    [false, trunk, true, 'livekit'],
    [true, noTrunk, true, 'console'],
    // A demo org never reaches a real phone, trunk or not (§19 Q116).
    [true, trunk, true, 'console'],
  ] as const)('demo=%s pack=%j → places %s on %s', (isDemo, pack, places, driver) => {
    expect(placesCalls({ isDemo }, pack)).toBe(places);
    expect(telephonyFor({ isDemo }, pack)).toBe(driver);
  });
});

describe('attempts, keys and the room (§19 Q128, Q157)', () => {
  it('numbers R1, R2 and the callback 1, 2, 3', () => {
    expect(OUTBOUND_CALL_ATTEMPT).toEqual({ reminder_1: 1, reminder_2: 2, callback: 3 });
  });
  it('keys a stage per site-day and reporter, and each capacity wait apart', () => {
    expect(outboundCallKey('sd', 'rep', 'reminder_1')).toBe('call:sd:rep:reminder_1');
    expect(outboundCallKey('sd', 'rep', 'reminder_1', 2)).toBe('call:sd:rep:reminder_1:w2');
    expect(missedCallJobKey('c')).toBe('call_missed:c');
  });
  it('puts the call id in the room metadata, never a number', () => {
    expect(JSON.parse(outboundRoomMetadata('abc'))).toEqual({
      callId: 'abc',
      transport: 'pstn',
      direction: 'outbound',
    });
  });
});

describe('unanswered dials (F6 step 1, F11, §19 Q128)', () => {
  it.each([
    [486, 'busy', 'missed_call'],
    [603, 'busy', 'missed_call'],
    [480, 'no_answer', 'missed_call'],
    [408, 'no_answer', 'missed_call'],
    [487, 'no_answer', 'missed_call'],
    [404, 'failed', 'stage_message'],
    [503, 'failed', 'stage_message'],
    [null, 'failed', 'stage_message'],
  ] as const)('SIP %s → %s → %s', (code, status, next) => {
    expect(unansweredStatusOf(code)).toBe(status);
    expect(afterUnanswered(status)).toBe(next);
  });
  it('a voicemail greeting is missed too', () => {
    expect(afterUnanswered('voicemail')).toBe('missed_call');
  });
});

describe('skips (§19 Q127, Q129, Q131)', () => {
  it('fall back to the stage message only where the reporter would hear nothing', () => {
    const fallback = CALL_SKIP_REASONS.filter(skipSendsMessage);
    expect(fallback).toEqual([
      'not_call_reporter',
      'no_consent',
      'no_calls_today',
      'no_trunk',
      'org_calls_off',
      'telephony_unavailable',
      'capacity',
    ]);
  });
  it('reads "Don\'t call me today" against now', () => {
    const now = new Date('2026-10-12T22:45:00Z');
    expect(noCallsToday(null, now)).toBe(false);
    expect(noCallsToday('2026-10-13T05:00:00Z', now)).toBe(true);
    expect(noCallsToday(new Date('2026-10-12T05:00:00Z'), now)).toBe(false);
  });
});

describe('the M8 share', () => {
  it('is null with nothing called, else filed by call over called', () => {
    expect(outboundCallShare({ call_days: 0, filed_by_call: 0 })).toBeNull();
    expect(outboundCallShare({ call_days: 8, filed_by_call: 7 })).toBe(0.875);
  });
});

describe('the place_call payloads', () => {
  const id = '0f0e0d0c-0b0a-4908-8706-050403020100';
  it('parses a dial, a ring end and a missed call', () => {
    const schema = JobPayloadSchemas.place_call;
    expect(schema.safeParse({ reporterId: id, siteDayId: id, stage: 'reminder_1' }).success).toBe(
      true,
    );
    expect(schema.safeParse({ phase: 'ring_end', callId: id }).success).toBe(true);
    expect(schema.safeParse({ phase: 'missed', callId: id }).success).toBe(true);
    expect(schema.safeParse({ reporterId: id, siteDayId: id, stage: 'heads_up' }).success).toBe(
      false,
    );
  });
});

describe('LiveKit Twirp helpers', () => {
  it('reads the config only with all three values', () => {
    const env = {
      LIVEKIT_URL: 'wss://x.livekit.cloud',
      LIVEKIT_API_KEY: 'k',
      LIVEKIT_API_SECRET: 's',
    };
    expect(liveKitConfigFrom((n) => env[n as keyof typeof env])).toEqual({
      url: env.LIVEKIT_URL,
      apiKey: 'k',
      apiSecret: 's',
    });
    expect(liveKitConfigFrom(() => undefined)).toBeNull();
  });
  it('reads the SIP status of a refused dial', () => {
    expect(
      parseTwirpError(JSON.stringify({ code: 'unavailable', meta: { sip_status_code: '486' } })),
    ).toEqual({ code: 'unavailable', sipStatus: 486 });
    expect(parseTwirpError('not json')).toEqual({ code: null, sipStatus: null });
  });
  it('dials with the call id as identity and the pack number as the caller id (§19 Q126)', () => {
    const body = createSipParticipantBody({
      trunkId: 'ST_abc123',
      to: '+15550142087',
      from: '+15550142290',
      room: 'call-x',
      callId: 'x',
      ringTimeoutS: 30,
      maxCallS: 720,
    });
    expect(body).toMatchObject({
      sip_trunk_id: 'ST_abc123',
      sip_call_to: '+15550142087',
      sip_number: '+15550142290',
      room_name: 'call-x',
      participant_identity: 'sip-x',
      wait_until_answered: true,
      ringing_timeout: '30s',
      max_call_duration: '720s',
    });
    expect(JSON.stringify(body.participant_metadata)).not.toContain('+1555');
  });
});
