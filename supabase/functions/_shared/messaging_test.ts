import { assertEquals, assertRejects, assertThrows } from '@std/assert';
import { assertE164, SmsStandInConfigError } from '@sitelog/shared';
import { smsApiBasesFromEnv, smsTransportsFromEnv } from './messaging.ts';

/**
 * W4-12: the edge functions' SMS drivers reach the local SMS stand-in only with
 * SMS_PROVIDER_STUB=true (the local stack and CI), at TWILIO_API_BASE and ILETIMERKEZI_API_BASE.
 */

const KEYS = [
  'SMS_PROVIDER_STUB',
  'TWILIO_API_BASE',
  'ILETIMERKEZI_API_BASE',
  'TWILIO_ACCOUNT_SID',
  'TWILIO_AUTH_TOKEN',
  'ILETIMERKEZI_API_KEY',
  'ILETIMERKEZI_API_HASH',
];

function withEnv(values: Record<string, string>, fn: () => Promise<void> | void) {
  return async () => {
    const before = new Map(KEYS.map((k) => [k, Deno.env.get(k)]));
    for (const k of KEYS) Deno.env.delete(k);
    for (const [k, v] of Object.entries(values)) Deno.env.set(k, v);
    try {
      await fn();
    } finally {
      for (const [k, v] of before) {
        if (v === undefined) Deno.env.delete(k);
        else Deno.env.set(k, v);
      }
    }
  };
}

Deno.test(
  'no stub: the real providers (the bases alone change nothing)',
  withEnv({ TWILIO_API_BASE: 'http://127.0.0.1:4010' }, () => {
    assertEquals(smsApiBasesFromEnv(), {});
  }),
);

Deno.test(
  'SMS_PROVIDER_STUB=true: Twilio and İletimerkezi sends go to the stand-in',
  withEnv(
    {
      SMS_PROVIDER_STUB: 'true',
      TWILIO_API_BASE: 'http://stand-in.test:4010',
      ILETIMERKEZI_API_BASE: 'http://stand-in.test:4010',
      TWILIO_ACCOUNT_SID: 'ACe2e',
      TWILIO_AUTH_TOKEN: 'token',
      ILETIMERKEZI_API_KEY: 'key',
      ILETIMERKEZI_API_HASH: 'hash',
    },
    async () => {
      const urls: string[] = [];
      const fake: typeof fetch = (input) => {
        const url = String(input);
        urls.push(url);
        return Promise.resolve(
          url.endsWith('/Messages.json')
            ? new Response(JSON.stringify({ sid: 'SM0123' }), { status: 201 })
            : new Response(
                JSON.stringify({ response: { status: { code: 200 }, order: { id: 7 } } }),
                { status: 200 },
              ),
        );
      };
      const transports = smsTransportsFromEnv(fake);
      assertEquals(
        await transports('twilio').send(assertE164('+15550142290'), 'hi', {
          sender: '+18885550100',
        }),
        { providerId: 'SM0123' },
      );
      assertEquals(
        await transports('iletimerkezi').send(assertE164('+905320000001'), 'merhaba', {
          sender: 'TALKOLOG',
        }),
        { providerId: 'iletimerkezi:7' },
      );
      assertEquals(urls, [
        'http://stand-in.test:4010/2010-04-01/Accounts/ACe2e/Messages.json',
        'http://stand-in.test:4010/v1/send-sms/json',
      ]);
    },
  ),
);

Deno.test(
  'a stub without both bases refuses to send rather than reach a real provider',
  withEnv({ SMS_PROVIDER_STUB: 'true', TWILIO_API_BASE: 'http://127.0.0.1:4010' }, async () => {
    assertThrows(() => smsApiBasesFromEnv(), SmsStandInConfigError);
    await assertRejects(async () => {
      await smsTransportsFromEnv(() => Promise.reject(new Error('no request expected')))(
        'twilio',
      ).send(assertE164('+15550142290'), 'hi', { sender: '+18885550100' });
    }, SmsStandInConfigError);
  }),
);
