import { assert, assertEquals, assertMatch } from '@std/assert';
import {
  ApplyCorrectionResponseSchema,
  type ConsentType,
  type CountryRow,
  emptyReportData,
  type OrgRow,
  type ReporterRow,
  RecordConsentResponseSchema,
  SaveChangeResponseSchema,
  SetDayStatusResponseSchema,
  type SiteRow,
  VoiceCallStartResponseSchema,
  renderVoice,
  readReportData,
} from '@sitelog/shared';
import { DEMO_COUNTRIES } from '@sitelog/shared/demo/countries.ts';
import { createFieldApp, type DailyLinkMessage } from './app.ts';
import { FakeFieldStore } from './fake_store.ts';
import { FakeVoiceSpecialStore } from './fake_voice_special.ts';

/**
 * W3-14 on the in-memory stores (spec F3, F6 special intents, F10, F12, F13, F15 on a call; §19
 * Q79, Q120, Q124, Q128, Q129, Q136): field-api's `voice_special.ts` routes behind the same two
 * auth layers as every voice route. The SQL behind the RPCs is tested on PGlite
 * (supabase/db-tests/src/voice-special-intents.test.ts).
 *
 * The ticket's "Done when" on Kestrel's people in a real (non-demo) org (§19 Q44, Q116):
 * Hillcrest's weather day said on a call files with code's lost hours and the photos link; "change
 * Friday's report, Apex was seven" makes Friday's version 2 via the call; an unknown number leaves
 * its snippet for the Team alert; a first-time caller who says yes is active with `voice_yes`.
 */

const ORG = '22222222-0000-4000-8000-000000000001';
const NORTHGATE = '22222222-0000-4000-8000-0000000000a1';
const HILLCREST = '22222222-0000-4000-8000-0000000000a5';
const KEVIN = '22222222-0000-4000-8000-000000000101';
const AISHA = '22222222-0000-4000-8000-000000000104';
const DANA = '22222222-0000-4000-8000-000000000105';
const KEVIN_PHONE = '+15550142087';
const AISHA_PHONE = '+15550149932';
const DANA_PHONE = '+15550177001';
const STRANGER = '+15550199001';
const VOICE_NUMBER = '+15550142290';
const SECRET = 'test-voice-agent-tool-secret';
const TOKEN_SECRET = 'test-voice-call-token-secret';
/** Mon Oct 12, 2026, 16:00 in Chicago: "Friday" is Oct 9. */
const T0 = new Date('2026-10-12T21:00:00Z');

const room = (n: number) => `call-37373737-0000-4000-8000-${n.toString(16).padStart(12, '0')}`;

function site(id: string, name: string, code: string): SiteRow {
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
    status: 'active',
    invited_at: '2026-10-01T15:00:00Z',
    verified_at: null,
    last_invite_error: null,
    created_at: '2026-10-01T15:00:00Z',
    locale: 'en-US',
    contact_pref: 'call',
    activated_at: '2026-10-01T15:00:00Z',
    opted_out_at: null,
    message_channel: null,
    no_calls_until: null,
    ...extra,
  };
}

function setup(opts: { waitMs?: number; onSleep?: () => void; trunk?: boolean } = {}) {
  const clock = { now: T0 };
  const store = new FakeFieldStore(() => clock.now);
  const special = new FakeVoiceSpecialStore(store, () => clock.now);
  const us = DEMO_COUNTRIES.find((c) => c.code === 'US')!;
  store.countries.push({
    ...us,
    voice_number: VOICE_NUMBER,
    // W3-17: the pack's outbound trunk here (§19 Q125), so the org places calls.
    outbound_trunk_id: opts.trunk ? 'ST_testTrunk1' : null,
  } as CountryRow);
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
    max_questions_per_report: 2,
  } as never);
  store.sites.push(
    site(NORTHGATE, 'Northgate Parking Structure', 'NG'),
    site(HILLCREST, 'Hillcrest School Extension', 'HS'),
  );
  store.reporters.push(
    reporter(KEVIN, "Kevin O'Brien", KEVIN_PHONE),
    reporter(AISHA, 'Aisha Bello', AISHA_PHONE),
    reporter(DANA, 'Dana Field', DANA_PHONE, { status: 'invited', activated_at: null }),
  );
  store.siteReporters.push(
    { site_id: NORTHGATE, reporter_id: KEVIN },
    { site_id: HILLCREST, reporter_id: AISHA },
    { site_id: HILLCREST, reporter_id: DANA },
  );
  const consent = (reporterId: string, type: ConsentType) =>
    store.consents.push({
      id: crypto.randomUUID(),
      reporter_id: reporterId,
      type,
      method: 'web_checkbox',
      text_version: 'field.consent.v1',
      evidence: null,
      given_at: '2026-10-01T15:00:00Z',
      revoked_at: null,
    });
  for (const t of ['recording', 'data_processing', 'sms'] as const) {
    consent(KEVIN, t);
    consent(AISHA, t);
  }
  if (opts.trunk) consent(KEVIN, 'auto_call');
  const texts: DailyLinkMessage[] = [];
  const app = createFieldApp({
    store,
    sendVerifyCode: () => Promise.resolve({ channel: 'sms', messageId: 'm' }),
    sendDailyLink: (m) => {
      texts.push(m);
      return Promise.resolve({ channel: 'sms', messageId: 'm' });
    },
    fieldAppUrl: () => 'https://go.sitelog.test',
    linkSigningSecret: () => 'test-link-signing-secret',
    allowedOrigins: () => ['https://go.sitelog.test'],
    now: () => clock.now,
    voiceToolSecret: () => SECRET,
    callTokenSecret: () => TOKEN_SECRET,
    voiceToolWaitMs: () => opts.waitMs ?? 600,
    voiceSpecial: { store: special },
    sleep: (ms) => {
      clock.now = new Date(clock.now.getTime() + ms);
      opts.onSleep?.();
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
  const sip = async (n: number, from: string) => {
    const res = await call('voice/calls/start', {
      room: room(n),
      from,
      to: VOICE_NUMBER,
      transport: 'pstn',
    });
    assertEquals(res.status, 200, res.text);
    VoiceCallStartResponseSchema.parse(res.json);
    return {
      callId: res.json.callId as string,
      token: res.json.callToken as string,
      json: res.json,
    };
  };
  const tool = (name: string, c: { callId: string; token: string }, body = {}) =>
    call(`voice/tools/${name}`, { callId: c.callId, ...body }, c.token);
  return { store, special, clock, call, sip, tool, texts };
}

Deno.test(
  "done when: Hillcrest's rained-out day, said on a call, files with code's lost hours and the photos link",
  async () => {
    const h = setup();
    const c = await h.sip(1, AISHA_PHONE);
    // "We got rained out, sent everyone home at eleven, twelve on site."
    const details = { since: '11:00', workersBefore: 12 };
    const first = await h.tool('set_day_status', c, {
      status: 'weather_day',
      details,
      start: 4.5,
      end: 9,
    });
    assertEquals(first.status, 200, first.text);
    const read = SetDayStatusResponseSchema.parse(first.json);
    assertEquals(read.status, 'confirm');
    // 07:00–15:30, stopped at 11:00: 4.5 h lost, from code (never the model).
    assertEquals(
      read.confirmation,
      'Weather day at Hillcrest School Extension: work stopped at 11:00, 12 on site before, 4.5 hours lost. Shall I log it?',
    );
    assert(read.confirmKey);
    assertEquals(h.store.reports.length, 0);

    // Not a yes: nothing logged, asked again with the same key.
    const unsure = await h.tool('set_day_status', c, {
      status: 'weather_day',
      details,
      utterance: 'I guess so',
      confirmKey: read.confirmKey,
    });
    assertEquals(unsure.json, {
      status: 'not_confirmed',
      confirmation: 'Shall I log it? Say yes or no.',
      confirmKey: read.confirmKey,
    });
    assertEquals(h.store.reports.length, 0);
    // A yes to other details than the ones read back is a new read-back.
    const other = await h.tool('set_day_status', c, {
      status: 'weather_day',
      details: { since: '10:00', workersBefore: 12 },
      utterance: 'Yes.',
      confirmKey: read.confirmKey,
    });
    assertEquals(other.json.status, 'confirm');
    assertEquals(h.store.reports.length, 0);

    const yes = await h.tool('set_day_status', c, {
      status: 'weather_day',
      details,
      start: 4.5,
      end: 9,
      utterance: 'Yes.',
      confirmKey: read.confirmKey,
    });
    assertEquals(yes.status, 200, yes.text);
    assertEquals(yes.json, {
      status: 'ok',
      confirmation:
        "Logged: weather day at Hillcrest School Extension. A photo of the conditions makes the record stronger — I've sent you a link.",
    });
    const report = h.store.reports.find((r) => r.site_id === HILLCREST)!;
    assertEquals(
      [report.kind, report.channel, report.status],
      ['weather_day', 'voice', 'processing'],
    );
    const day = h.store.siteDays.find((d) => d.id === report.site_day_id)!;
    assertEquals([day.date, day.status], ['2026-10-12', 'weather_day']);
    const version = h.store.versions.find((v) => v.report_id === report.id)!;
    assertEquals(version.via, 'voice');
    const data = readReportData(version.data as never);
    assertEquals(data.weather.periods[0]!.lostHours, 4.5);
    const callSource = { type: 'call' as const, callId: c.callId, start: 4.5, end: 9 };
    assertEquals(data.weather.periods[0]!.source, [callSource]);
    assertEquals(data.manpower[0]!.workers, 12);
    assertEquals(data.manpower[0]!.totalHours, 48); // 12 × 4 h worked before the stop
    assertEquals(data.manpower[0]!.source, [callSource]);
    // Filed by its job (the worker texts the photos link after a weather day on a call).
    assertEquals(
      h.store.jobs.filter((j) => j.type === 'file_report').map((j) => j.payload),
      [{ reportId: report.id, trigger: 'weather_day' }],
    );
    assertEquals(h.store.callRows[0]!.report_id, report.id);
    // The yes again (the agent's retry): logged, nothing new.
    const again = await h.tool('set_day_status', c, {
      status: 'weather_day',
      details,
      utterance: 'Yes.',
      confirmKey: read.confirmKey,
    });
    assertEquals(again.json.status, 'ok');
    assertEquals(h.store.reports.length, 1);
  },
);

Deno.test(
  "set_day_status: 'No work today?' first; a live report says it in the report (§19 Q79)",
  async () => {
    const h = setup();
    const c = await h.sip(2, KEVIN_PHONE);
    const ask = await h.tool('set_day_status', c, { status: 'no_work' });
    assertEquals(ask.json.status, 'confirm');
    assertEquals(
      ask.json.confirmation,
      'No work today at Northgate Parking Structure? Say yes or no.',
    );
    // The day's report has already started (a voice note, a turn of this call).
    h.store.siteDays.push({
      id: 'sd-ng',
      site_id: NORTHGATE,
      date: '2026-10-12',
      status: 'processing',
    } as never);
    h.store.reports.push({
      id: '55555555-0000-4000-8000-000000000001',
      site_day_id: 'sd-ng',
      site_id: NORTHGATE,
      org_id: ORG,
      status: 'processing',
    } as never);
    const live = await h.tool('set_day_status', c, {
      status: 'no_work',
      utterance: 'yes',
      confirmKey: ask.json.confirmKey,
    });
    assertEquals(live.json, {
      status: 'report_in_progress',
      confirmation: renderVoice('day_off_in_progress', 'en'),
    });
    assertEquals(h.store.siteDays.find((d) => d.id === 'sd-ng')!.status, 'processing');
  },
);

Deno.test(
  'set_day_status: an unknown caller and a caller without consent are refused',
  async () => {
    const h = setup();
    const unknown = await h.sip(3, STRANGER);
    const r = await h.tool('set_day_status', unknown, { status: 'no_work' });
    assertEquals([r.status, r.json.error], [403, 'unknown_caller']);
    const dana = await h.sip(4, DANA_PHONE);
    const d = await h.tool('set_day_status', dana, { status: 'no_work' });
    assertEquals([d.status, d.json.error], [403, 'consent_required']);
  },
);

/** Kevin's filed Friday report at Northgate (Apex Concrete 6 × 8 h). */
function friday(
  h: ReturnType<typeof setup>,
  date = '2026-10-09',
  id = '44444444-0000-4000-8000-000000000001',
) {
  h.store.siteDays.push({ id: `sd-${date}`, site_id: NORTHGATE, date, status: 'filed' } as never);
  h.store.reports.push({
    id,
    site_day_id: `sd-${date}`,
    site_id: NORTHGATE,
    org_id: ORG,
    report_no: 'NG-0068',
    status: 'filed',
    filed_at: T0.toISOString(),
    current_version: 1,
    is_late: false,
    language: 'en',
  } as never);
  h.store.versions.push({
    report_id: id,
    version: 1,
    data: {
      ...emptyReportData(date, { reportLanguage: 'en', units: 'imperial' }),
      manpower: [
        {
          companyId: null,
          companyNameHeard: 'Apex',
          companyName: 'Apex Concrete',
          workers: 6,
          hoursPerWorker: 8,
          totalHours: 48,
          hoursBasis: 'stated',
          confidence: 0.9,
          source: [],
        },
      ],
    } as never,
    summary: null,
    pdf_path: null,
    author: 'agent',
    author_user_id: null,
    author_message_id: null,
    change_note: null,
    created_at: T0.toISOString(),
    via: null,
    draft_rev: 1,
  } as never);
  return id;
}

Deno.test(
  'done when: "change Friday\'s report, Apex was seven" makes Friday\'s version 2 via the call, after the yes',
  async () => {
    const h = setup();
    const R = friday(h);
    const c = await h.sip(5, KEVIN_PHONE);
    const found = await h.tool('load_report', c, { dayReference: "Friday's report" });
    assertEquals(found.json.status, 'found', found.text);
    assertEquals(found.json.reportId, R);

    // The worker makes the preview (apply_correction, code's numbers); here the test settles it.
    const pending = await h.tool('apply_correction', c, {
      utterance: 'Apex was seven',
      start: 22.5,
      end: 24,
      reportId: R,
    });
    assertEquals(pending.status, 202, pending.text);
    assertEquals(pending.json, { status: 'pending', retryAfterMs: 1000 });
    const row = h.store.corrections[0]!;
    assertEquals([row.via, row.after_filing, row.call_id], ['voice', true, c.callId]);
    assertEquals(row.source, { type: 'call', callId: c.callId, start: 22.5, end: 24 });
    h.store.settleCorrectionReady(row.id, readReportData(h.store.versions[0]!.data as never), [
      {
        kind: 'crew',
        company: 'Apex Concrete',
        change: 'changed',
        workers: [6, 7],
        hoursPerWorker: [8, 8],
        totalHours: [48, 56],
      },
    ]);
    // The same words again find the same change, now ready: read back with "Save it?".
    const preview = await h.tool('apply_correction', c, {
      utterance: 'Apex was seven',
      start: 22.5,
      end: 24,
      reportId: R,
    });
    assertEquals(preview.status, 200, preview.text);
    const p = ApplyCorrectionResponseSchema.parse(preview.json);
    assertEquals(p, {
      status: 'preview',
      correctionId: row.id,
      lines: ['Apex Concrete: 7 workers, 8 hours each — 56 hours.'],
      readBack: 'Apex Concrete: 7 workers, 8 hours each — 56 hours. Save it?',
      draft: null,
    });
    assertEquals(h.store.corrections.length, 1);
    assertEquals(h.store.reports[0]!.current_version, 1);

    // Not a clear yes: nothing saved.
    const unsure = await h.tool('save_change', c, {
      reportId: R,
      correctionId: row.id,
      utterance: 'sounds good I guess',
    });
    assertEquals(unsure.json, {
      status: 'not_confirmed',
      confirmation: 'Save it? Say yes or no.',
    });
    assertEquals(h.store.reports[0]!.current_version, 1);

    const yes = await h.tool('save_change', c, {
      reportId: R,
      correctionId: row.id,
      utterance: 'Yes, please.',
    });
    assertEquals(yes.status, 200, yes.text);
    assertEquals(SaveChangeResponseSchema.parse(yes.json), {
      status: 'saved',
      version: 2,
      confirmation: 'Saved. Version 2 goes to the office.',
    });
    const v2 = h.store.versions.find((v) => v.report_id === R && v.version === 2)!;
    assertEquals([v2.author, v2.via, v2.author_reporter_id], ['reporter', 'voice', KEVIN]);
    assertEquals(v2.change_note, 'Apex Concrete 6 → 7 workers, 48 → 56 h');
    // The edit_applied text's day and change, in the reporter's language with GSM-7 punctuation.
    assertEquals(h.store.saved[0]!.message, {
      weekday: 'Friday',
      change: 'Apex Concrete 6 -> 7 workers, 48 -> 56 h',
    });
    assert(h.store.jobs.some((j) => j.type === 'render_pdf' && j.payload.version === 2));
  },
);

Deno.test(
  "F10 on a call: a report older than 14 days is locked; another reporter's is out of scope",
  async () => {
    const h = setup();
    const OLD = friday(h, '2026-09-18', '44444444-0000-4000-8000-000000000002');
    const c = await h.sip(6, KEVIN_PHONE);
    const locked = await h.tool('apply_correction', c, {
      utterance: 'Apex was seven',
      start: 3,
      reportId: OLD,
    });
    assertEquals([locked.status, locked.json.error], [409, 'report_locked']);
    const aisha = await h.sip(7, AISHA_PHONE);
    const other = await h.tool('apply_correction', aisha, {
      utterance: 'Apex was seven',
      start: 3,
      reportId: OLD,
    });
    assertEquals([other.status, other.json.error], [403, 'out_of_scope']);
  },
);

Deno.test(
  'done when: a first-time caller who says yes is active, with voice_yes and the call as evidence',
  async () => {
    const h = setup();
    const c = await h.sip(8, DANA_PHONE);
    const ctx = await h.tool('get_context', c);
    assertEquals(ctx.json.consents, {
      recording: false,
      dataProcessing: false,
      sms: false,
      autoCall: false,
    });
    const unclear = await h.tool('record_consent', c, { utterance: 'what is this about', at: 6 });
    assertEquals(RecordConsentResponseSchema.parse(unclear.json), {
      status: 'not_understood',
      confirmation: renderVoice('consent_repeat', 'en'),
      linkSent: false,
    });
    const yes = await h.tool('record_consent', c, { utterance: 'Yes.', at: 11.2 });
    assertEquals(yes.json, { status: 'given', confirmation: 'Thank you.', linkSent: false });
    const rows = h.store.consents.filter((x) => x.reporter_id === DANA);
    assertEquals(rows.map((r) => r.type).sort(), ['data_processing', 'recording', 'sms']);
    for (const r of rows) {
      assertEquals([r.method, r.text_version], ['voice_yes', 'voice.consent.v1']);
      assertEquals(r.evidence, { call_id: c.callId, at: 11.2 });
    }
    assertEquals(h.store.reporters.find((r) => r.id === DANA)!.status, 'active');
    const after = await h.tool('get_context', c);
    assertEquals(after.json.consents.recording, true);
  },
);

Deno.test(
  'a first-time caller who says no: nothing kept, no recording, the link by text only after an earlier sms consent',
  async () => {
    const h = setup();
    // Dana had consented to texts on an earlier invite, never to recording.
    h.store.consents.push({
      id: crypto.randomUUID(),
      reporter_id: DANA,
      type: 'sms',
      method: 'web_checkbox',
      text_version: 'field.consent.v1',
      evidence: null,
      given_at: '2026-10-01T15:00:00Z',
      revoked_at: null,
    });
    const c = await h.sip(9, DANA_PHONE);
    const no = await h.tool('record_consent', c, { utterance: 'No, thanks.', at: 7 });
    assertEquals(no.json, {
      status: 'declined',
      confirmation: renderVoice('consent_declined_link', 'en'),
      linkSent: true,
    });
    assertEquals(h.texts.length, 1);
    assertEquals(h.texts[0]!.vars.site, 'Hillcrest School Extension');
    assertMatch(h.texts[0]!.vars.link, /^https:\/\/go\.sitelog\.test\//);
    assert(h.store.callRows.find((x) => x.id === c.callId)!.consent_declined_at);
    assertEquals(
      h.store.consents.filter((x) => x.reporter_id === DANA).map((x) => x.type),
      ['sms'],
    );
    // Nothing of the call is processed or kept.
    const upload = await h.tool('update_draft', c, {
      segments: [{ start: 1, end: 2, text: 'Apex had six.' }],
    });
    assertEquals([upload.status, upload.json.error], [403, 'consent_required']);
    const rec = await h.call(
      `voice/calls/${c.callId}/recording`,
      { callId: c.callId, mime: 'audio/ogg', bytes: 1000, durationS: 30 },
      c.token,
    );
    assertEquals([rec.status, rec.json.error], [403, 'consent_required']);
  },
);

Deno.test(
  '"Not today" (§19 Q129) sets no calls until the end of today; no callback where no calls are placed',
  async () => {
    const h = setup();
    const c = await h.sip(10, KEVIN_PHONE);
    const r = await h.tool('set_preference', c, { noCallsToday: true });
    assertEquals(r.json, { ok: true, confirmation: 'OK, no more calls from me today.' });
    // Mon Oct 12 ends at midnight Chicago time (CDT, UTC−5).
    assertEquals(
      h.store.reporters.find((x) => x.id === KEVIN)!.no_calls_until,
      '2026-10-13T05:00:00.000Z',
    );
    const both = await h.tool('set_preference', c, { contactPref: 'link', noCallsToday: true });
    assertEquals(
      both.json.confirmation,
      'OK, your daily report is now set to a link by text. OK, no more calls from me today.',
    );
    const cb = await h.tool('schedule_callback', c, { minutes: 30 });
    assertEquals([cb.status, cb.json.error], [400, 'not_available']);
  },
);

Deno.test(
  'done when: an unknown number leaves its snippet for the Team alert, and at most 60 s of recording',
  async () => {
    const h = setup();
    const c = await h.sip(11, STRANGER);
    assertEquals(c.json.unknown, true);
    assertEquals(c.json.locale, 'en-US');
    assert(!JSON.stringify(c.json).includes(STRANGER));
    // Every report tool is refused.
    const ctx = await h.tool('get_context', c);
    assertEquals([ctx.status, ctx.json.error], [403, 'unknown_caller']);
    const said = 'Hi, this is Sam Ortiz with Apex Concrete, I run the crew at Northgate. '.repeat(
      3,
    );
    const msg = await h.tool('leave_message', c, { utterance: said, start: 8 });
    assertEquals(msg.json, {
      ok: true,
      confirmation: "Thanks, I'll pass it to the office. Goodbye.",
    });
    const contact = h.special.unknownContacts[0]!;
    assertEquals(
      [contact.channel, contact.call_id, contact.status],
      ['voice', c.callId, 'pending'],
    );
    assert(contact.snippet!.length <= 160);
    assert(contact.snippet!.startsWith('Hi, this is Sam Ortiz with Apex Concrete'));
    assertEquals(contact.phone_e164, STRANGER);
    const long = await h.call(
      `voice/calls/${c.callId}/recording`,
      { callId: c.callId, mime: 'audio/ogg', bytes: 1000, durationS: 61 },
      c.token,
    );
    assertEquals([long.status, long.json.error], [400, 'recording_too_long']);
    const rec = await h.call(
      `voice/calls/${c.callId}/recording`,
      { callId: c.callId, mime: 'audio/ogg', bytes: 1000, durationS: 45 },
      c.token,
    );
    assertEquals(rec.status, 201, rec.text);
    assertEquals(rec.json.path, `unknown/${c.callId}.ogg`);
    // A known caller leaves no message: their words are a report.
    const kevin = await h.sip(12, KEVIN_PHONE);
    const refused = await h.tool('leave_message', kevin, { utterance: 'hello', start: 1 });
    assertEquals([refused.status, refused.json.error], [403, 'out_of_scope']);
  },
);

Deno.test(
  'W3-17: "call me back in half an hour" queues the one callback inside the window (§19 Q128, Q131)',
  async () => {
    const h = setup({ trunk: true });
    const c = await h.sip(20, KEVIN_PHONE);
    // 16:00 Chicago + 30 min: inside the window, before the missing step.
    const cb = await h.tool('schedule_callback', c, { minutes: 30 });
    assertEquals(cb.status, 200, cb.text);
    assertEquals(cb.json, {
      status: 'scheduled',
      at: '2026-10-12T21:30:00.000Z',
      localTime: '16:30',
    });
    assertEquals(h.special.callbacks.length, 1);
    assertEquals(h.special.callbacks[0]!.at, '2026-10-12T21:30:00.000Z');
    const audit = h.store.audits.find((a) => a.action === 'call.callback_requested')!;
    assertEquals([audit.entityId, audit.actorType], [c.callId, 'agent']);
    // One per site-day.
    const again = await h.tool('schedule_callback', c, { minutes: 45 });
    assertEquals(again.json, { status: 'limit_reached' });
    // After the window closes (20:00): not planned.
    const late = await h.tool('schedule_callback', c, { minutes: 300 });
    assertEquals(late.json, { status: 'outside_window', windowEnd: '20:00' });
    // Aisha has no auto_call consent of her own: not available (the agent says so).
    const aisha = await h.sip(21, AISHA_PHONE);
    const refused = await h.tool('schedule_callback', aisha, { minutes: 30 });
    assertEquals([refused.status, refused.json.error], [400, 'not_available']);
  },
);
