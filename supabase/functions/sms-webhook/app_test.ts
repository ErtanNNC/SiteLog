import { assert, assertEquals, assertMatch } from '@std/assert';
import {
  EMPTY_TWIML,
  MASKED_CODE,
  SmsSendError,
  deriveLinkCode,
  linkCodeHash,
  twilioSignature,
  type CountryRow,
} from '@sitelog/shared';
import { DEMO_COUNTRIES } from '@sitelog/shared/demo/countries.ts';
import { EnvError } from '../_shared/env.ts';
import { HttpError } from '../_shared/http.ts';
import { fakeMessaging, type FakeMessaging } from '../_shared/fake_messaging.ts';
import { createSmsWebhook, routeOf, signedUrls } from './app.ts';
import { FakeSmsStore } from './fake_store.ts';

/** sms-webhook (W1-08): signature, keywords, F13, status callbacks and the Demo phone's replies. */

const BASE = 'https://proj.supabase.co/functions/v1/sms-webhook';
const TOKEN = 'twilio-auth-token';
const SECRET = 'link-signing-secret';
const US_SENDER = '+18885550142';
const T0 = new Date('2026-10-09T23:00:00Z');

const row = (code: 'US' | 'TR', patch: Partial<CountryRow>) => ({
  ...DEMO_COUNTRIES.find((c) => c.code === code)!,
  ...patch,
});

const KESTREL = '00000000-0000-4000-8000-0000000000a1';
const REAL_US = '00000000-0000-4000-8000-0000000000a2';
const DEMIR = '00000000-0000-4000-8000-0000000000a3';
const MARCO = '00000000-0000-4000-8000-0000000000c1';
const DANA = '00000000-0000-4000-8000-0000000000c2';
const EMRE = '00000000-0000-4000-8000-0000000000c3';
const LENA = '00000000-0000-4000-8000-0000000000e1';
const PM = '00000000-0000-4000-8000-0000000000e2';

interface Harness {
  store: FakeSmsStore;
  messaging: FakeMessaging;
  handle: (req: Request) => Promise<Response>;
  twilio: (
    path: string,
    params: Record<string, string>,
    opts?: { sign?: string },
  ) => Promise<Response>;
  demo: (body: unknown, user?: string | null) => Promise<Response>;
}

function setup(opts: { token?: () => string; fail?: Error } = {}): Harness {
  const store = new FakeSmsStore();
  store.countries.push(
    row('US', { sms_sender_id: US_SENDER }),
    row('TR', { sms_sender_id: 'SITELOG' }),
  );
  const base = {
    contactPref: 'link' as const,
    activatedAt: '2026-03-02T15:40:00Z',
    optedOutAt: null,
    createdAt: '2026-03-02T15:05:00Z',
  };
  store.reporters.push(
    {
      ...base,
      id: MARCO,
      orgId: KESTREL,
      status: 'active',
      phone: '+15550143378',
      locale: 'en-US',
      orgName: 'Kestrel Build Group',
      orgIsDemo: true,
      orgCountry: 'US',
    },
    {
      ...base,
      id: DANA,
      orgId: REAL_US,
      status: 'active',
      phone: '+15550145521',
      locale: 'en-US',
      orgName: 'Real Builders',
      orgIsDemo: false,
      orgCountry: 'US',
    },
    {
      ...base,
      id: EMRE,
      orgId: DEMIR,
      status: 'active',
      phone: '+905321234567',
      locale: 'tr-TR',
      orgName: 'Demir Yapı A.Ş.',
      orgIsDemo: true,
      orgCountry: 'TR',
    },
  );
  store.members.push(
    { userId: LENA, orgId: KESTREL, role: 'admin' },
    { userId: LENA, orgId: DEMIR, role: 'admin' },
    { userId: LENA, orgId: REAL_US, role: 'admin' },
    { userId: PM, orgId: KESTREL, role: 'pm' },
  );
  const messaging = fakeMessaging({ fail: opts.fail });
  let n = 0;
  const handle = createSmsWebhook({
    store,
    notifier: messaging.notifier,
    authToken: opts.token ?? (() => TOKEN),
    webhookUrl: () => BASE,
    linkSecret: () => SECRET,
    fieldAppUrl: () => 'https://go.sitelog.app',
    authUser: (req) => {
      const user = req.headers.get('authorization')?.replace(/^Bearer /, '');
      if (!user) return Promise.reject(new HttpError(401, 'Sign in required'));
      return Promise.resolve({ userId: user });
    },
    now: () => T0,
    randomUUID: () => `10000000-0000-4000-8000-${String(++n).padStart(12, '0')}`,
  });
  return {
    store,
    messaging,
    handle,
    async twilio(path, params, o = {}) {
      const url = `http://edge-runtime:8081/sms-webhook${path}`;
      const signature = o.sign ?? (await twilioSignature(`${BASE}${path}`, params, TOKEN));
      return handle(
        new Request(url, {
          method: 'POST',
          headers: {
            'content-type': 'application/x-www-form-urlencoded',
            'x-twilio-signature': signature,
          },
          body: new URLSearchParams(params).toString(),
        }),
      );
    },
    demo(body, user = LENA) {
      return handle(
        new Request(`${BASE}/demo-reply`, {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            ...(user ? { authorization: `Bearer ${user}` } : {}),
          },
          body: JSON.stringify(body),
        }),
      );
    },
  };
}

const sms = (from: string, body: string, extra: Record<string, string> = {}) => ({
  MessageSid: `SM${Math.random().toString(36).slice(2, 12)}`,
  AccountSid: 'AC1',
  From: from,
  To: US_SENDER,
  Body: body,
  NumMedia: '0',
  ...extra,
});

Deno.test('routes and the URLs a request may be signed for', () => {
  assertEquals(routeOf('/sms-webhook'), 'inbound');
  assertEquals(routeOf('/functions/v1/sms-webhook/inbound'), 'inbound');
  assertEquals(routeOf('/sms-webhook/status'), 'status');
  assertEquals(routeOf('/sms-webhook/demo-reply/'), 'demo-reply');
  assertEquals(routeOf('/sms-webhook/other'), null);
  const req = new Request('http://edge-runtime:8081/sms-webhook/status?x=1', { method: 'POST' });
  assertEquals(signedUrls(req, BASE), [`${BASE}/status?x=1`, req.url]);
});

Deno.test('an unsigned or wrongly signed request is refused and stores nothing', async () => {
  const h = setup();
  const bad = await h.twilio('', sms('+15550145521', 'STOP'), { sign: 'bm9wZQ==' });
  assertEquals(bad.status, 403);
  // Signed for another URL (a replay to a different endpoint).
  const params = sms('+15550145521', 'STOP');
  const other = await h.twilio('', params, {
    sign: await twilioSignature('https://evil.example/sms-webhook', params, TOKEN),
  });
  assertEquals(other.status, 403);
  assertEquals(h.store.inbound, []);
  assertEquals(h.store.reporters.find((r) => r.id === DANA)!.status, 'active');
});

Deno.test('without TWILIO_AUTH_TOKEN nothing is checked or stored: 500', async () => {
  const h = setup({
    token: () => {
      throw new EnvError('TWILIO_AUTH_TOKEN');
    },
  });
  const res = await h.twilio('', sms('+15550145521', 'STOP'));
  assertEquals(res.status, 500);
  assertEquals(h.store.inbound, []);
});

Deno.test(
  'STOP: the reporter opts out, the confirmation goes once, the reply TwiML is empty',
  async () => {
    const h = setup();
    const res = await h.twilio('', sms('+15550145521', ' stop. '));
    assertEquals(res.status, 200);
    assertEquals(res.headers.get('content-type'), 'text/xml; charset=utf-8');
    assertEquals(await res.text(), EMPTY_TWIML);
    assertEquals(h.store.reporters.find((r) => r.id === DANA)!.status, 'opted_out');
    const [inbound] = h.store.inbound;
    assertEquals(
      [inbound!.org_id, inbound!.reporter_id, inbound!.provider, inbound!.payload],
      [REAL_US, DANA, 'twilio', { to: US_SENDER, keyword: 'stop' }],
    );
    assert(inbound!.handled_at);
    const optOut = h.store.audits.find((a) => a.action === 'reporter.opted_out')!;
    assertEquals([optOut.actorType, optOut.actorId, optOut.orgId], ['reporter', DANA, REAL_US]);
    // The real org's pack has a sender: the reply goes through Twilio from it.
    assertEquals(h.messaging.sent, [
      {
        driver: 'twilio',
        to: '+15550145521',
        body: "You won't get more texts from SiteLog. Reply START to resume.",
        sender: US_SENDER,
      },
    ]);
    assertEquals(h.messaging.rows[0]!.copy_key, 'stop_confirm');
  },
);

Deno.test('START, CALL and TEXT: back in, and the report mode switches', async () => {
  const h = setup();
  await h.twilio('', sms('+15550145521', 'STOP'));
  await h.twilio('', sms('+15550145521', 'Start'));
  assertEquals(h.store.reporters.find((r) => r.id === DANA)!.status, 'active');
  await h.twilio('', sms('+15550145521', 'CALL'));
  assertEquals(h.store.reporters.find((r) => r.id === DANA)!.contactPref, 'call');
  await h.twilio('', sms('+15550145521', 'text'));
  assertEquals(h.store.reporters.find((r) => r.id === DANA)!.contactPref, 'link');
  // Only the STOP confirmation was texted (§9.2 has no START, CALL or TEXT reply).
  assertEquals(
    h.messaging.rows.map((r) => r.copy_key),
    ['stop_confirm'],
  );
  assertEquals(
    h.store.audits
      .filter((a) => a.actorType === 'reporter' && a.action.startsWith('reporter.'))
      .map((a) => a.action),
    [
      'reporter.opted_out',
      'reporter.opted_in',
      'reporter.preferences_changed',
      'reporter.preferences_changed',
    ],
  );
});

Deno.test(
  "HELP: the help text with the reporter's personal link, masked in a real org's log",
  async () => {
    const h = setup();
    await h.twilio('', sms('+15550145521', 'HELP'));
    const link = h.store.links.links[0]!;
    const code = await deriveLinkCode(SECRET, link.id);
    assertEquals(link.code_hash, linkCodeHash(code));
    assertEquals(
      h.messaging.sent[0]!.body,
      `SiteLog daily reports for Real Builders. Your link: https://go.sitelog.app/r/${code} · Text CALL or TEXT to switch · STOP to opt out. Msg & data rates may apply.`,
    );
    assertMatch(h.messaging.rows[0]!.body, new RegExp(`/r/${MASKED_CODE} `));
    // The same link the next time.
    await h.twilio('', sms('+15550145521', 'help'));
    assertEquals(h.store.links.links.length, 1);
    assertEquals(h.messaging.sent[1]!.body, h.messaging.sent[0]!.body);
  },
);

Deno.test('a redelivered text runs once; a text that failed halfway runs again', async () => {
  const h = setup();
  const params = sms('+15550145521', 'STOP');
  await h.twilio('', params);
  await h.twilio('', params);
  assertEquals(h.store.inbound.length, 1);
  assertEquals(h.messaging.sent.length, 1);

  const crash = setup();
  crash.store.failMarkOnce = true;
  const p2 = sms('+15550145521', 'HELP');
  assertEquals((await crash.twilio('', p2)).status, 500);
  assertEquals((await crash.twilio('', p2)).status, 200);
  assertEquals(crash.store.inbound.length, 1);
  assert(crash.store.inbound[0]!.handled_at);
});

Deno.test('F13: an unknown number gets the auto-reply and an unknown contact, once', async () => {
  const h = setup();
  await h.twilio('', sms('+15550194410', 'Hi, this is Carlos from Apex'));
  assertEquals(h.store.unknown.length, 1);
  assertEquals(h.store.unknown[0]!.snippet, 'Hi, this is Carlos from Apex');
  assertEquals(h.store.inbound[0]!.org_id, null);
  assertEquals(h.messaging.rows[0]!.copy_key, 'unknown_number');
  assertEquals(h.messaging.rows[0]!.org_id, null);
  await h.twilio('', sms('+15550194410', 'hello?'));
  assertEquals(h.store.unknown.length, 1);
  assertEquals(h.messaging.rows.length, 1);
  assert(h.store.audits.some((a) => a.action === 'unknown_contact.created'));
});

Deno.test('a one-way pack stores the text and runs no keyword (the TR pack)', async () => {
  const h = setup();
  await h.twilio('', { ...sms('+905321234567', 'STOP'), To: 'SITELOG' });
  assertEquals(h.store.inbound.length, 1);
  assertEquals(h.store.inbound[0]!.payload.keyword, null);
  assertEquals(h.store.reporters.find((r) => r.id === EMRE)!.status, 'active');
  assertEquals(h.messaging.rows, []);
  assertEquals(h.store.unknown, []);
});

Deno.test('a text to a sender no pack has is acknowledged and dropped', async () => {
  const h = setup();
  const res = await h.twilio('', { ...sms('+15550145521', 'STOP'), To: '+18005550000' });
  assertEquals(res.status, 200);
  assertEquals(h.store.inbound, []);
});

Deno.test(
  'a reply Twilio refuses for good is recorded; the text still counts as handled',
  async () => {
    const h = setup({
      fail: new SmsSendError('twilio 400 21610', {
        driver: 'twilio',
        retryable: false,
        undeliverable: true,
        code: '21610',
      }),
    });
    const res = await h.twilio('', sms('+15550145521', 'STOP'));
    assertEquals(res.status, 200);
    assertEquals(h.messaging.rows[0]!.status, 'undeliverable');
    assert(h.store.inbound[0]!.handled_at);
  },
);

Deno.test('status callbacks move a message forward only', async () => {
  const h = setup();
  h.store.outbound.push({
    id: 'm1',
    provider_message_id: 'SMout1',
    status: 'sent',
    org_id: REAL_US,
    error: null,
  });
  const cb = (status: string, extra: Record<string, string> = {}) =>
    h.twilio('/status', { MessageSid: 'SMout1', MessageStatus: status, ...extra });
  assertEquals((await cb('delivered')).status, 200);
  assertEquals(h.store.outbound[0]!.status, 'delivered');
  await cb('sent');
  await cb('undelivered', { ErrorCode: '30005' });
  assertEquals(h.store.outbound[0]!.status, 'delivered');
  assertEquals(h.store.audits.filter((a) => a.action === 'sms.status').length, 1);
  h.store.outbound[0]!.status = 'sent';
  await cb('undelivered', { ErrorCode: '30005' });
  assertEquals(
    [h.store.outbound[0]!.status, h.store.outbound[0]!.error],
    ['undeliverable', 'twilio 30005'],
  );
  assertEquals(
    (await h.twilio('/status', { MessageSid: 'SMnope', MessageStatus: 'delivered' })).status,
    200,
  );
  assertEquals(
    (await h.twilio('/status', { MessageSid: 'SMout1', MessageStatus: 'delivered' }, { sign: 'x' }))
      .status,
    403,
  );
});

Deno.test('Demo phone: an admin of a demo org replies as the reporter, console only', async () => {
  const h = setup();
  const res = await h.demo({ reporterId: MARCO, body: 'HELP' });
  assertEquals(res.status, 201);
  const out = (await res.json()) as { keyword: string; replyId: string };
  assertEquals(out.keyword, 'help');
  assertEquals(h.store.inbound[0]!.provider, 'console');
  assertMatch(h.store.inbound[0]!.provider_message_id, /^console:/);
  // A demo org: the reply goes through console and keeps its link (the Demo phone opens it).
  assertEquals(h.messaging.sent[0]!.driver, 'console');
  assertMatch(h.messaging.rows[0]!.body, /https:\/\/go\.sitelog\.app\/r\/[A-Z0-9]{6} /);
});

Deno.test(
  'Demo phone: refused without a session, for non-admins, real orgs and one-way packs',
  async () => {
    const h = setup();
    assertEquals((await h.demo({ reporterId: MARCO, body: 'hi' }, null)).status, 401);
    assertEquals((await h.demo({ reporterId: MARCO, body: 'hi' }, PM)).status, 403);
    assertEquals((await h.demo({ reporterId: DANA, body: 'STOP' })).status, 403);
    const oneWay = await h.demo({ reporterId: EMRE, body: 'merhaba' });
    assertEquals(oneWay.status, 409);
    assertEquals((await h.demo({ reporterId: MARCO, body: '' })).status, 400);
    assertEquals(h.store.inbound, []);
    assertEquals(h.store.reporters.find((r) => r.id === DANA)!.status, 'active');
  },
);
