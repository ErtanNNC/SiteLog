import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  assertE164,
  createSmsTransports,
  createTwilioWhatsappTransport,
  SMS_STAND_IN_ROUTES,
  SmsSendError,
  smsApiBases,
  type StandInMessage,
} from '@sitelog/shared';
import { startSmsStandIn, type SmsStandIn } from './sms-stand-in.ts';

/**
 * W4-12: the local SMS stand-in answers the real drivers (`createSmsTransports` with the bases
 * `smsApiBases` gives for SMS_PROVIDER_STUB=true) as the providers accept a text, and lists what
 * it received for the tests.
 */

let standIn: SmsStandIn;

beforeAll(async () => {
  standIn = await startSmsStandIn({ port: 0, host: '127.0.0.1' });
});

afterAll(async () => {
  await standIn?.close();
});

beforeEach(async () => {
  await fetch(`${standIn.url()}${SMS_STAND_IN_ROUTES.messages}`, { method: 'DELETE' });
});

function transports(creds = true) {
  return createSmsTransports({
    fetch: (url, init) => fetch(url, init),
    randomUUID: () => crypto.randomUUID(),
    twilio: creds ? { accountSid: 'ACe2e', authToken: 'token' } : {},
    iletimerkezi: { apiKey: 'key', apiHash: 'hash' },
    apiBase: smsApiBases({
      SMS_PROVIDER_STUB: 'true',
      TWILIO_API_BASE: standIn.url(),
      ILETIMERKEZI_API_BASE: standIn.url(),
    }),
  });
}

async function received(to?: string): Promise<StandInMessage[]> {
  const q = to ? `?to=${encodeURIComponent(to)}` : '';
  const res = await fetch(`${standIn.url()}${SMS_STAND_IN_ROUTES.messages}${q}`);
  return (await res.json()) as StandInMessage[];
}

describe('the SMS stand-in (W4-12)', () => {
  it('accepts a Twilio text from the real driver and lists it by recipient', async () => {
    const out = await transports()('twilio').send(
      assertE164('+15550142290'),
      'Hi Kevin, Kestrel Build Group uses SiteLog.',
      { sender: '+18885550100' },
    );
    expect(out.providerId).toMatch(/^SM[0-9a-f]{32}$/);
    expect(await received('+15550142290')).toEqual([
      {
        id: out.providerId,
        provider: 'twilio',
        channel: 'sms',
        to: '+15550142290',
        from: '+18885550100',
        body: 'Hi Kevin, Kestrel Build Group uses SiteLog.',
        at: expect.any(String),
      },
    ]);
    expect(await received('+15550000000')).toEqual([]);
  });

  it('accepts an İletimerkezi order (Turkish letters as sent) with a fresh order id', async () => {
    const t = transports()('iletimerkezi');
    const a = await t.send(assertE164('+905320000001'), 'Merhaba Emre, şantiye raporu.', {
      sender: 'SITELOG',
    });
    const b = await t.send(assertE164('+905320000002'), 'İkinci', { sender: 'SITELOG' });
    expect(a.providerId).toMatch(/^iletimerkezi:\d+$/);
    expect(b.providerId).not.toBe(a.providerId);
    const [first] = await received('+905320000001');
    expect(first).toMatchObject({
      provider: 'iletimerkezi',
      from: 'SITELOG',
      body: 'Merhaba Emre, şantiye raporu.',
    });
  });

  it('takes a Twilio WhatsApp send on the same route, the number without its prefix', async () => {
    const wa = createTwilioWhatsappTransport(
      { accountSid: 'ACe2e', authToken: 'token' },
      (url, init) => fetch(url, init),
      // The person wrote a minute ago: the 24-hour window is open, so a session text (Body).
      { lastInbound: () => Promise.resolve(new Date(Date.now() - 60_000).toISOString()) },
      standIn.url(),
    );
    const out = await wa.send(
      {
        to: assertE164('+15550142290'),
        body: 'Your link',
        key: 'welcome',
        language: 'en',
        vars: {},
      } as unknown as Parameters<typeof wa.send>[0],
      { sender: '+18885550100' },
    );
    expect(out.providerId).toMatch(/^SM/);
    expect(await received('+15550142290')).toMatchObject([
      { provider: 'twilio', channel: 'whatsapp', from: '+18885550100', body: 'Your link' },
    ]);
  });

  it('refuses what a provider would refuse: no credentials, an incomplete request', async () => {
    const res = await fetch(`${standIn.url()}/2010-04-01/Accounts/AC1/Messages.json`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: 'To=%2B15550142290&From=%2B18885550100&Body=hi',
    });
    expect(res.status).toBe(401);
    await expect(
      transports()('twilio').send(assertE164('+15550142290'), '', { sender: '+18885550100' }),
    ).rejects.toBeInstanceOf(SmsSendError);
    expect(await received()).toEqual([]);
  });
});
