import type { Context, Hono } from 'hono';
import type { z } from 'zod';
import {
  EndCallRequestSchema,
  GetContextRequestSchema,
  LoadReportRequestSchema,
  PickSiteRequestSchema,
  REQUIRED_CONSENTS,
  RecordAnswerRequestSchema,
  RecordAnswerResultSchema,
  UpdateDraftRequestSchema,
  VOICE_TOOL_WAIT_DEFAULT_MS,
  VOICE_TOOL_WAIT_MAX_MS,
  VoiceDraftStateSchema,
  voiceTurnKey,
  type VoiceTurnKind,
  type VoiceTurnPending,
  SetPreferenceRequestSchema,
  StartFallbackRecordingRequestSchema,
  VOICE_CALL_MAX_S,
  VOICE_CALL_TOKEN_HEADER,
  VOICE_RECORDING_GRACE_S,
  VOICE_REQUEST_ID_HEADER,
  VOICE_REQUEST_ID_RE,
  VOICE_TOOL_RATE_LIMIT,
  VoiceCallStartRequestSchema,
  VoiceRecordingUploadRequestSchema,
  buildKeyterms,
  callRecordingPath,
  deriveCallToken,
  firstName,
  languageOf,
  loadReportSummary,
  localDate,
  preferenceConfirmation,
  reportLanguageFor,
  resolveDayReference,
  verifyCallToken,
  voiceTextVersions,
  type CallRow,
  type ContactPref,
  type GetContextResponseSchema,
  type Json,
  type Language,
  type LoadReportResponseSchema,
  type OrgLocale,
  type ReporterLocale,
  type ReporterRow,
  type SiteRow,
  type StoredReportData,
  type VoiceCallStartResponse,
  type VoiceRecordingUploadResponseSchema,
} from '@sitelog/shared';
import { formatIssues, timingSafeEqual } from '../_shared/http.ts';
import { FieldError, consentState, filedChangeable, siteDeadline } from './logic.ts';
import type { FieldStore, OrgContext, VoiceTurnState } from './store.ts';

/**
 * field-api's voice routes (W3-03; spec §6.5, §9.4, Appendix B "field-api voice routes"): what the
 * voice agent (`apps/voice-agent`) calls, server to server. Every route needs
 * `Authorization: Bearer VOICE_AGENT_TOOL_SECRET` (constant time) and refuses a browser `Origin`;
 * every tool and the recording route also need the call's token in `X-Call-Token`
 * (`deriveCallToken` under `VOICE_CALL_TOKEN_SECRET`, field-api's own: the agent cannot mint the
 * token of another call), and name the call in the body. A tool acts only on the call's reporter,
 * their sites and that day's report (403 `out_of_scope` otherwise), 60 times a minute per call.
 *
 * No answer carries a phone number (§10.12): `calls/start` takes the SIP `from` and keeps it on
 * the call row; the agent only ever gets a first name and a locale.
 *
 * The live tools (W3-09: `update_draft`, `record_answer`) run in the worker (§19 Q117): the route
 * submits a turn (voice_turn_submit(): the report, its call source and live transcript, a
 * priority `voice_turn` job) and waits for its answer up to VOICE_TOOL_WAIT_MS; past the wait it
 * answers 202 `pending` and the agent, after a short line, asks again with the same words, which
 * are the same turn. The other model-backed tools (`apply_correction`, `file_report`,
 * `set_day_status`, `schedule_callback`) are W3-10 … W3-14's and are not served yet (404).
 */

export interface VoiceDeps {
  store: FieldStore;
  /** VOICE_AGENT_TOOL_SECRET: the bearer the agent sends (throws EnvError when unset). */
  voiceToolSecret: () => string;
  /** VOICE_CALL_TOKEN_SECRET: signs the per-call tokens (throws EnvError when unset). */
  callTokenSecret: () => string;
  /** STORAGE_PUBLIC_URL re-basing of a signed upload URL (`publicSignedUrl`). */
  publicSignedUrl: (signedUrl: string) => string;
  now: () => Date;
  /** W3-09 (§19 Q117): how long a live tool waits for its worker turn (`voiceToolWaitMs`). */
  toolWaitMs: () => number;
  /** Waiting between polls of a turn (tests pass a fake). */
  sleep: (ms: number) => Promise<void>;
}

/** How often a waiting live tool reads its turn (W3-09). */
export const VOICE_TURN_POLL_MS = 150;

/**
 * VOICE_TOOL_WAIT_MS (§19 Q117): unset or not a number → 12 s; at most 15 s, at least one poll.
 * Pure.
 */
export function voiceToolWaitMs(raw: number | undefined): number {
  if (raw === undefined || !Number.isFinite(raw)) return VOICE_TOOL_WAIT_DEFAULT_MS;
  return Math.min(VOICE_TOOL_WAIT_MAX_MS, Math.max(VOICE_TURN_POLL_MS, Math.round(raw)));
}

/** The answer of a live tool whose turn is still running past the wait (HTTP 202). */
const PENDING: VoiceTurnPending = { status: 'pending', retryAfterMs: 1000 };

/** A call the token named, with its reporter, org and the sites in scope. */
interface CallScope {
  call: CallRow;
  reporter: ReporterRow;
  org: OrgContext;
  language: Language;
  /** The call reporter's sites that are not archived (scope for reads: F10's reports). */
  sites: SiteRow[];
}

/** The call purposes `get_context` names (§6.3 `calls.purpose`). */
const PURPOSES = ['daily_report', 'reminder', 'callback', 'edit'] as const;

// deno-lint-ignore no-explicit-any
type AnyHono = Hono<any>;

export function registerVoiceRoutes(app: AnyHono, deps: VoiceDeps): void {
  const { store, now } = deps;

  // ── Auth: bearer secret on every /voice route, no browser ────────────────────────────────────
  app.use('/voice/*', async (c, next) => {
    if (c.req.header('origin')) {
      throw new FieldError(403, 'origin_not_allowed', 'The voice routes are server to server');
    }
    const secret = deps.voiceToolSecret();
    const header = c.req.header('authorization') ?? '';
    const bearer = /^Bearer\s+(\S+)\s*$/i.exec(header)?.[1] ?? '';
    if (!bearer || !timingSafeEqual(bearer, secret)) throw new FieldError(401, 'unauthorized');
    await next();
  });

  /**
   * The call named in the body, if the token is its token: started, not ended (unless `ended` lets
   * it), younger than VOICE_CALL_MAX_S; 60 tool calls a minute. The token is checked before the
   * call is read, so a caller without it learns nothing about the id.
   */
  async function authorizedCall(
    c: Context,
    callId: string,
    ended: 'refuse' | 'end' | 'recording' = 'refuse',
  ): Promise<CallRow> {
    const ok = await verifyCallToken(
      deps.callTokenSecret(),
      callId,
      c.req.header(VOICE_CALL_TOKEN_HEADER),
    );
    if (!ok) throw new FieldError(401, 'call_token_invalid');
    const call = await store.getCall(callId);
    if (!call) throw new FieldError(404, 'call_not_found');
    const { limit, windowSeconds } = VOICE_TOOL_RATE_LIMIT;
    const rl = await store.rateLimit(`call:${call.id}`, limit, windowSeconds);
    if (!rl.allowed) {
      const retryAfter = Math.max(
        1,
        Math.ceil((new Date(rl.resetAt).getTime() - now().getTime()) / 1000),
      );
      throw new FieldError(429, 'rate_limited', undefined, { retryAfter });
    }
    if (!call.call_token_issued_at) throw new FieldError(409, 'call_not_started');
    const t = now().getTime();
    if (call.ended_at) {
      if (ended === 'end') return call;
      if (
        ended === 'refuse' ||
        t - new Date(call.ended_at).getTime() > VOICE_RECORDING_GRACE_S * 1000
      ) {
        throw new FieldError(409, 'call_ended');
      }
      return call;
    }
    if (
      ended !== 'end' &&
      t - new Date(call.call_token_issued_at).getTime() > VOICE_CALL_MAX_S * 1000
    ) {
      throw new FieldError(409, 'call_ended');
    }
    return call;
  }

  /**
   * Runs a write once per named request (W3-03): with `X-Request-Id`, the first request claims the
   * key in `voice_tool_requests` and keeps its 2xx answer; the agent's retry (W3-02 retries once
   * after a 5xx or a transport error) gets that answer again, marked `Idempotent-Replay: true`,
   * and nothing runs twice. A request that throws frees its key, so a retry runs it. Without the
   * header the request simply runs (every W3-03 write is idempotent on its own as well: a pick
   * sets the site, a preference the mode, the fallback and the end happen once, the recording has
   * one path). The model-backed tools (W3-09 … W3-14: `file_report`, `record_answer`, …) go
   * through here too.
   */
  async function once(
    c: Context,
    call: CallRow,
    tool: string,
    run: () => Promise<{ status: 200 | 201 | 202; body: unknown }>,
    opts: { waitForFirst?: boolean } = {},
  ): Promise<Response> {
    const key = c.req.header(VOICE_REQUEST_ID_HEADER)?.trim();
    if (!key) {
      const r = await run();
      return c.json(r.body, r.status);
    }
    if (!VOICE_REQUEST_ID_RE.test(key)) {
      throw new FieldError(400, 'invalid_request', `${VOICE_REQUEST_ID_HEADER} is malformed`);
    }
    const claim = await store.claimToolRequest(call.id, key, tool);
    if (!claim.claimed) {
      if (claim.tool !== tool) throw new FieldError(409, 'request_conflict');
      let kept: { status: number | null; response: Json | null } | null = claim;
      if (kept.status === null && opts.waitForFirst) {
        // §19 Q151 (W3-09): a live tool's retry whose first copy still runs waits for that first
        // answer (a caller should never hear an error for a slow first try); past the wait, or
        // when the first copy failed (its key freed), `pending`: the agent asks again.
        kept = await waitForClaim(call.id, key);
        if (!kept || kept.status === null) return c.json(PENDING, 202);
      }
      if (kept.status === null) throw new FieldError(409, 'request_in_progress');
      c.header('Idempotent-Replay', 'true');
      return c.json(kept.response as Record<string, unknown>, kept.status as 200 | 201 | 202);
    }
    let r: { status: 200 | 201 | 202; body: unknown };
    try {
      r = await run();
    } catch (err) {
      await store.releaseToolRequest(call.id, key);
      throw err;
    }
    await store.finishToolRequest(call.id, key, r.status, r.body as Json);
    return c.json(r.body, r.status);
  }

  /** The claim of a named request once its first copy answered, or null (freed, or past the wait). */
  async function waitForClaim(
    callId: string,
    key: string,
  ): Promise<{ status: number | null; response: Json | null } | null> {
    const polls = Math.ceil(deps.toolWaitMs() / VOICE_TURN_POLL_MS);
    for (let i = 0; i < polls; i++) {
      await deps.sleep(VOICE_TURN_POLL_MS);
      const row = await store.getToolRequest(callId, key);
      if (!row) return null;
      if (row.status !== null) return row;
    }
    return null;
  }

  /**
   * W3-09 (§19 Q117): a live tool as a worker turn. The reporter's consents first (§19 Q95, Q120:
   * nothing of a caller who has not consented goes to a model), then the turn (the same words are
   * the same turn), then the wait: its answer, checked against the contract; 202 `pending` past
   * the wait; a failed turn's refusal as a 409 / 403, any other failure 503 `turn_failed` (the
   * agent's one retry submits the same words, which runs the turn again).
   */
  async function liveTurn(
    call: CallRow,
    kind: VoiceTurnKind,
    input: Json,
  ): Promise<{ status: 200 | 202; body: unknown }> {
    const scope = await callScope(call);
    const held = consentState(await store.listConsents(scope.reporter.id)).held;
    if (!REQUIRED_CONSENTS.every((t) => held.has(t))) {
      throw new FieldError(403, 'consent_required');
    }
    if (!call.site_id) throw new FieldError(409, 'site_required', 'pick_site first');
    const key = await voiceTurnKey(kind, input);
    const submitted = await store.voiceTurnSubmit(call.id, kind, key, input);
    let state: VoiceTurnState = submitted;
    const polls = Math.ceil(deps.toolWaitMs() / VOICE_TURN_POLL_MS);
    for (let i = 0; state.status === 'pending' && i < polls; i++) {
      await deps.sleep(VOICE_TURN_POLL_MS);
      state = (await store.getVoiceTurn(submitted.turnId)) ?? state;
    }
    if (state.status === 'pending') return { status: 202, body: PENDING };
    if (state.status === 'failed') {
      switch (state.error) {
        case 'report_closed':
        case 'question_closed':
          throw new FieldError(409, state.error);
        case 'consent_required':
          throw new FieldError(403, 'consent_required');
        default:
          throw new FieldError(503, 'turn_failed', 'The turn could not run; ask again');
      }
    }
    const schema = kind === 'update_draft' ? VoiceDraftStateSchema : RecordAnswerResultSchema;
    const answer = schema.safeParse(state.result);
    if (!answer.success) {
      // A worker answer outside the contract is the worker's fault; never handed to the agent.
      throw new FieldError(503, 'turn_failed', 'The turn answered outside the contract');
    }
    return { status: 200, body: answer.data };
  }

  // ── POST /voice/tools/update_draft (§9.4, §10.4 live mode; W3-09) ────────────────────────────
  app.post('/voice/tools/update_draft', async (c) => {
    const body = await parseVoiceBody(c, UpdateDraftRequestSchema);
    const call = await authorizedCall(c, body.callId);
    return once(
      c,
      call,
      'update_draft',
      () => liveTurn(call, 'update_draft', { segments: body.segments } as unknown as Json),
      { waitForFirst: true },
    );
  });

  // ── POST /voice/tools/record_answer (F7 on a call; W3-09) ────────────────────────────────────
  app.post('/voice/tools/record_answer', async (c) => {
    const body = await parseVoiceBody(c, RecordAnswerRequestSchema);
    const call = await authorizedCall(c, body.callId);
    const input = {
      questionId: body.questionId,
      utterance: body.utterance,
      start: body.start,
      ...(body.end !== undefined ? { end: body.end } : {}),
    };
    return once(c, call, 'record_answer', () => liveTurn(call, 'record_answer', input as Json), {
      waitForFirst: true,
    });
  });

  /** The call's reporter, org and sites; an unknown caller's call has none (F13: 403). */
  async function callScope(call: CallRow): Promise<CallScope> {
    if (!call.reporter_id || !call.org_id) throw new FieldError(403, 'unknown_caller');
    const [reporter, org] = await Promise.all([
      store.getReporter(call.reporter_id),
      store.getOrgContext(call.org_id),
    ]);
    if (!reporter || !org) throw new FieldError(403, 'unknown_caller');
    if (reporter.status === 'disabled') throw new FieldError(403, 'reporter_disabled');
    const sites = (await store.listReporterSites(reporter.id)).filter(
      (s) => s.status !== 'archived',
    );
    return {
      call,
      reporter,
      org,
      language: languageOf(call.language ?? reporter.locale),
      sites,
    };
  }

  /**
   * The sites a call may still be about (F14), each with its reporter: the call's site once known;
   * before that every active site of the caller, and for a SIP number in two real orgs of the pack
   * every active site of each (§19 Q44: the site question covers both).
   */
  async function candidateSites(
    scope: CallScope,
  ): Promise<{ site: SiteRow; reporter: ReporterRow; org: OrgContext }[]> {
    const { call } = scope;
    const own = scope.sites
      .filter((s) => s.status === 'active')
      .map((site) => ({ site, reporter: scope.reporter, org: scope.org }));
    if (call.site_id) return own.filter((x) => x.site.id === call.site_id);
    if (call.direction !== 'inbound' || call.transport !== 'pstn') return own;
    const callers = await store.callerReporters(call.id, scope.org.org.country);
    const out = [...own];
    for (const r of callers) {
      if (r.id === scope.reporter.id) continue;
      const org = await store.getOrgContext(r.org_id);
      if (!org) continue;
      for (const site of await store.listReporterSites(r.id)) {
        if (site.status === 'active') out.push({ site, reporter: r, org });
      }
    }
    return out;
  }

  // ── POST /voice/calls/start ──────────────────────────────────────────────────────────────────
  app.post('/voice/calls/start', async (c) => {
    const body = await parseVoiceBody(c, VoiceCallStartRequestSchema);
    const started = await store.voiceCallStart({
      room: body.room,
      transport: body.transport,
      callId: body.callId ?? null,
      from: body.callId ? null : (body.from ?? null),
      to: body.callId ? null : (body.to ?? null),
    });
    const callToken = await deriveCallToken(deps.callTokenSecret(), started.callId);
    if (!started.reporterId) {
      return c.json({
        callId: started.callId,
        callToken,
        unknown: true,
      } satisfies VoiceCallStartResponse);
    }
    const reporter = await store.getReporter(started.reporterId);
    if (!reporter) throw new FieldError(404, 'call_not_found');
    const answer: VoiceCallStartResponse = {
      callId: started.callId,
      callToken,
      reporter: {
        firstName: firstName(reporter.name),
        locale: reporter.locale as ReporterLocale,
      },
    };
    return c.json(answer);
  });

  // ── POST /voice/calls/:id/recording ──────────────────────────────────────────────────────────
  app.post('/voice/calls/:id/recording', async (c) => {
    const body = await parseVoiceBody(c, VoiceRecordingUploadRequestSchema);
    if (body.callId !== c.req.param('id')) {
      throw new FieldError(400, 'invalid_request', 'The path and the body name different calls');
    }
    const call = await authorizedCall(c, body.callId, 'recording');
    return once(c, call, 'recording_upload', async () => {
      const scope = await callScope(call);
      // §19 Q120: a caller who said no (or never said yes) leaves no recording.
      const held = consentState(await store.listConsents(scope.reporter.id)).held;
      if (!held.has('recording')) throw new FieldError(403, 'consent_required');
      // One path per call: a second upload replaces the first, never adds one.
      const path = callRecordingPath(scope.org.org.id, call.id);
      await store.voiceCallRecording(call.id, path);
      const signed = await store.createSignedUploadUrl('calls', path);
      const answer: z.infer<typeof VoiceRecordingUploadResponseSchema> = {
        bucket: 'calls',
        path,
        signedUrl: deps.publicSignedUrl(signed.signedUrl),
        token: signed.token,
      };
      return { status: 201, body: answer };
    });
  });

  // ── POST /voice/tools/get_context ────────────────────────────────────────────────────────────
  app.post('/voice/tools/get_context', async (c) => {
    const { callId } = await parseVoiceBody(c, GetContextRequestSchema);
    const call = await authorizedCall(c, callId);
    const scope = await callScope(call);
    const listed = await candidateSites(scope);
    const sites = await Promise.all(
      listed.slice(0, 50).map(async ({ site, org }) => {
        const date = localDate(now(), site.timezone);
        const day = await store.getSiteDay(site.id, date);
        return {
          id: site.id,
          name: site.name,
          status: day?.status ?? null,
          deadline: siteDeadline(site, org.settings),
        };
      }),
    );
    const orgIds = [...new Set(listed.map((x) => x.org.org.id).concat(scope.org.org.id))];
    const reporterIds = [...new Set(listed.map((x) => x.reporter.id).concat(scope.reporter.id))];
    const [companies, glossary, consentRows] = await Promise.all([
      store.listCompanies(orgIds),
      store.listGlossary(
        orgIds,
        listed.map((x) => x.site.id),
        reporterIds,
      ),
      store.listConsents(scope.reporter.id),
    ]);
    const held = consentState(consentRows).held;
    const keyterms = buildKeyterms({
      siteName: listed.map((x) => x.site.name),
      companies,
      glossary,
      languages: scope.reporter.languages,
    });
    const settings = scope.org.settings;
    const answer: z.infer<typeof GetContextResponseSchema> = {
      call: {
        direction: call.direction,
        transport: call.transport,
        purpose: (PURPOSES as readonly string[]).includes(call.purpose ?? '')
          ? (call.purpose as (typeof PURPOSES)[number])
          : null,
      },
      reporter: {
        firstName: firstName(scope.reporter.name),
        locale: scope.reporter.locale as ReporterLocale,
      },
      company: scope.org.org.name,
      reportLanguage: reportLanguageFor(scope.org.org.locale as OrgLocale),
      sites,
      siteId: call.site_id,
      companies: companies.slice(0, 200).map((co) => ({
        name: co.name,
        aliases: co.aliases.slice(0, 50),
      })),
      keyterms,
      consents: {
        recording: held.has('recording'),
        dataProcessing: held.has('data_processing'),
        sms: held.has('sms'),
        autoCall: held.has('auto_call'),
      },
      ...voiceTextVersions(scope.org.country.legal_keys),
      maxQuestions: Math.min(10, Math.max(0, settings?.max_questions_per_report ?? 2)),
    };
    return c.json(answer);
  });

  // ── POST /voice/tools/pick_site (F14 on a call) ──────────────────────────────────────────────
  app.post('/voice/tools/pick_site', async (c) => {
    const { callId, siteId } = await parseVoiceBody(c, PickSiteRequestSchema);
    const call = await authorizedCall(c, callId);
    return once(c, call, 'pick_site', async () => {
      const scope = await callScope(call);
      // The site question covers every candidate (a picked site can be picked again, or changed
      // among the caller's own sites).
      const candidates = await candidateSites({ ...scope, call: { ...call, site_id: null } });
      const pick = candidates.find((x) => x.site.id === siteId);
      if (!pick) throw new FieldError(403, 'out_of_scope', 'Not a site of this caller');
      await store.voiceCallPickSite(call.id, pick.site.id, pick.reporter.id);
      return { status: 200, body: { siteId: pick.site.id, name: pick.site.name } };
    });
  });

  // ── POST /voice/tools/set_preference (F15 on a call) ─────────────────────────────────────────
  app.post('/voice/tools/set_preference', async (c) => {
    const body = await parseVoiceBody(c, SetPreferenceRequestSchema);
    const call = await authorizedCall(c, body.callId);
    return once(c, call, 'set_preference', () => setPreference(call, body));
  });

  async function setPreference(
    call: CallRow,
    body: z.infer<typeof SetPreferenceRequestSchema>,
  ): Promise<{ status: 200; body: unknown }> {
    const scope = await callScope(call);
    // §19 Q129 ("not today") needs `reporters.no_calls_until`, which W3-17 adds with the calls.
    if (body.noCallsToday) {
      throw new FieldError(400, 'not_available', '"Not today" comes with outbound calls (W3-17)');
    }
    const pref = body.contactPref as ContactPref;
    const before = scope.reporter.contact_pref;
    if (pref !== before) {
      await store.updateReporter(scope.reporter.id, { contact_pref: pref });
      await store.audit({
        orgId: scope.reporter.org_id,
        actorType: 'reporter',
        actorId: scope.reporter.id,
        action: 'reporter.preferences_changed',
        entity: 'reporter',
        entityId: scope.reporter.id,
        diff: {
          from: { contact_pref: before },
          to: { contact_pref: pref },
          channel: 'voice',
          call_id: call.id,
        },
      });
    }
    return {
      status: 200,
      body: { ok: true, confirmation: preferenceConfirmation(pref, scope.language) },
    };
  }

  // ── POST /voice/tools/load_report (F10 on a call) ────────────────────────────────────────────
  app.post('/voice/tools/load_report', async (c) => {
    const body = await parseVoiceBody(c, LoadReportRequestSchema);
    const call = await authorizedCall(c, body.callId);
    const scope = await callScope(call);
    const held = consentState(await store.listConsents(scope.reporter.id)).held;
    if (!REQUIRED_CONSENTS.every((t) => held.has(t))) {
      throw new FieldError(403, 'consent_required');
    }
    let sites = scope.sites;
    if (body.siteId) {
      sites = sites.filter((s) => s.id === body.siteId);
      if (sites.length === 0)
        throw new FieldError(403, 'out_of_scope', 'Not a site of this caller');
    }
    const answer = await findReport(scope, sites, body.dayReference);
    return c.json(answer);
  });

  async function findReport(
    scope: CallScope,
    sites: SiteRow[],
    dayReference: string,
  ): Promise<z.infer<typeof LoadReportResponseSchema>> {
    // The day in the call site's time zone (or the first site's): sites of one org share it.
    const tzSite = sites.find((s) => s.id === scope.call.site_id) ?? sites[0];
    if (!tzSite) return { status: 'not_found' };
    const date = resolveDayReference(dayReference, now(), tzSite.timezone);
    if (!date) return { status: 'not_found' };
    const reports = (
      await store.listRecentReports(
        sites.map((s) => s.id),
        date,
      )
    ).filter((r) => r.date === date && (r.status === 'filed' || r.status === 'signed_off'));
    if (reports.length === 0) return { status: 'not_found' };
    if (reports.length > 1) return { status: 'ambiguous' };
    const report = reports[0]!;
    const site = sites.find((s) => s.id === report.site_id)!;
    // §19 Q81: the last 14 days (site time), as Past reports and the SMS EDIT.
    if (!filedChangeable(date, now(), site.timezone, 14)) return { status: 'locked' };
    const version = await store.getVersion(report.id, report.current_version);
    return {
      status: 'found',
      reportId: report.id,
      date,
      reportNo: report.report_no,
      summary: loadReportSummary({
        data: version ? (version.data as unknown as StoredReportData) : null,
        date,
        reportNo: report.report_no,
        language: scope.language,
      }),
    };
  }

  // ── POST /voice/tools/start_fallback_recording (§9.4 rule 9) ─────────────────────────────────
  app.post('/voice/tools/start_fallback_recording', async (c) => {
    const body = await parseVoiceBody(c, StartFallbackRecordingRequestSchema);
    const call = await authorizedCall(c, body.callId);
    return once(c, call, 'start_fallback_recording', async () => {
      await callScope(call);
      await store.voiceCallFallback(call.id, body.reason, body.at);
      return { status: 200, body: { ok: true } };
    });
  });

  // ── POST /voice/tools/end_call ───────────────────────────────────────────────────────────────
  app.post('/voice/tools/end_call', async (c) => {
    const body = await parseVoiceBody(c, EndCallRequestSchema);
    // An unknown caller's call ends too (its outcome and log); a repeat changes nothing.
    const call = await authorizedCall(c, body.callId, 'end');
    return once(c, call, 'end_call', async () => {
      await store.voiceCallEnd({
        callId: call.id,
        outcome: body.outcome,
        dialogLog: body.dialogLog as unknown as Json,
        metrics: body.metrics as unknown as Json,
      });
      return { status: 200, body: { ok: true } };
    });
  });
}

async function parseVoiceBody<S extends z.ZodType>(c: Context, schema: S): Promise<z.output<S>> {
  const text = await c.req.text();
  let raw: unknown = {};
  if (text.trim()) {
    try {
      raw = JSON.parse(text);
    } catch {
      throw new FieldError(400, 'invalid_request', 'Body must be valid JSON');
    }
  }
  const parsed = schema.safeParse(raw);
  if (!parsed.success) {
    throw new FieldError(400, 'invalid_request', 'Invalid request', {
      details: formatIssues(parsed.error),
    });
  }
  return parsed.data as z.output<S>;
}
