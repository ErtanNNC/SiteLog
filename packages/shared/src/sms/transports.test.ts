import { describe, expect, it } from 'vitest';
import { assertE164 } from '../format.ts';
import {
  SmsConfigError,
  SmsSendError,
  createConsoleSmsTransport,
  createIletimerkeziSmsTransport,
  createSmsTransports,
  createTwilioSmsTransport,
  type FetchLike,
} from './transports.ts';

/** A mocked HTTP endpoint: records each request and answers with the next response. */
function mockFetch(...responses: Array<Response | Error>) {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const fetch: FetchLike = (url, init) => {
    calls.push({ url, init });
    const next = responses.shift();
    if (!next) throw new Error('unexpected request');
    return next instanceof Error ? Promise.reject(next) : Promise.resolve(next);
  };
  return { fetch, calls };
}

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

const TO = assertE164('+15550143378');

describe('twilio driver (mocked HTTP)', () => {
  const creds = { accountSid: 'AC00000000000000000000000000000001', authToken: 'secret-token' };

  it('posts the form to the Messages resource with basic auth, From = the pack sender', async () => {
    const http = mockFetch(json(201, { sid: 'SM123', status: 'queued' }));
    const driver = createTwilioSmsTransport(creds, http.fetch, 'https://twilio.test');
    const out = await driver.send(TO, 'Hi Marco · link', {
      sender: '+18885550142',
      statusCallback: 'https://x.supabase.co/functions/v1/sms-webhook/status',
    });
    expect(out).toEqual({ providerId: 'SM123' });
    expect(driver.driver).toBe('twilio');
    const [call] = http.calls;
    expect(call!.url).toBe(
      'https://twilio.test/2010-04-01/Accounts/AC00000000000000000000000000000001/Messages.json',
    );
    expect(call!.init.method).toBe('POST');
    const headers = call!.init.headers as Record<string, string>;
    expect(headers.Authorization).toBe(`Basic ${btoa(`${creds.accountSid}:secret-token`)}`);
    expect(headers['Content-Type']).toBe('application/x-www-form-urlencoded');
    const form: Record<string, string> = {};
    new URLSearchParams(String(call!.init.body)).forEach((v, k) => (form[k] = v));
    expect(form).toEqual({
      To: '+15550143378',
      From: '+18885550142',
      Body: 'Hi Marco · link',
      StatusCallback: 'https://x.supabase.co/functions/v1/sms-webhook/status',
    });
  });

  it('maps refusals: undeliverable numbers, retryable outages, network errors', async () => {
    const http = mockFetch(
      json(400, { code: 21211, message: "The 'To' number is not valid.", status: 400 }),
      json(400, { code: 21610, message: 'Attempt to send to unsubscribed recipient', status: 400 }),
      json(401, { code: 20003, message: 'Authenticate', status: 401 }),
      json(429, { code: 20429, message: 'Too Many Requests', status: 429 }),
      json(503, { message: 'Service Unavailable' }),
      new TypeError('fetch failed'),
    );
    const driver = createTwilioSmsTransport(creds, http.fetch);
    const send = () => driver.send(TO, 'x', { sender: '+18885550142' });
    const errors: SmsSendError[] = [];
    for (let i = 0; i < 6; i++)
      errors.push(
        await send().then(
          () => null as never,
          (e) => e,
        ),
      );
    expect(errors.every((e) => e instanceof SmsSendError)).toBe(true);
    expect(errors.map((e) => [e.undeliverable, e.retryable, e.opts.code ?? null])).toEqual([
      [true, false, '21211'],
      [true, false, '21610'],
      [false, false, '20003'],
      [false, true, '20429'],
      [false, true, null],
      [false, true, null],
    ]);
    expect(errors[0]!.message).toBe("twilio 400 21211: The 'To' number is not valid.");
  });

  it('refuses to send without a sender id', async () => {
    const http = mockFetch();
    const driver = createTwilioSmsTransport(creds, http.fetch);
    await expect(driver.send(TO, 'x', {})).rejects.toThrow(/no sender id/);
    expect(http.calls).toHaveLength(0);
  });
});

describe('iletimerkezi driver (mocked HTTP)', () => {
  const creds = { apiKey: 'key-1', apiHash: 'hash-1' };
  const TR_PHONE = assertE164('+905321234567');

  it('posts the JSON order from the approved title, the number without its +', async () => {
    const http = mockFetch(
      json(200, {
        response: { status: { code: '200', message: 'İşlem başarılı' }, order: { id: '98765' } },
      }),
    );
    const driver = createIletimerkeziSmsTransport(creds, http.fetch, 'https://ime.test');
    const out = await driver.send(TR_PHONE, 'Merhaba Emre, ben SiteLog', { sender: 'SITELOG' });
    expect(out).toEqual({ providerId: 'iletimerkezi:98765' });
    const [call] = http.calls;
    expect(call!.url).toBe('https://ime.test/v1/send-sms/json');
    expect(JSON.parse(String(call!.init.body))).toEqual({
      request: {
        authentication: { key: 'key-1', hash: 'hash-1' },
        order: {
          sender: 'SITELOG',
          sendDateTime: [],
          message: {
            text: 'Merhaba Emre, ben SiteLog',
            receipents: { number: ['905321234567'] },
          },
        },
      },
    });
  });

  it('a provider refusal is not retried; an outage is', async () => {
    const http = mockFetch(
      json(200, { response: { status: { code: '401', message: 'Üyelik bilgileri hatalı' } } }),
      json(502, {}),
    );
    const driver = createIletimerkeziSmsTransport(creds, http.fetch);
    const refused = await driver.send(TR_PHONE, 'x', { sender: 'SITELOG' }).catch((e) => e);
    expect(refused).toBeInstanceOf(SmsSendError);
    expect([refused.retryable, refused.opts.code]).toEqual([false, '401']);
    const outage = await driver.send(TR_PHONE, 'x', { sender: 'SITELOG' }).catch((e) => e);
    expect(outage.retryable).toBe(true);
  });
});

describe('driver set', () => {
  it('console sends nothing and names a console provider id', async () => {
    const driver = createConsoleSmsTransport(() => 'u-1');
    expect(await driver.send(TO, 'x', {})).toEqual({ providerId: 'console:u-1' });
  });

  it('a provider driver without credentials refuses to exist, never falls back to console', () => {
    const http = mockFetch();
    const pick = createSmsTransports({
      fetch: http.fetch,
      randomUUID: () => 'u',
      twilio: { accountSid: 'AC1', authToken: '' },
    });
    expect(pick('console').driver).toBe('console');
    expect(() => pick('twilio')).toThrow(SmsConfigError);
    expect(() => pick('twilio')).toThrow(/TWILIO_AUTH_TOKEN/);
    expect(() => pick('iletimerkezi')).toThrow(/ILETIMERKEZI_API_KEY, ILETIMERKEZI_API_HASH/);
    const full = createSmsTransports({
      fetch: http.fetch,
      randomUUID: () => 'u',
      twilio: { accountSid: 'AC1', authToken: 't' },
      iletimerkezi: { apiKey: 'k', apiHash: 'h' },
    });
    expect(full('twilio').driver).toBe('twilio');
    expect(full('iletimerkezi').driver).toBe('iletimerkezi');
  });
});
