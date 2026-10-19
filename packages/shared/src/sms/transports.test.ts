import { describe, expect, it } from 'vitest';
import { assertE164 } from '../format.ts';
import {
  SmsConfigError,
  SmsSendError,
  createConsoleSmsTransport,
  createIletimerkeziSmsTransport,
  createSmsTransports,
  createTwilioSmsTransport,
  parseIletimerkeziIys,
  twilioCallbackCode,
  twilioCallbackError,
  twilioLateFailureIsAccountFault,
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
    // Only 21610 is the provider's own opt-out list (the Notifier records it as an opt-out).
    expect(errors.map((e) => e.optedOut)).toEqual([false, true, false, false, false, false]);
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
    const out = await driver.send(TR_PHONE, 'Merhaba Emre, ben TalkOlog', { sender: 'TALKOLOG' });
    expect(out).toEqual({ providerId: 'iletimerkezi:98765' });
    const [call] = http.calls;
    expect(call!.url).toBe('https://ime.test/v1/send-sms/json');
    expect(JSON.parse(String(call!.init.body))).toEqual({
      request: {
        authentication: { key: 'key-1', hash: 'hash-1' },
        order: {
          sender: 'TALKOLOG',
          sendDateTime: [],
          message: {
            text: 'Merhaba Emre, ben TalkOlog',
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
    const refused = await driver.send(TR_PHONE, 'x', { sender: 'TALKOLOG' }).catch((e) => e);
    expect(refused).toBeInstanceOf(SmsSendError);
    expect([refused.retryable, refused.opts.code]).toEqual([false, '401']);
    // An account fault is never blamed on the number (send_welcome keeps the reporter reachable).
    expect(refused.undeliverable).toBe(false);
    const outage = await driver.send(TR_PHONE, 'x', { sender: 'TALKOLOG' }).catch((e) => e);
    expect(outage.retryable).toBe(true);
  });

  it('a number the operator cannot route is undeliverable; a balance fault is not', async () => {
    const http = mockFetch(
      json(200, {
        response: { status: { code: '450', message: 'Gönderilecek numara bulunamadı' } },
      }),
      json(200, { response: { status: { code: '402', message: 'Bakiye yetersiz' } } }),
    );
    const driver = createIletimerkeziSmsTransport(creds, http.fetch);
    const bad = await driver.send(TR_PHONE, 'x', { sender: 'TALKOLOG' }).catch((e) => e);
    expect([bad.undeliverable, bad.retryable, bad.opts.code]).toEqual([true, false, '450']);
    const balance = await driver.send(TR_PHONE, 'x', { sender: 'TALKOLOG' }).catch((e) => e);
    expect([balance.undeliverable, balance.retryable, balance.opts.code]).toEqual([
      false,
      false,
      '402',
    ]);
  });

  // W4-11 (spec §9.1, §9.2): the TR text goes as written; the provider picks the encoding.
  it('sends Turkish text as is, never transliterated', async () => {
    const accepted = (id: string) =>
      json(200, { response: { status: { code: '200', message: 'OK' }, order: { id } } });
    const http = mockFetch(accepted('1'));
    const driver = createIletimerkeziSmsTransport(creds, http.fetch);
    const text =
      'Bugün için hâlâ rapor yok. Ataşehir İnşaat, Şantiye, çalışma, ğ ı İ ş Ş Ç Ğ Ö Ü ö ü.';
    await driver.send(TR_PHONE, text, { sender: 'TALKOLOG' });
    const body = JSON.parse(String(http.calls[0]!.init.body)) as {
      request: { order: { message: { text: string } } };
    };
    expect(body.request.order.message.text).toBe(text);
    // The raw request too (JSON.stringify keeps the letters; no \u escapes or ASCII folding).
    expect(String(http.calls[0]!.init.body)).toContain('hâlâ rapor yok. Ataşehir İnşaat, Şantiye');
  });

  // W4-11 (spec §19 Q49): İYS is configuration; informational (no İYS fields) by default.
  it('adds no İYS fields by default; `commercial` marks the order (Q49, Q281)', async () => {
    const accepted = json(200, {
      response: { status: { code: '200', message: 'OK' }, order: { id: '2' } },
    });
    const informational = mockFetch(accepted.clone());
    await createIletimerkeziSmsTransport(creds, informational.fetch).send(TR_PHONE, 'x', {
      sender: 'TALKOLOG',
    });
    const order = (http: ReturnType<typeof mockFetch>) =>
      (JSON.parse(String(http.calls[0]!.init.body)) as { request: { order: object } }).request
        .order;
    expect(Object.keys(order(informational)).sort()).toEqual(['message', 'sendDateTime', 'sender']);

    const commercial = mockFetch(accepted.clone());
    await createIletimerkeziSmsTransport(creds, commercial.fetch, undefined, 'commercial').send(
      TR_PHONE,
      'x',
      { sender: 'TALKOLOG' },
    );
    expect(order(commercial)).toMatchObject({ iys: '1', iysList: 'BIREYSEL' });
  });

  it('reads ILETIMERKEZI_IYS strictly: empty is informational, a typo refuses the driver', () => {
    expect(parseIletimerkeziIys(undefined)).toBe('informational');
    expect(parseIletimerkeziIys(' ')).toBe('informational');
    expect(parseIletimerkeziIys('Commercial')).toBe('commercial');
    expect(() => parseIletimerkeziIys('ticari')).toThrow(SmsConfigError);
    const pick = createSmsTransports({
      fetch: mockFetch().fetch,
      randomUUID: () => 'u',
      iletimerkezi: { apiKey: 'k', apiHash: 'h', iys: 'marketing' },
    });
    expect(() => pick('iletimerkezi')).toThrow(/ILETIMERKEZI_IYS/);
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

describe('late Twilio failures: the account or the number (W1-08)', () => {
  it('failed and the non-number codes are the account; 30003-30006 and no code the number', () => {
    expect(twilioLateFailureIsAccountFault('failed', null)).toBe(true);
    expect(twilioLateFailureIsAccountFault('undeliverable', '30032')).toBe(true);
    expect(twilioLateFailureIsAccountFault('undeliverable', '30007')).toBe(true);
    expect(twilioLateFailureIsAccountFault('undeliverable', '30005')).toBe(false);
    expect(twilioLateFailureIsAccountFault('undeliverable', null)).toBe(false);
  });

  it('the stored error round-trips its code', () => {
    expect(twilioCallbackError('30032')).toBe('twilio 30032');
    expect(twilioCallbackError(null)).toBeNull();
    expect(twilioCallbackCode('twilio 30032')).toBe('30032');
    expect(twilioCallbackCode('twilio failed')).toBeNull();
    expect(twilioCallbackCode(null)).toBeNull();
  });
});
