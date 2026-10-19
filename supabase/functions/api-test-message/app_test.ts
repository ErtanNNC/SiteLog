import { assertEquals, assertRejects } from '@std/assert';
import {
  type CountryRow,
  type MemberRole,
  SmsSendError,
  type SmsDriver,
  type SmsTransport,
  toCountryPack,
} from '@sitelog/shared';
import { DEMO_COUNTRIES } from '@sitelog/shared/demo/countries.ts';
import { HttpError } from '../_shared/http.ts';
import { maskPhone, sendTestMessage, type TestMessageStore } from './app.ts';

/** Settings' "Send me a test message" (P12, §19 Q232, W4-05) on an in-memory store. */

const ORG = '22222222-2222-4222-8222-222222222222';
const LENA = '44444444-4444-4444-8444-444444444444';

function packOf(code: 'US' | 'TR', over: Partial<CountryRow> = {}) {
  return toCountryPack({ ...DEMO_COUNTRIES.find((c) => c.code === code)!, ...over });
}

function setup(
  opts: {
    role?: MemberRole | null;
    isDemo?: boolean;
    code?: 'US' | 'TR';
    sender?: string | null;
    fail?: Error;
  } = {},
) {
  const claims: Array<Parameters<TestMessageStore['claim']>[0]> = [];
  const failures: Array<{ driver: SmsDriver; detail: string }> = [];
  const sent: Array<{ driver: SmsDriver; to: string; body: string; sender?: string }> = [];
  const code = opts.code ?? 'US';
  const sender =
    opts.sender === undefined ? (code === 'US' ? '+18885550142' : '+18885550199') : opts.sender;
  const store: TestMessageStore = {
    memberRole: () => Promise.resolve(opts.role === undefined ? 'admin' : opts.role),
    loadOrg: () =>
      Promise.resolve({
        id: ORG,
        name: code === 'US' ? 'Kestrel Build Group' : 'Demir Yapı A.Ş.',
        is_demo: opts.isDemo ?? false,
        pack: packOf(code, { sms_sender_id: sender }),
      }),
    claim: (input) => {
      claims.push(input);
      return Promise.resolve(
        claims.length > 5 ? { allowed: false, retryAt: '2026-10-17T13:00:00Z' } : { allowed: true },
      );
    },
    auditFailure: (input) => {
      failures.push({ driver: input.driver, detail: input.detail });
      return Promise.resolve();
    },
  };
  const transport = (driver: SmsDriver): SmsTransport => ({
    driver,
    send(to, body, o) {
      if (opts.fail) return Promise.reject(opts.fail);
      sent.push({ driver, to, body, ...(o.sender ? { sender: o.sender } : {}) });
      return Promise.resolve({ providerId: 'SM1' });
    },
  });
  return { deps: { store, transport }, claims, failures, sent };
}

const input = { orgId: ORG, phone: '+1 555 014 2290', language: 'en', attested: true } as const;

Deno.test('sends the test text through the pack’s provider with its sender id', async () => {
  const t = setup();
  assertEquals(await sendTestMessage(t.deps, LENA, input), { outcome: 'sent', driver: 'twilio' });
  assertEquals(t.sent, [
    {
      driver: 'twilio',
      to: '+15550142290',
      body: 'TalkOlog test message for Kestrel Build Group. Your site managers get their texts from this sender. No reply needed.',
      sender: '+18885550142',
    },
  ]);
  // Audited with the number masked, never whole.
  assertEquals(t.claims, [
    { orgId: ORG, userId: LENA, phoneMasked: '+1555***290', driver: 'twilio', language: 'en' },
  ]);
});

Deno.test(
  'a TR pack: Twilio since §19 Q370, the Turkish text, a national number read in Türkiye',
  async () => {
    const t = setup({ code: 'TR' });
    const r = await sendTestMessage(t.deps, LENA, {
      ...input,
      phone: '0532 555 01 42',
      language: 'tr',
    });
    assertEquals(r, { outcome: 'sent', driver: 'twilio' });
    assertEquals(t.sent[0]!.to, '+905325550142');
    assertEquals(
      t.sent[0]!.body,
      'Demir Yapı A.Ş. için TalkOlog deneme mesajı. Şantiye şefleriniz mesajlarını bu göndericiden alır. Yanıt gerekmez.',
    );
  },
);

Deno.test(
  'a demo org or a pack with no sender here: console, nothing leaves TalkOlog',
  async () => {
    const demo = setup({ isDemo: true });
    assertEquals(await sendTestMessage(demo.deps, LENA, input), {
      outcome: 'console',
      reason: 'demo',
    });
    const unset = setup({ sender: null });
    assertEquals(await sendTestMessage(unset.deps, LENA, input), {
      outcome: 'console',
      reason: 'no_sender',
    });
    assertEquals([...demo.sent, ...unset.sent], []);
    assertEquals(
      [...demo.claims, ...unset.claims].map((c) => c.driver),
      ['console', 'console'],
    );
  },
);

Deno.test('admins only; a bad number is 400 and claims nothing', async () => {
  for (const role of ['ops', 'pm', null] as const) {
    const t = setup({ role });
    const err = await assertRejects(() => sendTestMessage(t.deps, LENA, input), HttpError);
    assertEquals(err.status, 403);
    assertEquals(t.claims, []);
  }
  const t = setup();
  const err = await assertRejects(
    () => sendTestMessage(t.deps, LENA, { ...input, phone: '12' }),
    HttpError,
  );
  assertEquals([err.status, (err.details as { code: string }).code], [400, 'invalid_phone']);
  assertEquals(t.claims, []);
});

Deno.test('the sixth in an hour is 429 rate_limited and sends nothing', async () => {
  const t = setup();
  for (let i = 0; i < 5; i++) await sendTestMessage(t.deps, LENA, input);
  const err = await assertRejects(() => sendTestMessage(t.deps, LENA, input), HttpError);
  assertEquals(err.status, 429);
  assertEquals(err.details, { code: 'rate_limited', retryAt: '2026-10-17T13:00:00Z' });
  assertEquals(t.sent.length, 5);
});

Deno.test('a provider refusal is answered failed and audited', async () => {
  const t = setup({
    fail: new SmsSendError('Twilio 400: unverified', { driver: 'twilio', retryable: false }),
  });
  assertEquals(await sendTestMessage(t.deps, LENA, input), { outcome: 'failed', driver: 'twilio' });
  assertEquals(t.failures, [{ driver: 'twilio', detail: 'Twilio 400: unverified' }]);
});

Deno.test('maskPhone keeps the country code and the last three digits', () => {
  assertEquals(maskPhone('+15550143378'), '+1555***378');
  assertEquals(maskPhone('+905325550142'), '+9053***142');
  assertEquals(maskPhone('+12'), '***');
});
