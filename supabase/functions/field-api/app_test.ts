import { assert, assertEquals, assertMatch, assertStringIncludes } from '@std/assert';
import {
  type CountryRow,
  type DailyReportData,
  DEVICE_COOKIE_MAX_AGE_S,
  deviceCookieName,
  emptyReportData,
  emptyReportDataV1,
  type FieldLinkRow,
  linkCodeHash,
  type NotifyOutcome,
  type OrgRow,
  type QuestionRow,
  type ReportVersionRow,
  type ReporterRow,
  type SiteRow,
  UPLOAD_MAX_BYTES,
} from '@sitelog/shared';
import { DEMO_COUNTRIES } from '@sitelog/shared/demo/countries.ts';
import { EnvError } from '../_shared/env.ts';
import {
  createFieldApp,
  publicSignedUrl,
  type DailyLinkMessage,
  type VerifyCodeMessage,
} from './app.ts';
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
  /** F16: what `expired/daily-link` handed the Notifier. */
  daily: DailyLinkMessage[];
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
    dailyOutcome?: NotifyOutcome;
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
    units: 'imperial',
  } as OrgRow);
  store.settings.push({
    org_id: ORG,
    default_deadline: '17:30:00',
    working_days: [1, 2, 3, 4, 5],
    default_shift_hours: 8,
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
  const daily: DailyLinkMessage[] = [];
  let bytes = 1;
  const h: Harness = {
    store,
    sent,
    daily,
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
    sendDailyLink: async (m) => {
      // The Notifier's dedupe: it reads the messages under the key, then the provider sends
      // (a round trip), so two sends at once would both find none.
      const repeat = daily.some((d) => d.dedupeKey === m.dedupeKey);
      await new Promise((r) => setTimeout(r, 5));
      if (!repeat) daily.push(m);
      return opts.dailyOutcome ?? { channel: 'sms', messageId: 'msg-1' };
    },
    sleep: (ms) => new Promise((r) => setTimeout(r, Math.min(ms, 2))),
    fieldAppUrl: () => FIELD_APP,
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
    assertEquals(view.json.draftRev, null);
    const early = await h.call('POST', `reports/${reportId}/confirm`, {
      body: { version: 1, draftRev: 1 },
    });
    assertEquals(
      [early.status, early.json.error, early.json.status],
      [409, 'wrong_state', 'processing'],
    );

    // The draft is ready: confirm enqueues file_report for the draft seen (version and
    // revision), once.
    h.store.reports[0]!.status = 'awaiting_confirmation';
    h.store.versions.push({
      report_id: reportId,
      version: 1,
      data: emptyReportDataV1('2026-10-09') as never,
      summary: null,
      pdf_path: null,
      author: 'agent',
      author_user_id: null,
      author_message_id: null,
      change_note: null,
      created_at: T0.toISOString(),
      via: null,
      draft_rev: 1,
    });
    assertEquals((await h.call('GET', `reports/${reportId}`)).json.draftRev, 1);
    const conf = await h.call('POST', `reports/${reportId}/confirm`, {
      body: { version: 1, draftRev: 1 },
    });
    assertEquals([conf.status, conf.json.status], [202, 'queued']);
    assertEquals(
      (await h.call('POST', `reports/${reportId}/confirm`, { body: { draftRev: 1 } })).status,
      202,
    );
    const fileJobs = h.store.jobs.filter((j) => j.type === 'file_report');
    assertEquals(
      fileJobs.map((j) => [j.payload, j.dedupe_key]),
      [
        [
          { reportId, trigger: 'confirm', version: 1, draftRev: 1, via: 'web' },
          `file:${reportId}:v1:r1`,
        ],
      ],
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
    assertEquals(
      (await h.call('POST', `reports/${reportId}/confirm`, { body: { draftRev: 1 } })).json,
      { status: 'filed' },
    );

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
    for (const a of answers) {
      assertEquals(a.headers.get('cache-control'), 'no-store', String(a.status));
    }
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
    (
      await h.call('POST', `reports/${reportId}/confirm`, {
        code: CODES.dana,
        body: { draftRev: 1 },
      })
    ).status,
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
  // F16: the office is told once per lock window, however often the locked phone tries.
  assertEquals((await h.call('POST', 'device/verify', { body: { code: otp } })).status, 429);
  assertEquals(h.store.lockNotices.length, 1);
  assertEquals(h.store.lockNotices[0]!.reporterId, MARCO);
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
  'uploads: a late clip is filed under the day it was recorded (spec §19 Q53)',
  async () => {
    const h = setup();
    await consented(h);
    const up = (body: Record<string, unknown>) =>
      h.call('POST', 'uploads', {
        body: { kind: 'audio', mime: 'audio/webm', bytes: 10, siteId: SITE_A, ...body },
      });
    // Fri Oct 9, 17:00 Chicago. Thursday's window closed at noon today; a clip recorded Thursday
    // 20:00 (offline) arrives now: filed under Thursday, late.
    const recordedThu = '2026-10-09T01:00:00Z';
    assertEquals((await up({ date: '2026-10-08' })).json.error, 'date_not_allowed');
    const late = await up({ date: '2026-10-08', recordedAt: recordedThu });
    assertEquals(late.status, 201);
    assertEquals(late.json.path, `${ORG}/${SITE_A}/2026-10-08/${late.json.uploadId}.webm`);
    const created = h.store.audits.find(
      (a) => a.action === 'upload.created' && a.entityId === late.json.uploadId,
    );
    assertEquals(created?.diff, {
      kind: 'audio',
      site_id: SITE_A,
      date: '2026-10-08',
      late: true,
      recorded_at: recordedThu,
    });
    h.store.put(`audio/${late.json.path}`);
    const done = await h.call('POST', `uploads/${late.json.uploadId}/complete`);
    assertEquals(done.status, 200);
    const report = h.store.reports.find((r) => r.id === done.json.reportId)!;
    assertEquals(report.is_late, true);
    assertEquals(h.store.lateNotices, [{ reportId: report.id, uploadId: late.json.uploadId }]);
    // A retried complete flags nothing twice.
    await h.call('POST', `uploads/${late.json.uploadId}/complete`);
    assertEquals(h.store.lateUploads, [late.json.uploadId]);
    assertEquals(
      h.store.audits.filter((a) => a.action === 'upload.accepted_late').length,
      1,
      'one audit row per upload',
    );

    // Refused: a recording time outside Thursday's window (Friday 14:00), one in the future, none.
    assertEquals(
      (await up({ date: '2026-10-08', recordedAt: '2026-10-09T19:00:00Z' })).json.error,
      'date_not_allowed',
    );
    assertEquals(
      (await up({ date: '2026-10-08', recordedAt: '2026-10-09T23:00:00Z' })).json.error,
      'date_not_allowed',
    );
    // A date never allowed (Wednesday) even with a time on it.
    assertEquals(
      (await up({ date: '2026-10-07', recordedAt: recordedThu })).json.error,
      'date_not_allowed',
    );
    // 48 h after the window: Sun Oct 11, 12:00 Chicago (17:00Z) is the last moment.
    h.clock.now = new Date('2026-10-11T17:00:00Z');
    assertEquals((await up({ date: '2026-10-08', recordedAt: recordedThu })).status, 201);
    h.clock.now = new Date('2026-10-11T17:01:00Z');
    assertEquals(
      (await up({ date: '2026-10-08', recordedAt: recordedThu })).json.error,
      'date_not_allowed',
    );
  },
);

Deno.test('uploads/:id/complete: an on-time upload is not flagged late', async () => {
  const h = setup();
  await consented(h);
  const u = await h.call('POST', 'uploads', {
    body: { kind: 'audio', mime: 'audio/webm', bytes: 1, siteId: SITE_A },
  });
  h.store.put(`audio/${u.json.path}`);
  await h.call('POST', `uploads/${u.json.uploadId}/complete`);
  assertEquals(h.store.calls.includes('flagLateUpload'), false);
});

Deno.test(
  'uploads/:id/complete: a retry after the window of an upload that arrived on time is not late',
  async () => {
    const h = setup();
    await consented(h);
    const u = await h.call('POST', 'uploads', {
      body: { kind: 'audio', mime: 'audio/webm', bytes: 1, siteId: SITE_A },
    });
    h.store.put(`audio/${u.json.path}`);
    // Completed Fri Oct 9 17:00 Chicago (the answer lost); the queue retries Mon Oct 12 at 13:00,
    // after Friday's window closed (Monday noon).
    assertEquals((await h.call('POST', `uploads/${u.json.uploadId}/complete`)).status, 200);
    h.clock.now = new Date('2026-10-12T18:00:00Z');
    const retry = await h.call('POST', `uploads/${u.json.uploadId}/complete`);
    assertEquals([retry.status, retry.json.alreadyComplete], [200, true]);
    assertEquals(h.store.calls.includes('flagLateUpload'), false);
    const report = h.store.reports.find((r) => r.id === retry.json.reportId)!;
    assertEquals(report.is_late, false);
  },
);

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

Deno.test(
  'day-status (W2-08, spec §19 Q41): Weather from 09:00 with 12 on site makes a report with answered questions',
  async () => {
    const h = setup();
    await consented(h);
    const res = await h.call('POST', 'day-status', {
      body: {
        siteId: SITE_A,
        status: 'weather_day',
        details: { since: '09:00', workersBefore: 12 },
      },
    });
    assertEquals([res.status, res.json.status, res.json.changed], [200, 'weather_day', true]);
    const made = res.json.report as { id: string; reportNo: string };
    const report = h.store.reports.find((r) => r.id === made.id)!;
    assertEquals(
      [report.kind, report.status, report.channel, made.reportNo],
      ['weather_day', 'processing', 'web', report.report_no],
    );
    const questions = h.store.questions.filter((q) => q.report_id === report.id);
    assertEquals(
      questions.map((q) => [q.field, q.prompt, (q.answer as { text: string }).text]),
      [
        ['weather.impact', 'Since when?', '09:00'],
        ['manpower.workers', 'How many were on site before?', '12'],
      ],
    );
    const version = h.store.versions.find((v) => v.report_id === report.id)!;
    const data = version.data as {
      weather: { periods: { lostHours: number; source: unknown[] }[] };
      manpower: { workers: number; totalHours: number; source: unknown[] }[];
    };
    // Computed in code: 09:00 → 15:30 is 6.5 h lost; 12 × 2 h worked = 24 h.
    assertEquals(data.weather.periods[0]!.lostHours, 6.5);
    assertEquals(data.weather.periods[0]!.source, [
      { type: 'answer', questionId: questions[0]!.id },
    ]);
    assertEquals([data.manpower[0]!.workers, data.manpower[0]!.totalHours], [12, 24]);
    assertEquals(
      h.store.jobs.filter((j) => j.type === 'file_report').map((j) => j.payload),
      [{ reportId: report.id, trigger: 'weather_day' }],
    );
    // Today shows the day closed with its weather-day report.
    const today = await h.call('GET', `today?site=${SITE_A}`);
    assertEquals(today.json.dayStatus, 'weather_day');
    assertEquals((today.json.report as { kind: string }).kind, 'weather_day');
    // A retried tap: the same report, nothing new.
    const again = await h.call('POST', 'day-status', {
      body: { siteId: SITE_A, status: 'weather_day', details: { since: '09:00' } },
    });
    assertEquals(
      [again.json.changed, (again.json.report as { id: string }).id],
      [false, report.id],
    );
    // A weather day needs "Since when?".
    const noSince = await h.call('POST', 'day-status', {
      body: { siteId: SITE_B, status: 'weather_day', details: { workersBefore: 3 } },
    });
    assertEquals([noSince.status, noSince.json.error], [400, 'invalid_request']);
    // No work without a no-work PDF: the site-day only.
    const nw = await h.call('POST', 'day-status', { body: { siteId: SITE_B, status: 'no_work' } });
    assertEquals([nw.status, nw.json.status, nw.json.report], [200, 'no_work', null]);
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
    voice_answers: [],
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
    manpowerIndex: null,
    voice: null,
  });
  // The crew the question is about, for "Heard at 1:20 in your note" (W1-13).
  h.store.questions[0]!.target = { manpowerIndex: 0, path: 'manpower.workers:Delta' };
  assertEquals(
    ((await h.call('GET', `reports/${reportId}`)).json.question as { manpowerIndex: number })
      .manpowerIndex,
    0,
  );
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
  assertEquals([p.json.contactPref, p.json.locale], ['call', 'es-US']);
  assertEquals(
    (await h.call('PATCH', 'preferences', { body: { messageChannel: 'whatsapp' } })).json.error,
    'channel_not_offered',
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
    const draft: ReportVersionRow = {
      report_id: reportId,
      version: 2,
      data: emptyReportDataV1('2026-10-09') as never,
      summary: null,
      pdf_path: null,
      author: 'agent',
      author_user_id: null,
      author_message_id: null,
      change_note: null,
      created_at: T0.toISOString(),
      via: null,
      draft_rev: 1,
    };
    h.store.versions.push(draft);
    const stale = await h.call('POST', `reports/${reportId}/confirm`, {
      body: { version: 1, draftRev: 1 },
    });
    assertEquals(
      [stale.status, stale.json.error, stale.json.currentVersion],
      [409, 'draft_changed', 2],
    );
    assertEquals(
      (await h.call('POST', `reports/${reportId}/confirm`, { body: { version: 'x', draftRev: 1 } }))
        .json.error,
      'invalid_request',
    );
    // The revision is required.
    assertEquals(
      (await h.call('POST', `reports/${reportId}/confirm`, { body: { version: 2 } })).json.error,
      'invalid_request',
    );
    // The same version re-extracted in place (a late photo) is a newer draft too.
    draft.draft_rev = 2;
    const rewritten = await h.call('POST', `reports/${reportId}/confirm`, {
      body: { version: 2, draftRev: 1 },
    });
    assertEquals(
      [rewritten.status, rewritten.json.error, rewritten.json.draftRev],
      [409, 'draft_changed', 2],
    );
    assertEquals(
      h.store.jobs.filter((j) => j.type === 'file_report'),
      [],
    );
    const ok = await h.call('POST', `reports/${reportId}/confirm`, {
      body: { version: 2, draftRev: 2 },
    });
    assertEquals([ok.status, ok.json.status], [202, 'queued']);
    assertEquals(h.store.jobs.find((j) => j.type === 'file_report')!.payload.version, 2);
    assertEquals(h.store.jobs.find((j) => j.type === 'file_report')!.payload.draftRev, 2);

    // D16: that filing completed stale (the report left and came back to awaiting_confirmation
    // at v2); the next confirm is a new occurrence, not the finished job.
    h.store.jobs.find((j) => j.type === 'file_report')!.status = 'done';
    const again = await h.call('POST', `reports/${reportId}/confirm`, {
      body: { version: 2, draftRev: 2 },
    });
    assertEquals([again.status, again.json.status], [202, 'queued']);
    assertEquals(
      h.store.jobs.filter((j) => j.type === 'file_report').map((j) => [j.dedupe_key, j.status]),
      [
        [`file:${reportId}:v2:r2`, 'done'],
        [`file:${reportId}:v2:r2:c2`, 'queued'],
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
    sendDailyLink: () => Promise.resolve({ channel: 'sms', messageId: 'x' }),
    fieldAppUrl: () => FIELD_APP,
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
      sendDailyLink: () => Promise.resolve({ channel: 'sms', messageId: 'x' }),
      fieldAppUrl: () => FIELD_APP,
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

/** A web report awaiting an answer: the Delta draft (v2) and its open headcount question. */
async function awaitingAnswer(h: Harness, siteId = SITE_A) {
  await consented(h);
  const u = await h.call('POST', 'uploads', {
    body: { kind: 'audio', mime: 'audio/webm', bytes: 1, siteId },
  });
  h.store.put(`audio/${u.json.path}`);
  const done = await h.call('POST', `uploads/${u.json.uploadId}/complete`);
  const reportId = done.json.reportId as string;
  const report = h.store.reports.find((r) => r.id === reportId)!;
  report.status = 'awaiting_answer';
  const data: DailyReportData = {
    ...emptyReportData('2026-10-09', { reportLanguage: 'en', units: 'imperial' }),
    summary: 'Ductwork on Level 2.',
    manpower: [
      {
        companyId: 'delta',
        companyNameHeard: 'the Delta guys',
        companyName: 'Delta Mechanical',
        area: 'Level 2',
        workers: null,
        hoursPerWorker: 8,
        totalHours: null,
        hoursBasis: 'full_day_default',
        confidence: 0.85,
        source: [{ type: 'voice_note', uploadId: u.json.uploadId as string, start: 33 }],
      },
    ],
  };
  h.store.versions.push({
    report_id: reportId,
    version: 1,
    data: data as never,
    summary: null,
    pdf_path: null,
    author: 'agent',
    author_user_id: null,
    author_message_id: null,
    change_note: null,
    created_at: T0.toISOString(),
    via: null,
  });
  const question = (over: Partial<QuestionRow> = {}): QuestionRow => ({
    id: '11111111-0000-4000-8000-00000000f101',
    report_id: reportId,
    field: 'manpower.workers',
    target: { manpowerIndex: 0, path: 'manpower.workers:Delta Mechanical' },
    prompt: 'Quick check: the Delta guys on Level 2. How many?',
    options: [
      { id: 'o1', label: '4 · full day' },
      { id: 'o2', label: '5 · full day' },
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
    voice_answers: [],
    ...over,
  });
  h.store.questions.push(question());
  return { reportId, report, question, questionId: '11111111-0000-4000-8000-00000000f101' };
}

Deno.test(
  'answer (W1-12): an option is mapped in code, the draft and question updated, decide_next queued once',
  async () => {
    const h = setup();
    const { reportId, questionId } = await awaitingAnswer(h);
    const res = await h.call('POST', `reports/${reportId}/answer`, {
      body: { questionId, optionId: 'o2' },
    });
    assertEquals(
      [res.status, res.json],
      [
        202,
        {
          status: 'processing',
          reportStatus: 'processing',
          // F7's confirmation line (W1-13): the numbers of the draft the answer made.
          confirmation: {
            kind: 'crew',
            company: 'Delta Mechanical',
            workers: 5,
            hoursPerWorker: 8,
            totalHours: 40,
          },
        },
      ],
    );
    const data = h.store.versions[0]!.data as unknown as DailyReportData;
    assertEquals(
      [data.manpower[0]!.workers, data.manpower[0]!.hoursPerWorker, data.manpower[0]!.totalHours],
      [5, 8, 40],
    );
    assertEquals(data.manpower[0]!.source.at(-1), { type: 'answer', questionId });
    const q = h.store.questions[0]!;
    assertEquals(q.answer_source, { type: 'answer', questionId });
    assertEquals(q.answer, {
      optionId: 'o2',
      text: '5 · full day',
      parsed: { workers: 5, fullDay: true },
      via: 'web',
    });
    assertEquals(
      h.store.jobs.map((j) => [j.type, j.dedupe_key]),
      [
        ['transcribe_upload', h.store.jobs[0]!.dedupe_key],
        ['decide_next', `decide:${reportId}:answer:${questionId}`],
      ].slice(h.store.jobs[0]!.type === 'transcribe_upload' ? 0 : 1),
    );
    assert(h.store.audits.some((a) => a.action === 'report.question_answered'));

    // A retry (the answer lost on the way back) is answered the same way; nothing runs twice.
    const again = await h.call('POST', `reports/${reportId}/answer`, {
      body: { questionId, optionId: 'o2' },
    });
    assertEquals([again.status, again.json.status], [200, 'already_answered']);
    assertEquals((again.json.confirmation as { totalHours: number }).totalHours, 40);
    assertEquals(h.store.jobs.filter((j) => j.type === 'decide_next').length, 1);
    // Another answer to the answered question is refused.
    const other = await h.call('POST', `reports/${reportId}/answer`, {
      body: { questionId, optionId: 'o1' },
    });
    assertEquals([other.status, other.json.error], [409, 'question_closed']);
  },
);

Deno.test('answer (W1-12, D28): a typed headcount with the hours the reporter set', async () => {
  const h = setup();
  const { reportId, questionId } = await awaitingAnswer(h);
  // Neither or both of optionId and value: refused before anything is read.
  assertEquals(
    (await h.call('POST', `reports/${reportId}/answer`, { body: { questionId } })).json.error,
    'invalid_request',
  );
  assertEquals(
    (
      await h.call('POST', `reports/${reportId}/answer`, {
        body: { questionId, optionId: 'o1', value: 4 },
      })
    ).json.error,
    'invalid_request',
  );
  // A fraction of a person is not a headcount.
  const half = await h.call('POST', `reports/${reportId}/answer`, {
    body: { questionId, value: 4.5 },
  });
  assertEquals([half.status, half.json.error], [400, 'answer_not_accepted']);
  const res = await h.call('POST', `reports/${reportId}/answer`, {
    body: { questionId, value: 4, hours: 6 },
  });
  assertEquals(res.status, 202);
  const m = (h.store.versions[0]!.data as unknown as DailyReportData).manpower[0]!;
  assertEquals([m.workers, m.hoursPerWorker, m.totalHours, m.hoursBasis], [4, 6, 24, 'answer']);
  assertEquals((h.store.questions[0]!.answer as { text: string }).text, '4 · 6 h');
  assertEquals(res.json.confirmation, {
    kind: 'crew',
    company: 'Delta Mechanical',
    workers: 4,
    hoursPerWorker: 6,
    totalHours: 24,
  });
});

/** W2-09: an answer clip for the open question: created, put, completed. */
async function answerClip(h: Harness, reportId: string, questionId: string) {
  const u = await h.call('POST', 'uploads', {
    body: { kind: 'audio', mime: 'audio/webm', bytes: 2, answerTo: { reportId, questionId } },
  });
  assertEquals(u.status, 201);
  h.store.put(`audio/${u.json.path}`);
  return u.json as { uploadId: string; path: string };
}

Deno.test(
  'answer by voice (W2-09, F7 Other…): the clip is staged, never report material; parse_answer queued once',
  async () => {
    const h = setup();
    const { reportId, questionId } = await awaitingAnswer(h);
    const clip = await answerClip(h, reportId, questionId);
    // The clip goes in the report's site and day, and names the question.
    const row = h.store.uploads.find((x) => x.id === clip.uploadId)!;
    assertEquals(
      [row.question_id, row.site_id, row.storage_path.split('/')[2]],
      [questionId, SITE_A, '2026-10-09'],
    );
    // Answering before the clip is complete is refused.
    const early = await h.call('POST', `reports/${reportId}/answer`, {
      body: { questionId, uploadId: clip.uploadId },
    });
    assertEquals([early.status, early.json.error], [409, 'upload_missing']);

    const jobsBefore = h.store.jobs.length;
    const done = await h.call('POST', `uploads/${clip.uploadId}/complete`);
    assertEquals(
      [done.status, done.json.reportId, done.json.reportStatus],
      [200, reportId, 'awaiting_answer'],
    );
    // Not a voice note of the report: no transcription, no new status, not counted.
    assertEquals(h.store.jobs.length, jobsBefore);
    const view = await h.call('GET', `reports/${reportId}`);
    assertEquals((view.json.progress as { voiceNotes: number }).voiceNotes, 1);
    assertEquals((view.json.question as { voice: unknown }).voice, null);

    const res = await h.call('POST', `reports/${reportId}/answer`, {
      body: { questionId, uploadId: clip.uploadId },
    });
    assertEquals(
      [res.status, res.json],
      [202, { status: 'listening', reportStatus: 'awaiting_answer', confirmation: null }],
    );
    const parse = h.store.jobs.filter((j) => j.type === 'parse_answer');
    assertEquals(
      parse.map((j) => [j.dedupe_key, j.payload]),
      [
        [
          `answer:${questionId}:${clip.uploadId}`,
          { reportId, questionId, uploadId: clip.uploadId },
        ],
      ],
    );
    assert(h.store.audits.some((a) => a.action === 'report.answer_spoken'));
    // The report still awaits the answer; the question shows "Listening to your answer…".
    const listening = await h.call('GET', `reports/${reportId}`);
    assertEquals(
      [listening.json.status, (listening.json.question as { voice: unknown }).voice],
      ['awaiting_answer', { state: 'listening', unclear: 0 }],
    );
    assertEquals(listening.json.lastVoiceAnswer, null);

    // A retry of the same clip is answered the same way; nothing is queued twice.
    const again = await h.call('POST', `reports/${reportId}/answer`, {
      body: { questionId, uploadId: clip.uploadId },
    });
    assertEquals([again.status, again.json.status], [202, 'listening']);
    assertEquals(h.store.jobs.filter((j) => j.type === 'parse_answer').length, 1);
    // A second clip while the first is being listened to waits for it.
    const second = await answerClip(h, reportId, questionId);
    await h.call('POST', `uploads/${second.uploadId}/complete`);
    const pending = await h.call('POST', `reports/${reportId}/answer`, {
      body: { questionId, uploadId: second.uploadId },
    });
    assertEquals([pending.status, pending.json.error], [409, 'answer_pending']);
  },
);

Deno.test(
  'answer by voice (W2-09): scope, closed questions, other clips; the retry and the outcome views',
  async () => {
    const h = setup();
    const { reportId, questionId, report } = await awaitingAnswer(h);
    // An answer clip is audio, for the question's report only, and takes no site or date.
    const photo = await h.call('POST', 'uploads', {
      body: { kind: 'photo', mime: 'image/jpeg', bytes: 2, answerTo: { reportId, questionId } },
    });
    assertEquals([photo.status, photo.json.error], [400, 'invalid_request']);
    const withSite = await h.call('POST', 'uploads', {
      body: {
        kind: 'audio',
        mime: 'audio/webm',
        bytes: 2,
        siteId: SITE_A,
        answerTo: { reportId, questionId },
      },
    });
    assertEquals(withSite.status, 400);
    const unknown = await h.call('POST', 'uploads', {
      body: {
        kind: 'audio',
        mime: 'audio/webm',
        bytes: 2,
        answerTo: { reportId, questionId: '11111111-0000-4000-8000-00000000f999' },
      },
    });
    assertEquals([unknown.status, unknown.json.error], [404, 'not_found']);
    // A report outside the link's sites is not found (the daily link of Pier 9).
    const outside = await h.call('POST', 'uploads', {
      code: CODES.marcoDaily,
      body: { kind: 'audio', mime: 'audio/webm', bytes: 2, answerTo: { reportId, questionId } },
    });
    assertEquals(outside.status, 404);
    // A report voice note is not an answer clip.
    const note = h.store.uploads.find((u) => u.report_id === reportId && !u.question_id)!;
    const notClip = await h.call('POST', `reports/${reportId}/answer`, {
      body: { questionId, uploadId: note.id },
    });
    assertEquals([notClip.status, notClip.json.error], [404, 'not_found']);

    // The worker could not read the first clip: the question is asked once more.
    const clip = await answerClip(h, reportId, questionId);
    await h.call('POST', `uploads/${clip.uploadId}/complete`);
    await h.call('POST', `reports/${reportId}/answer`, {
      body: { questionId, uploadId: clip.uploadId },
    });
    const q = h.store.questions[0]!;
    q.voice_answers = [{ uploadId: clip.uploadId, at: T0.toISOString(), status: 'unclear' }];
    const retry = await h.call('GET', `reports/${reportId}`);
    assertEquals((retry.json.question as { voice: unknown }).voice, { state: 'retry', unclear: 1 });

    // Applied by the worker: the question answered with code's confirmation.
    Object.assign(q, {
      answered_at: T0.toISOString(),
      answer: {
        voice: { uploadId: clip.uploadId },
        parsed: { workers: 5, fullDay: true },
        confirmation: {
          kind: 'crew',
          company: 'Delta Mechanical',
          workers: 5,
          hoursPerWorker: 8,
          totalHours: 40,
        },
      },
    });
    report.status = 'processing';
    const applied = await h.call('GET', `reports/${reportId}`);
    assertEquals(applied.json.lastVoiceAnswer, {
      questionId,
      outcome: 'applied',
      confirmation: {
        kind: 'crew',
        company: 'Delta Mechanical',
        workers: 5,
        hoursPerWorker: 8,
        totalHours: 40,
      },
    });
    // A clip for an answered question is refused.
    const late = await h.call('POST', 'uploads', {
      body: { kind: 'audio', mime: 'audio/webm', bytes: 2, answerTo: { reportId, questionId } },
    });
    assertEquals([late.status, late.json.error], [409, 'question_closed']);
    // Unclear twice: the view says so (F7 "then move on and flag").
    q.answer = { unanswered: true, unclear: true, via: 'web' };
    const unclear = await h.call('GET', `reports/${reportId}`);
    assertEquals(unclear.json.lastVoiceAnswer, { questionId, outcome: 'unclear' });
  },
);

Deno.test(
  'answer (W1-12): scoped like the other routes; wrong question, state or answer refused',
  async () => {
    const h = setup();
    const { reportId, report, question, questionId } = await awaitingAnswer(h);
    const answer = (body: Record<string, unknown>, o: { code?: string | null } = {}) =>
      h.call('POST', `reports/${reportId}/answer`, { body, ...o });

    // No verified device: 401 whatever the report.
    const anon = await h.call('POST', `reports/${reportId}/answer`, {
      body: { questionId, optionId: 'o1' },
      cookies: {},
    });
    assertEquals([anon.status, anon.json.error], [401, 'device_unverified']);
    // A question of another report, an unknown option, a number for an option question's field.
    assertEquals(
      (await answer({ questionId: '11111111-0000-4000-8000-00000000f999', optionId: 'o1' })).status,
      404,
    );
    assertEquals((await answer({ questionId, optionId: 'zz' })).json.error, 'answer_not_accepted');
    // A WhatsApp question (no channel) is not the web's to answer.
    h.store.questions.push(
      question({ id: '11111111-0000-4000-8000-00000000f102', channel: null, field: 'safety' }),
    );
    assertEquals(
      (await answer({ questionId: '11111111-0000-4000-8000-00000000f102', optionId: 'o1' })).json
        .error,
      'question_closed',
    );
    // Not awaiting an answer (a new voice note reopened processing): refused, nothing written.
    report.status = 'processing';
    const busy = await answer({ questionId, optionId: 'o1' });
    assertEquals([busy.status, busy.json.error], [409, 'wrong_state']);
    assertEquals(h.store.questions[0]!.answered_at, null);
    report.status = 'awaiting_answer';
    // Safety takes no number.
    h.store.questions[0]!.field = 'safety';
    assertEquals((await answer({ questionId, value: 1 })).json.error, 'answer_not_accepted');
    h.store.questions[0]!.field = 'manpower.workers';

    // Dana's link: the report is on her site (Riverside), so she may answer it; a report of a site
    // she is not on (Pier 9) is not found.
    const pier = setup();
    const p = await awaitingAnswer(pier, SITE_B);
    await consented(pier, CODES.dana);
    const theirs = await pier.call('POST', `reports/${p.reportId}/answer`, {
      body: { questionId: p.questionId, optionId: 'o1' },
      code: CODES.dana,
    });
    assertEquals([theirs.status, theirs.json.error], [404, 'not_found']);
    assertEquals(pier.store.questions[0]!.answered_at, null);
  },
);

// ── Settings (F15, W2-02) ─────────────────────────────────────────────────────────────────────

Deno.test(
  'Settings: GET preferences shows the preference, channels and every consent given (and texts)',
  async () => {
    const h = setup();
    await verifiedDevice(h);
    // Before consent the Settings routes still answer (they need a verified device only).
    const before = await h.call('GET', 'preferences');
    assertEquals(before.status, 200);
    assertEquals(before.json, {
      contactPref: 'link',
      locale: 'en-US',
      messageChannel: null,
      messageChannels: ['sms'],
      // The texts consent is listed while the pack texts, so Settings can offer Turn on (Q86).
      consents: [{ type: 'sms', held: false }],
      textsOptedOut: false,
    });
    await h.call('POST', 'consent', {
      body: {
        types: ['recording', 'data_processing', 'sms'],
        textVersion: 'field.consent.v1',
        contactPref: 'link',
        locale: 'en-US',
      },
    });
    assertEquals((await h.call('GET', 'preferences')).json.consents, [
      { type: 'sms', held: true },
      { type: 'recording', held: true },
      { type: 'data_processing', held: true },
    ]);
    // No device: the same 401 as every other route.
    assertEquals(
      (await h.call('GET', 'preferences', { cookies: null })).json.error,
      'device_unverified',
    );
  },
);

Deno.test(
  "Settings: PATCH preferences takes the pack's built channels only (Q21), audited",
  async () => {
    const h = setup({ country: { message_channels: ['sms', 'whatsapp'] } });
    await consented(h);
    // WhatsApp is listed by the pack but not built (W2-15): not offered.
    const wa = await h.call('PATCH', 'preferences', { body: { messageChannel: 'whatsapp' } });
    assertEquals(
      [wa.status, wa.json.error, wa.json.offered],
      [400, 'channel_not_offered', ['sms']],
    );
    assertEquals(
      (await h.call('PATCH', 'preferences', { body: { messageChannel: 'push' } })).json.error,
      'channel_not_offered',
    );
    const sms = await h.call('PATCH', 'preferences', {
      body: { messageChannel: 'sms', contactPref: 'call', locale: 'es-US' },
    });
    assertEquals(sms.status, 200);
    assertEquals(
      [sms.json.messageChannel, sms.json.contactPref, sms.json.locale, sms.json.messageChannels],
      ['sms', 'call', 'es-US', ['sms']],
    );
    const marco = h.store.reporters.find((r) => r.id === MARCO)!;
    assertEquals(
      [marco.message_channel, marco.contact_pref, marco.locale],
      ['sms', 'call', 'es-US'],
    );
    const changed = h.store.audits
      .filter((a) => a.action === 'reporter.preferences_changed')
      .at(-1)!;
    const diff = changed.diff as Record<string, unknown>;
    assertEquals(changed.actorType, 'reporter');
    assertEquals(diff.from, { contact_pref: 'link', locale: 'en-US', message_channel: null });
    assertEquals(diff.to, { contact_pref: 'call', locale: 'es-US', message_channel: 'sms' });
    assert(diff.device_id, 'the device it came from');
    // null = the pack's order again; the same value again changes and audits nothing.
    const audits = h.store.audits.length;
    await h.call('PATCH', 'preferences', { body: { messageChannel: 'sms' } });
    assertEquals(h.store.audits.length, audits);
    assertEquals(
      (await h.call('PATCH', 'preferences', { body: { messageChannel: null } })).json
        .messageChannel,
      null,
    );
    // "Don't call me today" is M8's.
    assertEquals(
      (await h.call('PATCH', 'preferences', { body: { noCallsToday: true } })).json.error,
      'invalid_request',
    );
  },
);

Deno.test('Settings: turning texts off revokes the sms consent only; reports go on', async () => {
  const h = setup();
  await consented(h);
  const res = await h.call('POST', 'consent/revoke', { body: { type: 'sms' } });
  assertEquals(res.status, 200);
  assertEquals(res.json.consents, [
    { type: 'sms', held: false },
    { type: 'recording', held: true },
    { type: 'data_processing', held: true },
  ]);
  const row = h.store.consents.find((c) => c.type === 'sms')!;
  assertEquals(row.revoked_at, T0.toISOString());
  const audit = h.store.audits.find((a) => a.action === 'consent.revoked')!;
  assertEquals([audit.actorType, audit.actorId, audit.entityId], ['reporter', MARCO, row.id]);
  assertEquals((audit.diff as Record<string, unknown>).type, 'sms');
  // Per Q40 (first option) the SMS opt-out is the revoked consent; the status stays as it was.
  assertEquals(h.store.reporters.find((r) => r.id === MARCO)!.status, 'active');
  assertEquals(h.store.consentNotices, []);
  assertEquals((await h.call('GET', 'today')).status, 200);
  // Again: nothing held, nothing changes.
  await h.call('POST', 'consent/revoke', { body: { type: 'sms' } });
  assertEquals(h.store.audits.filter((a) => a.action === 'consent.revoked').length, 1);
  assertEquals(
    (await h.call('POST', 'consent/revoke', { body: { type: 'whatsapp' } })).json.error,
    'invalid_request',
  );
});

Deno.test(
  'Settings: Turn on records a fresh texts consent, audited like the revoke (Q86)',
  async () => {
    const h = setup();
    await consented(h);
    await h.call('POST', 'consent/revoke', { body: { type: 'sms' } });
    const res = await h.call('POST', 'consent/grant', {
      body: { type: 'sms', textVersion: 'field.consent.v1' },
    });
    assertEquals(res.status, 200);
    assertEquals(res.json.consents, [
      { type: 'sms', held: true },
      { type: 'recording', held: true },
      { type: 'data_processing', held: true },
    ]);
    assertEquals(res.json.textsOptedOut, false);
    const rows = h.store.consents.filter((c) => c.reporter_id === MARCO && c.type === 'sms');
    assertEquals(rows.length, 2, 'the revoked row stays; a new row is the consent');
    const fresh = rows.find((c) => c.revoked_at === null)!;
    assertEquals([fresh.method, fresh.text_version], ['web_checkbox', 'field.consent.v1']);
    assertEquals((fresh.evidence as Record<string, unknown>).device_id, h.store.devices[0]!.id);
    const given = h.store.audits.filter((a) => a.action === 'consent.given').at(-1)!;
    assertEquals([given.actorType, given.actorId, given.entityId], ['reporter', MARCO, fresh.id]);
    assertEquals(given.diff, {
      type: 'sms',
      method: 'web_checkbox',
      text_version: 'field.consent.v1',
      via: 'settings',
      device_id: h.store.devices[0]!.id,
    });
    // Held already: nothing changes, nothing audited.
    const audits = h.store.audits.length;
    await h.call('POST', 'consent/grant', {
      body: { type: 'sms', textVersion: 'field.consent.v1' },
    });
    assertEquals(h.store.audits.length, audits);
    // Texts only: recording and processing come back through the Welcome & consent screen.
    assertEquals(
      (await h.call('POST', 'consent/grant', { body: { type: 'recording', textVersion: 'v1' } }))
        .json.error,
      'invalid_request',
    );
  },
);

Deno.test('Settings: Turn on checks the wording version and the pack (Q86)', async () => {
  const h = setup({ country: { legal_keys: { consent: 'US.consent.v1' } } });
  await verifiedDevice(h);
  // Texts never given (the box was unticked on Welcome): listed, off.
  await h.call('POST', 'consent', {
    body: {
      types: ['recording', 'data_processing'],
      textVersion: 'US.consent.v1',
      contactPref: 'link',
      locale: 'en-US',
    },
  });
  const before = (await h.call('GET', 'preferences')).json.consents as unknown[];
  assertEquals(before[0], { type: 'sms', held: false });
  const stale = await h.call('POST', 'consent/grant', {
    body: { type: 'sms', textVersion: 'field.consent.v1' },
  });
  assertEquals(
    [stale.status, stale.json.error, stale.json.textVersion],
    [409, 'text_version_mismatch', 'US.consent.v1'],
  );
  const ok = await h.call('POST', 'consent/grant', {
    body: { type: 'sms', textVersion: 'US.consent.v1' },
  });
  assertEquals((ok.json.consents as unknown[])[0], { type: 'sms', held: true });

  const noTexts = setup({ country: { message_channels: ['whatsapp'] } });
  await consented(noTexts);
  const refused = await noTexts.call('POST', 'consent/grant', {
    body: { type: 'sms', textVersion: 'field.consent.v1' },
  });
  assertEquals([refused.status, refused.json.error], [400, 'channel_not_offered']);
});

Deno.test(
  'Settings: Turn on never overrides an opt-out (STOP or the phone on the pack, Q86)',
  async () => {
    const h = setup();
    await consented(h);
    await h.call('POST', 'consent/revoke', { body: { type: 'sms' } });
    const marco = h.store.reporters.find((r) => r.id === MARCO)!;
    const grant = () =>
      h.call('POST', 'consent/grant', { body: { type: 'sms', textVersion: 'field.consent.v1' } });

    // The reporter row opted out (SMS STOP).
    marco.status = 'opted_out';
    assertEquals((await h.call('GET', 'preferences')).json.textsOptedOut, true);
    const stopped = await grant();
    assertEquals([stopped.status, stopped.json.error], [409, 'texts_opted_out']);
    // The phone on the pack's sender (`sms_opt_outs`), whoever it belonged to then.
    marco.status = 'active';
    h.store.optOuts.add(`${marco.phone_e164}|US`);
    assertEquals((await grant()).json.error, 'texts_opted_out');
    assertEquals(
      h.store.consents.filter((c) => c.type === 'sms' && c.revoked_at === null).length,
      0,
      'no consent row',
    );
    assertEquals(h.store.audits.filter((a) => a.action === 'consent.given').length, 3); // Welcome only
    // An opt-out on another pack's sender does not bind this one; after START it goes.
    h.store.optOuts.clear();
    h.store.optOuts.add(`${marco.phone_e164}|TR`);
    const ok = await grant();
    assertEquals([ok.status, ok.json.textsOptedOut], [200, false]);
  },
);

Deno.test(
  'Settings: revoking recording stops every route but resolve, device/*, consent and Settings, and tells the office',
  async () => {
    const h = setup();
    await consented(h);
    const res = await h.call('POST', 'consent/revoke', { body: { type: 'recording' } });
    assertEquals(res.status, 200);
    assertEquals(h.store.consentNotices, [{ orgId: ORG, reporterId: MARCO, type: 'recording' }]);
    const revoked = h.store.audits.find((a) => a.action === 'consent.revoked')!;
    assertEquals((revoked.diff as Record<string, unknown>).notified, true);
    for (const [method, path, body] of [
      ['GET', 'today'],
      ['GET', 'history'],
      ['POST', 'uploads', { kind: 'audio', mime: 'audio/webm', bytes: 1, siteId: SITE_A }],
      ['POST', 'day-status', { siteId: SITE_A, status: 'no_work' }],
    ] as const) {
      const r = await h.call(method, path, { body });
      assertEquals([path, r.status, r.json.error], [path, 403, 'consent_required']);
    }
    // Still open: resolve (needsConsent again), Settings, and consent to report again.
    const resolved = await h.call('POST', 'resolve', { body: { code: CODES.marco }, code: null });
    assertEquals(resolved.json.needsConsent, true);
    assertEquals((await h.call('GET', 'preferences')).status, 200);
    assertEquals(
      (await h.call('POST', 'consent/revoke', { body: { type: 'data_processing' } })).status,
      200,
    );
    assertEquals(h.store.consentNotices.length, 2);
    const again = await h.call('POST', 'consent', {
      body: {
        types: ['recording', 'data_processing'],
        textVersion: 'field.consent.v1',
        contactPref: 'link',
        locale: 'en-US',
      },
    });
    assertEquals(again.status, 200);
    assertEquals((await h.call('GET', 'today')).status, 200);
  },
);

Deno.test(
  'Settings: sign out revokes this device, clears its cookie, and the phone must verify again',
  async () => {
    const h = setup();
    await consented(h);
    const device = h.store.devices[0]!;
    const out = await h.call('POST', 'device/sign-out');
    assertEquals([out.status, out.json], [200, { signedOut: true }]);
    assertEquals(device.revoked_at, T0.toISOString());
    const cleared = out.headers
      .getSetCookie()
      .find((c) => c.startsWith(`${deviceCookieName(MARCO)}=`))!;
    assertMatch(cleared, /Max-Age=0/);
    assertMatch(cleared, /Path=\//);
    const audit = h.store.audits.find((a) => a.action === 'device.signed_out')!;
    assertEquals([audit.entity, audit.entityId, audit.actorId], ['field_device', device.id, MARCO]);
    // The phone is back to the device check.
    assertEquals((await h.call('GET', 'today')).json.error, 'device_unverified');
    assertEquals(
      (await h.call('POST', 'resolve', { body: { code: CODES.marco }, code: null })).json
        .needsDeviceCheck,
      true,
    );
    // A new code makes a new device; the revoked one stays revoked.
    await verifiedDevice(h);
    assertEquals(h.store.devices.length, 2);
    assertEquals((await h.call('GET', 'today')).status, 200);
    assertEquals((await h.call('POST', 'device/sign-out', { cookies: null })).status, 401);
  },
);

Deno.test(
  'Settings: with texts turned off, the device code still goes by SMS (Q25, W2-02)',
  async () => {
    const messaging = fakeMessaging();
    const send = notifierCodeSender(messaging.notifier);
    const h: Harness = setup({
      sender: () => (m) => {
        h.sent.push(m);
        return send(m);
      },
    });
    await consented(h);
    await h.call('POST', 'consent/revoke', { body: { type: 'sms' } });
    await h.call('POST', 'device/sign-out');
    const sent = await h.call('POST', 'device/send-code');
    assertEquals(sent.status, 202);
    assertEquals(messaging.rows.filter((r) => r.copy_key === 'verify_code').length, 2);
  },
);

// ── F16: expired link → Send me today's link (W2-03) ─────────────────────────────────────────────

Deno.test(
  "expired/daily-link: an expired daily link texts today's link of its site, once a day",
  async () => {
    const h = setup();
    const expiredLink = h.store.links.find((l) => l.code_hash === linkCodeHash(CODES.expired))!;
    // No cookie needed: the phone that holds an expired link may be new.
    const res = await h.call('POST', 'expired/daily-link', {
      body: { code: CODES.expired },
      code: null,
      cookies: null,
    });
    assertEquals([res.status, res.json], [200, { sent: true, channel: 'sms' }]);
    assertEquals(JSON.stringify(res.json).includes('/r/'), false, 'the answer holds no link');
    assertEquals(h.daily.length, 1);
    const sent = h.daily[0]!;
    assertEquals(sent.reporterId, MARCO);
    assertEquals(sent.vars.site, 'Riverside');
    assertEquals(sent.dedupeKey, `expired_daily_link:${expiredLink.id}:2026-10-09`);
    assertEquals(sent.vars.number, undefined, 'no voice number: no call clause');
    // Today's daily link of the same site was made (72 h) and opens.
    const today = h.store.links.filter(
      (l) => l.kind === 'daily' && l.site_id === SITE_A && l.report_date === '2026-10-09',
    );
    assertEquals(today.length, 1);
    assertEquals(today[0]!.expires_at, '2026-10-12T22:00:00.000Z');
    const newCode = sent.vars.link.split('/r/')[1]!;
    assertEquals(linkCodeHash(newCode), today[0]!.code_hash);
    assertEquals(
      (await h.call('POST', 'resolve', { body: { code: newCode }, code: null })).status,
      200,
    );
    assert(h.store.audits.some((a) => a.action === 'field_link.created'));
    const requested = h.store.audits.filter((a) => a.action === 'daily_link.requested');
    assertEquals(requested.length, 1);
    assertEquals(requested[0]!.actorType, 'reporter');
    assertEquals(requested[0]!.diff, {
      expired_link_id: expiredLink.id,
      site_id: SITE_A,
      report_date: '2026-10-09',
      device_id: null,
      sent: true,
      link_id: today[0]!.id,
      channel: 'sms',
      message_id: 'msg-1',
    });

    // Tapped again: the same link, the same key (the Notifier sends nothing twice).
    await h.call('POST', 'expired/daily-link', { body: { code: CODES.expired }, code: null });
    assertEquals(h.daily.length, 1);
    assertEquals(h.store.links.filter((l) => l.site_id === SITE_A && l.kind === 'daily').length, 2);
    // Three a day per link, then 429.
    await h.call('POST', 'expired/daily-link', { body: { code: CODES.expired }, code: null });
    const limited = await h.call('POST', 'expired/daily-link', {
      body: { code: CODES.expired },
      code: null,
    });
    assertEquals([limited.status, limited.json.error], [429, 'rate_limited']);
    assert(Number(limited.headers.get('retry-after')) > 0);
  },
);

Deno.test(
  'expired/daily-link: two taps at once send one text, and both get the same answer',
  async () => {
    const h = setup();
    const call = () =>
      h.call('POST', 'expired/daily-link', {
        body: { code: CODES.expired },
        code: null,
        cookies: null,
      });
    const [a, b] = await Promise.all([call(), call()]);
    assertEquals([a.status, a.json], [200, { sent: true, channel: 'sms' }]);
    assertEquals([b.status, b.json], [200, { sent: true, channel: 'sms' }]);
    assertEquals(h.daily.length, 1);
    // The claim is let go once the Notifier answered.
    assertEquals(h.store.sendClaims.size, 0);
  },
);

Deno.test(
  'expired/daily-link: unknown, revoked, live and personal links tell no more than resolve',
  async () => {
    const h = setup();
    const send = (code: string) =>
      h.call('POST', 'expired/daily-link', { body: { code }, code: null, cookies: null });
    const unknown = await send('NOSUCH');
    assertEquals([unknown.status, unknown.json.error], [404, 'link_not_found']);
    const revoked = await send(CODES.revoked);
    assertEquals([revoked.status, revoked.json.error], [410, 'link_revoked']);
    const personal = await send(CODES.marco);
    assertEquals([personal.status, personal.json.error], [409, 'link_not_expired']);
    const live = await send(CODES.marcoDaily);
    assertEquals([live.status, live.json.error], [409, 'link_not_expired']);
    assertEquals((await send('')).json.error, 'invalid_request');
    // A disabled reporter's expired link sends nothing.
    h.store.links.push(
      link('G0NEXP', GONE, {
        kind: 'daily',
        site_id: SITE_A,
        report_date: '2026-10-05',
        expires_at: '2026-10-06T22:00:00Z',
      }),
    );
    const gone = await send('G0NEXP');
    assertEquals([gone.status, gone.json.error], [403, 'reporter_disabled']);
    // A wrong origin is refused like every route.
    const origin = await h.call('POST', 'expired/daily-link', {
      body: { code: CODES.expired },
      code: null,
      origin: 'https://evil.test',
    });
    assertEquals(origin.status, 403);
    assertEquals(h.daily, []);
    assertEquals(
      h.store.audits.filter((a) => a.action === 'daily_link.requested'),
      [],
      'refusals before the link checks are not requests',
    );
  },
);

Deno.test(
  'expired/daily-link: a paused or archived site and a non-working day answer the reason',
  async () => {
    const h = setup();
    const expiredOn = (code: string, siteId: string) =>
      h.store.links.push(
        link(code, MARCO, {
          kind: 'daily',
          site_id: siteId,
          report_date: '2026-10-05',
          expires_at: '2026-10-08T22:00:00Z',
        }),
      );
    expiredOn('PAUSE1', SITE_P);
    const paused = await h.call('POST', 'expired/daily-link', { body: { code: 'PAUSE1' } });
    assertEquals(paused.json, { sent: false, reason: 'site_paused' });
    // A site the reporter is no longer linked to.
    h.store.siteReporters = h.store.siteReporters.filter((l) => l.site_id !== SITE_B);
    expiredOn('UNLNK1', SITE_B);
    const unlinked = await h.call('POST', 'expired/daily-link', { body: { code: 'UNLNK1' } });
    assertEquals(unlinked.json, { sent: false, reason: 'site_inactive' });
    // Saturday Oct 10 in Chicago: not one of the org's working days.
    h.clock.now = new Date('2026-10-10T15:00:00Z');
    const weekend = await h.call('POST', 'expired/daily-link', { body: { code: CODES.expired } });
    assertEquals(weekend.json, { sent: false, reason: 'not_working_day' });
    assertEquals(h.daily, []);
    assertEquals(
      h.store.links.filter((l) => l.kind === 'daily' && l.report_date === '2026-10-10'),
      [],
      'no link is made for a day that has none',
    );
    const reasons = h.store.audits
      .filter((a) => a.action === 'daily_link.requested')
      .map((a) => (a.diff as { reason: string }).reason);
    assertEquals(reasons, ['site_paused', 'site_inactive', 'not_working_day']);
  },
);

Deno.test(
  "expired/daily-link: the Notifier's skip is the answer; a verified phone counts against its limit",
  async () => {
    const h = setup({ dailyOutcome: { channel: null, reason: 'no_consent' } });
    await verifiedDevice(h);
    const res = await h.call('POST', 'expired/daily-link', { body: { code: CODES.expired } });
    assertEquals(res.json, { sent: false, reason: 'no_consent' });
    const device = h.store.devices[0]!;
    assert(h.store.rates.get(`dev:${device.id}`)!.count > 0);
    const audit = h.store.audits.find((a) => a.action === 'daily_link.requested')!;
    assertEquals((audit.diff as { device_id: string }).device_id, device.id);
  },
);

Deno.test('history: the Late badge and every site of the reporter, newest first', async () => {
  const h = setup();
  await consented(h);
  const day = (id: string, siteId: string, date: string) => {
    h.store.siteDays.push({ id, site_id: siteId, date } as never);
  };
  const report = (id: string, dayId: string, siteId: string, no: string, extra = {}) =>
    h.store.reports.push({
      id,
      site_day_id: dayId,
      site_id: siteId,
      org_id: ORG,
      report_no: no,
      status: 'filed',
      filed_at: T0.toISOString(),
      current_version: 1,
      is_late: false,
      ...extra,
    } as never);
  day('d1', SITE_A, '2026-10-08');
  day('d2', SITE_B, '2026-10-09');
  day('d3', SITE_A, '2026-10-09');
  report('r1', 'd1', SITE_A, 'RL-2041-0001', { is_late: true });
  report('r2', 'd2', SITE_B, 'P9-3007-0001', { status: 'awaiting_confirmation', filed_at: null });
  report('r3', 'd3', SITE_A, 'RL-2041-0002', { status: 'void' });
  const res = await h.call('GET', 'history');
  assertEquals(
    (res.json.reports as { reportNo: string; siteName: string; isLate: boolean }[]).map((r) => [
      r.reportNo,
      r.siteName,
      r.isLate,
    ]),
    [
      ['P9-3007-0001', 'Pier 9', false],
      ['RL-2041-0001', 'Riverside', true],
    ],
  );
  // A daily link names one site: its history is that site's.
  const daily = await h.call('GET', 'history', { code: CODES.marcoDaily });
  assertEquals(
    (daily.json.reports as { reportNo: string }[]).map((r) => r.reportNo),
    ['P9-3007-0001'],
  );
});

/** F9 (W2-04): a filed web report of SITE_A, Fri Oct 9, version 1 with no photos. */
async function filedReport(h: Harness, code = CODES.marco, siteId = SITE_A) {
  const u = await h.call('POST', 'uploads', {
    code,
    body: {
      kind: 'audio',
      mime: 'audio/webm',
      bytes: 1,
      ...(code === CODES.marco ? { siteId } : {}),
    },
  });
  h.store.put(`audio/${u.json.path}`);
  const done = await h.call('POST', `uploads/${u.json.uploadId}/complete`, { code });
  const reportId = done.json.reportId as string;
  const report = h.store.reports.find((r) => r.id === reportId)!;
  report.status = 'filed';
  report.filed_at = T0.toISOString();
  h.store.versions.push({
    report_id: reportId,
    version: 1,
    data: {
      ...emptyReportData('2026-10-09', { reportLanguage: 'en', units: 'imperial' }),
      summary: 'Deck pour',
    } as never,
    summary: 'Deck pour',
    pdf_path: `${ORG}/${siteId}/${report.report_no}_v1.pdf`,
    author: 'agent',
    author_user_id: null,
    author_message_id: null,
    change_note: null,
    created_at: T0.toISOString(),
    via: null,
  });
  return reportId;
}

const BATCH_1 = '22222222-0000-4000-8000-000000000001';
const BATCH_2 = '22222222-0000-4000-8000-000000000002';
const BATCH_3 = '22222222-0000-4000-8000-000000000003';

Deno.test(
  'photos after filing (F9): two photos from the Filed screen make version 2, "2 photos added"',
  async () => {
    const h = setup();
    await consented(h);
    const reportId = await filedReport(h);

    const before = await h.call('GET', `reports/${reportId}`);
    assertEquals(before.json.addPhotos, {
      canAdd: true,
      remaining: 4,
      // 23:59 the next day at the site (Chicago).
      until: '2026-10-11T04:59:00.000Z',
      pending: 0,
    });
    assertEquals(before.json.changeNote, null);

    // The next morning: the day is no longer one the link reports, but the window is open.
    h.clock.now = new Date('2026-10-10T15:00:00Z');
    const addTo = { reportId, batchId: BATCH_1, photos: 2, caption: false };
    const ids: string[] = [];
    for (const _ of [1, 2]) {
      const up = await h.call('POST', 'uploads', {
        body: { kind: 'photo', mime: 'image/jpeg', bytes: 10, addTo },
      });
      assertEquals(up.status, 201);
      assertEquals(up.json.path, `${ORG}/${SITE_A}/2026-10-09/${up.json.uploadId}.jpg`);
      h.store.put(`photos/${up.json.path}`);
      ids.push(up.json.uploadId as string);
    }
    const created = h.store.audits.filter(
      (a) => a.action === 'upload.created' && (a.diff as { batch_id?: string }).batch_id,
    );
    assertEquals(created.length, 2);
    assertEquals((created[0]!.diff as { after_filing: boolean }).after_filing, true);

    const first = await h.call('POST', `uploads/${ids[0]}/complete`);
    assertEquals(first.status, 200);
    assertEquals(first.json.batch, { id: BATCH_1, ready: false, version: null });
    assert(!h.store.calls.includes('attachPhotos'), 'no version before the batch is whole');
    assertEquals((await h.call('GET', `reports/${reportId}`)).json.currentVersion, 1);

    const second = await h.call('POST', `uploads/${ids[1]}/complete`);
    assertEquals(second.json.batch, { id: BATCH_1, ready: true, version: 2 });
    assertEquals(second.json.reportStatus, 'filed');
    const v2 = h.store.versions.find((v) => v.report_id === reportId && v.version === 2)!;
    assertEquals([v2.author, v2.via, v2.change_note], ['reporter', 'web', '2 photos added']);
    assertEquals(
      (v2.data as { photos: { uploadId: string }[] }).photos.map((p) => p.uploadId),
      ids,
    );
    // Version 1 is untouched (versions are immutable).
    const v1 = h.store.versions.find((v) => v.report_id === reportId && v.version === 1)!;
    assertEquals((v1.data as { photos: unknown[] }).photos, []);
    assert(
      h.store.jobs.some((j) => j.dedupe_key === `render_pdf:${reportId}:2`),
      'the _v2 PDF and the Updated email',
    );
    // A photo added after filing is not a late clip (§19 Q53 is for report material).
    assertEquals(h.store.lateUploads, []);

    const after = await h.call('GET', `reports/${reportId}`);
    assertEquals(after.json.currentVersion, 2);
    assertEquals(after.json.changeNote, '2 photos added');
    assertEquals(after.json.status, 'filed');
    assertEquals((after.json.addPhotos as { remaining: number; pending: number }).remaining, 2);

    // A retried complete (its answer lost) answers the same version and makes no second one.
    const retry = await h.call('POST', `uploads/${ids[1]}/complete`);
    assertEquals(
      [retry.json.alreadyComplete, retry.json.batch],
      [true, { id: BATCH_1, ready: true, version: 2 }],
    );
    assertEquals(h.store.versions.filter((v) => v.report_id === reportId).length, 2);

    // At most 4 after filing: two more fit, three do not.
    const three = await h.call('POST', 'uploads', {
      body: {
        kind: 'photo',
        mime: 'image/jpeg',
        bytes: 10,
        addTo: { reportId, batchId: BATCH_2, photos: 3, caption: false },
      },
    });
    assertEquals([three.status, three.json.error, three.json.remaining], [409, 'photo_limit', 2]);

    // After 23:59 the next day the window is closed.
    h.clock.now = new Date('2026-10-11T05:00:00Z');
    h.store.rates.clear();
    const late = await h.call('POST', 'uploads', {
      body: {
        kind: 'photo',
        mime: 'image/jpeg',
        bytes: 10,
        addTo: { reportId, batchId: BATCH_2, photos: 1, caption: false },
      },
    });
    assertEquals([late.status, late.json.error], [409, 'photos_window_closed']);
    assertEquals(
      ((await h.call('GET', `reports/${reportId}`)).json.addPhotos as { canAdd: boolean }).canAdd,
      false,
    );
  },
);

Deno.test(
  'photos after filing (F9): a voice caption waits for its transcription; refusals',
  async () => {
    const h = setup();
    await consented(h);
    const reportId = await filedReport(h);
    const addTo = { reportId, batchId: BATCH_3, photos: 1, caption: true };
    const photo = await h.call('POST', 'uploads', {
      body: { kind: 'photo', mime: 'image/jpeg', bytes: 10, addTo },
    });
    const clip = await h.call('POST', 'uploads', {
      body: { kind: 'audio', mime: 'audio/webm', bytes: 10, addTo },
    });
    assertEquals([photo.status, clip.status], [201, 201]);
    h.store.put(`photos/${photo.json.path}`);
    h.store.put(`audio/${clip.json.path}`);
    await h.call('POST', `uploads/${photo.json.uploadId}/complete`);
    const done = await h.call('POST', `uploads/${clip.json.uploadId}/complete`);
    // Whole, but the worker attaches it after the caption's transcription.
    assertEquals(done.json.batch, { id: BATCH_3, ready: true, version: null });
    assert(!h.store.calls.includes('attachPhotos'));
    const job = h.store.jobs.find(
      (j) => j.dedupe_key === `transcribe_upload:${clip.json.uploadId}`,
    )!;
    assertEquals(job.payload, { uploadId: clip.json.uploadId, purpose: 'caption' });
    const view = await h.call('GET', `reports/${reportId}`);
    assertEquals((view.json.addPhotos as { pending: number }).pending, 1);

    // Refusals: no site or date with addTo, audio only with a caption, a report not filed.
    const up = (body: Record<string, unknown>, code?: string) =>
      h.call('POST', 'uploads', {
        code,
        body: { kind: 'photo', mime: 'image/jpeg', bytes: 10, ...body },
      });
    const batch = { reportId, batchId: BATCH_2, photos: 1, caption: false };
    assertEquals((await up({ addTo: batch, siteId: SITE_A })).json.error, 'invalid_request');
    assertEquals(
      (await up({ addTo: batch, kind: 'audio', mime: 'audio/webm' })).json.error,
      'invalid_request',
    );
    h.store.reports.find((r) => r.id === reportId)!.status = 'awaiting_confirmation';
    assertEquals((await up({ addTo: batch })).json.error, 'wrong_state');
    h.store.reports.find((r) => r.id === reportId)!.status = 'filed';
    // Another reporter's report is not found; a daily link of another site does not reach it.
    assertEquals((await up({ addTo: batch }, CODES.marcoDaily)).json.error, 'not_found');
  },
);

Deno.test('photos after filing (F9): a daily link of that day adds; the parameter', async () => {
  const h = setup();
  await consented(h);
  const reportId = await filedReport(h, CODES.marcoDaily, SITE_B);
  const view = await h.call('GET', `reports/${reportId}`, { code: CODES.marcoDaily });
  assertEquals((view.json.addPhotos as { canAdd: boolean }).canAdd, true);
  const up = await h.call('POST', 'uploads', {
    code: CODES.marcoDaily,
    body: {
      kind: 'photo',
      mime: 'image/jpeg',
      bytes: 10,
      addTo: { reportId, batchId: BATCH_1, photos: 1, caption: false },
    },
  });
  assertEquals(up.status, 201);
  h.store.put(`photos/${up.json.path}`);
  const done = await h.call('POST', `uploads/${up.json.uploadId}/complete`, {
    code: CODES.marcoDaily,
  });
  assertEquals(done.json.batch, { id: BATCH_1, ready: true, version: 2 });
  assertEquals(h.store.attached[0]!.changeNote, '1 photo added');
});

Deno.test(
  'test-clip (W2-13, F4): needs the consent, a signed upload under test/, never a report; 3 an hour',
  async () => {
    const h = setup();
    await verifiedDevice(h);
    // Before the consent: refused, nothing stored.
    const early = await h.call('POST', 'test-clip', { body: { mime: 'audio/webm', bytes: 10 } });
    assertEquals([early.status, early.json.error], [403, 'consent_required']);
    assertEquals(h.store.testClips, []);
    const consent = await h.call('POST', 'consent', {
      body: {
        types: ['recording', 'data_processing'],
        textVersion: 'field.consent.v1',
        contactPref: 'link',
        locale: 'en-US',
      },
    });
    assertEquals(consent.status, 200);

    const bad = await h.call('POST', 'test-clip', { body: { mime: 'image/jpeg', bytes: 10 } });
    assertEquals([bad.status, bad.json.error], [400, 'media_type_not_allowed']);
    const big = await h.call('POST', 'test-clip', {
      body: { mime: 'audio/webm', bytes: 6 * 1024 * 1024 },
    });
    assertEquals(big.status, 400);

    const res = await h.call('POST', 'test-clip', {
      body: { mime: 'audio/webm;codecs=opus', bytes: 10 },
    });
    assertEquals(res.status, 201);
    const id = res.json.testClipId as string;
    assertEquals(res.json.bucket, 'audio');
    assertEquals(res.json.path, `test/${ORG}/${id}.webm`);
    assertStringIncludes(res.json.signedUrl as string, `/audio/test/${ORG}/${id}.webm`);
    // The 10-minute backstop is queued with it; audited; no upload, no report.
    assertEquals(
      h.store.jobs.map((j) => [j.type, j.dedupe_key]),
      [['delete_test_clip', `test_clip:${id}:delete`]],
    );
    assert(h.store.audits.some((a) => a.action === 'test_clip.created' && a.entityId === id));
    assertEquals([h.store.uploads.length, h.store.reports.length], [0, 0]);

    // Complete before the file is there: refused; then the transcription is queued once.
    const missing = await h.call('POST', `test-clip/${id}/complete`);
    assertEquals([missing.status, missing.json.error], [409, 'upload_missing']);
    h.store.put(`audio/test/${ORG}/${id}.webm`, 'audio/webm', 4000);
    const done = await h.call('POST', `test-clip/${id}/complete`);
    assertEquals([done.status, done.json], [202, { status: 'pending', snippet: null }]);
    await h.call('POST', `test-clip/${id}/complete`);
    assertEquals(h.store.jobs.filter((j) => j.type === 'transcribe_test_clip').length, 1);
    assertEquals(h.store.testClips[0]!.bytes, 4000);

    // Pending until the worker heard it; then the words once, and gone.
    assertEquals((await h.call('GET', `test-clip/${id}`)).json, {
      status: 'pending',
      snippet: null,
    });
    Object.assign(h.store.testClips[0]!, {
      transcribed_at: T0.toISOString(),
      heard: true,
      snippet: 'Testing, one, two, three.',
    });
    assertEquals((await h.call('GET', `test-clip/${id}`)).json, {
      status: 'heard',
      snippet: 'Testing, one, two, three.',
    });
    assertEquals((await h.call('GET', `test-clip/${id}`)).json, { status: 'gone', snippet: null });
    assertEquals(h.store.testClips[0]!.snippet, null);
    assert(h.store.audits.some((a) => a.action === 'test_clip.deleted' && a.entityId === id));

    // Another reporter's clip, or an unknown id: not found.
    await consented(h, CODES.dana);
    const other = await h.call('GET', `test-clip/${id}`, { code: CODES.dana });
    assertEquals(other.status, 404);
    assertEquals((await h.call('GET', 'test-clip/not-a-uuid')).status, 404);

    // 3 an hour per device: the fourth is refused with its wait.
    await h.call('POST', 'test-clip', { body: { mime: 'audio/webm', bytes: 10 } });
    await h.call('POST', 'test-clip', { body: { mime: 'audio/webm', bytes: 10 } });
    const fourth = await h.call('POST', 'test-clip', { body: { mime: 'audio/webm', bytes: 10 } });
    assertEquals(fourth.status, 429);
    assert(typeof fourth.json.retryAfter === 'number');
    assertEquals(h.store.testClips.length, 3);
  },
);

Deno.test(
  'test-clip (W2-13): a file of another type is removed; a silent clip says so',
  async () => {
    const h = setup();
    await consented(h);
    const res = await h.call('POST', 'test-clip', { body: { mime: 'audio/webm', bytes: 10 } });
    const id = res.json.testClipId as string;
    h.store.put(`audio/test/${ORG}/${id}.webm`, 'image/png', 10);
    const done = await h.call('POST', `test-clip/${id}/complete`);
    assertEquals([done.status, done.json.error], [409, 'media_type_not_allowed']);
    assert(h.store.calls.includes('removeObject'));

    const second = await h.call('POST', 'test-clip', { body: { mime: 'audio/mp4', bytes: 10 } });
    const sid = second.json.testClipId as string;
    h.store.put(`audio/test/${ORG}/${sid}.m4a`, 'audio/mp4', 10);
    assertEquals((await h.call('POST', `test-clip/${sid}/complete`)).status, 202);
    Object.assign(h.store.testClips[1]!, { transcribed_at: T0.toISOString(), heard: false });
    assertEquals((await h.call('GET', `test-clip/${sid}`)).json, {
      status: 'silent',
      snippet: null,
    });
  },
);

// ── W2-10: Fix by voice and the steppers on the draft (F8, §10.6, Q80) ─────────────────────────

/** A web draft awaiting confirmation: Apex Concrete 6 × 8 h = 48 h, at revision 1. */
async function awaitingDraft(h: Harness) {
  await consented(h);
  const u = await h.call('POST', 'uploads', {
    body: { kind: 'audio', mime: 'audio/webm', bytes: 1, siteId: SITE_A },
  });
  h.store.put(`audio/${u.json.path}`);
  const done = await h.call('POST', `uploads/${u.json.uploadId}/complete`);
  const reportId = done.json.reportId as string;
  const report = h.store.reports.find((r) => r.id === reportId)!;
  report.status = 'awaiting_confirmation';
  const note = { type: 'voice_note' as const, uploadId: u.json.uploadId as string, start: 18.9 };
  const data: DailyReportData = {
    ...emptyReportData('2026-10-09', { reportLanguage: 'en', units: 'imperial' }),
    summary: 'Slab pour on Level 4.',
    manpower: [
      {
        companyId: 'apex',
        companyNameHeard: 'Apex',
        companyName: 'Apex Concrete',
        workers: 6,
        hoursPerWorker: 8,
        totalHours: 48,
        hoursBasis: 'full_day_default',
        confidence: 0.95,
        source: [note],
      },
    ],
  };
  h.store.versions.push({
    report_id: reportId,
    version: 1,
    data: data as never,
    summary: null,
    pdf_path: null,
    author: 'agent',
    author_user_id: null,
    author_message_id: null,
    change_note: null,
    created_at: T0.toISOString(),
    via: null,
    draft_rev: 1,
  });
  return { reportId, report, data, note };
}

/** W2-10: a correction clip of the draft: created, put, completed. */
async function fixClip(h: Harness, reportId: string, complete = true) {
  const u = await h.call('POST', 'uploads', {
    body: { kind: 'audio', mime: 'audio/webm', bytes: 2, fixTo: { reportId } },
  });
  assertEquals(u.status, 201);
  h.store.put(`audio/${u.json.path}`);
  if (complete) await h.call('POST', `uploads/${u.json.uploadId}/complete`);
  return u.json as { uploadId: string; path: string };
}

const SEVEN = (data: DailyReportData): DailyReportData => ({
  ...data,
  manpower: [{ ...data.manpower[0]!, workers: 7, totalHours: 56 }],
});
const SEVEN_LINES = [
  {
    kind: 'crew',
    company: 'Apex Concrete',
    change: 'changed',
    workers: [6, 7],
    hoursPerWorker: [8, 8],
    totalHours: [48, 56],
  },
];

Deno.test(
  'fix by voice (W2-10): the clip is staged, never report material; the preview is saved at its revision only',
  async () => {
    const h = setup();
    const { reportId, data } = await awaitingDraft(h);
    const clip = await fixClip(h, reportId, false);
    const row = h.store.uploads.find((x) => x.id === clip.uploadId)!;
    assertEquals(
      [row.correction_report_id, row.site_id, row.storage_path.split('/')[2]],
      [reportId, SITE_A, '2026-10-09'],
    );
    // Before the clip is complete: refused.
    const early = await h.call('POST', `reports/${reportId}/correction`, {
      body: { uploadId: clip.uploadId },
    });
    assertEquals([early.status, early.json.error], [409, 'upload_missing']);
    const jobsBefore = h.store.jobs.length;
    const done = await h.call('POST', `uploads/${clip.uploadId}/complete`);
    assertEquals([done.status, done.json.reportStatus], [200, 'awaiting_confirmation']);
    // Not a voice note of the report: no job, not counted, the draft unchanged.
    assertEquals(h.store.jobs.length, jobsBefore);
    const view = await h.call('GET', `reports/${reportId}`);
    assertEquals(
      [(view.json.progress as { voiceNotes: number }).voiceNotes, view.json.correction],
      [1, null],
    );

    const res = await h.call('POST', `reports/${reportId}/correction`, {
      body: { uploadId: clip.uploadId },
    });
    assertEquals(res.status, 202);
    const cid = res.json.id as string;
    assertEquals(res.json, {
      id: cid,
      status: 'listening',
      via: 'voice',
      changes: null,
      clarification: null,
      reason: null,
      version: null,
      draftRev: null,
      afterFiling: false,
    });
    assertEquals(
      h.store.jobs
        .filter((j) => j.type === 'apply_correction')
        .map((j) => [j.dedupe_key, j.payload]),
      [[`correction:${cid}`, { reportId, correctionId: cid }]],
    );
    // A retry of the same clip answers the same fix; another fix meanwhile waits.
    const again = await h.call('POST', `reports/${reportId}/correction`, {
      body: { uploadId: clip.uploadId },
    });
    assertEquals([again.status, again.json.id], [202, cid]);
    const typed = await h.call('POST', `reports/${reportId}/correction`, {
      body: { text: 'Apex had 8' },
    });
    assertEquals([typed.status, typed.json.error], [409, 'correction_pending']);
    // Nothing to save yet.
    const notReady = await h.call('POST', `reports/${reportId}/correction/${cid}/apply`);
    assertEquals([notReady.status, notReady.json.error], [409, 'correction_not_ready']);
    assertEquals(
      ((await h.call('GET', `reports/${reportId}`)).json.correction as { status: string }).status,
      'listening',
    );

    // The worker's preview (apply_correction, code's numbers).
    h.store.settleCorrectionReady(cid, SEVEN(data), SEVEN_LINES);
    const ready = await h.call('GET', `reports/${reportId}/correction/${cid}`);
    assertEquals(ready.json, {
      id: cid,
      status: 'ready',
      via: 'voice',
      changes: SEVEN_LINES,
      clarification: null,
      reason: null,
      version: 1,
      draftRev: 1,
      afterFiling: false,
    });
    assertEquals(
      ((await h.call('GET', `reports/${reportId}`)).json.correction as { status: string }).status,
      'ready',
    );

    const saved = await h.call('POST', `reports/${reportId}/correction/${cid}/apply`);
    assertEquals(
      [saved.status, saved.json],
      [200, { status: 'applied', reportStatus: 'processing' }],
    );
    const v = h.store.versions[0]!;
    assertEquals(
      [(v.data as unknown as DailyReportData).manpower[0]!.totalHours, v.draft_rev],
      [56, 2],
    );
    assertEquals(
      h.store.jobs.filter((j) => j.type === 'decide_next').map((j) => j.dedupe_key),
      [`decide:${reportId}:correction:${cid}`],
    );
    assert(h.store.audits.some((a) => a.action === 'report.draft_corrected'));
    // A retry (the answer lost): applied, nothing written twice.
    const retry = await h.call('POST', `reports/${reportId}/correction/${cid}/apply`);
    assertEquals([retry.status, retry.json.status], [200, 'applied']);
    assertEquals(h.store.versions[0]!.draft_rev, 2);
    // The draft is processing now: no correction shown, and no new fix until it is shown again.
    const after = await h.call('GET', `reports/${reportId}`);
    assertEquals([after.json.status, after.json.correction], ['processing', null]);
    const late = await h.call('POST', `reports/${reportId}/correction`, {
      body: { text: 'Apex had 8' },
    });
    assertEquals([late.status, late.json.error], [409, 'wrong_state']);
  },
);

Deno.test(
  'fix by voice (W2-10): a newer draft makes the preview draft_changed; typed fixes; scope',
  async () => {
    const h = setup();
    const { reportId, data } = await awaitingDraft(h);
    const both = await h.call('POST', `reports/${reportId}/correction`, {
      body: { text: 'Apex had 7', uploadId: '11111111-0000-4000-8000-00000000abcd' },
    });
    assertEquals([both.status, both.json.error], [400, 'invalid_request']);
    const res = await h.call('POST', `reports/${reportId}/correction`, {
      body: { text: 'Apex had 7, not 6' },
    });
    const cid = res.json.id as string;
    assertEquals([res.status, res.json.via, res.json.status], [202, 'text', 'listening']);
    h.store.settleCorrectionReady(cid, SEVEN(data), SEVEN_LINES);
    // A late photo re-extracted the draft in place: another revision.
    h.store.versions[0]!.draft_rev = 2;
    const stale = await h.call('POST', `reports/${reportId}/correction/${cid}/apply`);
    assertEquals(
      [stale.status, stale.json.error, stale.json.currentVersion, stale.json.draftRev],
      [409, 'draft_changed', 1, 2],
    );
    assertEquals(h.store.corrections[0]!.status, 'stale');
    assertEquals((h.store.versions[0]!.data as unknown as DailyReportData).manpower[0]!.workers, 6);
    // Dana covers the site but the fix is Marco's.
    await consented(h, CODES.dana);
    const dana = await h.call('GET', `reports/${reportId}/correction/${cid}`, {
      code: CODES.dana,
    });
    assertEquals(dana.status, 404);
    // W2-10 review: Marco's fix is not on Dana's draft view (nor holds her Confirm & send).
    h.store.corrections[0]!.status = 'ready';
    const danaView = await h.call('GET', `reports/${reportId}`, { code: CODES.dana });
    assertEquals(danaView.json.correction, null);
    const marcoView = await h.call('GET', `reports/${reportId}`);
    assertEquals((marcoView.json.correction as { id: string }).id, cid);
    // A correction clip of a report that is neither a draft nor filed is refused at upload.
    h.store.reports.find((r) => r.id === reportId)!.status = 'processing';
    const filed = await h.call('POST', 'uploads', {
      body: { kind: 'audio', mime: 'audio/webm', bytes: 2, fixTo: { reportId } },
    });
    assertEquals([filed.status, filed.json.error], [409, 'wrong_state']);
    // A photo is never a correction clip.
    const photo = await h.call('POST', 'uploads', {
      body: { kind: 'photo', mime: 'image/jpeg', bytes: 2, fixTo: { reportId } },
    });
    assertEquals([photo.status, photo.json.error], [400, 'invalid_request']);
  },
);

Deno.test(
  'steppers (W2-10, Q80): the crew line in code, reporter_edit, the draft the reporter saw only',
  async () => {
    const h = setup();
    const { reportId, note } = await awaitingDraft(h);
    const edit = (body: Record<string, unknown>) =>
      h.call('POST', `reports/${reportId}/edit`, { body: { version: 1, draftRev: 1, ...body } });
    const old = await edit({ draftRev: 2, index: 0, workers: 7, hoursPerWorker: 8 });
    assertEquals([old.status, old.json.error], [409, 'draft_changed']);
    const none = await edit({ index: 3, workers: 7, hoursPerWorker: 8 });
    assertEquals([none.status, none.json.error], [400, 'edit_not_accepted']);
    const same = await edit({ index: 0, workers: 6, hoursPerWorker: 8 });
    assertEquals([same.status, same.json.error], [400, 'edit_not_accepted']);
    const half = await edit({ index: 0, workers: 6.5, hoursPerWorker: 8 });
    assertEquals([half.status, half.json.error], [400, 'invalid_request']);

    const res = await edit({ index: 0, workers: 7, hoursPerWorker: 9 });
    assertEquals(
      [res.status, res.json],
      [202, { status: 'processing', reportStatus: 'processing' }],
    );
    const m = (h.store.versions[0]!.data as unknown as DailyReportData).manpower[0]!;
    assertEquals([m.workers, m.hoursPerWorker, m.totalHours, m.hoursBasis], [7, 9, 63, 'stated']);
    assertEquals(m.source, [
      note,
      { type: 'reporter_edit', reporterId: MARCO, at: T0.toISOString(), via: 'web' },
    ]);
    assertEquals(
      h.store.jobs.filter((j) => j.type === 'decide_next').map((j) => j.dedupe_key),
      [`decide:${reportId}:edit:v1:r1`],
    );
    assert(h.store.audits.some((a) => a.action === 'report.draft_edited'));
    // Processing now: no stepper until the draft is shown again.
    const busy = await edit({ draftRev: 2, index: 0, workers: 8, hoursPerWorker: 9 });
    assertEquals([busy.status, busy.json.error], [409, 'wrong_state']);
  },
);

Deno.test(
  'change something (W2-11, F10): a filed report of the last 14 days, version n+1 from code’s lines',
  async () => {
    const h = setup();
    const { reportId, report, data } = await awaitingDraft(h);
    report.status = 'filed';
    const view = await h.call('GET', `reports/${reportId}`);
    assertEquals(view.json.change, { canChange: true, locked: false });
    assertEquals(view.json.correction, null);

    const clip = await fixClip(h, reportId);
    const res = await h.call('POST', `reports/${reportId}/correction`, {
      body: { uploadId: clip.uploadId },
    });
    assertEquals([res.status, res.json.afterFiling, res.json.status], [202, true, 'listening']);
    assert(h.store.calls.includes('requestFiledCorrection'));
    assert(!h.store.calls.includes('requestCorrection'));
    const cid = res.json.id as string;
    h.store.settleCorrectionReady(cid, SEVEN(data), SEVEN_LINES);
    const ready = (await h.call('GET', `reports/${reportId}`)).json.correction as {
      status: string;
      afterFiling: boolean;
    };
    assertEquals([ready.status, ready.afterFiling], ['ready', true]);

    const saved = await h.call('POST', `reports/${reportId}/correction/${cid}/apply`);
    assertEquals(
      [saved.status, saved.json],
      [200, { status: 'applied', reportStatus: 'filed', version: 2 }],
    );
    // The note and the text from code's lines: the report language, the reporter's (GSM-7).
    assertEquals(h.store.saved, [
      {
        correctionId: cid,
        version: 2,
        changeNote: 'Apex Concrete 6 → 7 workers, 48 → 56 h',
        message: { weekday: 'Friday', change: 'Apex Concrete 6 -> 7 workers, 48 -> 56 h' },
      },
    ]);
    assertEquals(h.store.versions.at(-1)!.author_reporter_id, MARCO);
    assertEquals(
      (h.store.versions.at(-1)!.data as unknown as DailyReportData).manpower[0]!.totalHours,
      56,
    );
    assertEquals(h.store.versions[0]!.version, 1); // version 1 kept as it was
    assertEquals((h.store.versions[0]!.data as unknown as DailyReportData).manpower[0]!.workers, 6);
    // A retry (a lost answer) answers the same version and makes nothing new.
    const again = await h.call('POST', `reports/${reportId}/correction/${cid}/apply`);
    assertEquals([again.status, again.json.version], [200, 2]);
    assertEquals(h.store.saved.length, 1);
    assertEquals(
      h.store.jobs.filter((j) => j.type === 'render_pdf').map((j) => j.dedupe_key),
      [`render_pdf:${reportId}:2`],
    );
  },
);

Deno.test(
  'change something (W2-11, Q81): a backup on the site may change it; older than 14 days is locked',
  async () => {
    const h = setup();
    const { reportId, report } = await awaitingDraft(h);
    report.status = 'signed_off';
    // Dana covers Riverside too: her change of Marco's report is hers (§19 Q81).
    await consented(h, CODES.dana);
    const dana = await h.call('POST', `reports/${reportId}/correction`, {
      code: CODES.dana,
      body: { text: 'Apex had 7, not 6' },
    });
    assertEquals([dana.status, dana.json.afterFiling], [202, true]);
    assertEquals(h.store.corrections[0]!.reporter_id, DANA);

    // Fri Oct 9 is changeable through Thu Oct 22 (site time), locked from Fri Oct 23.
    h.clock.now = new Date('2026-10-23T04:59:00Z'); // Thu Oct 22, 23:59 in Chicago
    assertEquals((await h.call('GET', `reports/${reportId}`)).json.change, {
      canChange: true,
      locked: false,
    });
    h.clock.now = new Date('2026-10-23T15:00:00Z');
    assertEquals((await h.call('GET', `reports/${reportId}`)).json.change, {
      canChange: false,
      locked: true,
    });
    const typed = await h.call('POST', `reports/${reportId}/correction`, {
      body: { text: 'Apex had 8' },
    });
    assertEquals([typed.status, typed.json.error], [409, 'report_locked']);
    const upload = await h.call('POST', 'uploads', {
      body: { kind: 'audio', mime: 'audio/webm', bytes: 2, fixTo: { reportId } },
    });
    assertEquals([upload.status, upload.json.error], [409, 'report_locked']);
    // A draft's fix route never makes a version: a draft is not "filed".
    report.status = 'processing';
    assertEquals((await h.call('GET', `reports/${reportId}`)).json.change, null);
  },
);
