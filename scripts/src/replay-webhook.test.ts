import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  isTwilioWhatsappForm,
  parseTwilioInbound,
  parseTwilioStatus,
  parseTwilioWhatsappInbound,
  verifyTwilioSignature,
} from '@sitelog/shared';
import {
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
