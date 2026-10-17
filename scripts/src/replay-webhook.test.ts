import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  isTwilioWhatsappForm,
  parseTwilioInbound,
  parseTwilioStatus,
  parseTwilioWhatsappInbound,
  verifyTwilioSignature,
  verifyLiveKitWebhook,
  LiveKitWebhookEventSchema,
  toVoiceEvent,
} from '@sitelog/shared';
import {
  isLiveKitFixture,
  liveKitRequest,
  isTwilioFixture,
  parseArgs,
  substitute,
  substituteTwilio,
  twilioRequest,
  type TwilioFixture,
} from './replay-webhook.ts';

describe('replay-webhook substitute', () => {
  it('fills phone, timestamp and fresh ids', () => {
    const out = substitute('{"from":"{{phone}}","ts":"{{ts}}","a":"{{id}}","b":"{{id}}"}', {
      phone: '15550143378',
    });
    const parsed = JSON.parse(out) as { from: string; ts: string; a: string; b: string };
    expect(parsed.from).toBe('15550143378');
    expect(Number(parsed.ts)).toBeGreaterThan(1_700_000_000);
    expect(parsed.a).toMatch(/^wamid\.replay\./);
    expect(parsed.a).not.toBe(parsed.b);
  });
});

describe('replay-webhook Twilio mode (W1-08)', () => {
  const FIXTURES = join(import.meta.dirname, '..', '..', 'fixtures', 'sms');

  it('every SMS fixture is a Twilio fixture that sms-webhook can read once filled', () => {
    const files = readdirSync(FIXTURES).filter((f) => f.endsWith('.json'));
    expect(files.length).toBeGreaterThanOrEqual(6);
    for (const f of files) {
      const raw = readFileSync(join(FIXTURES, f), 'utf8');
      expect(isTwilioFixture(JSON.parse(raw)), f).toBe(true);
      const fixture = JSON.parse(
        substituteTwilio(raw, { phone: '15550143378', to: '+18885550142', sid: 'SMstatus1' }),
      ) as TwilioFixture;
      const form = new URLSearchParams(fixture.params);
      if (fixture.path === '') {
        const inbound = parseTwilioInbound(form);
        expect(inbound, f).not.toBeNull();
        expect(inbound!.to).toBe('+18885550142');
      } else {
        expect(fixture.path).toBe('/status');
        expect(parseTwilioStatus(form)?.messageSid).toBe('SMstatus1');
      }
    }
  });

  it('every WhatsApp fixture (W2-16) is a Twilio WhatsApp form sms-webhook can read once filled', () => {
    const dir = join(import.meta.dirname, '..', '..', 'fixtures', 'whatsapp');
    const files = readdirSync(dir).filter((f) => f.endsWith('.json'));
    expect(files.length).toBeGreaterThanOrEqual(6);
    for (const f of files) {
      const raw = readFileSync(join(dir, f), 'utf8');
      expect(isTwilioFixture(JSON.parse(raw)), f).toBe(true);
      const fixture = JSON.parse(
        substituteTwilio(raw, { phone: '905321234567', to: '+905320000099', sid: 'SMwa1' }),
      ) as TwilioFixture;
      const form = new URLSearchParams(fixture.params);
      if (fixture.path === '') {
        expect(isTwilioWhatsappForm(form), f).toBe(true);
        const inbound = parseTwilioWhatsappInbound(form);
        expect(inbound, f).toMatchObject({ from: '+905321234567', to: '+905320000099' });
        expect(form.get('WaId')).toBe('905321234567');
        // An SMS reader never takes it for a text.
        expect(parseTwilioInbound(form), f).toBeNull();
      } else {
        expect(parseTwilioStatus(form)?.messageSid).toBe('SMwa1');
      }
    }
    const note = JSON.parse(
      substituteTwilio(readFileSync(join(dir, 'inbound-voice-note.json'), 'utf8'), {
        phone: '905321234567',
        to: '+905320000099',
        sid: 'SMwa1',
      }),
    ) as TwilioFixture;
    expect(parseTwilioWhatsappInbound(new URLSearchParams(note.params))!.media).toHaveLength(1);
  });

  it('fills the placeholders: E.164 sender, the pack sender, a fresh SID per replay', () => {
    const t = '{"a":"{{phone}}","b":"{{to}}","c":"{{sid}}","d":"{{message_sid}}"}';
    const one = JSON.parse(
      substituteTwilio(t, { phone: '1 555 014 3378', to: 'SITELOG', sid: '' }),
    );
    const two = JSON.parse(substituteTwilio(t, { phone: '15550143378', to: 'SITELOG', sid: '' }));
    expect(one.a).toBe('+15550143378');
    expect(one.b).toBe('SITELOG');
    expect(one.c).toMatch(/^SM[0-9a-f]+$/);
    expect(one.c).not.toBe(two.c);
    expect(JSON.parse(substituteTwilio(t, { phone: '1', to: 'x', sid: 'SMgiven' })).d).toBe(
      'SMgiven',
    );
  });

  it('signs the form for the URL it posts to, as sms-webhook verifies it', async () => {
    const fixture: TwilioFixture = {
      path: '/status',
      params: { MessageSid: 'SM1', MessageStatus: 'delivered' },
    };
    const req = await twilioRequest(
      fixture,
      'http://127.0.0.1:54321/functions/v1/sms-webhook/',
      'tok',
    );
    expect(req.url).toBe('http://127.0.0.1:54321/functions/v1/sms-webhook/status');
    expect(req.body).toBe('MessageSid=SM1&MessageStatus=delivered');
    expect(
      await verifyTwilioSignature([req.url], new URLSearchParams(req.body), req.signature, 'tok'),
    ).toBe(true);
  });

  it('reads the Twilio flags', () => {
    const args = parseArgs(
      ['--sms-url', 'https://x/sms', '--token', 't', '--to', 'SITELOG', '--sid', 'SM9', 'f.json'],
      {},
    );
    expect(args).toMatchObject({
      smsUrl: 'https://x/sms',
      token: 't',
      to: 'SITELOG',
      sid: 'SM9',
      files: ['f.json'],
    });
  });
});

describe('replay-webhook LiveKit mode (W3-04)', () => {
  const FIXTURES = join(import.meta.dirname, '..', '..', 'fixtures', 'livekit');
  const ROOM = 'call-0f0e0d0c-0000-4000-8000-0000000000f1';

  it('signs every LiveKit fixture as voice-events checks it, filled for one room', async () => {
    const files = readdirSync(FIXTURES).filter((f) => f.endsWith('.json'));
    expect(files.length).toBeGreaterThanOrEqual(6);
    const args = parseArgs(['--room', ROOM, '--phone', '15550142087'], {
      LIVEKIT_API_KEY: 'APIlocal',
      LIVEKIT_API_SECRET: 'local-secret',
    });
    expect(args).toMatchObject({ room: ROOM, livekitKey: 'APIlocal' });
    const now = new Date();
    for (const f of files) {
      const raw = readFileSync(join(FIXTURES, f), 'utf8');
      expect(isLiveKitFixture(JSON.parse(raw)), f).toBe(true);
      expect(isTwilioFixture(JSON.parse(raw)), f).toBe(false);
      const req = await liveKitRequest(raw, args, now);
      const body = JSON.parse(req.body) as { room: { name: string }; createdAt: string };
      expect(body.room.name).toBe(ROOM);
      expect(Number(body.createdAt)).toBeLessThanOrEqual(now.getTime() / 1000);
      expect(
        await verifyLiveKitWebhook(req.body, req.authorization, {
          apiKey: 'APIlocal',
          apiSecret: 'local-secret',
          now,
        }),
      ).toMatchObject({ ok: true });
    }
  });

  it('maps the fixtures as voice-events does: the outbound call, no answer, busy', async () => {
    const args = parseArgs(['--room', ROOM], {});
    const status = async (f: string) => {
      const req = await liveKitRequest(readFileSync(join(FIXTURES, f), 'utf8'), args);
      const ev = toVoiceEvent(LiveKitWebhookEventSchema.parse(JSON.parse(req.body)), new Date());
      expect(ev, f).not.toBeNull();
      // No number or participant identity leaves toVoiceEvent (§10.12).
      expect(JSON.stringify(ev), f).not.toMatch(/\+1555|\+1888|sip_/);
      return [ev!.event, ev!.status];
    };
    const outbound = [1, 2, 3, 4, 5, 6].map(
      (n) => readdirSync(FIXTURES).find((f) => f.startsWith(`outbound-0${n}-`)) ?? `missing ${n}`,
    );
    expect(await Promise.all(outbound.map(status))).toEqual([
      ['room_started', null],
      ['participant_joined', null],
      ['participant_joined', 'ringing'],
      ['track_published', 'in_progress'],
      ['participant_left', 'completed'],
      ['room_finished', null],
    ]);
    expect(await status('no-answer-02-sip-unavailable.json')).toEqual([
      'participant_left',
      'no_answer',
    ]);
    expect(await status('busy-sip-rejected.json')).toEqual(['participant_left', 'busy']);
  });

  it('defaults to a fresh room and a local key pair', () => {
    const a = parseArgs([], {});
    expect(a.room).toMatch(/^call-[0-9a-f-]{36}$/);
    expect(a.livekitKey).toBe('devkey');
    expect(a.voiceUrl).toMatch(/voice-events$/);
  });
});
