import { assert, assertEquals, assertMatch } from '@std/assert';
import {
  EMPTY_TWIML,
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

/**
 * sms-webhook (W1-08): signature, store → enqueue → ack on the Twilio route, status callbacks with
 * the welcome failure, and the Demo phone's replies (inline, inside the caller's org). The keyword
 * handling itself is `processInboundSms` (packages/shared/src/sms/inbound.test.ts), run by the
 * worker's `sms_inbound` job for Twilio texts.
 */

const BASE = 'https://proj.supabase.co/functions/v1/sms-webhook';
const TOKEN = 'twilio-auth-token';
const SECRET = 'link-signing-secret';
const US_SENDER = '+18885550142';
/** The TR pack's long code since §19 Q370 (Twilio). */
const TR_SENDER = '+18885550199';
const T0 = new Date('2026-10-09T23:00:00Z');

const row = (code: 'US' | 'TR', patch: Partial<CountryRow>) => ({
  ...DEMO_COUNTRIES.find((c) => c.code === code)!,
  ...patch,
});

const KESTREL = '00000000-0000-4000-8000-0000000000a1';
const REAL_US = '00000000-0000-4000-8000-0000000000a2';
const DEMIR = '00000000-0000-4000-8000-0000000000a3';
const OTHER_DEMO = '00000000-0000-4000-8000-0000000000a4';
const MARCO = '00000000-0000-4000-8000-0000000000c1';
const DANA = '00000000-0000-4000-8000-0000000000c2';
const EMRE = '00000000-0000-4000-8000-0000000000c3';
const MARCO_TWIN = '00000000-0000-4000-8000-0000000000c4';
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
    row('TR', { sms_sender_id: TR_SENDER }),
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
      name: 'Marco Ruiz',
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
      id: MARCO_TWIN,
      name: 'Marco Ruiz',
      orgId: OTHER_DEMO,
      status: 'active',
      phone: '+15550143378',
      locale: 'en-US',
      orgName: 'Other Demo Co',
      orgIsDemo: true,
      orgCountry: 'US',
      createdAt: '2026-04-01T00:00:00Z',
    },
    {
      ...base,
      id: DANA,
      name: 'Dana Whitfield',
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
      name: 'Emre Kaya',
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
    fieldAppUrl: () => 'https://go.talkolog.com',
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
  assertEquals(h.store.jobs, []);
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
  'a Twilio text is stored, audited and handed to the worker; the ack is empty TwiML',
  async () => {
    const h = setup();
    const params = sms('+15550145521', ' stop. ', { OptOutType: 'STOP' });
    const res = await h.twilio('', params);
    assertEquals(res.status, 200);
    assertEquals(res.headers.get('content-type'), 'text/xml; charset=utf-8');
    assertEquals(await res.text(), EMPTY_TWIML);
    const [inbound] = h.store.inbound;
    assertEquals(
      [inbound!.org_id, inbound!.reporter_id, inbound!.provider, inbound!.payload],
      [
        REAL_US,
        DANA,
        'twilio',
        { to: US_SENDER, keyword: 'stop', pack: 'US', opt_out_type: 'STOP' },
      ],
    );
    assertEquals(inbound!.handled_at, undefined);
    assertEquals(h.store.jobs, [
      { id: 1, messageId: inbound!.id, dedupeKey: `sms_inbound:${params.MessageSid}` },
    ]);
    const received = h.store.audits.find((a) => a.action === 'sms.received')!;
    assertEquals(
      [received.actorType, received.actorId, received.orgId],
      ['reporter', DANA, REAL_US],
    );
    // The worker's job does the rest: nothing changed and nothing was sent here.
    assertEquals(h.store.reporters.find((r) => r.id === DANA)!.status, 'active');
    assertEquals(h.messaging.sent, []);
    assertEquals(h.store.phoneOptOuts.size, 0);
  },
);

Deno.test(
  'a redelivery joins the job of a text not yet handled; a handled text runs nothing',
  async () => {
    const h = setup();
    const params = sms('+15550145521', 'HELP');
    await h.twilio('', params);
    await h.twilio('', params);
    assertEquals(h.store.inbound.length, 1);
    assertEquals(h.store.jobs.length, 1);
    assertEquals(h.store.audits.filter((a) => a.action === 'sms.received').length, 1);
    // The worker handled it (handled_at set): a late redelivery enqueues nothing more.
    h.store.inbound[0]!.handled_at = T0.toISOString();
    h.store.jobs.length = 0;
    assertEquals((await h.twilio('', params)).status, 200);
    assertEquals(h.store.jobs, []);
  },
);

Deno.test('a text from a number nobody knows is stored with no org, for the worker', async () => {
  const h = setup();
  await h.twilio('', sms('+15550194410', 'Hi, this is Carlos from Apex'));
  assertEquals(h.store.inbound[0]!.org_id, null);
  assertEquals(h.store.inbound[0]!.reporter_id, null);
  assertEquals(h.store.audits[0]!.actorType, 'system');
  assertEquals(h.store.jobs.length, 1);
  assertEquals(h.store.unknown, []);
});

Deno.test(
  "a real sender's text is filed under the real org, never a demo org's reporter",
  async () => {
    // Marco's number is a reporter in two demo orgs; a text to the real US sender is not his.
    const h = setup();
    await h.twilio('', sms('+15550143378', 'HELP'));
    assertEquals([h.store.inbound[0]!.org_id, h.store.inbound[0]!.reporter_id], [null, null]);
  },
);

Deno.test('a one-way pack stores the text with no keyword (the TR pack)', async () => {
  const h = setup();
  await h.twilio('', { ...sms('+905321234567', 'STOP'), To: TR_SENDER });
  assertEquals(h.store.inbound.length, 1);
  assertEquals(h.store.inbound[0]!.payload.keyword, null);
  assertEquals(h.store.inbound[0]!.payload.pack, 'TR');
  assertEquals(h.store.jobs.length, 1);
});

Deno.test('a text to a sender no pack has is acknowledged and dropped', async () => {
  const h = setup();
  const res = await h.twilio('', { ...sms('+15550145521', 'STOP'), To: '+18005550000' });
  assertEquals(res.status, 200);
  assertEquals(h.store.inbound, []);
  assertEquals(h.store.jobs, []);
});

Deno.test(
  'one sender for several packs: the last text, the reporters, the country, the sender (§19 Q370)',
  async () => {
    const h = setup();
    h.store.countries.find((c) => c.code === 'TR')!.sms_sender_id = US_SENDER;
    const packOf = async (from: string) => {
      await h.twilio('', sms(from, 'Hello'));
      return h.store.inbound.at(-1)!.payload.pack;
    };
    // An unknown Turkish number: its own country. A Greek one: the sender's (US).
    assertEquals(await packOf('+905329876543'), 'TR');
    assertEquals(await packOf('+306912345678'), 'US');
    // Dana is a reporter of a real US org.
    assertEquals(await packOf('+15550145521'), 'US');
    // The last text to Dana went from a TR org: her reply is that pack's.
    h.store.lastOutbound.set('+15550145521|sms', 'TR');
    assertEquals(await packOf('+15550145521'), 'TR');
  },
);

Deno.test('a WhatsApp sender shared by two packs picks the pack the same way', async () => {
  const h = setup();
  for (const c of h.store.countries) c.whatsapp_sender_id = '+17752628262';
  const message = (from: string) => ({
    MessageSid: `SM${Math.random().toString(36).slice(2, 12)}`,
    AccountSid: 'AC1',
    From: `whatsapp:${from}`,
    To: 'whatsapp:+17752628262',
    Body: 'Merhaba',
    NumMedia: '0',
  });
  await h.twilio('', message('+905329876543'));
  assertEquals(h.store.inbound.at(-1)!.payload.pack, 'TR');
  h.store.lastOutbound.set('+905329876543|whatsapp', 'US');
  await h.twilio('', message('+905329876543'));
  assertEquals(h.store.inbound.at(-1)!.payload.pack, 'US');
});

Deno.test('status callbacks move a message forward only', async () => {
  const h = setup();
  h.store.outbound.push({
    id: 'm1',
    provider_message_id: 'SMout1',
    status: 'sent',
    org_id: REAL_US,
    reporter_id: DANA,
    copy_key: 'daily_link',
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
  // Not a welcome: the reporter is not flagged.
  assertEquals(h.store.notifications, []);
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

Deno.test(
  'W2-15: WhatsApp status callbacks reach read; a late failure falls back with no account notice',
  async () => {
    const h = setup();
    const sentBy = {
      reporterId: DANA,
      key: 'daily_link' as const,
      vars: { site: 'Pier 9', link: 'https://go.talkolog.com/r/AAAAAA' },
      dedupeKey: 'notify:daily:x',
    };
    h.store.notifyJobs.push({ id: 1, payload: sentBy, dedupeKey: sentBy.dedupeKey });
    h.store.outbound.push(
      {
        id: 'wa1',
        provider_message_id: 'SMwa1',
        status: 'sent',
        org_id: REAL_US,
        reporter_id: DANA,
        copy_key: 'daily_link',
        error: null,
        channel: 'whatsapp',
      },
      {
        id: 'wa2',
        provider_message_id: 'SMwa2',
        status: 'sent',
        org_id: REAL_US,
        reporter_id: DANA,
        copy_key: 'daily_link',
        error: null,
        channel: 'whatsapp',
        payload: { dedupe_key: 'notify:daily:x', attempt: 1 },
      },
    );
    await h.twilio('/status', { MessageSid: 'SMwa1', MessageStatus: 'delivered' });
    await h.twilio('/status', { MessageSid: 'SMwa1', MessageStatus: 'read' });
    assertEquals(h.store.outbound[0]!.status, 'read');
    assertEquals(
      h.store.audits.filter((a) => a.action === 'whatsapp.status').map((a) => a.diff),
      [
        { from: 'sent', to: 'delivered', error_code: null },
        { from: 'delivered', to: 'read', error_code: null },
      ],
    );
    // 63016 (outside the window) or `failed`: the next channel, never the texts-account notice.
    await h.twilio('/status', {
      MessageSid: 'SMwa2',
      MessageStatus: 'failed',
      ErrorCode: '63016',
    });
    assertEquals(h.store.outbound[1]!.status, 'failed');
    assertEquals(h.store.notifications, []);
    assertEquals(h.store.audits.filter((a) => a.action === 'sms.provider_fault').length, 0);
    assertEquals(h.store.notifyJobs.at(-1)!.dedupeKey, 'notify:daily:x:after:wa2');
  },
);

Deno.test('a late failure of a notify message queues its fallback once (W2-01, Q22)', async () => {
  const h = setup();
  const FILED = '00000000-0000-4000-8000-0000000000f1';
  const sentBy = {
    reporterId: DANA,
    key: 'filed' as const,
    vars: { report_no: 'RL-2041-0199', pdf_link: 'https://go.talkolog.com/r/AAAAAA/report/1' },
    dedupeKey: 'notify:filed:r9',
  };
  h.store.notifyJobs.push({ id: 1, payload: sentBy, dedupeKey: sentBy.dedupeKey });
  h.store.outbound.push({
    id: FILED,
    provider_message_id: 'SMfiled',
    status: 'sent',
    org_id: REAL_US,
    reporter_id: DANA,
    copy_key: 'filed',
    error: null,
    payload: { dedupe_key: 'notify:filed:r9', attempt: 1 },
  });
  const cb = () =>
    h.twilio('/status', {
      MessageSid: 'SMfiled',
      MessageStatus: 'undelivered',
      ErrorCode: '30005',
    });
  assertEquals((await cb()).status, 200);
  await cb();
  assertEquals(h.store.notifyJobs.length, 2);
  assertEquals(h.store.notifyJobs[1], {
    id: 101,
    payload: { ...sentBy, afterMessageId: FILED },
    dedupeKey: `notify:filed:r9:after:${FILED}`,
  });
  const queued = h.store.audits.filter((a) => a.action === 'notify.fallback_queued');
  assertEquals(queued.length, 1);
  assertEquals(
    [queued[0]!.entityId, queued[0]!.diff],
    [
      FILED,
      { copy_key: 'filed', dedupe_key: 'notify:filed:r9', status: 'undeliverable', job_id: 101 },
    ],
  );

  // A message no notify job sent (an inline text) and a delivery queue nothing.
  h.store.outbound.push({
    id: 'inline1',
    provider_message_id: 'SMinline',
    status: 'sent',
    org_id: REAL_US,
    reporter_id: DANA,
    copy_key: 'draft_ready',
    error: null,
    payload: { dedupe_key: 'notify:draft_ready:x:1', attempt: 1 },
  });
  await h.twilio('/status', { MessageSid: 'SMinline', MessageStatus: 'failed' });
  await h.twilio('/status', { MessageSid: 'SMfiled', MessageStatus: 'delivered' });
  assertEquals(h.store.notifyJobs.length, 2);
});

Deno.test(
  'a late account fault on a notify message: one account notice an hour, its fallback still queued (W2-01)',
  async () => {
    const h = setup();
    const filed = (n: number) => {
      const sentBy = {
        reporterId: DANA,
        key: 'filed' as const,
        vars: {
          report_no: `RL-2041-01${n}`,
          pdf_link: 'https://go.talkolog.com/r/AAAAAA/report/1',
        },
        dedupeKey: `notify:filed:acct${n}`,
      };
      h.store.notifyJobs.push({ id: n, payload: sentBy, dedupeKey: sentBy.dedupeKey });
      h.store.outbound.push({
        id: `f${n}`,
        provider_message_id: `SMacctf${n}`,
        status: 'sent',
        org_id: REAL_US,
        reporter_id: DANA,
        copy_key: 'filed',
        error: null,
        payload: { dedupe_key: sentBy.dedupeKey, attempt: 1 },
      });
    };
    filed(1);
    filed(2);
    filed(3);
    await h.twilio('/status', {
      MessageSid: 'SMacctf1',
      MessageStatus: 'undelivered',
      ErrorCode: '30032',
    });
    await h.twilio('/status', { MessageSid: 'SMacctf2', MessageStatus: 'failed' });
    await h.twilio('/status', {
      MessageSid: 'SMacctf3',
      MessageStatus: 'undelivered',
      ErrorCode: '30034',
    });
    // One notice for the account, never one per text, and never about the number.
    assertEquals(h.store.notifications.length, 1);
    const notice = h.store.notifications[0]!;
    assertEquals(notice.kind, 'message_failed');
    assertEquals(notice.data, {
      key: 'message_account_fault',
      params: { name: 'Dana Whitfield', error: 'twilio 30032' },
    });
    assertMatch(notice.body, /^Texts are failing for this account \(twilio 30032\)/);
    assertEquals(
      h.store.audits
        .filter((a) => a.action === 'sms.provider_fault')
        .map((a) => [a.entityId, a.diff.copy_key, a.diff.notified]),
      [
        ['f1', 'filed', true],
        ['f2', 'filed', false],
        ['f3', 'filed', false],
      ],
    );
    // The reporter is never flagged; each message may still reach them on another channel.
    assertEquals(h.store.reporters.find((r) => r.id === DANA)!.lastInviteError ?? null, null);
    assertEquals(
      h.store.notifyJobs.slice(3).map((j) => j.dedupeKey),
      [1, 2, 3].map((n) => `notify:filed:acct${n}:after:f${n}`),
    );
  },
);

Deno.test('a late failure for the number on a notify message posts no account notice', async () => {
  const h = setup();
  h.store.outbound.push({
    id: 'n1',
    provider_message_id: 'SMnum1',
    status: 'sent',
    org_id: REAL_US,
    reporter_id: DANA,
    copy_key: 'filed',
    error: null,
    payload: { dedupe_key: 'notify:filed:num1', attempt: 1 },
  });
  await h.twilio('/status', {
    MessageSid: 'SMnum1',
    MessageStatus: 'undelivered',
    ErrorCode: '30006',
  });
  assertEquals(h.store.notifications, []);
  assertEquals(
    h.store.audits.filter((a) => a.action === 'sms.provider_fault'),
    [],
  );
});

Deno.test(
  'a welcome the carrier cannot deliver flags the reporter: Team\'s "Can\'t reach this number", the office notice, the audit',
  async () => {
    const h = setup();
    const dana = h.store.reporters.find((r) => r.id === DANA)!;
    dana.status = 'invited';
    h.store.outbound.push({
      id: 'w1',
      provider_message_id: 'SMwelcome',
      status: 'sent',
      org_id: REAL_US,
      reporter_id: DANA,
      copy_key: 'welcome',
      error: null,
    });
    await h.twilio('/status', {
      MessageSid: 'SMwelcome',
      MessageStatus: 'undelivered',
      ErrorCode: '30006',
    });
    assertEquals(dana.lastInviteError, 'twilio 30006');
    assertEquals(h.store.notifications.length, 1);
    assertEquals(h.store.notifications[0], {
      orgId: REAL_US,
      kind: 'reporter_invite_failed',
      title: 'Dana Whitfield: the welcome text could not be delivered',
      body: h.store.notifications[0]!.body,
      targetPath: '/team',
      // The panel renders it in the reader's language from this (20261015000080).
      data: {
        key: 'welcome_carrier_undelivered',
        params: { name: 'Dana Whitfield', error: 'twilio 30006' },
      },
    });
    assertMatch(h.store.notifications[0]!.body, /twilio 30006/);
    assertMatch(h.store.notifications[0]!.body, /landline/);
    const failed = h.store.audits.find((a) => a.action === 'reporter.invite_failed')!;
    assertEquals([failed.orgId, failed.entityId], [REAL_US, DANA]);
    assertEquals(failed.diff, {
      error: 'twilio 30006',
      status: 'undeliverable',
      message_id: 'w1',
      via: 'status_callback',
    });

    // `failed`: it never left the account. The office hears about the account; the number is
    // not blamed and Team's "Can't reach this number" keeps what it had.
    h.store.outbound.push({
      id: 'w2',
      provider_message_id: 'SMwelcome2',
      status: 'sent',
      org_id: REAL_US,
      reporter_id: DANA,
      copy_key: 'welcome',
      error: null,
    });
    await h.twilio('/status', { MessageSid: 'SMwelcome2', MessageStatus: 'failed' });
    assertEquals(dana.lastInviteError, 'twilio 30006');
    assertEquals(
      h.store.notifications[1]!.title,
      'Dana Whitfield: the welcome text failed at the SMS provider',
    );
    assertMatch(
      h.store.notifications[1]!.body,
      /^Texts are failing for this account \(twilio failed\)/,
    );
    assertEquals(h.store.notifications[1]!.data, {
      key: 'welcome_account_fault',
      params: { name: 'Dana Whitfield', error: 'twilio failed' },
    });
    assertEquals(h.store.audits.filter((a) => a.action === 'reporter.invite_failed').length, 1);
    dana.status = 'active';
    h.store.outbound.push({
      id: 'w3',
      provider_message_id: 'SMwelcome3',
      status: 'sent',
      org_id: REAL_US,
      reporter_id: DANA,
      copy_key: 'welcome',
      error: null,
    });
    await h.twilio('/status', {
      MessageSid: 'SMwelcome3',
      MessageStatus: 'undelivered',
      ErrorCode: '30003',
    });
    assertEquals(h.store.notifications.length, 2);
  },
);

Deno.test(
  'Demo phone: an admin of a demo org replies as the reporter, console only, at once',
  async () => {
    const h = setup();
    const res = await h.demo({ reporterId: MARCO, body: 'HELP' });
    assertEquals(res.status, 201);
    const out = (await res.json()) as { keyword: string; replyId: string; messageId: string };
    assertEquals(out.keyword, 'help');
    assertEquals(h.store.inbound[0]!.provider, 'console');
    assertMatch(h.store.inbound[0]!.provider_message_id, /^console:/);
    assertEquals(h.store.inbound[0]!.org_id, KESTREL);
    assert(h.store.inbound[0]!.handled_at);
    // No worker job: the Demo phone's reply is handled inline.
    assertEquals(h.store.jobs, []);
    // A demo org: the reply goes through console and keeps its link (the Demo phone opens it).
    assertEquals(h.messaging.sent[0]!.driver, 'console');
    assertMatch(h.messaging.rows[0]!.body, /https:\/\/go\.talkolog\.com\/r\/[A-Z0-9]{12} /);
    const link = h.store.links.links[0]!;
    const code = await deriveLinkCode(SECRET, link.id);
    assertEquals(link.code_hash, linkCodeHash(code));
    assertEquals(h.messaging.rows[0]!.id, out.replyId);
  },
);

Deno.test(
  'Demo phone: OK, NO WORK, WEATHER and EDIT go to the worker (sms_keyword), with no reply here (W2-12)',
  async () => {
    const h = setup();
    for (const body of ['OK', 'no work', 'WEATHER', 'EDIT FRI Apex was 7 not 6']) {
      const res = await h.demo({ reporterId: MARCO, body });
      assertEquals(res.status, 201);
      const out = (await res.json()) as { replyId: string | null };
      assertEquals(out.replyId, null);
    }
    assertEquals(
      h.store.inbound.map((m) => m.payload.keyword),
      ['ok', 'no_work', 'weather', 'edit'],
    );
    assertEquals(
      h.store.keywordJobs,
      h.store.inbound.map((m) => m.id),
    );
    assert(h.store.inbound.every((m) => m.handled_at));
    assertEquals(h.messaging.sent, []);
    // An opted-out phone's keyword is stored and nothing more.
    h.store.reporters.find((r) => r.id === MARCO)!.status = 'opted_out';
    await h.demo({ reporterId: MARCO, body: 'WEATHER' });
    assertEquals(h.store.keywordJobs.length, 4);
  },
);

Deno.test(
  'a Twilio report keyword is stored with its keyword, for the worker (W2-12)',
  async () => {
    const h = setup();
    await h.twilio('', sms('+15550145521', 'EDIT FRI Apex was 7 not 6'));
    assertEquals(h.store.inbound[0]!.payload.keyword, 'edit');
    assertEquals(h.store.jobs.length, 1);
    // The sms_inbound job queues sms_keyword in the worker; nothing is sent here.
    assertEquals(h.store.keywordJobs, []);
    assertEquals(h.messaging.sent, []);
  },
);

Deno.test(
  'Demo phone: STOP opts the reporter out, tells the office, and never records the phone',
  async () => {
    const h = setup();
    await h.demo({ reporterId: MARCO, body: 'STOP' });
    assertEquals(h.store.reporters.find((r) => r.id === MARCO)!.status, 'opted_out');
    assertEquals(
      h.store.notifications.map((n) => [n.kind, n.orgId]),
      [['reporter_opted_out', KESTREL]],
    );
    assertEquals(h.store.phoneOptOuts.size, 0);
    assertEquals(h.messaging.rows[0]!.copy_key, 'stop_confirm');
    const optOut = h.store.audits.find((a) => a.action === 'reporter.opted_out')!;
    assertEquals([optOut.actorType, optOut.actorId, optOut.orgId], ['reporter', MARCO, KESTREL]);
  },
);

Deno.test(
  "Demo phone: a reply acts inside the caller's org only, never on another demo org's reporter",
  async () => {
    // The same phone is Marco in Kestrel and in another demo org; Lena is an admin of Kestrel only.
    const h = setup();
    await h.demo({ reporterId: MARCO, body: 'STOP' });
    assertEquals(h.store.reporters.find((r) => r.id === MARCO)!.status, 'opted_out');
    assertEquals(h.store.reporters.find((r) => r.id === MARCO_TWIN)!.status, 'active');
    assertEquals(h.store.inbound[0]!.org_id, KESTREL);
    assertEquals(h.store.notifications.length, 1);
  },
);

Deno.test(
  'Demo phone: a reply Twilio-style refused for good is recorded; the text still counts as handled',
  async () => {
    const h = setup({
      fail: new SmsSendError('twilio 400 21610', {
        driver: 'twilio',
        retryable: false,
        undeliverable: true,
        code: '21610',
      }),
    });
    const res = await h.demo({ reporterId: MARCO, body: 'STOP' });
    assertEquals(res.status, 201);
    assertEquals(h.messaging.rows[0]!.status, 'undeliverable');
    assert(h.store.inbound[0]!.handled_at);
  },
);

Deno.test(
  'Demo phone: a crash before the handled mark is a 500 and runs again next time',
  async () => {
    const h = setup();
    h.store.failMarkOnce = true;
    assertEquals((await h.demo({ reporterId: MARCO, body: 'HELP' })).status, 500);
    assertEquals((await h.demo({ reporterId: MARCO, body: 'HELP' })).status, 201);
    assertEquals(h.store.links.links.length, 1);
    assert(h.store.inbound[1]!.handled_at);
  },
);

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

Deno.test(
  'a welcome refused later for the account (Twilio 30032, unverified toll-free sender) never blames the number',
  async () => {
    const h = setup();
    const dana = h.store.reporters.find((r) => r.id === DANA)!;
    dana.status = 'invited';
    const welcome = (n: number) =>
      h.store.outbound.push({
        id: `w${n}`,
        provider_message_id: `SMacct${n}`,
        status: 'sent',
        org_id: REAL_US,
        reporter_id: DANA,
        copy_key: 'welcome',
        error: null,
      });
    welcome(1);
    await h.twilio('/status', {
      MessageSid: 'SMacct1',
      MessageStatus: 'undelivered',
      ErrorCode: '30032',
    });
    assertEquals(dana.lastInviteError ?? null, null);
    assertEquals(h.store.outbound[0]!.status, 'undeliverable');
    assertEquals(h.store.notifications.length, 1);
    assertEquals(h.store.notifications[0]!.kind, 'reporter_invite_failed');
    assertMatch(
      h.store.notifications[0]!.body,
      /^Texts are failing for this account \(twilio 30032\)/,
    );
    assert(!/landline/.test(h.store.notifications[0]!.body));
    const fault = h.store.audits.find((a) => a.action === 'sms.provider_fault')!;
    assertEquals([fault.orgId, fault.entity, fault.entityId], [REAL_US, 'message', 'w1']);
    assertEquals(fault.diff.code, '30032');
    assertEquals(fault.diff.notified, true);
    assertEquals(
      h.store.audits.filter((a) => a.action === 'reporter.invite_failed'),
      [],
    );

    // The next one within the hour is audited, not notified again (one per failed text otherwise).
    welcome(2);
    await h.twilio('/status', {
      MessageSid: 'SMacct2',
      MessageStatus: 'undelivered',
      ErrorCode: '30034',
    });
    assertEquals(h.store.notifications.length, 1);
    const faults = h.store.audits.filter((a) => a.action === 'sms.provider_fault');
    assertEquals(
      faults.map((a) => [a.diff.code, a.diff.notified]),
      [
        ['30032', true],
        ['30034', false],
      ],
    );
    assertEquals(dana.lastInviteError ?? null, null);
  },
);

Deno.test(
  'an account notice send_welcome gave this hour is enough; an older one is not',
  async () => {
    const h = setup();
    h.store.outbound.push(
      {
        id: 'w1',
        provider_message_id: 'SMold1',
        status: 'sent',
        org_id: REAL_US,
        reporter_id: DANA,
        copy_key: 'welcome',
        error: null,
      },
      {
        id: 'w2',
        provider_message_id: 'SMold2',
        status: 'sent',
        org_id: REAL_US,
        reporter_id: DANA,
        copy_key: 'welcome',
        error: null,
      },
    );
    h.store.priorFaultNotices.push({ orgId: REAL_US, at: '2026-10-09T22:30:00.000Z' });
    await h.twilio('/status', {
      MessageSid: 'SMold1',
      MessageStatus: 'failed',
      ErrorCode: '30002',
    });
    assertEquals(h.store.notifications, []);
    h.store.priorFaultNotices.length = 0;
    h.store.priorFaultNotices.push({ orgId: REAL_US, at: '2026-10-09T21:59:59.000Z' });
    h.store.audits.length = 0;
    await h.twilio('/status', {
      MessageSid: 'SMold2',
      MessageStatus: 'failed',
      ErrorCode: '30002',
    });
    assertEquals(h.store.notifications.length, 1);
    assertMatch(h.store.notifications[0]!.body, /\(twilio 30002\)/);
  },
);

// ── W2-16: inbound WhatsApp (spec §9.5, §19 Q26, Q40, Q85; GAP D49 (2)) ──────────────────────────

const TR_WA_SENDER = '+905320000099';

/** A Twilio WhatsApp form: `whatsapp:` addresses on the same webhook. */
const wa = (from: string, body: string, extra: Record<string, string> = {}) => ({
  MessageSid: `SM${Math.random().toString(36).slice(2, 12)}`,
  AccountSid: 'AC1',
  From: `whatsapp:${from}`,
  To: `whatsapp:${TR_WA_SENDER}`,
  Body: body,
  NumMedia: '0',
  ...extra,
});

function setupWa(): Harness {
  const h = setup();
  h.store.countries.find((c) => c.code === 'TR')!.whatsapp_sender_id = TR_WA_SENDER;
  // Emre's org is a real one here: a WhatsApp message to the real sender reaches it.
  h.store.reporters.find((r) => r.id === EMRE)!.orgIsDemo = false;
  return h;
}

Deno.test(
  'W2-16: a Twilio WhatsApp message is stored with its channel, keyword on a one-way pack, for the worker',
  async () => {
    const h = setupWa();
    const params = wa('+905321234567', 'HELP');
    const res = await h.twilio('', params);
    assertEquals([res.status, await res.text()], [200, EMPTY_TWIML]);
    const [inbound] = h.store.inbound;
    assertEquals(
      [inbound!.channel, inbound!.provider, inbound!.phone_e164, inbound!.reporter_id],
      ['whatsapp', 'twilio', '+905321234567', EMRE],
    );
    // TR SMS is one-way; WhatsApp is two-way on every pack (§19 Q26).
    assertEquals(inbound!.payload, {
      to: TR_WA_SENDER,
      keyword: 'help',
      pack: 'TR',
      opt_out_type: null,
      num_media: 0,
      media: [],
    });
    assertEquals(h.store.jobs, [
      { id: 1, messageId: inbound!.id, dedupeKey: `sms_inbound:${params.MessageSid}` },
    ]);
    assertEquals(h.store.audits.filter((a) => a.action === 'whatsapp.received').length, 1);
    // A redelivery joins the job; nothing is sent here.
    await h.twilio('', params);
    assertEquals([h.store.inbound.length, h.store.jobs.length], [1, 1]);
    assertEquals(h.messaging.waSent, []);
  },
);

Deno.test(
  'W2-16: a WhatsApp voice note keeps its media (stored, never transcribed, Q85)',
  async () => {
    const h = setupWa();
    await h.twilio(
      '',
      wa('+905321234567', '', {
        NumMedia: '1',
        MediaUrl0: 'https://api.twilio.com/2010-04-01/Accounts/AC1/Messages/MM1/Media/ME1',
        MediaContentType0: 'audio/ogg',
      }),
    );
    assertEquals(h.store.inbound[0]!.payload.num_media, 1);
    assertEquals(h.store.inbound[0]!.payload.media, [
      {
        url: 'https://api.twilio.com/2010-04-01/Accounts/AC1/Messages/MM1/Media/ME1',
        content_type: 'audio/ogg',
      },
    ]);
  },
);

Deno.test(
  'W2-16: a WhatsApp sender no pack has, or a wrong signature: nothing is stored',
  async () => {
    const h = setupWa();
    await h.twilio('', { ...wa('+905321234567', 'HELP'), To: 'whatsapp:+15550000000' });
    assertEquals((await h.twilio('', wa('+905321234567', 'HELP'), { sign: 'forged' })).status, 403);
    assertEquals(h.store.inbound, []);
  },
);

Deno.test(
  "W2-16: Demo phone's WhatsApp thread: a TR reporter's HELP is answered there in Turkish",
  async () => {
    const h = setup();
    const res = await h.demo({ reporterId: EMRE, body: 'HELP', channel: 'whatsapp' });
    assertEquals(res.status, 201);
    const out = (await res.json()) as { keyword: string; replyId: string };
    assertEquals(out.keyword, 'help');
    assertEquals(h.store.inbound[0]!.channel, 'whatsapp');
    const reply = h.messaging.rows.find((r) => r.id === out.replyId)!;
    assertEquals([reply.channel, reply.provider, reply.copy_key], ['whatsapp', 'console', 'help']);
    assertMatch(reply.body, /^Demir Yapı A\.Ş\. için TalkOlog günlük raporları\. Linkiniz: https:/);
    assertEquals(h.messaging.sent, []);
  },
);

Deno.test(
  'W2-16: Demo phone WhatsApp STOP revokes the WhatsApp consent only; a "5" goes to whatsapp_answer',
  async () => {
    const h = setup();
    h.store.waConsent.set(EMRE, 'held');
    const stop = await h.demo({ reporterId: EMRE, body: 'STOP', channel: 'whatsapp' });
    assertEquals(stop.status, 201);
    assertEquals(h.store.waConsent.get(EMRE), 'revoked');
    assertEquals(h.store.reporters.find((r) => r.id === EMRE)!.status, 'active');
    assertEquals(h.store.notifications, []);
    assertEquals(h.messaging.rows.at(-1)!.copy_key, 'whatsapp_stop_confirm');
    const five = await h.demo({ reporterId: EMRE, body: '5', channel: 'whatsapp' });
    const { messageId } = (await five.json()) as { messageId: string };
    assertEquals(h.store.answerJobs, [messageId]);
    // A pack that lists no WhatsApp has no WhatsApp thread.
    h.store.countries.find((c) => c.code === 'US')!.message_channels = ['push', 'sms'];
    assertEquals(
      (await h.demo({ reporterId: MARCO, body: 'HELP', channel: 'whatsapp' })).status,
      409,
    );
  },
);

// ── §19 Q372: WhatsApp business-scoped user ids (Meta's usernames, 2026) ──────────────────────────

const BSUID = 'TR.968122199252486';

/** Runs `fn` with console output captured: the lines it logged. */
async function captureLogs(fn: () => Promise<void>): Promise<string> {
  const lines: string[] = [];
  const saved = { log: console.log, warn: console.warn, error: console.error };
  const keep = (...a: unknown[]) => void lines.push(a.map(String).join(' '));
  console.log = keep;
  console.warn = keep;
  console.error = keep;
  try {
    await fn();
  } finally {
    Object.assign(console, saved);
  }
  return lines.join('\n');
}

Deno.test(
  'Q372: a WhatsApp message with the number and ExternalUserId records the id on the reporter',
  async () => {
    const h = setupWa();
    const logs = await captureLogs(async () => {
      const res = await h.twilio(
        '',
        wa('+905321234567', 'OK', {
          ExternalUserId: `whatsapp:${BSUID}`,
          ParentExternalUserId: `whatsapp:${BSUID}`,
        }),
      );
      assertEquals([res.status, await res.text()], [200, EMPTY_TWIML]);
    });
    const emre = h.store.reporters.find((r) => r.id === EMRE)!;
    assertEquals(emre.whatsappUserId, BSUID);
    assertEquals(h.store.inbound[0]!.phone_e164, '+905321234567');
    const set = h.store.audits.filter((a) => a.action === 'reporter.whatsapp_user_id_set');
    assertEquals(
      set.map((a) => a.entityId),
      [EMRE],
    );
    // The id is never logged nor audited.
    assert(!logs.includes('968122199252486'));
    assert(!JSON.stringify(h.store.audits).includes('968122199252486'));
    // The same id again changes nothing.
    await h.twilio('', wa('+905321234567', 'OK', { ExternalUserId: `whatsapp:${BSUID}` }));
    assertEquals(
      h.store.audits.filter((a) => a.action === 'reporter.whatsapp_user_id_set').length,
      1,
    );
    // A malformed id is ignored; the message is handled by the number as before.
    await h.twilio('', wa('+905321234567', 'HELP', { ExternalUserId: 'whatsapp:tr.12' }));
    assertEquals([h.store.inbound.length, emre.whatsappUserId], [3, BSUID]);
  },
);

Deno.test(
  "Q372: a WhatsApp message from the user id only is the reporter's, as if from their number (STOP)",
  async () => {
    const h = setupWa();
    h.store.reporters.find((r) => r.id === EMRE)!.whatsappUserId = BSUID;
    const params = wa(BSUID, 'STOP', {
      ExternalUserId: `whatsapp:${BSUID}`,
      ParentExternalUserId: `whatsapp:${BSUID}`,
    });
    const logs = await captureLogs(async () => {
      const res = await h.twilio('', params);
      assertEquals([res.status, await res.text()], [200, EMPTY_TWIML]);
    });
    const [inbound] = h.store.inbound;
    assertEquals(
      [inbound!.channel, inbound!.phone_e164, inbound!.reporter_id, inbound!.org_id],
      ['whatsapp', '+905321234567', EMRE, DEMIR],
    );
    assertEquals(inbound!.payload.keyword, 'stop');
    assertEquals(inbound!.payload.pack, 'TR');
    // The worker's sms_inbound job runs STOP on the number, as for any WhatsApp message.
    assertEquals(h.store.jobs, [
      { id: 1, messageId: inbound!.id, dedupeKey: `sms_inbound:${params.MessageSid}` },
    ]);
    assert(!logs.includes('968122199252486'));
    // Nothing to record: the message had no number.
    assertEquals(
      h.store.audits.filter((a) => a.action.startsWith('reporter.whatsapp_user_id')),
      [],
    );
  },
);

Deno.test(
  'Q372: an id seen with a new number moves to it; the old number no longer answers to it',
  async () => {
    const h = setupWa();
    h.store.reporters.find((r) => r.id === EMRE)!.whatsappUserId = BSUID;
    await h.twilio('', wa('+905329876543', 'OK', { ExternalUserId: `whatsapp:${BSUID}` }));
    assertEquals(h.store.reporters.find((r) => r.id === EMRE)!.whatsappUserId, null);
    assertEquals(
      h.store.audits
        .filter((a) => a.action === 'reporter.whatsapp_user_id_cleared')
        .map((a) => a.entityId),
      [EMRE],
    );
  },
);

Deno.test(
  'Q372: a user id no reporter has: 200, audited without the id, nothing stored or sent',
  async () => {
    const h = setupWa();
    // A demo org's reporter with the id never matches a real sender.
    h.store.reporters.find((r) => r.id === MARCO)!.whatsappUserId = BSUID;
    const logs = await captureLogs(async () => {
      const res = await h.twilio('', wa(BSUID, 'Hello', { ExternalUserId: `whatsapp:${BSUID}` }));
      assertEquals([res.status, await res.text()], [200, EMPTY_TWIML]);
    });
    assertEquals([h.store.inbound, h.store.jobs, h.store.unknown], [[], [], []]);
    assertEquals([h.messaging.sent, h.messaging.waSent], [[], []]);
    const unmatched = h.store.audits.filter((a) => a.action === 'whatsapp.inbound_unmatched');
    assertEquals(unmatched.length, 1);
    assertEquals([unmatched[0]!.orgId, unmatched[0]!.entityId], [null, null]);
    assert(!JSON.stringify(h.store.audits).includes('968122199252486'));
    assert(!logs.includes('968122199252486'));
    // A malformed id in From is no message at all.
    const bad = await h.twilio('', wa('TR.12-34', 'Hello'));
    assertEquals(bad.status, 200);
    assertEquals(h.store.inbound, []);
  },
);
