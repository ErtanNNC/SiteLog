import { describe, expect, it } from 'vitest';
import {
  msgStatusFromTwilio,
  nextMessageStatus,
  parseTwilioInbound,
  parseTwilioStatus,
  parseTwilioWhatsappInbound,
  twilioSignature,
  twilioSignedPayload,
  verifyTwilioSignature,
  whatsappUserIdOf,
} from './twilio.ts';

/**
 * The signature vector of Twilio's own libraries (twilio-node `webhooks` tests): auth token
 * 12345, this URL and these parameters sign to RSOYDt4T1cUTdK1PDd93/VVr8B8=.
 */
const VECTOR = {
  token: '12345',
  url: 'https://mycompany.com/myapp.php?foo=1&bar=2',
  params: {
    CallSid: 'CA1234567890ABCDE',
    Caller: '+14158675309',
    Digits: '1234',
    From: '+14158675309',
    To: '+18005551212',
  },
  signature: 'RSOYDt4T1cUTdK1PDd93/VVr8B8=',
};

describe('X-Twilio-Signature', () => {
  it('matches the documented vector', async () => {
    expect(await twilioSignature(VECTOR.url, VECTOR.params, VECTOR.token)).toBe(VECTOR.signature);
    expect(
      await verifyTwilioSignature([VECTOR.url], VECTOR.params, VECTOR.signature, VECTOR.token),
    ).toBe(true);
  });

  it('signs the URL then the parameters sorted by name, values unseparated', () => {
    expect(twilioSignedPayload('https://a/b', { b: '2', a: '1', B: '3' })).toBe(
      'https://a/bB3a1b2',
    );
    expect(twilioSignedPayload('https://a', new URLSearchParams('x=2&x=1'))).toBe('https://ax1x2');
  });

  it('refuses a changed parameter, URL or token, a missing header and an empty token', async () => {
    const tampered = { ...VECTOR.params, Digits: '1235' };
    expect(
      await verifyTwilioSignature([VECTOR.url], tampered, VECTOR.signature, VECTOR.token),
    ).toBe(false);
    expect(
      await verifyTwilioSignature(
        ['https://mycompany.com/myapp.php?foo=1&bar=3'],
        VECTOR.params,
        VECTOR.signature,
        VECTOR.token,
      ),
    ).toBe(false);
    expect(
      await verifyTwilioSignature([VECTOR.url], VECTOR.params, VECTOR.signature, '12346'),
    ).toBe(false);
    expect(await verifyTwilioSignature([VECTOR.url], VECTOR.params, null, VECTOR.token)).toBe(
      false,
    );
    expect(await verifyTwilioSignature([VECTOR.url], VECTOR.params, VECTOR.signature, '')).toBe(
      false,
    );
  });

  it('accepts any of the candidate URLs, with or without the default port', async () => {
    const internal = 'http://edge-runtime:8081/sms-webhook';
    const sig = await twilioSignature(
      'https://mycompany.com:443/myapp.php?foo=1&bar=2',
      VECTOR.params,
      VECTOR.token,
    );
    expect(
      await verifyTwilioSignature([internal, VECTOR.url], VECTOR.params, sig, VECTOR.token),
    ).toBe(true);
  });
});

describe('Twilio webhook fields', () => {
  it('reads an inbound SMS; a WhatsApp or malformed sender is not one', () => {
    const form = new URLSearchParams({
      MessageSid: 'SM1',
      From: '+15550143378',
      To: '+18885550142',
      Body: 'STOP',
      NumMedia: '0',
      OptOutType: 'stop',
    });
    expect(parseTwilioInbound(form)).toEqual({
      messageSid: 'SM1',
      from: '+15550143378',
      to: '+18885550142',
      body: 'STOP',
      optOutType: 'STOP',
      numMedia: 0,
    });
    form.set('From', 'whatsapp:+15550143378');
    expect(parseTwilioInbound(form)).toBeNull();
    expect(parseTwilioInbound(new URLSearchParams({ From: '+15550143378' }))).toBeNull();
  });

  it('reads a WhatsApp business-scoped user id (§19 Q372) beside the number or in its place', () => {
    const form = (p: Record<string, string>) =>
      new URLSearchParams({ MessageSid: 'SMwa1', To: 'whatsapp:+15550142299', Body: 'OK', ...p });
    // The number and the id.
    expect(
      parseTwilioWhatsappInbound(
        form({ From: 'whatsapp:+905321234567', ExternalUserId: 'whatsapp:TR.968122199252486' }),
      ),
    ).toMatchObject({ from: '+905321234567', userId: 'TR.968122199252486' });
    // Only the id: `From` holds it.
    expect(
      parseTwilioWhatsappInbound(
        form({
          From: 'whatsapp:TR.968122199252486',
          ExternalUserId: 'whatsapp:TR.968122199252486',
        }),
      ),
    ).toMatchObject({ from: null, userId: 'TR.968122199252486' });
    expect(parseTwilioWhatsappInbound(form({ From: 'whatsapp:TR.968122199252486' }))).toMatchObject(
      { from: null, userId: 'TR.968122199252486' },
    );
    // No id, or a malformed one: the number alone; a malformed `From` is no message.
    expect(parseTwilioWhatsappInbound(form({ From: 'whatsapp:+905321234567' }))!.userId).toBeNull();
    expect(
      parseTwilioWhatsappInbound(
        form({ From: 'whatsapp:+905321234567', ExternalUserId: 'whatsapp:tr.12' }),
      )!.userId,
    ).toBeNull();
    expect(parseTwilioWhatsappInbound(form({ From: 'whatsapp:TR.' }))).toBeNull();
    expect(parseTwilioWhatsappInbound(form({ From: 'whatsapp:TR.12-34' }))).toBeNull();
    expect(whatsappUserIdOf('TR.968122199252486')).toBe('TR.968122199252486');
    expect(whatsappUserIdOf(`whatsapp:US.${'a'.repeat(128)}`)).toBe(`US.${'a'.repeat(128)}`);
    expect(whatsappUserIdOf(`US.${'a'.repeat(129)}`)).toBeNull();
    expect(whatsappUserIdOf('whatsapp:+905321234567')).toBeNull();
    expect(whatsappUserIdOf('')).toBeNull();
  });

  it('reads a status callback and maps Twilio statuses to msg_status', () => {
    expect(
      parseTwilioStatus(
        new URLSearchParams({
          MessageSid: 'SM1',
          MessageStatus: 'undelivered',
          ErrorCode: '30005',
        }),
      ),
    ).toEqual({ messageSid: 'SM1', status: 'undelivered', errorCode: '30005' });
    expect(parseTwilioStatus(new URLSearchParams({ MessageSid: 'SM1' }))).toBeNull();
    expect(
      ['queued', 'sending', 'sent', 'delivered', 'undelivered', 'failed', 'read'].map(
        msgStatusFromTwilio,
      ),
    ).toEqual([null, null, 'sent', 'delivered', 'undeliverable', 'failed', 'read']);
  });

  it('never moves a message back, and a late failure does not undo a delivery', () => {
    expect(nextMessageStatus('sent', 'delivered')).toBe('delivered');
    expect(nextMessageStatus('delivered', 'sent')).toBeNull();
    expect(nextMessageStatus('sent', 'sent')).toBeNull();
    expect(nextMessageStatus('sent', 'undeliverable')).toBe('undeliverable');
    expect(nextMessageStatus('queued', 'failed')).toBe('failed');
    expect(nextMessageStatus('delivered', 'failed')).toBeNull();
    expect(nextMessageStatus('failed', 'undeliverable')).toBeNull();
    expect(nextMessageStatus('failed', 'delivered')).toBe('delivered');
  });
});
