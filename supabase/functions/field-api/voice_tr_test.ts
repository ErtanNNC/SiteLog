import { assert, assertEquals } from '@std/assert';
import {
  type ConsentType,
  type CountryRow,
  type Json,
  type OrgRow,
  type ReporterRow,
  type SiteRow,
  SetDayStatusResponseSchema,
  UpdateDraftResponseSchema,
  VoiceCallStartResponseSchema,
  readBack,
  readReportData,
  speakable,
} from '@sitelog/shared';
import { DEMO_COUNTRIES } from '@sitelog/shared/demo/countries.ts';
import { createFieldApp } from './app.ts';
import { FakeFieldStore } from './fake_store.ts';
import { FakeVoiceSpecialStore } from './fake_voice_special.ts';
import kartalHero from '../../../fixtures/calls/kartal-hero-tr.json' with { type: 'json' };
import kartalWeather from '../../../fixtures/calls/kartal-weather-tr.json' with { type: 'json' };
import kartalExpected from '../../../fixtures/expected/call-kartal-2026-10-09-tr.json' with { type: 'json' };

/**
 * W4-07 (spec §9.4 "numbers spoken naturally", §16.2 M11; §19 Q245 `SPOKEN_FORM`): field-api's
 * voice routes on a Turkish call of Demir Yapı (§18.2: Emre Yıldız, Kartal) by Talk now, on the
 * in-memory stores. Every line a tool answer hands the agent leaves in Turkish words: the worker's
 * read-back (numbers, the ordinal "3. Kat", ",5" as "buçuk"), and W3-14's day-off read-back (the
 * stop "11:00" as "on bir", the lost hours as "dört buçuk"). The answers are the recorded TR calls
 * (`fixtures/calls/kartal-*-tr`) the agent's replay and `pnpm simulate:call` use.
 */

const ORG = 'd1000000-0000-4000-8000-0000000000f1';
const KARTAL = 'd1000000-0000-4000-8000-00000000a001';
const EMRE = 'd1000000-0000-4000-8000-0000000000e1';
const SECRET = 'test-voice-agent-tool-secret';
const TOKEN_SECRET = 'test-voice-call-token-secret';
/** Fri Oct 9, 2026, 13:00 in Istanbul. */
const T0 = new Date('2026-10-09T10:00:00Z');

function setup() {
  const clock = { now: T0 };
  const store = new FakeFieldStore(() => clock.now);
  const special = new FakeVoiceSpecialStore(store, () => clock.now);
  const tr = DEMO_COUNTRIES.find((c) => c.code === 'TR')!;
  // The TR pack has no voice number (§19 Q2): its calls are Talk now.
  store.countries.push({ ...tr, voice_number: null } as CountryRow);
  store.orgs.push({
    id: ORG,
    name: 'Demir Yapı A.Ş.',
    country: 'TR',
    locale: 'tr-TR',
    timezone: 'Europe/Istanbul',
    is_demo: false,
    units: 'metric',
  } as OrgRow);
  store.settings.push({
    org_id: ORG,
    default_deadline: '17:30:00',
    working_days: [1, 2, 3, 4, 5],
    default_shift_hours: 8,
    max_questions_per_report: 3,
  } as never);
  store.sites.push({
    id: KARTAL,
    org_id: ORG,
    name: 'Kartal Konutları — B Blok',
    project_code: 'KK',
    address: null,
    lat: null,
    lng: null,
    timezone: 'Europe/Istanbul',
    deadline: null,
    working_hours: '07:00–15:30',
    status: 'active',
    active_since: '2026-10-05',
    paused_at: null,
    report_seq: 0,
    created_at: '2026-10-05T06:00:00Z',
  } as SiteRow);
  store.reporters.push({
    id: EMRE,
    org_id: ORG,
    name: 'Emre Yıldız',
    phone_e164: '+905320001203',
    role: 'site_manager',
    languages: ['tr'],
    status: 'active',
    invited_at: '2026-10-05T06:05:00Z',
    verified_at: null,
    last_invite_error: null,
    created_at: '2026-10-05T06:05:00Z',
    locale: 'tr-TR',
    contact_pref: 'call',
    activated_at: '2026-10-05T06:40:00Z',
    opted_out_at: null,
    message_channel: null,
    no_calls_until: null,
  } as ReporterRow);
  store.siteReporters.push({ site_id: KARTAL, reporter_id: EMRE });
  store.siteDays.push({
    id: 'sd-kk-1009',
    site_id: KARTAL,
    date: '2026-10-09',
    status: 'reminded',
  } as never);
  const consent = (type: ConsentType) =>
    store.consents.push({
      id: crypto.randomUUID(),
      reporter_id: EMRE,
      type,
      method: 'web_checkbox',
      text_version: 'field.consent.v1',
      evidence: null,
      given_at: '2026-10-05T06:40:00Z',
      revoked_at: null,
    });
  for (const t of ['recording', 'data_processing', 'sms'] as const) consent(t);
  // §18.2's roster and glossary (the recorded get_context's companies and key terms).
  for (const name of ['Usta Beton', 'Volt Elektrik', 'Akış Mekanik', 'Demir Yapı öz ekip'])
    store.companies.push({ org_id: ORG, name, aliases: [] });
  for (const heard of ['döküm', 'kalıp söktük', 'demirci ekibi', 'TBM', 'tool box'])
    store.glossary.push({
      org_id: ORG,
      scope_site_id: null,
      scope_reporter_id: null,
      heard,
      official: null,
      language: 'tr',
      kind: 'term',
      status: 'confirmed',
      times_heard: 1,
    });
  const app = createFieldApp({
    store,
    sendVerifyCode: () => Promise.resolve({ channel: 'sms', messageId: 'm' }),
    sendDailyLink: () => Promise.resolve({ channel: 'sms', messageId: 'm' }),
    fieldAppUrl: () => 'https://go.sitelog.test',
    linkSigningSecret: () => 'test-link-signing-secret',
    allowedOrigins: () => ['https://go.sitelog.test'],
    now: () => clock.now,
    voiceToolSecret: () => SECRET,
    callTokenSecret: () => TOKEN_SECRET,
    voiceToolWaitMs: () => 600,
    voiceSpecial: { store: special },
    sleep: (ms) => {
      clock.now = new Date(clock.now.getTime() + ms);
      return Promise.resolve();
    },
  });
  const call = async (path: string, body: unknown, token?: string) => {
    const headers: Record<string, string> = {
      'content-type': 'application/json',
      authorization: `Bearer ${SECRET}`,
    };
    if (token) headers['x-call-token'] = token;
    const res = await app.request(`/field-api/${path}`, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
    });
    const text = await res.text();
    return { status: res.status, json: text ? JSON.parse(text) : {}, text };
  };
  /** A Talk now call (W3-13): field-api's voice/token made the row; the agent starts it. */
  const talkNow = async (callId: string) => {
    store.callRows.push({
      id: callId,
      org_id: ORG,
      reporter_id: EMRE,
      site_id: KARTAL,
      report_id: null,
      direction: 'inbound',
      transport: 'web',
      purpose: 'daily_report',
      provider_call_id: null,
      from_e164: null,
      to_e164: null,
      status: 'queued',
      outcome: null,
      disclosure_played: false,
      disclosure_version: null,
      started_at: null,
      answered_at: null,
      ended_at: null,
      duration_s: null,
      recording_path: null,
      peaks: null,
      dialog_log: null,
      metrics: null,
      created_at: T0.toISOString(),
      language: 'tr-TR',
      call_token_issued_at: null,
      attempt: null,
      site_day_id: 'sd-kk-1009',
      fallback: null,
      reconcile: null,
      consent_declined_at: null,
    } as never);
    const res = await call('voice/calls/start', {
      room: `call-${callId}`,
      transport: 'web',
      callId,
    });
    assertEquals(res.status, 200, res.text);
    const started = VoiceCallStartResponseSchema.parse(res.json);
    return { callId: started.callId, token: started.callToken };
  };
  const tool = (name: string, c: { callId: string; token: string }, body = {}) =>
    call(`voice/tools/${name}`, { callId: c.callId, ...body }, c.token);
  return { store, clock, call, talkNow, tool };
}

type Recorded = { routes: Record<string, unknown[]>; start: { request: { callId: string } } };

Deno.test(
  'TR Talk now: get_context answers the recorded Turkish context; the day off read back in Turkish words',
  async () => {
    const h = setup();
    const recorded = kartalWeather as unknown as Recorded;
    const c = await h.talkNow(recorded.start.request.callId);
    const ctx = await h.tool('get_context', c);
    assertEquals(ctx.status, 200, ctx.text);
    assertEquals(ctx.json, recorded.routes.get_context![0]);

    // "Yağmur yüzünden iş durdu, saat on birde herkesi eve gönderdim, sahada on iki kişi vardı."
    const body = {
      status: 'weather_day',
      details: { since: '11:00', workersBefore: 12 },
      start: 3,
    };
    const first = await h.tool('set_day_status', c, body);
    assertEquals(first.status, 200, first.text);
    const read = SetDayStatusResponseSchema.parse(first.json);
    const [confirm, logged] = recorded.routes.set_day_status as Array<{
      status: string;
      confirmation: string;
    }>;
    // 07:00–15:30 stopped at 11:00: 4,5 saat from code, said "dört buçuk"; 11:00 said "on bir".
    assertEquals([read.status, read.confirmation], [confirm!.status, confirm!.confirmation]);
    assert(!/\d/.test(read.confirmation), read.confirmation);
    assert(read.confirmKey);
    const yes = await h.tool('set_day_status', c, {
      ...body,
      utterance: 'Evet.',
      confirmKey: read.confirmKey,
    });
    assertEquals(yes.status, 200, yes.text);
    assertEquals(yes.json, logged);
    const report = h.store.reports.find((r) => r.site_id === KARTAL)!;
    assertEquals([report.kind, report.channel], ['weather_day', 'voice']);
    const version = h.store.versions.find((v) => v.report_id === report.id)!;
    assertEquals(readReportData(version.data as never).weather.periods[0]!.lostHours, 4.5);
  },
);

Deno.test(
  "TR Talk now: the worker's read-back leaves field-api in Turkish words (the recorded hero call)",
  async () => {
    const h = setup();
    const recorded = kartalHero as unknown as Recorded;
    const c = await h.talkNow(recorded.start.request.callId);
    // The worker's answer: code's read-back of the Kartal draft, written as Turkish writes it.
    const written = readBack(readReportData(kartalExpected as never), 'tr');
    assertEquals(
      written.slice(0, 92),
      'Elimdeki bilgiler: 3 firmadan sahada 12 kişi, toplam 90 saat. Hava nedeniyle 1,5 saat çalışı',
    );
    const want = recorded.routes.update_draft![0] as { reportId: string; draftRev: number };
    h.store.onVoiceTurn = (t) =>
      Object.assign(t, {
        status: 'done',
        result: {
          reportId: want.reportId,
          draftRev: want.draftRev,
          missing: [],
          question: null,
          readBack: written,
        } as Json,
        error: null,
      });
    const res = await h.tool('update_draft', c, {
      segments: [
        { start: 6, end: 11.5, text: 'Merhaba, ben Emre, Kartal B Blok için bugünün raporu.' },
      ],
    });
    assertEquals(res.status, 200, res.text);
    const state = UpdateDraftResponseSchema.parse(res.json);
    assertEquals(state as unknown, want);
    assertEquals((state as { readBack: string }).readBack, speakable(written, 'tr'));
    assert(!/\d/.test((state as { readBack: string }).readBack));
  },
);
