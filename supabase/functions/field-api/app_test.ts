import { assert, assertEquals, assertMatch, assertStringIncludes } from '@std/assert';
import {
  DEVICE_COOKIE_MAX_AGE_S,
  UPLOAD_MAX_BYTES,
  deviceCookieName,
  emptyReportDataV1,
  linkCodeHash,
  type CountryRow,
  type FieldLinkRow,
  type NotifyOutcome,
  type OrgRow,
  type ReporterRow,
  type SiteRow,
} from '@sitelog/shared';
import { DEMO_COUNTRIES } from '@sitelog/shared/demo/countries.ts';
import { EnvError } from '../_shared/env.ts';
import { createFieldApp, publicSignedUrl, type VerifyCodeMessage } from './app.ts';
import { fakeMessaging } from '../_shared/fake_messaging.ts';
import { notifierCodeSender } from './code_sender.ts';
import { FakeFieldStore } from './fake_store.ts';

/**
 * field-api routes end to end on an in-memory store (fake_store.ts): authentication (link code,
 * device cookie, verification), scoping, rate limits, the cookie's attributes, no-store, and the
 * happy path resolve → send-code → verify → consent → uploads → complete → confirm. The SQL behind
 * the RPCs is tested on PGlite (supabase/db-tests/src/field-api.test.ts) and against a local
 * stack (supabase/db-tests/stack/field-api.test.ts).
 */

const ORG = '11111111-0000-4000-8000-000000000001';
const SITE_A = '11111111-0000-4000-8000-0000000000a1'; // Riverside, 17:30
const SITE_B = '11111111-0000-4000-8000-0000000000b1'; // Pier 9, the org's 17:30
const SITE_P = '11111111-0000-4000-8000-0000000000c1'; // paused
const MARCO = '11111111-0000-4000-8000-000000000101';
const DANA = '11111111-0000-4000-8000-000000000102';
const GONE = '11111111-0000-4000-8000-000000000103'; // disabled
const FIELD_APP = 'https://go.sitelog.test';

const CODES = {
  marco: 'K7Q2MX',
  marcoDaily: 'D4ILY2',
  expired: 'XP1RED',
  revoked: 'RVK3D2',
  dana: 'DANA22',
  gone: 'G0NE22',
};

const T0 = new Date('2026-10-09T22:00:00Z'); // Fri Oct 9, 17:00 in Chicago

function site(id: string, name: string, code: string, extra: Partial<SiteRow> = {}): SiteRow {
  return {
    id,
    org_id: ORG,
    name,
    project_code: code,
    address: null,
    lat: null,
    lng: null,
    timezone: 'America/Chicago',
    deadline: null,
    working_hours: '07:00–15:30',
    status: 'active',
    active_since: '2026-01-01',
    paused_at: null,
    report_seq: 0,
    created_at: '2026-01-01T00:00:00Z',
    ...extra,
  };
}

function reporter(
  id: string,
  name: string,
  phone: string,
  extra: Partial<ReporterRow> = {},
): ReporterRow {
  return {
    id,
    org_id: ORG,
    name,
    phone_e164: phone,
    role: 'site_manager',
    languages: ['en'],
    status: 'invited',
    invited_at: '2026-10-01T15:00:00Z',
    verified_at: null,
    last_invite_error: null,
    created_at: '2026-10-01T15:00:00Z',
    locale: 'en-US',
    contact_pref: 'link',
    activated_at: null,
    opted_out_at: null,
    message_channel: null,
    ...extra,
  };
}

function link(code: string, reporterId: string, extra: Partial<FieldLinkRow> = {}): FieldLinkRow {
  return {
    id: crypto.randomUUID(),
    code_hash: linkCodeHash(code),
    reporter_id: reporterId,
    site_id: null,
    kind: 'personal',
    report_date: null,
    expires_at: null,
    revoked_at: null,
    last_opened_at: null,
    created_at: '2026-10-01T15:00:00Z',
    ...extra,
  };
}

type Cookies = Record<string, string>;

interface Harness {
  store: FakeFieldStore;
  sent: VerifyCodeMessage[];
  clock: { now: Date };
  /**
   * `cookies` replaces the browser's jar for one call (null: none); the jar keeps every cookie
   * the answers set, as a browser does.
   */
  call: (
    method: string,
    path: string,
    opts?: { body?: unknown; code?: string | null; cookies?: Cookies | null; origin?: string },
  ) => Promise<{ status: number; json: Record<string, unknown>; headers: Headers }>;
  jar: Map<string, string>;
  /** The jar's device cookie of a reporter (`sl_dev_<8 hex>`), if any. */
  cookieOf: (reporterId: string) => string | undefined;
}

function setup(
  opts: {
    country?: Partial<CountryRow>;
    outcome?: NotifyOutcome;
    secret?: string;
    isDemo?: boolean;
    sender?: (store: FakeFieldStore) => (m: VerifyCodeMessage) => Promise<NotifyOutcome>;
  } = {},
): Harness {
  const clock = { now: T0 };
  const store = new FakeFieldStore(() => clock.now);
  const us = DEMO_COUNTRIES.find((c) => c.code === 'US')!;
  store.countries.push({ ...us, ...opts.country });
  store.orgs.push({
    id: ORG,
    name: 'Kestrel Build Group',
    country: 'US',
    locale: 'en-US',
    timezone: 'America/Chicago',
    is_demo: opts.isDemo ?? true,
  } as OrgRow);
  store.settings.push({
    org_id: ORG,
    default_deadline: '17:30:00',
    working_days: [1, 2, 3, 4, 5],
  } as never);
  store.sites.push(
    site(SITE_A, 'Riverside', 'RL-2041', { deadline: '17:30:00' }),
    site(SITE_B, 'Pier 9', 'P9-3007'),
    site(SITE_P, 'Paused Yard', 'PY-1', { status: 'paused' }),
  );
  store.reporters.push(
    reporter(MARCO, 'Marco Ruiz', '+15550143378'),
    reporter(DANA, 'Dana Park', '+15550143379', { status: 'active' }),
    reporter(GONE, 'Gone Person', '+15550143380', { status: 'disabled' }),
  );
  store.siteReporters.push(
    { site_id: SITE_A, reporter_id: MARCO },
    { site_id: SITE_B, reporter_id: MARCO },
    { site_id: SITE_P, reporter_id: MARCO },
    { site_id: SITE_A, reporter_id: DANA },
  );
  store.links.push(
    link(CODES.marco, MARCO),
    link(CODES.marcoDaily, MARCO, {
      kind: 'daily',
      site_id: SITE_B,
      report_date: '2026-10-09',
      expires_at: '2026-10-12T22:00:00Z',
    }),
    link(CODES.expired, MARCO, {
      kind: 'daily',
      site_id: SITE_A,
      report_date: '2026-10-05',
      expires_at: '2026-10-08T22:00:00Z',
    }),
    link(CODES.revoked, MARCO, { revoked_at: '2026-10-08T00:00:00Z' }),
    link(CODES.dana, DANA),
    link(CODES.gone, GONE),
  );
  const sent: VerifyCodeMessage[] = [];
  let bytes = 1;
  const h: Harness = {
    store,
    sent,
    clock,
    jar: new Map(),
    cookieOf: (reporterId) => h.jar.get(deviceCookieName(reporterId)),
    call: async (method, path, o = {}) => {
      const headers: Record<string, string> = { 'user-agent': 'FieldTest/1.0' };
      if (o.body !== undefined) headers['content-type'] = 'application/json';
      const code = o.code === undefined ? CODES.marco : o.code;
      if (code) headers['x-link-code'] = code;
      const cookies = o.cookies === undefined ? Object.fromEntries(h.jar) : (o.cookies ?? {});
      const cookie = Object.entries(cookies)
        .map(([k, v]) => `${k}=${v}`)
        .join('; ');
      if (cookie) headers['cookie'] = cookie;
      if (o.origin) headers['origin'] = o.origin;
      const res = await app.request(`/field-api/${path}`, {
        method,
        headers,
        body: o.body === undefined ? undefined : JSON.stringify(o.body),
      });
      for (const set of res.headers.getSetCookie()) {
        const m = /^([^=]+)=([^;]*)/.exec(set);
        if (m) h.jar.set(m[1]!, m[2]!);
      }
      const text = await res.text();
      return { status: res.status, json: text ? JSON.parse(text) : {}, headers: res.headers };
    },
  };
  const record = (message: VerifyCodeMessage): Promise<NotifyOutcome> => {
    sent.push(message);
    return Promise.resolve(opts.outcome ?? { channel: 'sms', messageId: crypto.randomUUID() });
  };
  const app = createFieldApp({
    store,
    sendVerifyCode: opts.sender ? opts.sender(store) : record,
    linkSigningSecret: () => opts.secret ?? 'test-link-signing-secret',
    allowedOrigins: () => [FIELD_APP],
    now: () => clock.now,
    // Deterministic but distinct bytes: tokens differ per call.
    randomBytes: (n) => Uint8Array.from({ length: n }, () => (bytes = (bytes * 73 + 41) % 251)),
  });
  return h;
}

/** resolve → send-code → verify with the code the sender got. */
async function verifiedDevice(h: Harness, code = CODES.marco) {
  await h.call('POST', 'resolve', { body: { code }, code: null });
  const sent = await h.call('POST', 'device/send-code', { code });
  assertEquals(sent.status, 202);
  const otp = h.sent.at(-1)!.code;
  const ok = await h.call('POST', 'device/verify', { code, body: { code: otp } });
  assertEquals(ok.status, 200);
}

async function consented(h: Harness, code = CODES.marco) {
  await verifiedDevice(h, code);
  const res = await h.call('POST', 'consent', {
    code,
    body: {
      types: ['recording', 'data_processing', 'sms'],
      textVersion: 'field.consent.v1',
      contactPref: 'link',
      locale: 'en-US',
    },
  });
  assertEquals(res.status, 200);
}

Deno.test(
  'happy path: resolve → send-code → verify → consent → uploads → complete → confirm',
  async () => {
    const h = setup();

    // resolve: a new device, no sites before verification, the pack subset only.
    const r1 = await h.call('POST', 'resolve', { body: { code: 'k7q2mx' }, code: null });
    assertEquals(r1.status, 200);
    assertEquals(r1.json.needsDeviceCheck, true);
    assertEquals(r1.json.needsConsent, true);
    assertEquals(r1.json.sites, []);
    assertEquals((r1.json.reporter as Record<string, unknown>).firstName, 'Marco');
    // The consent notice names the company (F4 "for {company}").
    assertEquals(r1.json.org, { name: 'Kestrel Build Group' });
    assertEquals(Object.keys(r1.json.country as object).sort(), [
      'code',
      'fieldLocales',
      'legalKeys',
      'messageChannels',
      'twoWaySms',
      'voiceNumber',
    ]);
    assert(!JSON.stringify(r1.json).includes('sms_sender'), 'no sender id or provider');
    assert(!JSON.stringify(r1.json).includes('+1555014337'), 'no phone number');
    assertEquals(h.store.audits.filter((a) => a.action === 'link.opened').length, 1);

    // send-code: creates the device, sets the cookie, sends a 6-digit code (never stores it).
    const s = await h.call('POST', 'device/send-code');
    assertEquals(s.status, 202);
    assertEquals(s.json.sent, true);
    assertEquals(s.json.expiresAt, '2026-10-09T22:10:00.000Z');
    assert(h.cookieOf(MARCO), 'the reporter cookie is set');
    const otp = h.sent[0]!.code;
    assertMatch(otp, /^\d{6}$/);
    const device = h.store.devices[0]!;
    assert(
      device.code_hash && !device.code_hash.includes(otp),
      'only an HMAC of the code is stored',
    );
    assertEquals(device.verified_at, null);

    // An unverified device is refused everywhere but resolve and device/*.
    assertEquals((await h.call('GET', 'today')).json.error, 'device_unverified');

    // verify
    const v = await h.call('POST', 'device/verify', { body: { code: otp } });
    assertEquals(v.status, 200);
    assertEquals(v.json, { verified: true, needsConsent: true });
    assertEquals(h.store.devices[0]!.code_hash, null);
    assert(h.store.devices[0]!.verified_at);

    // Before consent: only consent is open.
    assertEquals((await h.call('GET', 'today')).json.error, 'consent_required');
    const r2 = await h.call('POST', 'resolve', { body: { code: CODES.marco }, code: null });
    assertEquals(r2.json.needsDeviceCheck, false);
    assertEquals(
      (r2.json.sites as { name: string }[]).map((x) => x.name),
      ['Paused Yard', 'Pier 9', 'Riverside'],
    );

    // consent: rows with text_version, preference, locale, reporter active.
    const c = await h.call('POST', 'consent', {
      body: {
        types: ['recording', 'data_processing', 'sms'],
        textVersion: 'field.consent.v1',
        contactPref: 'link',
        locale: 'es-US',
      },
    });
    assertEquals(c.status, 200);
    assertEquals(c.json.status, 'active');
    assertEquals(c.json.locale, 'es-US');
    assertEquals(c.json.consents, ['data_processing', 'recording', 'sms']);
    assertEquals(
      h.store.consents.map((x) => [x.type, x.method, x.text_version]),
      [
        ['recording', 'web_checkbox', 'field.consent.v1'],
        ['data_processing', 'web_checkbox', 'field.consent.v1'],
        ['sms', 'web_checkbox', 'field.consent.v1'],
      ],
    );
    const marco = h.store.reporters.find((x) => x.id === MARCO)!;
    assertEquals(
      [marco.status, marco.locale, marco.activated_at],
      ['active', 'es-US', T0.toISOString()],
    );

    // today: nearest deadline among active sites (both 17:30), no row yet → pending.
    const t = await h.call('GET', `today?site=${SITE_A}`);
    assertEquals(t.status, 200);
    assertEquals((t.json.site as { id: string }).id, SITE_A);
    assertEquals(t.json.date, '2026-10-09');
    assertEquals(t.json.allowedDates, ['2026-10-09']); // 17:00: today only (F5)
    assertEquals(t.json.dayStatus, 'pending');
    assertEquals(t.json.deadlineAt, '2026-10-09T22:30:00.000Z');
    assertEquals(
      (t.json.sites as { name: string }[]).map((x) => x.name),
      ['Pier 9', 'Riverside'],
    );

    // uploads: a voice note for Riverside today.
    const u = await h.call('POST', 'uploads', {
      body: { kind: 'audio', mime: 'audio/webm;codecs=opus', bytes: 1_200_000, siteId: SITE_A },
    });
    assertEquals(u.status, 201);
    const uploadId = u.json.uploadId as string;
    assertEquals(u.json.bucket, 'audio');
    assertEquals(u.json.path, `${ORG}/${SITE_A}/2026-10-09/${uploadId}.webm`);
    assertStringIncludes(u.json.signedUrl as string, `/upload/sign/audio/${ORG}/${SITE_A}/`);

    // complete before the file is there → upload_missing; then with the file.
    assertEquals(
      (await h.call('POST', `uploads/${uploadId}/complete`)).json.error,
      'upload_missing',
    );
    h.store.put(`audio/${u.json.path}`, 'audio/webm;codecs=opus', 1_150_000);
    const done = await h.call('POST', `uploads/${uploadId}/complete`);
    assertEquals(done.status, 200);
    assertEquals(h.store.uploads[0]!.bytes, 1_150_000, 'the stored size, not the claimed one');
    assertEquals(done.json.reportNo, 'RL-2041-0001');
    assertEquals(done.json.reportStatus, 'processing');
    assertEquals(done.json.created, true);
    assertEquals(
      h.store.siteDays.map((d) => [d.date, d.status]),
      [['2026-10-09', 'processing']],
    );
    assertEquals(
      h.store.jobs.map((j) => [j.type, j.payload, j.dedupe_key]),
      [['transcribe_upload', { uploadId }, `transcribe_upload:${uploadId}`]],
    );
    // A retry is harmless.
    const again = await h.call('POST', `uploads/${uploadId}/complete`);
    assertEquals([again.json.alreadyComplete, h.store.jobs.length], [true, 1]);

    // reports/:id while processing; confirm is refused until there is a draft.
    const reportId = done.json.reportId as string;
    const view = await h.call('GET', `reports/${reportId}`);
    assertEquals(view.status, 200);
    assertEquals(view.json.status, 'processing');
    assertEquals(view.json.progress, { voiceNotes: 1, transcribed: 0, photos: 0 });
    assertEquals(view.json.data, null);
    const early = await h.call('POST', `reports/${reportId}/confirm`);
    assertEquals(
      [early.status, early.json.error, early.json.status],
      [409, 'wrong_state', 'processing'],
    );

    // The draft is ready: confirm enqueues file_report for the version seen, once.
    h.store.reports[0]!.status = 'awaiting_confirmation';
    const conf = await h.call('POST', `reports/${reportId}/confirm`, { body: { version: 1 } });
    assertEquals([conf.status, conf.json.status], [202, 'queued']);
    assertEquals((await h.call('POST', `reports/${reportId}/confirm`)).status, 202);
    const fileJobs = h.store.jobs.filter((j) => j.type === 'file_report');
    assertEquals(
      fileJobs.map((j) => [j.payload, j.dedupe_key]),
      [[{ reportId, trigger: 'confirm', version: 1 }, `file:${reportId}:v1`]],
    );
    // Being filed: no voice note or photo joins the confirmed draft.
    const late = await h.call('POST', 'uploads', {
      body: { kind: 'audio', mime: 'audio/webm', bytes: 10, siteId: SITE_A },
    });
    h.store.put(`audio/${late.json.path}`);
    const refused = await h.call('POST', `uploads/${late.json.uploadId}/complete`);
    assertEquals([refused.status, refused.json.error], [409, 'report_filing']);
    assertEquals(h.store.reports[0]!.status, 'awaiting_confirmation');
    h.store.reports[0]!.status = 'filed';
    assertEquals((await h.call('POST', `reports/${reportId}/confirm`)).json, { status: 'filed' });

    // Every state change is audited as the reporter.
    const actions = h.store.audits.map((a) => a.action);
    for (const a of [
      'link.opened',
      'device.created',
      'device.code_sent',
      'device.verified',
      'consent.given',
      'reporter.activated',
      'reporter.preferences_changed',
      'upload.created',
      'report.confirm_requested',
    ]) {
      assert(actions.includes(a), `audited ${a}`);
    }
    assert(h.store.audits.every((a) => a.actorType === 'reporter' && a.actorId === MARCO));
  },
);

Deno.test(
  'links: unknown 404, expired 410 with the pack subset, revoked 410, disabled reporter 403',
  async () => {
    const h = setup({ country: { voice_number: '+15550142290' } });
    const unknown = await h.call('POST', 'resolve', { body: { code: 'NOPE22' }, code: null });
    assertEquals([unknown.status, unknown.json.error], [404, 'link_not_found']);

    const expired = await h.call('POST', 'resolve', { body: { code: CODES.expired }, code: null });
    assertEquals([expired.status, expired.json.error], [410, 'link_expired']);
    assertEquals(expired.json.locale, 'en-US');
    assertEquals((expired.json.country as { voiceNumber: string }).voiceNumber, '+15550142290');

    const revoked = await h.call('POST', 'resolve', { body: { code: CODES.revoked }, code: null });
    assertEquals([revoked.status, revoked.json.error], [410, 'link_revoked']);

    const gone = await h.call('POST', 'resolve', { body: { code: CODES.gone }, code: null });
    assertEquals([gone.status, gone.json.error], [403, 'reporter_disabled']);

    // The header routes refuse the same way, and a missing code.
    assertEquals((await h.call('POST', 'device/send-code', { code: CODES.expired })).status, 410);
    assertEquals((await h.call('GET', 'today', { code: null })).json.error, 'link_required');
    // A daily link expires at its time: the same link the minute before still works.
    h.clock.now = new Date('2026-10-08T21:59:00Z');
    assertEquals(
      (await h.call('POST', 'resolve', { body: { code: CODES.expired }, code: null })).status,
      200,
    );
  },
);

Deno.test(
  'cookie: httpOnly, Secure, SameSite=Lax, Path=/, 180 days; every answer no-store',
  async () => {
    const h = setup();
    const sent = await h.call('POST', 'device/send-code');
    const setCookie = sent.headers.get('set-cookie')!;
    assertMatch(setCookie, /^sl_dev_[0-9a-f]{8}=[A-Za-z0-9_-]{43};/);
    assert(setCookie.startsWith(`${deviceCookieName(MARCO)}=`), 'named for the reporter');
    for (const attr of [
      'HttpOnly',
      'Secure',
      'SameSite=Lax',
      'Path=/',
      `Max-Age=${DEVICE_COOKIE_MAX_AGE_S}`,
    ]) {
      assertStringIncludes(setCookie, attr);
    }
    assertEquals(DEVICE_COOKIE_MAX_AGE_S, 15_552_000);
    // verify renews it for 180 days from verification.
    const ok = await h.call('POST', 'device/verify', { body: { code: h.sent[0]!.code } });
    assertStringIncludes(ok.headers.get('set-cookie')!, `Max-Age=${DEVICE_COOKIE_MAX_AGE_S}`);

    const answers = [
      sent,
      ok,
      await h.call('POST', 'resolve', { body: { code: CODES.marco }, code: null }),
      await h.call('POST', 'resolve', { body: { code: CODES.expired }, code: null }),
      await h.call('GET', 'today'),
      await h.call('GET', 'nowhere'),
      await h.call('POST', 'resolve', {
        body: { code: CODES.marco },
        code: null,
        origin: 'https://evil.test',
      }),
      await h.call('POST', 'resolve', { body: '{bad json', code: null }),
    ];
    for (const a of answers)
      assertEquals(a.headers.get('cache-control'), 'no-store', String(a.status));
    assertEquals(answers[5]!.json.error, 'not_found');
    assertEquals(answers[6]!.json.error, 'origin_not_allowed');
    assertEquals(answers[7]!.json.error, 'invalid_request');
    // The field app's own origin passes.
    assertEquals(
      (
        await h.call('POST', 'resolve', {
          body: { code: CODES.marco },
          code: null,
          origin: FIELD_APP,
        })
      ).status,
      200,
    );
  },
);

Deno.test('device: wrong and expired codes, no code, unverified and revoked devices', async () => {
  const h = setup();
  assertEquals(
    (await h.call('POST', 'device/verify', { body: { code: '123456' } })).json.error,
    'device_required',
  );
  await h.call('POST', 'device/send-code');
  const otp = h.sent[0]!.code;
  const wrong = otp === '000000' ? '000001' : '000000';
  const bad = await h.call('POST', 'device/verify', { body: { code: wrong } });
  assertEquals([bad.status, bad.json.error, bad.json.attemptsLeft], [400, 'code_invalid', 4]);
  assertEquals(
    (await h.call('POST', 'device/verify', { body: { code: '12' } })).json.error,
    'invalid_request',
  );

  h.clock.now = new Date(T0.getTime() + 11 * 60_000);
  assertEquals(
    (await h.call('POST', 'device/verify', { body: { code: otp } })).json.error,
    'code_expired',
  );

  // A new code replaces the old one.
  await h.call('POST', 'device/send-code');
  assertEquals(h.store.devices.length, 1, 'the same device gets the new code');
  const ok = await h.call('POST', 'device/verify', { body: { code: h.sent[1]!.code } });
  assertEquals(ok.status, 200);
  // Verified: send-code sends nothing more.
  assertEquals((await h.call('POST', 'device/send-code')).json, { alreadyVerified: true });
  assertEquals(h.sent.length, 2);

  // A revoked device is no device: the next call needs a new check.
  h.store.devices[0]!.revoked_at = new Date().toISOString();
  assertEquals((await h.call('GET', 'today')).json.error, 'device_unverified');
});

Deno.test(
  'send-code: the code goes through the injected sender; nothing deliverable → 409',
  async () => {
    const h = setup({ outcome: { channel: null, reason: 'opted_out' } });
    const res = await h.call('POST', 'device/send-code');
    assertEquals(
      [res.status, res.json.error, res.json.reason],
      [409, 'code_undeliverable', 'opted_out'],
    );
    assertEquals(h.sent[0]!.reporter.id, MARCO);
    assertEquals(h.sent[0]!.pack.code, 'US');
    assert(h.store.audits.some((a) => a.action === 'device.code_skipped'));
  },
);

Deno.test('cross-reporter access is denied', async () => {
  const h = setup();
  await consented(h, CODES.marco);
  const marcoCookie = h.cookieOf(MARCO)!;
  const u = await h.call('POST', 'uploads', {
    body: { kind: 'audio', mime: 'audio/mp4', bytes: 10, siteId: SITE_B },
  });
  h.store.put(`audio/${u.json.path}`, 'audio/mp4');
  const done = await h.call('POST', `uploads/${u.json.uploadId}/complete`);
  const reportId = done.json.reportId as string;

  // Dana's link with Marco's device cookie, under either name: the device is not Dana's.
  assertEquals(
    (await h.call('GET', 'today', { code: CODES.dana })).json.error,
    'device_unverified',
  );
  assertEquals(
    (
      await h.call('GET', 'today', {
        code: CODES.dana,
        cookies: { [deviceCookieName(DANA)]: marcoCookie },
      })
    ).json.error,
    'device_unverified',
  );
  // Dana with her own verified device and consents (the same browser keeps Marco's cookie).
  await consented(h, CODES.dana);
  // Pier 9 is not Dana's site: its report, an upload there and Marco's upload are out of scope.
  const view = await h.call('GET', `reports/${reportId}`, { code: CODES.dana });
  assertEquals([view.status, view.json.error], [404, 'not_found']);
  assertEquals(
    (await h.call('POST', `reports/${reportId}/confirm`, { code: CODES.dana })).status,
    404,
  );
  assertEquals(
    (
      await h.call('POST', 'uploads', {
        code: CODES.dana,
        body: { kind: 'audio', mime: 'audio/mp4', bytes: 10, siteId: SITE_B },
      })
    ).json.error,
    'not_found',
  );
  assertEquals(
    (await h.call('POST', `uploads/${u.json.uploadId}/complete`, { code: CODES.dana })).status,
    404,
  );
  assertEquals((await h.call('GET', `today?site=${SITE_B}`, { code: CODES.dana })).status, 404);
  assertEquals(
    (
      await h.call('POST', 'day-status', {
        code: CODES.dana,
        body: { siteId: SITE_B, status: 'no_work' },
      })
    ).status,
    404,
  );
  // Marco's link with Dana's cookie presented as Marco's is not Marco's device either.
  assertEquals(
    (
      await h.call('GET', 'history', {
        code: CODES.marco,
        cookies: { [deviceCookieName(MARCO)]: h.cookieOf(DANA)! },
      })
    ).json.error,
    'device_unverified',
  );
  // Not a uuid: not found, not a database error.
  assertEquals((await h.call('GET', 'reports/not-a-uuid', { code: CODES.marco })).status, 404);

  // A daily link names one site: Marco's daily link for Pier 9 does not reach Riverside.
  assertEquals(
    (await h.call('GET', `today?site=${SITE_A}`, { code: CODES.marcoDaily })).status,
    404,
  );
});

Deno.test('rate limits: 30 a minute per device', async () => {
  const h = setup();
  await consented(h);
  // Requests so far in this minute, per the device's window.
  const used = h.store.rates.get(`dev:${h.store.devices[0]!.id}`)!.count;
  let last = 0;
  for (let i = used; i < 30; i++) last = (await h.call('GET', 'today')).status;
  assertEquals(last, 200);
  const limited = await h.call('GET', 'today');
  assertEquals([limited.status, limited.json.error], [429, 'rate_limited']);
  assert(Number(limited.headers.get('retry-after')) > 0);
  assertEquals(limited.headers.get('cache-control'), 'no-store');
  h.clock.now = new Date(T0.getTime() + 61_000);
  assertEquals((await h.call('GET', 'today')).status, 200);
});

Deno.test('rate limits: 5 code sends and 5 verifications an hour per phone', async () => {
  const h = setup();
  for (let i = 0; i < 5; i++) assertEquals((await h.call('POST', 'device/send-code')).status, 202);
  const sixth = await h.call('POST', 'device/send-code');
  assertEquals([sixth.status, sixth.json.error], [429, 'rate_limited']);
  assertEquals(h.sent.length, 5);

  // Another device of the same phone shares the limit (the cookie is dropped).
  assertEquals((await h.call('POST', 'device/send-code', { cookies: null })).status, 429);

  const otp = h.sent.at(-1)!.code;
  const wrong = otp === '999999' ? '999998' : '999999';
  for (let i = 0; i < 5; i++) {
    assertEquals(
      (await h.call('POST', 'device/verify', { body: { code: wrong } })).json.error,
      'code_invalid',
    );
  }
  // The sixth attempt is refused even with the right code, and the lock is audited once.
  const locked = await h.call('POST', 'device/verify', { body: { code: otp } });
  assertEquals([locked.status, locked.json.error], [429, 'rate_limited']);
  assertEquals(h.store.audits.filter((a) => a.action === 'device.verify_locked').length, 1);
  // An hour later both work again.
  h.clock.now = new Date(T0.getTime() + 61 * 60_000);
  assertEquals((await h.call('POST', 'device/send-code')).status, 202);
  assertEquals(
    (await h.call('POST', 'device/verify', { body: { code: h.sent.at(-1)!.code } })).status,
    200,
  );
});

Deno.test(
  'consent: required boxes, the pack consent key, the pack locales; not twice',
  async () => {
    const h = setup({ country: { legal_keys: { consent: 'US.consent.v1' } } });
    await verifiedDevice(h);
    const base = {
      types: ['recording', 'data_processing'],
      textVersion: 'US.consent.v1',
      contactPref: 'call',
      locale: 'en-US',
    };
    assertEquals(
      (await h.call('POST', 'consent', { body: { ...base, types: ['sms'] } })).json.error,
      'consent_required',
    );
    const mismatch = await h.call('POST', 'consent', {
      body: { ...base, textVersion: 'field.v0' },
    });
    assertEquals(
      [mismatch.status, mismatch.json.error, mismatch.json.textVersion],
      [409, 'text_version_mismatch', 'US.consent.v1'],
    );
    assertEquals(
      (await h.call('POST', 'consent', { body: { ...base, locale: 'tr-TR' } })).json.error,
      'locale_not_offered',
    );
    assertEquals(h.store.consents.length, 0);
    const ok = await h.call('POST', 'consent', { body: base });
    assertEquals([ok.status, ok.json.contactPref], [200, 'call']);
    await h.call('POST', 'consent', { body: base });
    assertEquals(h.store.consents.length, 2, 'held consents are not given twice');
    assertEquals(h.store.consents[0]!.evidence, {
      device_id: h.store.devices[0]!.id,
      user_agent: 'FieldTest/1.0',
      ip: null,
    });
  },
);

Deno.test('uploads: media type, kind, date, inactive site, closed and filed days', async () => {
  const h = setup();
  await consented(h);
  const up = (body: Record<string, unknown>, code?: string) =>
    h.call('POST', 'uploads', {
      body: { kind: 'audio', mime: 'audio/webm', bytes: 10, siteId: SITE_A, ...body },
      code,
    });
  assertEquals((await up({ mime: 'video/mp4' })).json.error, 'media_type_not_allowed');
  assertEquals((await up({ kind: 'photo' })).json.error, 'media_type_not_allowed');
  assertEquals((await up({ bytes: 60 * 1024 * 1024 })).json.error, 'invalid_request');
  assertEquals((await up({ siteId: SITE_P })).json.error, 'site_inactive');
  assertEquals((await up({ siteId: undefined })).json.error, 'invalid_request'); // two active sites
  // 17:00: today only.
  const yesterday = await up({ date: '2026-10-08' });
  assertEquals(
    [yesterday.json.error, yesterday.json.allowed],
    ['date_not_allowed', ['2026-10-09']],
  );
  // Monday 10:00 (before noon): today or the previous working day, Friday (F5, §19 Q43).
  h.clock.now = new Date('2026-10-12T15:00:00Z');
  assertEquals((await h.call('GET', `today?site=${SITE_A}`)).json.allowedDates, [
    '2026-10-12',
    '2026-10-09',
  ]);
  assertEquals((await up({ date: '2026-10-09' })).status, 201);
  const sunday = await up({ date: '2026-10-11' });
  assertEquals(
    [sunday.json.error, sunday.json.allowed],
    ['date_not_allowed', ['2026-10-12', '2026-10-09']],
  );
  // The daily link fixes its site and date.
  const daily = await h.call('POST', 'uploads', {
    code: CODES.marcoDaily,
    body: { kind: 'photo', mime: 'image/jpeg', bytes: 10 },
  });
  assertEquals(daily.status, 201);
  assertEquals(daily.json.path, `${ORG}/${SITE_B}/2026-10-09/${daily.json.uploadId}.jpg`);
  assertEquals(daily.json.bucket, 'photos');

  // A no-work day takes no upload; a filed report neither.
  await h.call('POST', 'day-status', { body: { siteId: SITE_A, status: 'no_work' } });
  assertEquals((await up({})).json.error, 'day_closed');
  h.store.put(`photos/${daily.json.path}`);
  const done = await h.call('POST', `uploads/${daily.json.uploadId}/complete`, {
    code: CODES.marcoDaily,
  });
  assertEquals(done.json.reportStatus, 'collecting'); // photos only: no transcription
  h.store.reports.find((r) => r.id === done.json.reportId)!.status = 'filed';
  const filed = await h.call('POST', 'uploads', {
    code: CODES.marcoDaily,
    body: { kind: 'photo', mime: 'image/jpeg', bytes: 10 },
  });
  assertEquals([filed.status, filed.json.error], [409, 'report_filed']);
});

Deno.test(
  'day-status: no work and weather day on a pending day; refused with a report',
  async () => {
    const h = setup();
    await consented(h);
    const nw = await h.call('POST', 'day-status', {
      body: {
        siteId: SITE_A,
        status: 'weather_day',
        details: { since: '11:00', workersBefore: 12 },
      },
    });
    assertEquals([nw.status, nw.json.status, nw.json.changed], [200, 'weather_day', true]);
    // A day with a report in progress: the report decides (spec §19 Q41).
    const u = await h.call('POST', 'uploads', {
      body: { kind: 'audio', mime: 'audio/webm', bytes: 1, siteId: SITE_B },
    });
    h.store.put(`audio/${u.json.path}`);
    await h.call('POST', `uploads/${u.json.uploadId}/complete`);
    const busy = await h.call('POST', 'day-status', {
      body: { siteId: SITE_B, status: 'no_work' },
    });
    assertEquals([busy.status, busy.json.error], [409, 'report_in_progress']);
    assertEquals(
      (await h.call('POST', 'day-status', { body: { siteId: SITE_A, status: 'filed' } })).json
        .error,
      'invalid_request',
    );
  },
);

Deno.test('reports/:id view, history and preferences', async () => {
  const h = setup();
  await consented(h);
  const u = await h.call('POST', 'uploads', {
    body: { kind: 'audio', mime: 'audio/webm', bytes: 1, siteId: SITE_A },
  });
  h.store.put(`audio/${u.json.path}`);
  const done = await h.call('POST', `uploads/${u.json.uploadId}/complete`);
  const reportId = done.json.reportId as string;
  const report = h.store.reports[0]!;
  report.status = 'awaiting_answer';
  h.store.questions.push({
    id: '11111111-0000-4000-8000-00000000f001',
    report_id: reportId,
    field: 'manpower.workers',
    target: null,
    prompt: 'Delta — 4 or 5?',
    options: [
      { id: 'a', label: '4 · full day' },
      { id: 'b', label: '5 · full day' },
    ],
    asked_message_id: null,
    answered_message_id: null,
    answer: null,
    asked_at: T0.toISOString(),
    answered_at: null,
    created_at: T0.toISOString(),
    channel: 'web',
    call_id: null,
    answer_source: null,
  });
  h.store.versions.push({
    report_id: reportId,
    version: 1,
    data: { ...emptyReportDataV1('2026-10-09'), summary: 'Deck pour' } as never,
    summary: null,
    pdf_path: `${ORG}/${SITE_A}/RL-2041-0001_v1.pdf`,
    author: 'agent',
    author_user_id: null,
    author_message_id: null,
    change_note: null,
    created_at: T0.toISOString(),
    via: null,
  });
  const v = await h.call('GET', `reports/${reportId}`);
  assertEquals(v.json.question, {
    id: '11111111-0000-4000-8000-00000000f001',
    field: 'manpower.workers',
    prompt: 'Delta — 4 or 5?',
    options: [
      { id: 'a', label: '4 · full day' },
      { id: 'b', label: '5 · full day' },
    ],
  });
  assertEquals((v.json.data as { schemaVersion: number }).schemaVersion, 2); // v1 read as v2
  assertEquals(v.json.pdfUrl, null); // not filed yet
  report.status = 'filed';
  assertStringIncludes((await h.call('GET', `reports/${reportId}`)).json.pdfUrl as string, 'pdfs/');

  const hist = await h.call('GET', 'history');
  assertEquals(
    (hist.json.reports as { reportNo: string; date: string }[]).map((r) => [r.reportNo, r.date]),
    [['RL-2041-0001', '2026-10-09']],
  );
  // 14 days later it is gone from history.
  h.clock.now = new Date('2026-10-23T22:00:00Z');
  h.store.rates.clear();
  assertEquals((await h.call('GET', 'history')).json.reports, []);

  const p = await h.call('PATCH', 'preferences', {
    body: { contactPref: 'call', locale: 'es-US' },
  });
  assertEquals(p.json, { contactPref: 'call', locale: 'es-US' });
  assertEquals(
    (await h.call('PATCH', 'preferences', { body: { messageChannel: 'whatsapp' } })).json.error,
    'invalid_request',
  );
  assertEquals(
    (await h.call('PATCH', 'preferences', { body: { locale: 'tr-TR' } })).json.error,
    'locale_not_offered',
  );
});

Deno.test(
  'device: verified for 180 days from verification, then a new code for the same device',
  async () => {
    const h = setup();
    await consented(h);
    assertEquals((await h.call('GET', 'today')).status, 200);
    const verifiedAt = h.store.devices[0]!.verified_at!;

    // One second short of 180 days: still verified.
    h.clock.now = new Date(new Date(verifiedAt).getTime() + DEVICE_COOKIE_MAX_AGE_S * 1000 - 1000);
    assertEquals((await h.call('GET', 'today')).status, 200);
    // 180 days on, the browser still sends the cookie (a copied token, a clock): no longer verified.
    h.clock.now = new Date(new Date(verifiedAt).getTime() + DEVICE_COOKIE_MAX_AGE_S * 1000);
    assertEquals((await h.call('GET', 'today')).json.error, 'device_unverified');
    assertEquals(
      (await h.call('POST', 'resolve', { body: { code: CODES.marco }, code: null })).json
        .needsDeviceCheck,
      true,
    );
    const again = await h.call('POST', 'device/send-code');
    assertEquals([again.status, again.json.sent], [202, true]);
    assertEquals(h.store.devices.length, 1, 'the same device gets the new code');
    const ok = await h.call('POST', 'device/verify', { body: { code: h.sent.at(-1)!.code } });
    assertEquals(ok.json, { verified: true, needsConsent: false });
    assertEquals(h.store.devices[0]!.verified_at, h.clock.now.toISOString());
    assertEquals((await h.call('GET', 'today')).status, 200);
  },
);

Deno.test('one cookie per reporter: a phone keeps two reporters verified', async () => {
  const h = setup();
  await verifiedDevice(h, CODES.marco);
  const marco = h.cookieOf(MARCO);
  // The same browser opens Dana's link and verifies it: Marco's cookie is untouched.
  await verifiedDevice(h, CODES.dana);
  assertEquals(h.cookieOf(MARCO), marco);
  assert(h.cookieOf(DANA) && h.cookieOf(DANA) !== marco);
  assertEquals(h.store.devices.length, 2);
  // Back to Marco's link: no new code (two sends in all, one per reporter).
  const back = await h.call('POST', 'resolve', { body: { code: CODES.marco }, code: null });
  assertEquals(back.json.needsDeviceCheck, false);
  assertEquals((await h.call('POST', 'device/send-code')).json, { alreadyVerified: true });
  assertEquals(h.sent.length, 2);
});

Deno.test(
  'header routes answer an unknown, revoked or expired link like a valid one without a device',
  async () => {
    const h = setup();
    for (const code of ['NOPE22', CODES.revoked, CODES.expired, CODES.gone, CODES.marco]) {
      const res = await h.call('GET', 'today', { code });
      assertEquals([res.status, res.json.error], [401, 'device_unverified'], code);
    }
    // With the reporter's verified device the link's state shows.
    await verifiedDevice(h);
    assertEquals(
      (await h.call('GET', 'history', { code: CODES.revoked })).json.error,
      'link_revoked',
    );
    const expired = await h.call('GET', 'history', { code: CODES.expired });
    assertEquals([expired.status, expired.json.error], [410, 'link_expired']);
  },
);

Deno.test(
  'complete: the stored object must be the type the upload named and at most 50 MB',
  async () => {
    const h = setup();
    await consented(h);
    const up = async () =>
      (
        await h.call('POST', 'uploads', {
          body: { kind: 'audio', mime: 'audio/webm', bytes: 2048, siteId: SITE_A },
        })
      ).json as { uploadId: string; path: string };

    // Uploaded as text/html under a .webm name: refused, and the object is removed.
    const html = await up();
    h.store.put(`audio/${html.path}`, 'text/html', 2048);
    const wrong = await h.call('POST', `uploads/${html.uploadId}/complete`);
    assertEquals([wrong.status, wrong.json.error], [409, 'media_type_not_allowed']);
    assertEquals(h.store.objects.has(`audio/${html.path}`), false);
    assertEquals(h.store.reports.length, 0);
    assert(h.store.audits.some((a) => a.action === 'upload.rejected'));
    // Another audio type than the one named is refused too.
    const mp4 = await up();
    h.store.put(`audio/${mp4.path}`, 'audio/mp4', 2048);
    assertEquals(
      (await h.call('POST', `uploads/${mp4.uploadId}/complete`)).json.error,
      'media_type_not_allowed',
    );
    // Over the limit (the claimed size said 2 KB).
    const big = await up();
    h.store.put(`audio/${big.path}`, 'audio/webm', UPLOAD_MAX_BYTES + 1);
    assertEquals(
      (await h.call('POST', `uploads/${big.uploadId}/complete`)).json.error,
      'upload_too_large',
    );
    // The named type with parameters, in size: completed with the stored size.
    const good = await up();
    h.store.put(`audio/${good.path}`, 'audio/webm; codecs=opus', 4096);
    assertEquals((await h.call('POST', `uploads/${good.uploadId}/complete`)).status, 200);
    assertEquals(h.store.uploads.find((u) => u.id === good.uploadId)!.bytes, 4096);
  },
);

Deno.test(
  'confirm: the version the reporter saw; a newer draft or another state is refused',
  async () => {
    const h = setup();
    await consented(h);
    const u = await h.call('POST', 'uploads', {
      body: { kind: 'audio', mime: 'audio/webm', bytes: 10, siteId: SITE_A },
    });
    h.store.put(`audio/${u.json.path}`);
    const reportId = (await h.call('POST', `uploads/${u.json.uploadId}/complete`)).json
      .reportId as string;
    const report = h.store.reports[0]!;
    report.status = 'awaiting_confirmation';
    report.current_version = 2; // a second draft after more audio
    const stale = await h.call('POST', `reports/${reportId}/confirm`, { body: { version: 1 } });
    assertEquals(
      [stale.status, stale.json.error, stale.json.currentVersion],
      [409, 'draft_changed', 2],
    );
    assertEquals(
      (await h.call('POST', `reports/${reportId}/confirm`, { body: { version: 'x' } })).json.error,
      'invalid_request',
    );
    assertEquals(
      h.store.jobs.filter((j) => j.type === 'file_report'),
      [],
    );
    const ok = await h.call('POST', `reports/${reportId}/confirm`, { body: { version: 2 } });
    assertEquals([ok.status, ok.json.status], [202, 'queued']);
    assertEquals(h.store.jobs.find((j) => j.type === 'file_report')!.payload.version, 2);

    // D16: that filing completed stale (the report left and came back to awaiting_confirmation
    // at v2); the next confirm is a new occurrence, not the finished job.
    h.store.jobs.find((j) => j.type === 'file_report')!.status = 'done';
    const again = await h.call('POST', `reports/${reportId}/confirm`, { body: { version: 2 } });
    assertEquals([again.status, again.json.status], [202, 'queued']);
    assertEquals(
      h.store.jobs.filter((j) => j.type === 'file_report').map((j) => [j.dedupe_key, j.status]),
      [
        [`file:${reportId}:v2`, 'done'],
        [`file:${reportId}:v2:c2`, 'queued'],
      ],
    );
  },
);

Deno.test(
  'send-code on a real org: the console sender writes nothing and answers 409',
  async () => {
    const messaging = fakeMessaging();
    const h = setup({ isDemo: false, sender: () => notifierCodeSender(messaging.notifier) });
    const res = await h.call('POST', 'device/send-code');
    assertEquals(
      [res.status, res.json.error, res.json.reason],
      [409, 'code_undeliverable', 'no_channel'],
    );
    assertEquals(messaging.rows, [], 'no messages row holds the code');
    assert(h.store.audits.some((a) => a.action === 'device.code_skipped'));
  },
);

Deno.test('a missing LINK_SIGNING_SECRET is a 500 that says nothing more', async () => {
  const h = setup();
  const app = createFieldApp({
    store: h.store,
    sendVerifyCode: () => Promise.resolve({ channel: 'sms', messageId: 'x' }),
    linkSigningSecret: () => {
      throw new EnvError('LINK_SIGNING_SECRET');
    },
    allowedOrigins: () => [],
    now: () => T0,
  });
  const res = await app.request('/field-api/device/send-code', {
    method: 'POST',
    headers: { 'x-link-code': CODES.marco },
  });
  assertEquals(res.status, 500);
  assertEquals(((await res.json()) as { error: string }).error, 'internal');
  assertEquals(res.headers.get('cache-control'), 'no-store');
});

Deno.test(
  'a signed upload URL is re-based on STORAGE_PUBLIC_URL for local stacks (W1-09)',
  async () => {
    // Inside `supabase start` the functions see the gateway as http://kong:8000, which no phone can
    // reach; the public URL replaces the origin and keeps the signed path and token.
    const signed =
      'http://kong:8000/storage/v1/object/upload/sign/audio/o/s/2026-10-09/u.webm?token=abc';
    assertEquals(
      publicSignedUrl(signed, 'http://127.0.0.1:54321'),
      'http://127.0.0.1:54321/storage/v1/object/upload/sign/audio/o/s/2026-10-09/u.webm?token=abc',
    );
    // A self-hosted gateway under a path keeps the prefix; a trailing slash is dropped.
    assertEquals(
      publicSignedUrl(signed, 'https://api.example.com/supabase/'),
      'https://api.example.com/supabase/storage/v1/object/upload/sign/audio/o/s/2026-10-09/u.webm?token=abc',
    );
    // Unset, unparsable or not http(s): as Storage built it.
    assertEquals(publicSignedUrl(signed, undefined), signed);
    assertEquals(publicSignedUrl(signed, 'not a url'), signed);
    assertEquals(publicSignedUrl(signed, 'ftp://x'), signed);
    assertEquals(
      publicSignedUrl('https://p.supabase.co/other/path', 'http://127.0.0.1:54321'),
      'https://p.supabase.co/other/path',
    );

    // Through the app: `uploads` answers the public one; without the dep, the store's.
    const h = setup();
    await consented(h);
    const app = createFieldApp({
      store: h.store,
      sendVerifyCode: () => Promise.resolve({ channel: 'sms', messageId: 'x' }),
      linkSigningSecret: () => 'test-link-signing-secret',
      allowedOrigins: () => [],
      now: () => T0,
      publicUrl: () => 'http://localhost:4174',
    });
    const res = await app.request('/field-api/uploads', {
      method: 'POST',
      headers: {
        'x-link-code': CODES.marco,
        'content-type': 'application/json',
        cookie: [...h.jar].map(([k, v]) => `${k}=${v}`).join('; '),
      },
      body: JSON.stringify({ kind: 'audio', mime: 'audio/webm', bytes: 1000, siteId: SITE_A }),
    });
    assertEquals(res.status, 201);
    const body = (await res.json()) as { signedUrl: string; path: string };
    assertEquals(
      body.signedUrl,
      `http://localhost:4174/storage/v1/object/upload/sign/audio/${body.path}?token=t`,
    );
  },
);
