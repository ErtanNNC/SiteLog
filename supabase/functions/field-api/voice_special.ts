import type { Context, Hono } from 'hono';
import type { z } from 'zod';
import {
  ApplyCorrectionRequestSchema,
  LeaveMessageRequestSchema,
  REQUIRED_CONSENTS,
  RecordConsentRequestSchema,
  SaveChangeRequestSchema,
  ScheduleCallbackRequestSchema,
  SetDayStatusRequestSchema,
  UNKNOWN_CALLER_MAX_RECORDING_S,
  VOICE_CALLBACK_POLICY,
  DEFAULT_CALL_WINDOW,
  callbackPlan,
  placesCalls,
  toCountryPack,
  VoiceRecordingUploadRequestSchema,
  callYesNo,
  correctionNote,
  dailyLinkExpiresAt,
  dayOffConfirmKey,
  dayOffReadBack,
  ensureDailyLink,
  fieldLinkUrl,
  formatDate,
  formatPhone,
  isCallConfirm,
  languageOf,
  localDate,
  renderVoice,
  unknownCallerSnippet,
  voiceCorrectionLines,
  voiceTextVersions,
  type ApplyCorrectionResult,
  type CallRow,
  type CorrectionChange,
  type Json,
  type Language,
  type RecordConsentResponse,
  type ReporterLocale,
  type SaveChangeResponse,
  type SetDayStatusResponse,
  type SiteRow,
  type Source,
  type VoiceRecordingUploadResponseSchema,
  type VoiceTurnPending,
} from '@sitelog/shared';
import type { AppClient } from '../_shared/supabase.ts';
import type { SendDailyLink } from './app.ts';
import { FieldError, consentState, dayOffPlan } from './logic.ts';
import {
  FieldDbError,
  type DayStatusResult,
  type FieldStore,
  type OrgContext,
  type RequestCorrectionResult,
} from './store.ts';

/**
 * The special requests on a call (W3-14; spec F6 "Special intents during the call", §9.4 rule 6,
 * §9.5, F3 step 2, F10 call, F12 call, F13, F15 call; §19 Q79, Q81, Q99, Q120, Q124, Q128, Q129,
 * Q136). Its own module, mounted by `voice.ts` (`registerVoiceRoutes`) with its helpers: the same
 * bearer and call token, the same scoping, and every write through `once()` (the agent's retry
 * gets the first answer).
 *
 * - `set_day_status` (F12 call, §19 Q136): code reads the day off back with the lost hours it
 *   computed (`dayOffPlan`, the call second as the source of each value) and a `confirmKey`; only
 *   the reporter's verbatim yes to it (`isCallConfirm`) logs it (`voice_report_day_off()`: the
 *   weather-day report, channel voice, filed by its job, which texts the photos link). A day whose
 *   report is under way answers `report_in_progress` ("say it in the report", §19 Q79).
 * - `apply_correction` with a `reportId` from `load_report` (F10 call): W2-11's preview of a filed
 *   report, the words citing the call seconds (`voice_request_filed_correction()`), read back
 *   with "Save it?"; `save_change` makes version n+1 only after the yes
 *   (`voice_save_filed_correction()`), with the `edit_applied` text.
 * - `set_preference {noCallsToday}` (§19 Q129): `reporters.no_calls_until`, audited.
 * - `schedule_callback` (§19 Q128, W3-17): code plans the time (`callbackPlan()`: inside the call
 *   window, the same day, before the missing step) and voice_schedule_callback() queues the one
 *   callback of the site-day as a delayed `place_call`; 400 `not_available` where the org places no
 *   calls or the reporter has no `auto_call` consent of their own (§19 Q131).
 * - `record_consent` (F3 call, §19 Q120): yes stores the consents by voice; no stores nothing more,
 *   deletes the call's recording and texts the link only when texts were consented before.
 * - `leave_message` and the recording of an unknown caller (F13, §19 Q124): a 160-character
 *   snippet on `unknown_contacts`, at most 60 s of recording outside every org's folder.
 */

// ───────────────────────────── Store ─────────────────────────────

/** voice_save_filed_correction(). */
export type VoiceSaveResult =
  | { status: 'applied'; version: number; repeat?: boolean }
  | { status: 'not_confirmed' }
  | { status: 'stale'; currentVersion: number; draftRev: number | null };

/** voice_record_consent(). */
export interface VoiceConsentResult {
  status: 'given' | 'declined';
  /** A `sms` consent was held before this call (§19 Q120: the link is texted only then). */
  smsBefore: boolean;
  /** Declined: the call's recording path to delete, if one was signed. */
  recordingPath: string | null;
  given: string[];
}

/** The RPCs of 20261016000370_voice_special_intents.sql (service role). */
export interface VoiceSpecialStore {
  reportDayOff(input: {
    callId: string;
    status: 'no_work' | 'weather_day';
    details: Json;
    data: Json | null;
    utterance: string;
  }): Promise<DayStatusResult>;
  requestFiledCorrection(input: {
    callId: string;
    reportId: string;
    text: string;
    start: number;
    end: number | null;
  }): Promise<RequestCorrectionResult>;
  saveFiledCorrection(input: {
    callId: string;
    correctionId: string;
    utterance: string;
    confirmed: boolean;
    changeNote: string;
    message: { weekday: string; change: string } | null;
  }): Promise<VoiceSaveResult>;
  recordConsent(input: {
    callId: string;
    answer: 'yes' | 'no';
    at: number;
    textVersion: string;
  }): Promise<VoiceConsentResult>;
  noCallsToday(callId: string): Promise<{ until: string; changed: boolean }>;
  /**
   * W3-17 (§19 Q128): what a callback of this call is planned against: its site-day, the site's
   * time zone, the org's call window and when the day's missing step comes. null: no site yet.
   */
  callbackContext(callId: string): Promise<CallbackContext | null>;
  /** voice_schedule_callback(): the one callback of the site-day as a delayed `place_call`. */
  scheduleCallback(input: {
    callId: string;
    at: string;
    minutes: number;
  }): Promise<{ status: 'scheduled' | 'limit_reached' }>;
  unknownCaller(
    callId: string,
    snippet: string,
  ): Promise<{ id: string; orgId: string | null; created: boolean }>;
  unknownRecording(callId: string): Promise<{ path: string }>;
  /** An unknown caller's language: the first field locale of the pack whose number was called. */
  callPackLocale(callId: string): Promise<ReporterLocale | null>;
}

/** A callback's planning inputs (W3-17, `callbackPlan()`). */
export interface CallbackContext {
  siteDayId: string;
  timezone: string;
  window: { start: string; end: string };
  /** The day's missing step (the deadline plus `missing_offset_min`); a callback comes before it. */
  missingAt: string | null;
}

/**
 * A callback's planning inputs from its rows: the org's call window (the column defaults for
 * nulls) and the day's missing step (the deadline plus `missing_offset_min`, default 90).
 */
export function callbackContextOf(
  day: { id: string; deadline_at: string },
  timezone: string,
  settings: {
    call_window_start?: string | null;
    call_window_end?: string | null;
    missing_offset_min?: number | null;
  } | null,
): CallbackContext {
  const deadline = Date.parse(day.deadline_at);
  return {
    siteDayId: day.id,
    timezone,
    window: {
      start: settings?.call_window_start ?? DEFAULT_CALL_WINDOW.start,
      end: settings?.call_window_end ?? DEFAULT_CALL_WINDOW.end,
    },
    missingAt: Number.isFinite(deadline)
      ? new Date(deadline + (settings?.missing_offset_min ?? 90) * 60_000).toISOString()
      : null,
  };
}

/** The refusals of these RPCs the routes answer (any other database error is a 500). */
export const VOICE_SPECIAL_DB_ERRORS = [
  'not_available',
  'call_not_found',
  'call_ended',
  'unknown_caller',
  'site_required',
  'site_inactive',
  'report_in_progress',
  'report_filed',
  'wrong_state',
  'out_of_scope',
  'report_locked',
  'correction_pending',
  'correction_not_found',
  'correction_not_ready',
  'reporter_disabled',
  'invalid_request',
] as const;

export function supabaseVoiceSpecialStore(admin: AppClient): VoiceSpecialStore {
  async function rpc<T>(
    call: PromiseLike<{ data: unknown; error: { message: string } | null }>,
  ): Promise<T> {
    const { data, error } = await call;
    if (error) {
      if ((VOICE_SPECIAL_DB_ERRORS as readonly string[]).includes(error.message)) {
        throw new FieldDbError(error.message);
      }
      throw new Error(`field-api rpc: ${error.message}`);
    }
    return data as T;
  }
  return {
    reportDayOff: (i) =>
      rpc(
        admin.rpc('voice_report_day_off', {
          p_call_id: i.callId,
          p_status: i.status,
          p_details: i.details,
          p_data: i.data as Json,
          p_utterance: i.utterance,
        }),
      ),
    requestFiledCorrection: (i) =>
      rpc(
        admin.rpc('voice_request_filed_correction', {
          p_call_id: i.callId,
          p_report_id: i.reportId,
          p_text: i.text,
          p_start: i.start,
          p_end: i.end,
        }),
      ),
    saveFiledCorrection: (i) =>
      rpc(
        admin.rpc('voice_save_filed_correction', {
          p_call_id: i.callId,
          p_correction_id: i.correctionId,
          p_utterance: i.utterance,
          p_confirmed: i.confirmed,
          p_change_note: i.changeNote,
          p_message: i.message as Json,
        }),
      ),
    recordConsent: (i) =>
      rpc(
        admin.rpc('voice_record_consent', {
          p_call_id: i.callId,
          p_answer: i.answer,
          p_at: i.at,
          p_text_version: i.textVersion,
        }),
      ),
    noCallsToday: (callId) => rpc(admin.rpc('voice_no_calls_today', { p_call_id: callId })),
    async callbackContext(callId) {
      const { data: call } = await admin
        .from('calls')
        .select('site_day_id, org_id')
        .eq('id', callId)
        .maybeSingle()
        .throwOnError();
      if (!call?.site_day_id || !call.org_id) return null;
      const [{ data: day }, { data: settings }] = await Promise.all([
        admin
          .from('site_days')
          .select('id, deadline_at, site_id')
          .eq('id', call.site_day_id)
          .single()
          .throwOnError(),
        admin
          .from('org_settings')
          .select('call_window_start, call_window_end, missing_enabled, missing_offset_min')
          .eq('org_id', call.org_id)
          .maybeSingle()
          .throwOnError(),
      ]);
      const { data: site } = await admin
        .from('sites')
        .select('timezone')
        .eq('id', day.site_id)
        .single()
        .throwOnError();
      return callbackContextOf(day, site.timezone, settings);
    },
    scheduleCallback: (i) =>
      rpc(
        admin.rpc('voice_schedule_callback', {
          p_call_id: i.callId,
          p_at: i.at,
          p_minutes: i.minutes,
        }),
      ),
    unknownCaller: (callId, snippet) =>
      rpc(admin.rpc('voice_unknown_caller', { p_call_id: callId, p_snippet: snippet })),
    unknownRecording: (callId) => rpc(admin.rpc('voice_unknown_recording', { p_call_id: callId })),
    async callPackLocale(callId) {
      const { data: call } = await admin
        .from('calls')
        .select('to_e164')
        .eq('id', callId)
        .maybeSingle()
        .throwOnError();
      if (!call?.to_e164) return null;
      const { data: pack } = await admin
        .from('countries')
        .select('field_locales')
        .eq('voice_number', call.to_e164)
        .maybeSingle()
        .throwOnError();
      return (pack?.field_locales?.[0] as ReporterLocale | undefined) ?? null;
    },
  };
}

// ───────────────────────────── Routes ─────────────────────────────

/** A call the token named, with its reporter, org and sites (`voice.ts`'s `callScope`). */
export interface SpecialCallScope {
  call: CallRow;
  reporter: { id: string; locale: string; org_id: string };
  org: OrgContext;
  language: Language;
  sites: SiteRow[];
}

type Answer = { status: 200 | 201 | 202; body: unknown };

/** What `voice.ts` hands this module: its closures and deps. */
export interface VoiceHelpers {
  store: FieldStore;
  now: () => Date;
  toolWaitMs: () => number;
  sleep: (ms: number) => Promise<void>;
  publicSignedUrl: (signedUrl: string) => string;
  pollMs: number;
  pending: VoiceTurnPending;
  authorizedCall: (
    c: Context,
    callId: string,
    ended?: 'refuse' | 'end' | 'recording',
  ) => Promise<CallRow>;
  once: (
    c: Context,
    call: CallRow,
    tool: string,
    run: () => Promise<Answer>,
    opts?: { waitForFirst?: boolean },
  ) => Promise<Response>;
  callScope: (call: CallRow) => Promise<SpecialCallScope>;
  parseBody: <S extends z.ZodType>(c: Context, schema: S) => Promise<z.output<S>>;
}

/** Field-api's deps this module needs besides the voice routes' (`FieldApiDeps`). */
export interface VoiceSpecialDeps {
  store: VoiceSpecialStore;
  /** F3 call (§19 Q120): the daily link texted after a "no", when texts were consented before. */
  sendDailyLink: SendDailyLink;
  fieldAppUrl: () => string;
  linkSigningSecret: () => string;
  dailyLinkTtlHours?: () => number | undefined;
  randomUUID?: () => string;
}

/** The hooks `voice.ts` calls from its own routes. */
export interface VoiceSpecialHooks {
  /** `apply_correction` with a `reportId` other than the call's (F10 call). */
  applyFiledCorrection: (
    c: Context,
    call: CallRow,
    body: z.infer<typeof ApplyCorrectionRequestSchema>,
  ) => Promise<Response>;
  /** `POST /voice/calls/:id/recording` of an unknown caller (F13, ≤ 60 s). */
  unknownRecording: (
    c: Context,
    call: CallRow,
    body: z.infer<typeof VoiceRecordingUploadRequestSchema>,
  ) => Promise<Response>;
  /** `set_preference {noCallsToday}` (§19 Q129): the spoken confirmation. */
  noCallsToday: (call: CallRow, language: Language) => Promise<string>;
  /** `calls/start` of an unknown caller: the language of the pack whose number was called. */
  unknownLocale: (callId: string) => Promise<ReporterLocale | null>;
}

// deno-lint-ignore no-explicit-any
type AnyHono = Hono<any>;

export function registerVoiceSpecialRoutes(
  app: AnyHono,
  deps: VoiceSpecialDeps,
  h: VoiceHelpers,
): VoiceSpecialHooks {
  const { store, now } = h;
  const special = deps.store;
  const randomUUID = deps.randomUUID ?? (() => crypto.randomUUID());

  /** The recording and data-processing consents (§19 Q95, Q120): nothing is kept without them. */
  async function requireConsent(reporterId: string) {
    const held = consentState(await store.listConsents(reporterId)).held;
    if (!REQUIRED_CONSENTS.every((t) => held.has(t))) {
      throw new FieldError(403, 'consent_required');
    }
  }

  /** An RPC refusal as this module answers it (the generic map for the rest). */
  function dbError(err: unknown): never {
    if (err instanceof FieldDbError) {
      switch (err.code) {
        case 'site_inactive':
        case 'report_locked':
        case 'correction_pending':
        case 'correction_not_ready':
        case 'wrong_state':
        case 'call_ended':
        case 'site_required':
          throw new FieldError(409, err.code as FieldError['code']);
        case 'out_of_scope':
        case 'unknown_caller':
        case 'reporter_disabled':
          throw new FieldError(403, err.code as FieldError['code']);
        case 'correction_not_found':
        case 'call_not_found':
          throw new FieldError(404, 'not_found');
        case 'invalid_request':
          throw new FieldError(400, 'invalid_request');
      }
    }
    throw err;
  }

  // ── POST /voice/tools/set_day_status (F12 call; §19 Q79, Q136) ──────────────────────────────
  app.post('/voice/tools/set_day_status', async (c) => {
    const body = await h.parseBody(c, SetDayStatusRequestSchema);
    const call = await h.authorizedCall(c, body.callId);
    return h.once(c, call, 'set_day_status', () => setDayStatus(call, body));
  });

  async function setDayStatus(
    call: CallRow,
    body: z.infer<typeof SetDayStatusRequestSchema>,
  ): Promise<Answer> {
    const scope = await h.callScope(call);
    await requireConsent(scope.reporter.id);
    if (!call.site_id) throw new FieldError(409, 'site_required', 'pick_site first');
    const site = scope.sites.find((s) => s.id === call.site_id);
    if (!site) throw new FieldError(403, 'out_of_scope');
    const language = scope.language;
    const answer = (
      status: SetDayStatusResponse['status'],
      confirmation: string,
      confirmKey?: string,
    ): Answer => ({
      status: 200,
      body: { status, confirmation, ...(confirmKey ? { confirmKey } : {}) },
    });
    if (site.status !== 'active') {
      return answer(
        'site_paused',
        renderVoice('day_off_site_paused', language, { site: site.name }),
      );
    }
    const settings = scope.org.settings;
    if (!settings) throw new Error(`org ${scope.org.org.id} has no settings`);
    const date = localDate(new Date(call.started_at ?? now().toISOString()), site.timezone);

    // The day as it stands: a live report says it in the report (§19 Q79), a filed one is filed.
    const day = await store.getSiteDay(site.id, date);
    const live = day ? await store.getLiveReport(day.id) : null;
    const logged = day?.status === body.status;
    if (!logged && live) {
      return live.status === 'filed' || live.status === 'signed_off'
        ? answer('report_filed', renderVoice('day_off_filed', language, { site: site.name }))
        : answer('report_in_progress', renderVoice('day_off_in_progress', language));
    }

    const details = body.status === 'weather_day' ? (body.details ?? {}) : {};
    const start = body.start ?? 0;
    const source: Source = {
      type: 'call',
      callId: call.id,
      start,
      ...(body.end !== undefined && body.end > start ? { end: body.end } : {}),
    };
    const plan = dayOffPlan({
      status: body.status,
      date,
      site,
      org: { locale: scope.org.org.locale, units: scope.org.org.units },
      defaultShiftHours: Number(settings.default_shift_hours),
      reporterLocale: scope.reporter.locale,
      details,
      newId: randomUUID,
      callSource: source,
    });
    const key = await dayOffConfirmKey({ callId: call.id, status: body.status, details });
    const readBack = dayOffReadBack({
      status: body.status,
      siteName: site.name,
      details,
      data: plan.data,
      language,
    });
    // Step 1, or details other than the ones read back: read it back (code's numbers).
    if (body.utterance === undefined || body.confirmKey !== key) {
      if (logged) return answer('ok', loggedLine(body.status, site.name, language));
      return answer('confirm', readBack, key);
    }
    // Step 2: only the reporter's own words decide (§19 Q119's grammar); the model never does.
    if (!isCallConfirm(body.utterance)) {
      await store.audit({
        orgId: call.org_id,
        actorType: 'reporter',
        actorId: scope.reporter.id,
        action: 'call.day_off_refused',
        entity: 'call',
        entityId: call.id,
        diff: { status: body.status, utterance: body.utterance.slice(0, 200) },
      });
      return answer('not_confirmed', renderVoice('day_off_confirm_repeat', language), key);
    }
    try {
      await special.reportDayOff({
        callId: call.id,
        status: body.status,
        details: details as Json,
        // The RPC makes the report for a weather day, and for no work with no_work_pdf.
        data: plan.data as unknown as Json,
        utterance: body.utterance,
      });
    } catch (err) {
      if (err instanceof FieldDbError && err.code === 'report_in_progress')
        return answer('report_in_progress', renderVoice('day_off_in_progress', language));
      if (err instanceof FieldDbError && err.code === 'report_filed')
        return answer('report_filed', renderVoice('day_off_filed', language, { site: site.name }));
      if (err instanceof FieldDbError && err.code === 'site_inactive')
        return answer(
          'site_paused',
          renderVoice('day_off_site_paused', language, { site: site.name }),
        );
      dbError(err);
    }
    return answer('ok', loggedLine(body.status, site.name, language));
  }

  /** "Logged: …", and for a weather day F12's line about the photos link (texted after filing). */
  function loggedLine(status: 'no_work' | 'weather_day', site: string, language: Language) {
    if (status === 'no_work') return renderVoice('day_off_logged_no_work', language, { site });
    return `${renderVoice('day_off_logged_weather', language, { site })} ${renderVoice(
      'weather_photo_link',
      language,
    )}`;
  }

  // ── POST /voice/tools/schedule_callback (§19 Q128, W3-17) ───────────────────────────────────
  app.post('/voice/tools/schedule_callback', async (c) => {
    const body = await h.parseBody(c, ScheduleCallbackRequestSchema);
    const call = await h.authorizedCall(c, body.callId);
    return h.once(c, call, 'schedule_callback', () => scheduleCallback(call, body.minutes));
  });

  async function scheduleCallback(call: CallRow, minutes: number): Promise<Answer> {
    const scope = await h.callScope(call);
    if (!VOICE_CALLBACK_POLICY.available) {
      throw new FieldError(400, 'not_available', 'Callbacks are off (VOICE_CALLBACK_POLICY)');
    }
    // §19 Q131: a callback is an automated call: the org places them and the reporter agreed.
    if (
      !placesCalls({ isDemo: scope.org.org.is_demo === true }, toCountryPack(scope.org.country))
    ) {
      throw new FieldError(400, 'not_available');
    }
    const cb = await special.callbackContext(call.id);
    if (!cb) throw new FieldError(409, 'site_required', 'pick_site first');
    const plan = callbackPlan({
      now: now(),
      minutes,
      timezone: cb.timezone,
      window: cb.window,
      requestedToday: 0,
      notAfter: cb.missingAt ? new Date(cb.missingAt) : null,
    });
    if (plan.status !== 'scheduled') return { status: 200, body: plan };
    let queued: { status: 'scheduled' | 'limit_reached' };
    try {
      queued = await special.scheduleCallback({ callId: call.id, at: plan.at, minutes });
    } catch (err) {
      if (err instanceof FieldDbError && err.code === 'not_available') {
        throw new FieldError(400, 'not_available');
      }
      dbError(err);
    }
    if (queued.status === 'limit_reached') {
      return { status: 200, body: { status: 'limit_reached' } };
    }
    return { status: 200, body: plan };
  }

  // ── POST /voice/tools/save_change (F10 call) ────────────────────────────────────────────────
  app.post('/voice/tools/save_change', async (c) => {
    const body = await h.parseBody(c, SaveChangeRequestSchema);
    const call = await h.authorizedCall(c, body.callId);
    return h.once(c, call, 'save_change', () => saveChange(call, body));
  });

  async function saveChange(
    call: CallRow,
    body: z.infer<typeof SaveChangeRequestSchema>,
  ): Promise<Answer> {
    const scope = await h.callScope(call);
    await requireConsent(scope.reporter.id);
    const row = await store.getCorrection(body.correctionId);
    if (!row || row.call_id !== call.id || row.report_id !== body.reportId) {
      throw new FieldError(404, 'not_found');
    }
    const report = await store.getReport(row.report_id);
    if (!report) throw new FieldError(404, 'not_found');
    const language = scope.language;
    const changes = (Array.isArray(row.changes)
      ? row.changes
      : []) as unknown as CorrectionChange[];
    const reportLanguage = report.language === 'tr' ? 'tr' : 'en';
    // §19 Q100: the version's note is code's lines, never the model's.
    const note = correctionNote(changes, reportLanguage);
    if (!note && row.status === 'ready') throw new FieldError(409, 'correction_not_ready');
    const day = await store.getSiteDayById(report.site_day_id);
    const change = correctionNote(changes, language, { sms: true });
    let res;
    try {
      res = await special.saveFiledCorrection({
        callId: call.id,
        correctionId: row.id,
        utterance: body.utterance,
        confirmed: isCallConfirm(body.utterance),
        changeNote: note ?? '',
        message:
          day && change ? { weekday: formatDate(day.date, 'weekday', language), change } : null,
      });
    } catch (err) {
      dbError(err);
    }
    const out = (b: SaveChangeResponse): Answer => ({ status: 200, body: b });
    switch (res.status) {
      case 'not_confirmed':
        return out({
          status: 'not_confirmed',
          confirmation: renderVoice('edit_save_repeat', language),
        });
      case 'stale':
        return out({
          status: 'draft_changed',
          confirmation: renderVoice('edit_changed_meanwhile', language),
        });
      case 'applied':
        return out({
          status: 'saved',
          version: res.version,
          confirmation: renderVoice('edit_saved', language, { version: res.version }),
        });
    }
  }

  // ── POST /voice/tools/record_consent (F3 call, §19 Q120) ────────────────────────────────────
  app.post('/voice/tools/record_consent', async (c) => {
    const body = await h.parseBody(c, RecordConsentRequestSchema);
    const call = await h.authorizedCall(c, body.callId);
    return h.once(c, call, 'record_consent', () => recordConsent(call, body));
  });

  async function recordConsent(
    call: CallRow,
    body: z.infer<typeof RecordConsentRequestSchema>,
  ): Promise<Answer> {
    const scope = await h.callScope(call);
    const language = scope.language;
    const out = (b: RecordConsentResponse): Answer => ({ status: 200, body: b });
    // Code reads the answer; the model never does (CLAUDE.md, §19 Q120).
    const answer = callYesNo(body.utterance);
    if (answer === 'unclear') {
      return out({
        status: 'not_understood',
        confirmation: renderVoice('consent_repeat', language),
        linkSent: false,
      });
    }
    const textVersion = voiceTextVersions(scope.org.country.legal_keys).consentTextVersion;
    let res: VoiceConsentResult;
    try {
      res = await special.recordConsent({ callId: call.id, answer, at: body.at, textVersion });
    } catch (err) {
      dbError(err);
    }
    if (res.status === 'given') {
      return out({
        status: 'given',
        confirmation: renderVoice('consent_given', language),
        linkSent: false,
      });
    }
    // No: nothing more of the call is processed; its recording (if one was signed) is deleted.
    if (res.recordingPath) {
      try {
        await store.removeObject('calls', res.recordingPath);
      } catch {
        // Nothing uploaded yet: the upload is refused from now on (no recording consent).
      }
    }
    const linkSent = res.smsBefore ? await textLink(scope) : false;
    return out({
      status: 'declined',
      confirmation: renderVoice(linkSent ? 'consent_declined_link' : 'consent_declined', language),
      linkSent,
    });
  }

  /**
   * §19 Q120: the declined caller's daily link for the call's site (or their one active site) by
   * text, through the Notifier (which checks the `sms` consent and the opt-out), once per call.
   */
  async function textLink(scope: SpecialCallScope): Promise<boolean> {
    const active = scope.sites.filter((s) => s.status === 'active');
    const site =
      active.find((s) => s.id === scope.call.site_id) ?? (active.length === 1 ? active[0] : null);
    if (!site) return false;
    const reportDate = localDate(now(), site.timezone);
    const link = await ensureDailyLink(
      store,
      deps.linkSigningSecret(),
      {
        reporterId: scope.reporter.id,
        siteId: site.id,
        reportDate,
        expiresAt: dailyLinkExpiresAt(now(), deps.dailyLinkTtlHours?.()),
        now: now(),
      },
      randomUUID,
    );
    if (link.created) {
      await store.audit({
        orgId: scope.org.org.id,
        actorType: 'system',
        action: 'field_link.created',
        entity: 'field_link',
        entityId: link.id,
        diff: { kind: 'daily', site_id: site.id, report_date: reportDate, via: 'call_declined' },
      });
    }
    const voiceNumber = scope.org.country.voice_number;
    const outcome = await deps.sendDailyLink({
      reporterId: scope.reporter.id,
      vars: {
        site: site.name,
        link: fieldLinkUrl(deps.fieldAppUrl(), link.code),
        ...(voiceNumber ? { number: formatPhone(voiceNumber) } : {}),
      },
      dedupeKey: `call_declined_link:${scope.call.id}`,
    });
    return outcome.channel !== null;
  }

  // ── POST /voice/tools/leave_message (F13, §19 Q124) ─────────────────────────────────────────
  app.post('/voice/tools/leave_message', async (c) => {
    const body = await h.parseBody(c, LeaveMessageRequestSchema);
    const call = await h.authorizedCall(c, body.callId);
    if (call.reporter_id) throw new FieldError(403, 'out_of_scope', 'A known caller reports');
    return h.once(c, call, 'leave_message', async () => {
      try {
        await special.unknownCaller(call.id, unknownCallerSnippet(body.utterance));
      } catch (err) {
        dbError(err);
      }
      const language = languageOf((await special.callPackLocale(call.id)) ?? 'en-US');
      return {
        status: 200,
        body: { ok: true, confirmation: renderVoice('unknown_goodbye', language) },
      };
    });
  });

  // ── Hooks of voice.ts's own routes ──────────────────────────────────────────────────────────
  return {
    async applyFiledCorrection(c, call, body) {
      const scope = await h.callScope(call);
      await requireConsent(scope.reporter.id);
      const report = await store.getReport(body.reportId!);
      if (!report || !scope.sites.some((s) => s.id === report.site_id)) {
        throw new FieldError(403, 'out_of_scope', 'Not a report of this caller');
      }
      return h.once(c, call, 'apply_correction', () => filedPreview(scope, report.id, body), {
        waitForFirst: true,
      });
    },

    unknownRecording(c, call, body) {
      return h.once(c, call, 'recording_upload', async () => {
        // §19 Q124: at most 60 s of an unknown caller.
        if (body.durationS > UNKNOWN_CALLER_MAX_RECORDING_S) {
          throw new FieldError(400, 'recording_too_long');
        }
        let path: string;
        try {
          ({ path } = await special.unknownRecording(call.id));
        } catch (err) {
          dbError(err);
        }
        const signed = await store.createSignedUploadUrl('calls', path);
        const answer: z.infer<typeof VoiceRecordingUploadResponseSchema> = {
          bucket: 'calls',
          path,
          signedUrl: h.publicSignedUrl(signed.signedUrl),
          token: signed.token,
        };
        return { status: 201, body: answer };
      });
    },

    async noCallsToday(call, language) {
      try {
        await special.noCallsToday(call.id);
      } catch (err) {
        dbError(err);
      }
      return renderVoice('pref_not_today_ok', language);
    },

    unknownLocale: (callId) => special.callPackLocale(callId),
  };

  /**
   * F10 on a call: the change of the filed report as W2-11's preview (the worker's
   * `apply_correction`, code's numbers), waited for up to VOICE_TOOL_WAIT_MS; past the wait 202
   * `pending` (the same words again find the same change). Nothing is saved here.
   */
  async function filedPreview(
    scope: SpecialCallScope,
    reportId: string,
    body: z.infer<typeof ApplyCorrectionRequestSchema>,
  ): Promise<Answer> {
    const language = scope.language;
    let req: RequestCorrectionResult;
    try {
      req = await special.requestFiledCorrection({
        callId: scope.call.id,
        reportId,
        text: body.utterance,
        start: body.start,
        end: body.end ?? null,
      });
    } catch (err) {
      dbError(err);
    }
    let row = await store.getCorrection(req.id);
    const polls = Math.ceil(h.toolWaitMs() / h.pollMs);
    for (let i = 0; row?.status === 'listening' && i < polls; i++) {
      await h.sleep(h.pollMs);
      row = await store.getCorrection(req.id);
    }
    if (!row || row.status === 'listening') return { status: 202, body: h.pending };
    const out = (b: ApplyCorrectionResult): Answer => ({ status: 200, body: b });
    if (row.status !== 'ready' && row.status !== 'applied') {
      return out({
        status: 'not_understood',
        lines: [renderVoice('correction_unclear', language)],
        readBack: null,
        draft: null,
      });
    }
    const changes = (Array.isArray(row.changes)
      ? row.changes
      : []) as unknown as CorrectionChange[];
    const lines = voiceCorrectionLines(changes, language);
    if (lines.length === 0) {
      return out({
        status: 'nothing_to_change',
        lines: [renderVoice('correction_nothing', language)],
        readBack: null,
        draft: null,
      });
    }
    return out({
      status: 'preview',
      correctionId: row.id,
      lines,
      readBack: [...lines, renderVoice('edit_save_ask', language)].join(' '),
      draft: null,
    });
  }
}
