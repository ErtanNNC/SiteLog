import { describe, expect, it } from 'vitest';
import { fillLiveKitFixture } from './fixture.ts';
import {
  LiveKitWebhookEventSchema,
  liveKitBodyHash,
  signLiveKitWebhook,
  sipCallStatus,
  toVoiceEvent,
  verifyLiveKitWebhook,
} from './webhook.ts';

const KEY = 'APItestkey';
const SECRET = 'test-livekit-secret-not-real-0123456789';
const NOW = new Date('2026-10-16T21:00:00Z');
const ROOM = 'call-0f0e0d0c-0000-4000-8000-000000000001';
describe('verifyLiveKitWebhook', () => {
  const body = JSON.stringify({ event: 'room_finished', id: 'EV_1', room: { name: ROOM } });
  const opts = { apiKey: KEY, apiSecret: SECRET, now: NOW };

  it('accepts a token LiveKit-style: HS256, iss = key, sha256 of the body', async () => {
    const token = await signLiveKitWebhook(body, opts);
    const res = await verifyLiveKitWebhook(body, token, opts);
    expect(res.ok).toBe(true);
    expect(await verifyLiveKitWebhook(body, `Bearer ${token}`, opts)).toMatchObject({ ok: true });
    if (res.ok) expect(res.claims.sha256).toBe(await liveKitBodyHash(body));
  });

  it('refuses a missing, malformed, forged, foreign, stale or mismatched token', async () => {
    const good = await signLiveKitWebhook(body, opts);
    expect(await verifyLiveKitWebhook(body, null, opts)).toEqual({ ok: false, reason: 'missing' });
    expect(await verifyLiveKitWebhook(body, 'a.b', opts)).toEqual({
      ok: false,
      reason: 'malformed',
    });
    const forged = await signLiveKitWebhook(body, { ...opts, apiSecret: 'another-secret' });
    expect(await verifyLiveKitWebhook(body, forged, opts)).toEqual({
      ok: false,
      reason: 'signature',
    });
    const foreign = await signLiveKitWebhook(body, { ...opts, apiKey: 'APIother' });
    expect(await verifyLiveKitWebhook(body, foreign, opts)).toEqual({
      ok: false,
      reason: 'issuer',
    });
    const stale = await signLiveKitWebhook(body, {
      ...opts,
      now: new Date(NOW.getTime() - 10 * 60_000),
    });
    expect(await verifyLiveKitWebhook(body, stale, opts)).toEqual({
      ok: false,
      reason: 'expired',
    });
    const future = await signLiveKitWebhook(body, {
      ...opts,
      now: new Date(NOW.getTime() + 10 * 60_000),
    });
    expect(await verifyLiveKitWebhook(body, future, opts)).toEqual({
      ok: false,
      reason: 'not_yet_valid',
    });
    // The same token on another body (a byte changed).
    expect(await verifyLiveKitWebhook(body.replace('EV_1', 'EV_2'), good, opts)).toEqual({
      ok: false,
      reason: 'body_hash',
    });
    // alg none with a valid-looking payload.
    const [, payload] = good.split('.');
    const none = `${btoa(JSON.stringify({ alg: 'none' })).replace(/=+$/, '')}.${payload}.`;
    expect((await verifyLiveKitWebhook(body, none, opts)).ok).toBe(false);
  });
});

describe('sipCallStatus', () => {
  const sip = (status: string, disconnectReason?: string | number) => ({
    kind: 'SIP',
    attributes: { 'sip.callStatus': status },
    ...(disconnectReason === undefined ? {} : { disconnectReason }),
  });

  it('maps a SIP participant to the line status (§4.2)', () => {
    expect(sipCallStatus('participant_joined', sip('dialing'))).toBe('ringing');
    expect(sipCallStatus('participant_joined', sip('ringing'))).toBe('ringing');
    expect(sipCallStatus('participant_joined', sip('active'))).toBe('in_progress');
    expect(sipCallStatus('track_published', sip('active'))).toBe('in_progress');
    expect(sipCallStatus('participant_left', sip('hangup', 'USER_UNAVAILABLE'))).toBe('no_answer');
    expect(sipCallStatus('participant_left', sip('hangup', 12))).toBe('busy');
    expect(sipCallStatus('participant_left', sip('hangup', 'SIP_TRUNK_FAILURE'))).toBe('failed');
    expect(sipCallStatus('participant_left', sip('hangup', 'CLIENT_INITIATED'))).toBe('completed');
    expect(sipCallStatus('participant_left', sip('hangup'))).toBe('completed');
  });

  it('leaves other participants alone (the agent, a Talk now browser)', () => {
    expect(sipCallStatus('participant_joined', { kind: 'AGENT' })).toBeNull();
    expect(sipCallStatus('participant_left', { identity: 'reporter' })).toBeNull();
    expect(sipCallStatus('participant_left', undefined)).toBeNull();
  });
});

describe('toVoiceEvent', () => {
  const sipLeft = fillLiveKitFixture(
    JSON.stringify({
      event: 'participant_left',
      id: '{{id}}',
      createdAt: '{{ts+134}}',
      room: { sid: 'RM_{{room_sid}}', name: '{{room}}' },
      participant: {
        sid: 'PA_sip',
        identity: 'sip_{{phone}}',
        name: 'Phone {{phone}}',
        kind: 'SIP',
        attributes: {
          'sip.callStatus': 'hangup',
          'sip.phoneNumber': '{{phone}}',
          'sip.trunkPhoneNumber': '{{to}}',
        },
        disconnectReason: 'CLIENT_INITIATED',
      },
    }),
    { room: ROOM, ts: NOW.getTime() / 1000, phone: '+15550142087', to: '+18885550100', id: 'EV_1' },
  );

  it('keeps the event, the room, the time and the SIP status; no number or identity', () => {
    const ev = toVoiceEvent(LiveKitWebhookEventSchema.parse(JSON.parse(sipLeft)), NOW)!;
    expect(ev).toEqual({
      eventId: 'EV_1',
      event: 'participant_left',
      room: ROOM,
      at: new Date(NOW.getTime() + 134_000).toISOString(),
      status: 'completed',
      detail: { participant: 'sip', sipCallStatus: 'hangup', disconnectReason: 'CLIENT_INITIATED' },
    });
    expect(JSON.stringify(ev)).not.toMatch(/\+1555|\+1888|sip_/);
  });

  it('takes the receipt time when createdAt is missing, and no participant for room events', () => {
    const ev = toVoiceEvent(
      { event: 'room_finished', id: 'EV_2', room: { name: ROOM }, participant: { kind: 'SIP' } },
      NOW,
    )!;
    expect(ev).toMatchObject({ at: NOW.toISOString(), status: null, detail: {} });
  });

  it('keys a dispatch rule room by its sid and drops its name (Q227)', () => {
    const raw = JSON.parse(sipLeft) as { room: { name: string; sid: string } };
    raw.room = { name: 'call-_+15550142087_8kQzv3WbN2xa', sid: 'RM_Q227sid00001' };
    const ev = toVoiceEvent(LiveKitWebhookEventSchema.parse(raw), NOW)!;
    expect(ev.room).toBe('RM_Q227sid00001');
    expect(ev.status).toBe('completed');
    expect(JSON.stringify(ev)).not.toMatch(/1555|1888|sip_|8kQzv3WbN2xa/);
  });

  it('ignores a room that is not a call, and an event it does not act on', () => {
    const base = { id: 'EV_x', createdAt: '1760648400' };
    expect(
      toVoiceEvent({ ...base, event: 'room_finished', room: { name: 'demo-room' } }, NOW),
    ).toBeNull();
    expect(
      toVoiceEvent(
        { ...base, event: 'room_finished', room: { name: 'demo-room', sid: 'not a sid' } },
        NOW,
      ),
    ).toBeNull();
    expect(toVoiceEvent({ ...base, event: 'egress_ended', room: { name: ROOM } }, NOW)).toBeNull();
  });
});
