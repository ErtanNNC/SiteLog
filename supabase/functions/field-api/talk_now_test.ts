import { assert, assertEquals, assertMatch } from '@std/assert';
import {
  type ConsentType,
  type CountryRow,
  deriveCallToken,
  deviceCookieName,
  linkCodeHash,
  type OrgRow,
  type ReporterRow,
  sha256Hex,
  type SiteRow,
  VoiceCallStartResponseSchema,
} from '@sitelog/shared';
import { DEMO_COUNTRIES } from '@sitelog/shared/demo/countries.ts';
import { createFieldApp } from './app.ts';
import { FakeLiveKitApi, FakeTalkNowStore, TEST_LIVEKIT } from './fake_talk_now.ts';
import { FakeFieldStore } from './fake_store.ts';
import { liveKitConfig, liveKitHttpApi, type LiveKitApi } from './talk_now.ts';

/**
 * Talk now (W3-13; spec §9.4, Appendix B `POST /field/voice/token`, §19 Q121, Q157) on the
 * in-memory store and a fake LiveKit: `talkNow` in resolve and today (LiveKit configured, billing),
 * the token route's authentication (link, device, consents), its site scoping, the 3-an-hour limit,
 * the call row, room, dispatch and participant token (identity the call id, no phone number), a
 * LiveKit failure ending the call, and the agent then starting that call (W3-03). The real LiveKit
 * client's Twirp requests are checked on a fake fetch with a test key pair.
 */

const ORG = '44444444-0000-4000-8000-000000000001';
const SITE_A = '44444444-0000-4000-8000-0000000000a1';
const SITE_B = '44444444-0000-4000-8000-0000000000b1';
const SITE_P = '44444444-0000-4000-8000-0000000000c1';
const SITE_X = '44444444-0000-4000-8000-0000000000d1'; // not Marco's
const MARCO = '44444444-0000-4000-8000-000000000101';
const MARCO_PHONE = '+15550143378';
const CODE = 'T4LKN0';
const DAILY = 'D4ILYB';
const PHOTOS = 'PH0T0S';
const FIELD_APP = 'https://go.sitelog.test';
const DEVICE_TOKEN = 'device-token-marco';
const SECRET = 'test-voice-agent-tool-secret';
const TOKEN_SECRET = 'test-voice-call-token-secret';
const T0 = new Date('2026-10-09T22:00:00Z');

function site(id: string, name: string, extra: Partial<SiteRow> = {}): SiteRow {
  return {
    id,
    org_id: ORG,
    name,
    project_code: name.slice(0, 2).toUpperCase(),
    address: null,
    lat: null,
    lng: null,
    timezone: 'America/Chicago',
    deadline: '17:30:00',
    working_hours: null,
    status: 'active',
    active_since: '2026-01-01',
    paused_at: null,
    report_seq: 0,
    created_at: '2026-01-01T00:00:00Z',
    ...extra,
  };
}

interface Opts {
  /** No LiveKit in this environment (no deps.talkNow at all with `none`). */
  livekit?: 'fake' | 'unset' | 'none';
  consents?: ConsentType[];
}

function setup(opts: Opts = {}) {
  const clock = { now: T0 };
  const now = () => clock.now;
  const store = new FakeFieldStore(now);
  store.countries.push({ ...DEMO_COUNTRIES.find((c) => c.code === 'US')! } as CountryRow);
  store.orgs.push({
    id: ORG,
    name: 'Kestrel Build Group',
    country: 'US',
    locale: 'en-US',
    timezone: 'America/Chicago',
    is_demo: false,
    units: 'imperial',
  } as OrgRow);
  store.settings.push({
    org_id: ORG,
    default_deadline: '17:30:00',
    working_days: [1, 2, 3, 4, 5],
    default_shift_hours: 8,
  } as never);
  store.sites.push(
    site(SITE_A, 'Riverside'),
    site(SITE_B, 'Pier 9'),
    site(SITE_P, 'Paused Yard', { status: 'paused' }),
    site(SITE_X, 'Elsewhere'),
  );
  store.reporters.push({
    id: MARCO,
    org_id: ORG,
    name: 'Marco Ruiz',
    phone_e164: MARCO_PHONE,
    role: 'site_manager',
    languages: ['en'],
    status: 'active',
    invited_at: '2026-10-01T15:00:00Z',
    verified_at: null,
    last_invite_error: null,
    created_at: '2026-10-01T15:00:00Z',
    locale: 'en-US',
    contact_pref: 'call',
    activated_at: '2026-10-01T16:00:00Z',
    opted_out_at: null,
    message_channel: null,
  } as ReporterRow);
  store.siteReporters.push(
    { site_id: SITE_A, reporter_id: MARCO },
    { site_id: SITE_B, reporter_id: MARCO },
    { site_id: SITE_P, reporter_id: MARCO },
  );
  const link = (code: string, extra: Record<string, unknown> = {}) => ({
    id: crypto.randomUUID(),
    code_hash: linkCodeHash(code),
    reporter_id: MARCO,
    site_id: null,
    kind: 'personal' as const,
    report_date: null,
    expires_at: null,
    revoked_at: null,
    last_opened_at: null,
    created_at: '2026-10-01T15:00:00Z',
    ...extra,
  });
  store.links.push(
    link(CODE),
    link(DAILY, {
      kind: 'daily',
      site_id: SITE_B,
      report_date: '2026-10-09',
      expires_at: '2026-10-12T22:00:00Z',
    }),
    link(PHOTOS, {
      kind: 'photos',
      site_id: SITE_A,
      report_date: '2026-10-09',
      expires_at: '2026-10-11T04:59:00Z',
    }),
  );
  store.devices.push({
    id: '44444444-0000-4000-8000-00000000dd01',
    reporter_id: MARCO,
    device_token_hash: sha256Hex(DEVICE_TOKEN),
    user_agent: 'FieldTest/1.0',
    verified_at: '2026-10-05T15:00:00Z',
    last_seen_at: null,
    revoked_at: null,
    code_hash: null,
    code_expires_at: null,
  });
  for (const type of opts.consents ?? ['recording', 'data_processing', 'sms']) {
    store.consents.push({
      id: crypto.randomUUID(),
      reporter_id: MARCO,
      type,
      method: 'web_checkbox',
      text_version: 'field.consent.v1',
      evidence: null,
      given_at: '2026-10-05T15:00:00Z',
      revoked_at: null,
    });
  }
  const livekit = new FakeLiveKitApi(now);
  const talk = new FakeTalkNowStore(store, now);
  const mode = opts.livekit ?? 'fake';
  const app = createFieldApp({
    store,
    sendVerifyCode: () => Promise.resolve({ channel: 'sms', messageId: 'm' }),
    sendDailyLink: () => Promise.resolve({ channel: 'sms', messageId: 'm' }),
    fieldAppUrl: () => FIELD_APP,
    linkSigningSecret: () => 'test-link-signing-secret',
    allowedOrigins: () => [FIELD_APP],
    voiceToolSecret: () => SECRET,
    callTokenSecret: () => TOKEN_SECRET,
    now,
    ...(mode === 'none'
      ? {}
      : {
          talkNow: {
            store: talk,
            livekit: (): LiveKitApi | null => (mode === 'fake' ? livekit : null),
            agentName: () => 'sitelog-voice',
          },
        }),
  });
  const call = async (
    method: string,
    path: string,
    o: { body?: unknown; code?: string | null; cookie?: boolean; bearer?: string } = {},
  ) => {
    const headers: Record<string, string> = { 'user-agent': 'FieldTest/1.0' };
    if (o.body !== undefined) headers['content-type'] = 'application/json';
    if (o.bearer) headers['authorization'] = `Bearer ${o.bearer}`;
    else headers['origin'] = FIELD_APP; // the field app's same-origin POST carries its Origin
    const code = o.code === undefined ? CODE : o.code;
    if (code) headers['x-link-code'] = code;
    if (o.cookie !== false && !o.bearer) {
      headers['cookie'] = `${deviceCookieName(MARCO)}=${DEVICE_TOKEN}`;
    }
    const res = await app.request(`/field-api/${path}`, {
      method,
      headers,
      body: o.body === undefined ? undefined : JSON.stringify(o.body),
    });
    const text = await res.text();
    return {
      status: res.status,
      json: (text ? JSON.parse(text) : {}) as Record<string, unknown>,
      headers: res.headers,
    };
  };
  return { store, livekit, talk, clock, call };
}

function claims(token: string): Record<string, unknown> {
  const p = token.split('.')[1]!.replace(/-/g, '+').replace(/_/g, '/');
  return JSON.parse(atob(p + '='.repeat((4 - (p.length % 4)) % 4)));
}

Deno.test(
  'talkNow: resolve and today say it when LiveKit is set here and billing allows',
  async () => {
    const h = setup();
    const r = await h.call('POST', 'resolve', { body: { code: CODE }, code: null });
    assertEquals(r.status, 200);
    assertEquals(r.json.talkNow, true);
    const t = await h.call('GET', `today?site=${SITE_A}`);
    assertEquals(t.status, 200);
    assertEquals(t.json.talkNow, true);

    // Billing-blocked (§F19 step 5: canceled, paused, past due beyond the grace days): off.
    h.talk.billing.set(ORG, { billingStatus: 'canceled', pastDueSince: null, graceDays: 14 });
    assertEquals((await h.call('GET', 'today')).json.talkNow, false);
    h.talk.billing.set(ORG, {
      billingStatus: 'past_due',
      pastDueSince: '2026-10-01T00:00:00Z',
      graceDays: 14,
    });
    assertEquals((await h.call('GET', 'today')).json.talkNow, true, 'inside the grace days');
    h.talk.billing.set(ORG, {
      billingStatus: 'past_due',
      pastDueSince: '2026-09-01T00:00:00Z',
      graceDays: 14,
    });
    assertEquals((await h.call('GET', 'today')).json.talkNow, false, 'past the grace days');
  },
);

Deno.test('talkNow: false without LiveKit here; the token route refuses', async () => {
  for (const livekit of ['unset', 'none'] as const) {
    const h = setup({ livekit });
    const r = await h.call('POST', 'resolve', { body: { code: CODE }, code: null });
    assertEquals(r.json.talkNow, false, livekit);
    assertEquals((await h.call('GET', 'today')).json.talkNow, false, livekit);
    const res = await h.call('POST', 'voice/token', { body: { siteId: SITE_A } });
    assertEquals(res.status, 403, livekit);
    assertEquals(res.json.error, 'talk_now_unavailable');
    assertEquals(h.store.callRows.length, 0);
  }
});

Deno.test('liveKitConfig: all three variables, a ws(s)/http(s) URL', () => {
  const env = (vars: Record<string, string>) => (n: string) => vars[n];
  const all = {
    LIVEKIT_URL: TEST_LIVEKIT.url,
    LIVEKIT_API_KEY: TEST_LIVEKIT.apiKey,
    LIVEKIT_API_SECRET: TEST_LIVEKIT.apiSecret,
  };
  assertEquals(liveKitConfig(env(all)), {
    url: TEST_LIVEKIT.url,
    apiKey: TEST_LIVEKIT.apiKey,
    apiSecret: TEST_LIVEKIT.apiSecret,
  });
  for (const k of Object.keys(all)) {
    assertEquals(liveKitConfig(env({ ...all, [k]: '' })), null, k);
  }
  assertEquals(liveKitConfig(env({ ...all, LIVEKIT_URL: 'ftp://x' })), null);
});

Deno.test(
  'voice/token: the call row, its room call-{id}, the agent dispatched, the token; no phone',
  async () => {
    const h = setup();
    const res = await h.call('POST', 'voice/token', { body: { siteId: SITE_B } });
    assertEquals(res.status, 201);
    assertEquals(res.headers.get('cache-control'), 'no-store');
    const { livekitUrl, token, room, callId } = res.json as Record<string, string>;
    assertEquals(livekitUrl, TEST_LIVEKIT.url);
    assertEquals(room, `call-${callId}`);
    assertMatch(callId!, /^[0-9a-f-]{36}$/);

    // The row: web, inbound, queued, the site and the reporter; audited as the reporter.
    const row = h.store.callRows.find((c) => c.id === callId)!;
    assertEquals(
      {
        transport: row.transport,
        direction: row.direction,
        purpose: row.purpose,
        status: row.status,
        site: row.site_id,
        reporter: row.reporter_id,
        room: row.provider_call_id,
        from: row.from_e164,
      },
      {
        transport: 'web',
        direction: 'inbound',
        purpose: 'daily_report',
        status: 'queued',
        site: SITE_B,
        reporter: MARCO,
        room,
        from: null,
      },
    );
    const audit = h.store.audits.find((a) => a.action === 'call.requested')!;
    assertEquals(audit.actorType, 'reporter');
    assertEquals(audit.entityId, callId);

    // The room with the call id in its metadata, the agent dispatched explicitly to it.
    assertEquals(h.livekit.rooms, [
      { name: room!, metadata: JSON.stringify({ callId, transport: 'web' }), emptyTimeoutS: 120 },
    ]);
    assertEquals(h.livekit.dispatches, [
      {
        room: room!,
        agentName: 'sitelog-voice',
        metadata: JSON.stringify({ callId, transport: 'web' }),
      },
    ]);
    // The participant token: that room only, identity the call id.
    const c = claims(token!);
    assertEquals(c.sub, callId);
    assertEquals((c.video as Record<string, unknown>).room, room);
    assertEquals((c.video as Record<string, unknown>).roomJoin, true);
    assertEquals((c.video as Record<string, unknown>).roomAdmin, undefined);
    assertEquals(c.iss, TEST_LIVEKIT.apiKey);

    // No phone number anywhere the browser or LiveKit sees.
    for (const text of [
      JSON.stringify(res.json),
      JSON.stringify(c),
      JSON.stringify(h.livekit.rooms),
      JSON.stringify(h.livekit.dispatches),
      JSON.stringify(audit),
    ]) {
      assert(!text.includes(MARCO_PHONE), text);
    }

    // The agent then starts this call by its room and id (W3-03), as a web call.
    const start = await h.call('POST', 'voice/calls/start', {
      body: { room, callId, transport: 'web' },
      bearer: SECRET,
      code: null,
    });
    assertEquals(start.status, 200);
    const parsed = VoiceCallStartResponseSchema.parse(start.json);
    assertEquals(parsed.callId, callId);
    assertEquals(parsed.callToken, await deriveCallToken(TOKEN_SECRET, callId!));
    assertEquals(parsed.reporter?.firstName, 'Marco');
    assertEquals(row.status, 'in_progress');
  },
);

Deno.test('voice/token: link, device and consents first', async () => {
  const h = setup();
  const noCookie = await h.call('POST', 'voice/token', { body: { siteId: SITE_A }, cookie: false });
  assertEquals(noCookie.status, 401);
  assertEquals(noCookie.json.error, 'device_unverified');
  const noCode = await h.call('POST', 'voice/token', { body: { siteId: SITE_A }, code: null });
  assertEquals(noCode.status, 401);
  const unknown = await h.call('POST', 'voice/token', {
    body: { siteId: SITE_A },
    code: 'ZZZZZZ',
  });
  assertEquals(unknown.status, 401);
  const ok = await h.call('POST', 'voice/token', {
    body: { siteId: SITE_A },
    code: CODE,
  });
  assertEquals(ok.status, 201, 'the field app’s own origin is accepted');
  assertEquals(h.livekit.rooms.length, 1);

  // Without the recording consent: refused before any row or room.
  const h2 = setup({ consents: ['data_processing', 'sms'] });
  const res = await h2.call('POST', 'voice/token', { body: { siteId: SITE_A } });
  assertEquals(res.status, 403);
  assertEquals(res.json.error, 'consent_required');
  assertEquals(h2.store.callRows.length, 0);
  assertEquals(h2.livekit.rooms.length, 0);
});

Deno.test('voice/token: one of the link’s active sites only', async () => {
  const h = setup();
  for (const [siteId, status, error] of [
    [SITE_X, 404, 'not_found'],
    [SITE_P, 409, 'site_inactive'],
    ['not-a-uuid', 400, 'invalid_request'],
  ] as const) {
    const res = await h.call('POST', 'voice/token', { body: { siteId } });
    assertEquals([res.status, res.json.error], [status, error], siteId);
  }
  // A daily link of Pier 9 starts no call at Riverside.
  const daily = await h.call('POST', 'voice/token', { body: { siteId: SITE_A }, code: DAILY });
  assertEquals(daily.status, 404);
  const ok = await h.call('POST', 'voice/token', { body: { siteId: SITE_B }, code: DAILY });
  assertEquals(ok.status, 201);
  assertEquals(h.store.callRows.length, 1);
});

Deno.test('voice/token: 3 starts an hour per device, then 429 with Retry-After', async () => {
  const h = setup();
  for (let i = 0; i < 3; i++) {
    assertEquals((await h.call('POST', 'voice/token', { body: { siteId: SITE_A } })).status, 201);
  }
  const fourth = await h.call('POST', 'voice/token', { body: { siteId: SITE_A } });
  assertEquals(fourth.status, 429);
  assertEquals(fourth.json.error, 'rate_limited');
  assert(Number(fourth.headers.get('retry-after')) > 0);
  assertEquals(h.store.callRows.length, 3);
  h.clock.now = new Date(T0.getTime() + 61 * 60_000);
  assertEquals((await h.call('POST', 'voice/token', { body: { siteId: SITE_A } })).status, 201);
});

Deno.test(
  'voice/token: LiveKit failing ends the call at once (failed, not_reached), 502',
  async () => {
    for (const fail of ['createRoom', 'dispatchAgent'] as const) {
      const h = setup();
      h.livekit.fail = fail;
      const res = await h.call('POST', 'voice/token', { body: { siteId: SITE_A } });
      assertEquals(res.status, 502, fail);
      assertEquals(res.json.error, 'voice_unavailable');
      const row = h.store.callRows[0]!;
      assertEquals([row.status, row.outcome], ['failed', 'not_reached']);
      assert(row.ended_at);
      assertEquals(h.livekit.tokens.length, 0, 'no token for a call that cannot happen');
      assertEquals(
        h.store.audits.filter((a) => a.action === 'call.ended' && a.entityId === row.id).length,
        1,
      );
    }
  },
);

Deno.test(
  'liveKitHttpApi: Twirp CreateRoom and CreateDispatch with short server tokens',
  async () => {
    const requests: { url: string; auth: string; body: Record<string, unknown> }[] = [];
    const api = liveKitHttpApi(TEST_LIVEKIT, {
      now: () => T0,
      fetch: (input, init) => {
        requests.push({
          url: String(input),
          auth: new Headers(init?.headers).get('authorization') ?? '',
          body: JSON.parse(String(init?.body)),
        });
        return Promise.resolve(new Response('{}', { status: 200 }));
      },
    });
    const room = 'call-6a0c1e2f-3b4d-4e5f-8a9b-0c1d2e3f4a5b';
    await api.createRoom({ name: room, metadata: '{"callId":"x"}', emptyTimeoutS: 120 });
    await api.dispatchAgent({ room, agentName: 'sitelog-voice', metadata: '{}' });
    assertEquals(
      requests.map((r) => r.url),
      [
        'https://sitelog-test.livekit.invalid/twirp/livekit.RoomService/CreateRoom',
        'https://sitelog-test.livekit.invalid/twirp/livekit.AgentDispatchService/CreateDispatch',
      ],
    );
    assertEquals(requests[0]!.body, { name: room, metadata: '{"callId":"x"}', empty_timeout: 120 });
    assertEquals(requests[1]!.body, { room, agent_name: 'sitelog-voice', metadata: '{}' });
    const create = claims(requests[0]!.auth.replace(/^Bearer /, ''));
    assertEquals(create.video, { roomCreate: true });
    assertEquals((create.exp as number) - (create.nbf as number), 60);
    const dispatch = claims(requests[1]!.auth.replace(/^Bearer /, ''));
    assertEquals(dispatch.video, { roomAdmin: true, room });

    const failing = liveKitHttpApi(TEST_LIVEKIT, {
      fetch: () => Promise.resolve(new Response('no', { status: 503 })),
    });
    let threw = false;
    try {
      await failing.createRoom({ name: room, metadata: '{}', emptyTimeoutS: 1 });
    } catch {
      threw = true;
    }
    assert(threw, 'a refused Twirp call throws');
  },
);

Deno.test('a photos link starts no call (F9: it takes photos only)', async () => {
  const h = setup();
  const res = await h.call('POST', 'voice/token', { body: { siteId: SITE_A }, code: PHOTOS });
  assertEquals(res.status, 400);
  assertEquals(res.json.error, 'kind_not_allowed');
  assertEquals(h.store.callRows.length, 0);
  assertEquals(h.livekit.rooms.length, 0);
});
