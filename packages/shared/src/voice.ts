import { z } from 'zod';
import {
  CALL_OUTCOMES,
  CALL_TRANSPORTS,
  CALL_DIRECTIONS,
  CONTACT_PREFS,
  SITE_DAY_STATUSES,
} from './enums.ts';
import { REPORT_LANGUAGES, REPORTER_LOCALES } from './locale.ts';

/**
 * The voice contract (W3-01; spec §9.4, §6.3 `calls`, §6.5, Appendix B "field-api voice routes"):
 * what the voice agent (`apps/voice-agent`, Python) sends to `field-api` and what it gets back,
 * as Zod schemas. `pnpm voice:contract` writes each one as JSON Schema to
 * `apps/voice-agent/contract/*.json` (`VOICE_CONTRACT`), which the agent validates against
 * (W3-02); CI fails when the checked-in files drift from these.
 *
 * Every voice route is server to server: bearer `VOICE_AGENT_TOOL_SECRET` on all of them, and on
 * every tool also `X-Call-Token` (`deriveCallToken`), with the call named in the body (`callId`).
 * A tool acts only on the call's reporter, their sites and that day's report (W3-03).
 *
 * Never a phone number in an answer (§10.12): `calls/start` takes the SIP `from` and stores it
 * server side; nothing here carries one back. Recommended defaults of spec §19 Q117–Q134 are built
 * in where a shape depends on them (the filing check of Q119, the consent of Q120).
 *
 * Pure (Node, browser, Deno): `deriveCallToken` uses WebCrypto only.
 */

// ───────────────────────────── Shared pieces ─────────────────────────────

/** The header that carries the per-call token on every `/voice/tools/*` request. */
export const VOICE_CALL_TOKEN_HEADER = 'X-Call-Token';

/**
 * W3-03: the header that names an agent request (`[A-Za-z0-9_.:-]{1,128}`, e.g. a uuid), the same
 * on its one retry. field-api runs a named request once per call and answers a retry with the
 * first 2xx answer (`voice_tool_requests`), so a retried `file_report` never files twice and a
 * retried `record_answer` never counts twice. Without it a request runs again.
 */
export const VOICE_REQUEST_ID_HEADER = 'X-Request-Id';
export const VOICE_REQUEST_ID_RE = /^[A-Za-z0-9_.:-]{1,128}$/;

/** A LiveKit room of a call: `call-{uuid}` (§9.4 "How a call starts"; `calls.provider_call_id`). */
export const VOICE_ROOM_RE = /^call-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** The consent wording version a call stores until the pack's `legal_keys.consent` is set (§19 Q28, Q120). */
export const VOICE_CONSENT_TEXT_VERSION = 'voice.consent.v1';

/** The recording notice version a call plays until the pack's `legal_keys.recording_notice` is set (§19 Q28). */
export const VOICE_RECORDING_NOTICE_VERSION = 'voice.recording_notice.v1';

const uuid = z.uuid();
const e164 = z.string().regex(/^\+[1-9]\d{6,14}$/, 'E.164');
const hhmm = z.string().regex(/^\d{2}:\d{2}$/, 'HH:MM');
const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'YYYY-MM-DD');
const isoInstant = z.iso.datetime({ offset: true });
/** Seconds from the call's start (answer), as the dialog log and the transcript count them. */
const callSeconds = z.number().min(0).max(3600);
/** Text the reporter said, as STT heard it (data, never instructions: §10.12). */
const utterance = z.string().trim().min(1).max(4000);

/** Every tool request names its call; the token in `X-Call-Token` must be this call's. */
const toolBase = { callId: uuid };

/** A call token: base64url (no padding) of an HMAC-SHA-256, 43 characters. */
export const CallTokenSchema = z.string().regex(/^[A-Za-z0-9_-]{43}$/, 'call token');

/** The reporter as the agent may know them: first name and locale, never the phone number. */
export const VoiceReporterSchema = z.strictObject({
  firstName: z.string().min(1).max(80),
  locale: z.enum(REPORTER_LOCALES),
});

/**
 * Where the draft of the call's report stands after a tool changed it (§9.4 `update_draft`):
 * what is still missing, the one spoken question to ask (≤ 2 choices, §9.4 rule 3), or, nothing
 * missing, the read-back code wrote (§19 Q118: every number spoken is code's). `draftRev` is the
 * revision `file_report` must name (§19 Q119).
 */
export const VoiceDraftStateSchema = z.strictObject({
  reportId: uuid,
  draftRev: z.number().int().min(1),
  missing: z.array(z.string().min(1).max(100)).max(20),
  question: z
    .strictObject({
      id: uuid,
      text: z.string().min(1).max(400),
      choices: z.array(z.string().min(1).max(80)).max(2),
    })
    .nullable(),
  readBack: z.string().min(1).max(1200).nullable(),
});

/**
 * W3-09 (spec §19 Q117): the live tools (`update_draft`, `record_answer`) run in the worker as a
 * priority `voice_turn` job; field-api waits for its answer up to `VOICE_TOOL_WAIT_MS` (at most
 * `VOICE_TOOL_WAIT_MAX_MS`). Past the wait it answers this instead (HTTP 202): the agent says a
 * short line ("Still working on it, one moment") and calls the tool again with the same words,
 * which finds the same turn (`voiceTurnKey`) and waits for it again, never a second extraction.
 */
export const VoiceTurnPendingSchema = z.strictObject({
  status: z.literal('pending'),
  /** When asking again is worth it, in milliseconds. */
  retryAfterMs: z.number().int().min(0).max(15_000),
});

/** §19 Q117's default wait (`VOICE_TOOL_WAIT_MS` unset) and its cap. */
export const VOICE_TOOL_WAIT_DEFAULT_MS = 12_000;
export const VOICE_TOOL_WAIT_MAX_MS = 15_000;

/** The live tools that run as a worker turn (W3-09; W3-10 adds `apply_correction`). */
export const VOICE_TURN_KINDS = ['update_draft', 'record_answer', 'apply_correction'] as const;
export type VoiceTurnKind = (typeof VOICE_TURN_KINDS)[number];

/**
 * The turn a live tool request is (W3-09): SHA-256 (hex) of the tool and its words, so the same
 * words of the same call are one turn however often the agent asks (a retry with a new request
 * id, a call again after `pending`): `voice_turns (call_id, kind, turn_key)` is unique. WebCrypto,
 * so Node, Deno and browsers share it.
 */
export async function voiceTurnKey(kind: VoiceTurnKind, input: unknown): Promise<string> {
  const bytes = new TextEncoder().encode(`${kind}\n${canonicalJson(input)}`);
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', bytes));
  return Array.from(digest, (b) => b.toString(16).padStart(2, '0')).join('');
}

/** JSON with object keys sorted, so equal values hash equally. */
function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value && typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`).join(',')}}`;
  }
  return JSON.stringify(value ?? null);
}

// ───────────────────────────── POST /voice/calls/start ─────────────────────────────

/**
 * `POST /voice/calls/start` (§9.4 "How a call starts"): the agent's first request in a room. A SIP
 * call passes the caller's number (`from`, the SIP participant's `sip.phoneNumber`) and the number
 * it called (`to`, `sip.trunkPhoneNumber`; W3-03), and the reporter is found by `from` in the real
 * orgs of the pack whose voice number is `to` (§4.6, §19 Q44); a Talk now call (`web`) and an
 * outbound call pass the `callId` the call row already has.
 */
export const VoiceCallStartRequestSchema = z
  .strictObject({
    room: z.string().regex(VOICE_ROOM_RE, 'call-{uuid}'),
    from: e164.optional(),
    /** The pack's voice number the caller dialled (W3-03: the pack is found by it, §4.6). */
    to: e164.optional(),
    callId: uuid.optional(),
    transport: z.enum(CALL_TRANSPORTS),
  })
  .refine((b) => b.transport !== 'web' || b.callId !== undefined, {
    message: 'a web call passes its callId',
    path: ['callId'],
  })
  .refine((b) => b.callId !== undefined || (b.from !== undefined && b.to !== undefined), {
    message: 'callId, or from and to',
    path: ['from'],
  })
  .describe('A web call passes callId; every other call passes callId, or from and to.');

/**
 * The answer: the call, its token, and the reporter's first name and locale; or `unknown: true`
 * for a caller no reporter matches (F13). Never the phone number.
 */
export const VoiceCallStartResponseSchema = z
  .strictObject({
    callId: uuid,
    callToken: CallTokenSchema,
    reporter: VoiceReporterSchema.optional(),
    unknown: z.literal(true).optional(),
    /**
     * W3-14 (F13): an unknown caller's language, the first field locale of the pack whose number
     * was called (the disclosure and the F13 line are said in it).
     */
    locale: z.enum(REPORTER_LOCALES).optional(),
  })
  .refine((r) => (r.reporter === undefined) !== (r.unknown === undefined), {
    message: 'reporter or unknown',
  })
  .describe('Exactly one of reporter or unknown.');

// ───────────────────────────── The call's bookkeeping shapes ─────────────────────────────

/** One line of `calls.dialog_log` (§6.3: `[{t, speaker, text, tool?}]`). */
export const DialogLogEntrySchema = z.strictObject({
  t: callSeconds,
  speaker: z.enum(['agent', 'reporter']),
  text: z.string().max(4000),
  tool: z.string().min(1).max(64).optional(),
});
export const DialogLogSchema = z.array(DialogLogEntrySchema).max(2000);

/** `calls.metrics` (§6.3: latency p50/p95, interruptions, STT confidence; the SIP call id). */
export const CallMetricsSchema = z.strictObject({
  latencyP50Ms: z.number().int().min(0).nullable(),
  latencyP95Ms: z.number().int().min(0).nullable(),
  interruptions: z.number().int().min(0),
  sttConfidence: z.number().min(0).max(1).nullable(),
  turns: z.number().int().min(0),
  sipCallId: z.string().min(1).max(200).optional(),
});

/** One lane of waveform peaks: values 0 … 1, at most 2048 of them. */
const peakLane = z.array(z.number().min(0).max(1)).max(2048);

/**
 * `calls.peaks`: two lanes since W3-01, the reporter's (left channel) and the agent's (right),
 * as the dual-channel recording holds them (§9.4 "Recording"). A v1 row's single array (the
 * Kestrel seed's) is still read, as one reporter lane (`readCallPeaks`).
 */
export const CallPeaksSchema = z.strictObject({ reporter: peakLane, agent: peakLane });
export const CallPeaksV1Schema = peakLane;
export const StoredCallPeaksSchema = z.union([CallPeaksSchema, CallPeaksV1Schema]);

/** A call's peaks as the player reads them: the reporter lane, and the agent lane when there is one. */
export interface CallPeaksLanes {
  reporter: number[];
  agent: number[] | null;
}

/** `calls.peaks` → lanes: two lanes, a v1 single array as the reporter lane, anything else none. */
export function readCallPeaks(value: unknown): CallPeaksLanes | null {
  const two = CallPeaksSchema.safeParse(value);
  if (two.success) return { reporter: two.data.reporter, agent: two.data.agent };
  const one = CallPeaksV1Schema.safeParse(value);
  if (one.success) return { reporter: one.data, agent: null };
  return null;
}

// ───────────────────────────── POST /voice/calls/:id/recording ─────────────────────────────

/**
 * `POST /voice/calls/:id/recording` (§9.4 "Recording"; W3-03): a signed upload URL for the
 * dual-channel recording, `calls/{org}/{call}.ogg` (reporter left, agent right; Opus/OGG).
 */
export const VoiceRecordingUploadRequestSchema = z.strictObject({
  ...toolBase,
  mime: z.literal('audio/ogg'),
  bytes: z
    .number()
    .int()
    .positive()
    .max(50 * 1024 * 1024),
  durationS: z.number().min(0).max(3600),
});
export const VoiceRecordingUploadResponseSchema = z.strictObject({
  bucket: z.literal('calls'),
  path: z.string().min(1).max(300),
  signedUrl: z.url(),
  token: z.string().min(1).max(2000),
});

// ───────────────────────────── POST /voice/tools/* (§9.4's table) ─────────────────────────────

/** `get_context`: who is calling about what (§9.4; F14 lists ≤ 3 sites by name). */
export const GetContextRequestSchema = z.strictObject({ ...toolBase });
export const GetContextResponseSchema = z.strictObject({
  call: z.strictObject({
    direction: z.enum(CALL_DIRECTIONS),
    transport: z.enum(CALL_TRANSPORTS),
    purpose: z.enum(['daily_report', 'reminder', 'callback', 'edit']).nullable(),
  }),
  reporter: VoiceReporterSchema,
  /** The org's name: the opening's "for {company}". */
  company: z.string().min(1).max(200),
  reportLanguage: z.enum(REPORT_LANGUAGES),
  sites: z
    .array(
      z.strictObject({
        id: uuid,
        name: z.string().min(1).max(200),
        /** Today's site-day status in the site's time zone; null with no site-day yet. */
        status: z.enum(SITE_DAY_STATUSES).nullable(),
        /** Today's deadline, site local time. */
        deadline: hhmm.nullable(),
      }),
    )
    .max(50),
  /** The call's site once known (one site, a Talk now call, an outbound call, or `pick_site`). */
  siteId: uuid.nullable(),
  companies: z
    .array(
      z.strictObject({
        name: z.string().min(1).max(200),
        aliases: z.array(z.string().min(1).max(200)).max(50),
      }),
    )
    .max(200),
  /** Confirmed glossary terms for speech recognition (`buildKeyterms`, W3-08). */
  keyterms: z.array(z.string().min(1).max(100)).max(100),
  /** The reporter's consents held now (F3, §19 Q120: a caller without them is asked first). */
  consents: z.strictObject({
    recording: z.boolean(),
    dataProcessing: z.boolean(),
    sms: z.boolean(),
    autoCall: z.boolean(),
  }),
  /** The pack's `legal_keys.recording_notice`, else `voice.recording_notice.v1`. */
  recordingNoticeVersion: z.string().min(1).max(64),
  /** The pack's `legal_keys.consent`, else `voice.consent.v1`. */
  consentTextVersion: z.string().min(1).max(64),
  /** §9.4 dialog policy `{max_questions}`: `org_settings.max_questions_per_report` (§10.5). */
  maxQuestions: z.number().int().min(0).max(10),
});

/** `pick_site` (F14 on a call; W3-03's addition to §9.4's table): fixes the call's site. */
export const PickSiteRequestSchema = z.strictObject({ ...toolBase, siteId: uuid });
export const PickSiteResponseSchema = z.strictObject({
  siteId: uuid,
  name: z.string().min(1).max(200),
});

/** A stretch of the reporter's channel with its timestamps (seconds from the call's start). */
const TranscriptSegmentSchema = z.strictObject({
  start: callSeconds,
  end: callSeconds,
  text: z.string().max(4000),
});

/**
 * `update_draft` (§9.4, §10.4 live mode): the reporter's channel so far, with timestamps; the
 * extraction runs in code's pipeline (§19 Q117) and answers the draft state.
 */
export const UpdateDraftRequestSchema = z.strictObject({
  ...toolBase,
  segments: z.array(TranscriptSegmentSchema).min(1).max(2000),
});
export const UpdateDraftResponseSchema = z
  .union([VoiceDraftStateSchema, VoiceTurnPendingSchema])
  .describe('The draft state, or (HTTP 202) status pending: ask again with the same segments.');

/** `record_answer` (§9.4, F7 on a call): the answer to the open question, as said. */
export const RecordAnswerRequestSchema = z.strictObject({
  ...toolBase,
  questionId: uuid,
  utterance,
  start: callSeconds,
  end: callSeconds.optional(),
});
export const RecordAnswerResultSchema = z.strictObject({
  /**
   * `applied`: code applied the value (F7). `not_understood`: the answer did not give the value;
   * the draft still has the question, and the agent asks it once more with its choices.
   * `skipped` (W3-09): the second unclear answer: the question is recorded unanswered for the
   * office (`unanswered:<field>`) and the draft has moved on (the next question, or the
   * read-back).
   */
  status: z.enum(['applied', 'not_understood', 'skipped']),
  /**
   * The line to say, in the call language, numbers from code: F7's confirmation when applied,
   * "I didn't catch that." when not understood, "I've left it for the office to check." when
   * skipped.
   */
  confirmation: z.string().min(1).max(400).nullable(),
  draft: VoiceDraftStateSchema,
});
export const RecordAnswerResponseSchema = z
  .union([RecordAnswerResultSchema, VoiceTurnPendingSchema])
  .describe('The answer settled, or (HTTP 202) status pending: ask again with the same words.');

/**
 * `apply_correction` (§9.4, §10.6, F8 by voice; F10 after `load_report`): the change as said;
 * the agent then reads back only the changed part and asks again (§9.4 rule 5).
 */
export const ApplyCorrectionRequestSchema = z.strictObject({
  ...toolBase,
  utterance,
  start: callSeconds,
  end: callSeconds.optional(),
  /** The report `load_report` found (F10); omitted for the call's own draft. */
  reportId: uuid.optional(),
});
export const ApplyCorrectionResultSchema = z.strictObject({
  /**
   * W3-10 (F8 call): `applied`: code applied the change to the call's draft at once (the spoken
   * "Shall I file it?" after the change's read-back is its confirm; a new draft revision).
   * `not_understood`: the change could not be read or code refused it; nothing changed.
   * `nothing_to_change`: the draft already says it.
   * W3-14 (F10 call, a `reportId` from `load_report`): `preview`: code made the change of the filed
   * report as a preview (W2-11's, from its current version); nothing is saved until the reporter
   * says yes to "Save it?" (`save_change` with `correctionId`). `draft` is then null.
   */
  status: z.enum(['applied', 'not_understood', 'nothing_to_change', 'preview']),
  /** W3-14: the preview `save_change` names (status `preview` only). */
  correctionId: uuid.optional(),
  /**
   * The lines to say, worded by code in the call language: the changed lines (numbers from code)
   * when applied; "I couldn't make that change. What should I change?" when not understood.
   */
  lines: z.array(z.string().min(1).max(400)).max(20),
  /** The read-back of the change only, then "Shall I file it?" (§9.4 rule 5); null otherwise. */
  readBack: z.string().min(1).max(800).nullable(),
  /** The call's draft after the turn (its `draftRev` is what `file_report` names next). */
  draft: VoiceDraftStateSchema.nullable(),
});
export const ApplyCorrectionResponseSchema = z
  .union([ApplyCorrectionResultSchema, VoiceTurnPendingSchema])
  .describe('The change settled, or (HTTP 202) status pending: ask again with the same words.');

/**
 * `file_report` (§9.4, F8; §19 Q119): the reporter's verbatim last utterance and the revision the
 * read-back was made from. Code files only when the whole utterance, normalised, is a §9.5
 * confirm and the revision matches; the model never decides to file (CLAUDE.md).
 */
export const FileReportRequestSchema = z.strictObject({
  ...toolBase,
  reportId: uuid,
  draftRev: z.number().int().min(1),
  utterance,
});
export const FileReportResponseSchema = z.discriminatedUnion('status', [
  z.strictObject({
    status: z.literal('filed'),
    reportNo: z.string().min(1).max(40),
    /** The PDF renders after the call; the `filed` message carries it (Notifier). */
    pdf: z.literal('pending'),
  }),
  /** Not a confirm: the agent asks "Shall I file it? Say yes or no." (§19 Q119). */
  z.strictObject({ status: z.literal('not_confirmed') }),
  /** A newer draft than the one read back: read back again. */
  z.strictObject({ status: z.literal('draft_changed'), draft: VoiceDraftStateSchema }),
  /**
   * W3-10 (HTTP 202): the filing runs past field-api's wait (`VOICE_TOOL_WAIT_MS`); say a short
   * line and call file_report again with the same words and revision: a draft revision is filed
   * by one filing job, never twice (§19 Q151).
   */
  VoiceTurnPendingSchema,
]);

/** A day-off read-back's key (W3-14): SHA-256 hex of the call, the status and the details. */
const confirmKey = z.string().regex(/^[0-9a-f]{64}$/, 'confirm key');

/**
 * `set_day_status` (§9.4, F12 on a call): no work today, or a weather day with its details.
 *
 * W3-14 (CLAUDE.md: the model never decides to file; a day off files a report): in two steps.
 * Without `utterance` code reads the day off back (`confirm`: "Weather day at Hillcrest: work
 * stopped at 11:00, 12 on site before, 4.5 hours lost. Shall I log it?", the lost hours from code)
 * and hands a `confirmKey`; the reporter's verbatim answer then comes back as `utterance` with that
 * key and the same details, and code logs the day only when the whole answer is a §9.5 confirm
 * (`isCallConfirm`, §19 Q119's grammar) and the key is the read-back's. `start`/`end`: the call
 * seconds the reporter said the details at (the source of each value, `{type: 'call'}`).
 */
export const SetDayStatusRequestSchema = z
  .strictObject({
    ...toolBase,
    status: z.enum(['no_work', 'weather_day']),
    details: z
      .strictObject({
        since: z.union([hhmm, z.literal('never_started')]).optional(),
        workersBefore: z.number().int().min(0).max(9999).optional(),
      })
      .optional(),
    start: callSeconds.optional(),
    end: callSeconds.optional(),
    /** W3-14: the reporter's verbatim answer to the read-back (with `confirmKey`). */
    utterance: utterance.optional(),
    confirmKey: confirmKey.optional(),
  })
  .refine((b) => b.status !== 'weather_day' || b.details?.since !== undefined, {
    message: 'a weather day needs details.since',
    path: ['details', 'since'],
  })
  .refine((b) => (b.utterance === undefined) === (b.confirmKey === undefined), {
    message: 'utterance and confirmKey go together',
    path: ['confirmKey'],
  })
  .describe(
    'A weather_day needs details.since; utterance and confirmKey go together (the answer to the read-back).',
  );
export const SetDayStatusResponseSchema = z.strictObject({
  /**
   * W3-14: `confirm`: say `confirmation` (the read-back ending in "Shall I log it?") and send the
   * reporter's answer with `confirmKey`. `not_confirmed`: not a clear yes, asked again
   * (`day_off_confirm_repeat`; the same key). `ok`: logged (a weather day: the photos link was
   * texted). `report_in_progress` (§19 Q79: say it in the report), `report_filed`, `site_paused`:
   * nothing logged.
   */
  status: z.enum([
    'confirm',
    'not_confirmed',
    'ok',
    'report_in_progress',
    'report_filed',
    'site_paused',
  ]),
  /** The sentence to say, in the call language. */
  confirmation: z.string().min(1).max(400),
  /** W3-14: the read-back's key (`confirm`, `not_confirmed`). */
  confirmKey: confirmKey.optional(),
});

/**
 * `schedule_callback` (§9.4, F6 "call me back in half an hour"; §19 Q128: one callback a
 * site-day, inside the call window, before the missing step).
 */
export const ScheduleCallbackRequestSchema = z.strictObject({
  ...toolBase,
  minutes: z.number().int().min(5).max(720),
});
export const ScheduleCallbackResponseSchema = z.discriminatedUnion('status', [
  z.strictObject({
    status: z.literal('scheduled'),
    at: isoInstant,
    /** `at` in the site's time zone, for the goodbye. */
    localTime: hhmm,
  }),
  z.strictObject({ status: z.literal('outside_window'), windowEnd: hhmm.nullable() }),
  z.strictObject({ status: z.literal('limit_reached') }),
]);

/**
 * `set_preference` (§9.4, F15 "text me instead" / "stop calling me"): the report mode; and
 * "not today" (§19 Q129, M8), which sets no calls until the end of today.
 */
export const SetPreferenceRequestSchema = z
  .strictObject({
    ...toolBase,
    contactPref: z.enum(CONTACT_PREFS).optional(),
    noCallsToday: z.literal(true).optional(),
  })
  .refine((b) => b.contactPref !== undefined || b.noCallsToday !== undefined, 'nothing to change')
  .describe('contactPref or noCallsToday (or both).');
export const SetPreferenceResponseSchema = z.strictObject({
  ok: z.literal(true),
  /**
   * W3-03: the sentence to say in the call language (`pref_call_ok` / `pref_text_ok`, the spoken
   * form of §9.5's CALL / TEXT replies): the mode now set, changed or not; null when the request
   * set no mode.
   */
  confirmation: z.string().min(1).max(400).nullable(),
});

/**
 * `load_report` (§9.4, F10 "change Friday's report"): the day as said; code resolves it
 * (`resolveDayReference`) to a filed report of the reporter's sites within 14 days (§19 Q81).
 */
export const LoadReportRequestSchema = z.strictObject({
  ...toolBase,
  dayReference: z.string().trim().min(1).max(100),
  siteId: uuid.optional(),
});
export const LoadReportResponseSchema = z.discriminatedUnion('status', [
  z.strictObject({
    status: z.literal('found'),
    reportId: uuid,
    date: isoDate,
    reportNo: z.string().min(1).max(40),
    /** A short spoken summary in the call language, numbers from code. */
    summary: z.string().min(1).max(1200),
  }),
  z.strictObject({ status: z.enum(['not_found', 'ambiguous', 'locked']) }),
]);

/**
 * W3-14 `save_change` (F10 on a call, an addition to §9.4's table like `pick_site`): the
 * reporter's verbatim answer to "Save it?" after a filed report's change was read back
 * (`apply_correction` → `preview`). Code saves version n+1 only when the whole answer is a §9.5
 * confirm (`isCallConfirm`) and the report is still the version the preview was made from.
 */
export const SaveChangeRequestSchema = z.strictObject({
  ...toolBase,
  reportId: uuid,
  correctionId: uuid,
  utterance,
});
export const SaveChangeResponseSchema = z.strictObject({
  /**
   * `saved`: version n+1 made (the PDF, the "Updated" email and the `edit_applied` text follow).
   * `not_confirmed`: not a clear yes ("Save it? Say yes or no."). `draft_changed`: the report has a
   * newer version than the preview's ("…say the change again").
   */
  status: z.enum(['saved', 'not_confirmed', 'draft_changed']),
  version: z.number().int().min(2).optional(),
  /** The sentence to say, in the call language. */
  confirmation: z.string().min(1).max(400),
});

/**
 * W3-14 `record_consent` (F3 on a call, §19 Q120; an addition to §9.4's table): the reporter's
 * verbatim answer to `consent_ask`, said after the disclosure, with its call second. Code reads it
 * (`callYesNo`): yes stores `recording`, `data_processing` and `sms` (`voice_yes`, the call id
 * and second as evidence) and activates the reporter; no stores nothing more, deletes the call's
 * recording and texts the link only if `sms` was given before; anything else is asked again.
 */
export const RecordConsentRequestSchema = z.strictObject({
  ...toolBase,
  utterance,
  at: callSeconds,
});
export const RecordConsentResponseSchema = z.strictObject({
  status: z.enum(['given', 'declined', 'not_understood']),
  /**
   * The line to say: `consent_given`; `consent_declined` / `consent_declined_link` (then end the
   * call `abandoned`); `consent_repeat`.
   */
  confirmation: z.string().min(1).max(400),
  /** `declined`: the personal link was texted (only with an `sms` consent given before). */
  linkSent: z.boolean(),
});

/**
 * W3-14 `leave_message` (F13, §19 Q124; an addition to §9.4's table): what an unknown caller said
 * after `unknown_caller` (name, company, site), as heard. Code keeps a 160-character snippet on
 * `unknown_contacts` (channel `voice`, the call) for the office's Team alert; never a report.
 */
export const LeaveMessageRequestSchema = z.strictObject({
  ...toolBase,
  utterance,
  start: callSeconds,
});
export const LeaveMessageResponseSchema = z.strictObject({
  ok: z.literal(true),
  /** `unknown_goodbye`, in the pack's language. */
  confirmation: z.string().min(1).max(400),
});

/** `start_fallback_recording` (§9.4 rule 9, F6 failure handling; W3-11). */
export const StartFallbackRecordingRequestSchema = z.strictObject({
  ...toolBase,
  reason: z.enum(['not_understood', 'stt_low_confidence', 'agent_error']),
  at: callSeconds,
});
export const StartFallbackRecordingResponseSchema = z.strictObject({ ok: z.literal(true) });

/** `end_call` (§9.4): the outcome, the dialog log and the metrics (§6.3 `calls`). */
export const EndCallRequestSchema = z.strictObject({
  ...toolBase,
  outcome: z.enum(CALL_OUTCOMES),
  dialogLog: DialogLogSchema,
  metrics: CallMetricsSchema,
});
export const EndCallResponseSchema = z.strictObject({ ok: z.literal(true) });

// ───────────────────────────── The routes and the generated files ─────────────────────────────

/**
 * The tools of §9.4's table, in its order, plus `pick_site` (W3-03, F14) and W3-14's
 * `save_change` (F10), `record_consent` (F3) and `leave_message` (F13).
 */
export const VOICE_TOOLS = [
  'get_context',
  'update_draft',
  'record_answer',
  'apply_correction',
  'file_report',
  'set_day_status',
  'schedule_callback',
  'set_preference',
  'load_report',
  'start_fallback_recording',
  'end_call',
  'pick_site',
  'save_change',
  'record_consent',
  'leave_message',
] as const;
export type VoiceTool = (typeof VOICE_TOOLS)[number];

/** Each tool's request and response schema (`POST /voice/tools/{tool}`). */
export const VOICE_TOOL_SCHEMAS = {
  get_context: { request: GetContextRequestSchema, response: GetContextResponseSchema },
  update_draft: { request: UpdateDraftRequestSchema, response: UpdateDraftResponseSchema },
  record_answer: { request: RecordAnswerRequestSchema, response: RecordAnswerResponseSchema },
  apply_correction: {
    request: ApplyCorrectionRequestSchema,
    response: ApplyCorrectionResponseSchema,
  },
  file_report: { request: FileReportRequestSchema, response: FileReportResponseSchema },
  set_day_status: { request: SetDayStatusRequestSchema, response: SetDayStatusResponseSchema },
  schedule_callback: {
    request: ScheduleCallbackRequestSchema,
    response: ScheduleCallbackResponseSchema,
  },
  set_preference: { request: SetPreferenceRequestSchema, response: SetPreferenceResponseSchema },
  load_report: { request: LoadReportRequestSchema, response: LoadReportResponseSchema },
  start_fallback_recording: {
    request: StartFallbackRecordingRequestSchema,
    response: StartFallbackRecordingResponseSchema,
  },
  end_call: { request: EndCallRequestSchema, response: EndCallResponseSchema },
  pick_site: { request: PickSiteRequestSchema, response: PickSiteResponseSchema },
  save_change: { request: SaveChangeRequestSchema, response: SaveChangeResponseSchema },
  record_consent: { request: RecordConsentRequestSchema, response: RecordConsentResponseSchema },
  leave_message: { request: LeaveMessageRequestSchema, response: LeaveMessageResponseSchema },
} as const satisfies Record<VoiceTool, { request: z.ZodType; response: z.ZodType }>;

/** A voice route: method, path under `FIELD_API_URL`, and its contract files. */
export interface VoiceRoute {
  method: 'POST';
  path: string;
  request: string;
  response: string;
  /** Whether the route needs `X-Call-Token` besides the bearer secret. */
  callToken: boolean;
}

/** Every `/voice/*` route of `field-api` (Appendix B), by name. */
export const VOICE_ROUTES: Record<string, VoiceRoute> = {
  calls_start: {
    method: 'POST',
    path: '/voice/calls/start',
    request: 'calls_start_request',
    response: 'calls_start_response',
    callToken: false,
  },
  recording_upload: {
    method: 'POST',
    path: '/voice/calls/{callId}/recording',
    request: 'recording_upload_request',
    response: 'recording_upload_response',
    callToken: true,
  },
  ...Object.fromEntries(
    VOICE_TOOLS.map((tool) => [
      tool,
      {
        method: 'POST',
        path: `/voice/tools/${tool}`,
        request: `tool_${tool}_request`,
        response: `tool_${tool}_response`,
        callToken: true,
      } satisfies VoiceRoute,
    ]),
  ),
};

/**
 * Every schema `pnpm voice:contract` writes, by file name (`apps/voice-agent/contract/<name>.json`).
 * The keys are stable: the Python side loads them by name.
 */
export const VOICE_CONTRACT: Record<string, z.ZodType> = {
  calls_start_request: VoiceCallStartRequestSchema,
  calls_start_response: VoiceCallStartResponseSchema,
  recording_upload_request: VoiceRecordingUploadRequestSchema,
  recording_upload_response: VoiceRecordingUploadResponseSchema,
  dialog_log: DialogLogSchema,
  call_metrics: CallMetricsSchema,
  call_peaks: CallPeaksSchema,
  draft_state: VoiceDraftStateSchema,
  turn_pending: VoiceTurnPendingSchema,
  ...Object.fromEntries(
    VOICE_TOOLS.flatMap((tool) => [
      [`tool_${tool}_request`, VOICE_TOOL_SCHEMAS[tool].request],
      [`tool_${tool}_response`, VOICE_TOOL_SCHEMAS[tool].response],
    ]),
  ),
};

// ───────────────────────────── Limits and errors (W3-03) ─────────────────────────────

/** Tool calls a call may make: 60 a minute (`rate_limits`, key `call:<callId>`; W3-03). */
export const VOICE_TOOL_RATE_LIMIT = { limit: 60, windowSeconds: 60 } as const;

/**
 * How long after its start a call's token works for the tools (W3-03): §9.4 caps a call at 12
 * minutes and `callSeconds` at an hour; past this, or once the call ended, a tool answers 409
 * `call_ended`. The recording upload is the exception: it is signed until `VOICE_RECORDING_GRACE_S`
 * after the end (the agent uploads at call end, §9.4 "Recording").
 */
export const VOICE_CALL_MAX_S = 60 * 60;
export const VOICE_RECORDING_GRACE_S = 60 * 60;

/** The error codes of `/voice/*` (JSON `{error, message?}`, as every field-api answer). */
export const VOICE_API_ERRORS = [
  'invalid_request',
  'not_found',
  /** No or a wrong `Authorization: Bearer VOICE_AGENT_TOOL_SECRET` (401). */
  'unauthorized',
  /** A browser `Origin` on a server-to-server route (403). */
  'origin_not_allowed',
  /** No or a wrong `X-Call-Token` for the call named (401). */
  'call_token_invalid',
  'call_not_found',
  /** The call has not started yet (no `calls/start`) (409). */
  'call_not_started',
  /** The call has ended, or started more than `VOICE_CALL_MAX_S` ago (409). */
  'call_ended',
  'call_conflict',
  /** The `to` of a SIP start is no pack's voice number (404). */
  'voice_number_unknown',
  /**
   * A tool on an unknown caller's call (F13) (403): every tool but `leave_message` and `end_call`;
   * and `leave_message` on a known caller's call.
   */
  'unknown_caller',
  /** A site, report or reporter outside the call's reporter and sites (403). */
  'out_of_scope',
  'reporter_disabled',
  'consent_required',
  /**
   * `schedule_callback` while no pack places outbound calls (W3-14 until W3-17, §19 Q128); a
   * filed report's change on a call before W3-14 (400).
   */
  'not_available',
  /** W3-14 (F10 call): a filed report older than the 14 days (§19 Q81) (409). */
  'report_locked',
  /** W3-14 (F10 call): a change of that report is still being read (409; ask again shortly). */
  'correction_pending',
  /** W3-14 (F10 call): `save_change` for a preview that is not ready (409). */
  'correction_not_ready',
  /** W3-14 (F10 call): the report's site is paused or archived (§19 Q99) (409). */
  'site_inactive',
  /** W3-14 (F13, §19 Q124): an unknown caller's recording longer than 60 s (400). */
  'recording_too_long',
  'rate_limited',
  /** W3-09: a live tool before the call's site is known (`pick_site` first, F14) (409). */
  'site_required',
  /** W3-09: today's report of the call's site is filed already (F10 is `load_report`) (409). */
  'report_closed',
  /** W3-09: `record_answer` for a question that is not the call's open question (409). */
  'question_closed',
  /** W3-10: `apply_correction` before the call's first `update_draft` made its draft (409). */
  'draft_required',
  /** W3-09: the worker could not run the turn (503; the agent's one retry runs it again). */
  'turn_failed',
  /** The first request with this `X-Request-Id` is still running (409). */
  'request_in_progress',
  /** This `X-Request-Id` named another tool's request in this call (409). */
  'request_conflict',
  'internal',
] as const;
export type VoiceApiErrorCode = (typeof VOICE_API_ERRORS)[number];

// ───────────────────────────── The per-call token (§6.5) ─────────────────────────────

/**
 * The per-call token (§6.5: "minted when the call starts, bound to `call_id` + reporter"):
 * HMAC-SHA-256 of `sitelog/call_token/v1/<callId>` (the id in lower case) under a server secret
 * (W3-03: `VOICE_CALL_TOKEN_SECRET`, field-api's only, never `VOICE_AGENT_TOOL_SECRET`: the agent
 * holds that one and must not be able to mint the token of another call),
 * as base64url without padding (43 characters). Like a link code (`deriveLinkCode`) nothing is
 * stored: `field-api` derives it again for the call a tool names and compares. The reporter
 * binding is the call row's `reporter_id`, fixed when the call starts; the token names the call.
 * WebCrypto, so Node, Deno and browsers share it.
 */
export async function deriveCallToken(secret: string, callId: string): Promise<string> {
  if (!secret) throw new Error('deriveCallToken needs a secret');
  if (!z.uuid().safeParse(callId).success) throw new Error('deriveCallToken needs a call uuid');
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey(
    'raw',
    enc.encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const mac = new Uint8Array(
    await crypto.subtle.sign(
      'HMAC',
      key,
      enc.encode(`sitelog/call_token/v1/${callId.toLowerCase()}`),
    ),
  );
  return base64Url(mac);
}

/** True when `token` is the call's token; compares in constant time over the expected length. */
export async function verifyCallToken(
  secret: string,
  callId: string,
  token: string | null | undefined,
): Promise<boolean> {
  if (!token || !CallTokenSchema.safeParse(token).success) return false;
  let expected: string;
  try {
    expected = await deriveCallToken(secret, callId);
  } catch {
    return false;
  }
  let diff = 0;
  for (let i = 0; i < expected.length; i++) diff |= expected.charCodeAt(i) ^ token.charCodeAt(i);
  return diff === 0;
}

function base64Url(bytes: Uint8Array): string {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';
  let out = '';
  for (let i = 0; i < bytes.length; i += 3) {
    const b0 = bytes[i]!;
    const b1 = i + 1 < bytes.length ? bytes[i + 1]! : 0;
    const b2 = i + 2 < bytes.length ? bytes[i + 2]! : 0;
    const n = (b0 << 16) | (b1 << 8) | b2;
    out += alphabet[(n >> 18) & 63]! + alphabet[(n >> 12) & 63]!;
    if (i + 1 < bytes.length) out += alphabet[(n >> 6) & 63]!;
    if (i + 2 < bytes.length) out += alphabet[n & 63]!;
  }
  return out;
}

// ───────────────────────────── Types ─────────────────────────────

export type VoiceCallStartRequest = z.infer<typeof VoiceCallStartRequestSchema>;
export type VoiceCallStartResponse = z.infer<typeof VoiceCallStartResponseSchema>;
export type VoiceDraftState = z.infer<typeof VoiceDraftStateSchema>;
export type VoiceTurnPending = z.infer<typeof VoiceTurnPendingSchema>;
export type RecordAnswerResult = z.infer<typeof RecordAnswerResultSchema>;
export type ApplyCorrectionResult = z.infer<typeof ApplyCorrectionResultSchema>;
export type SetDayStatusResponse = z.infer<typeof SetDayStatusResponseSchema>;
export type SaveChangeResponse = z.infer<typeof SaveChangeResponseSchema>;
export type RecordConsentResponse = z.infer<typeof RecordConsentResponseSchema>;
export type FileReportResponse = z.infer<typeof FileReportResponseSchema>;
export type DialogLogEntry = z.infer<typeof DialogLogEntrySchema>;
export type CallMetrics = z.infer<typeof CallMetricsSchema>;
export type CallPeaks = z.infer<typeof CallPeaksSchema>;
export type VoiceToolRequest<T extends VoiceTool> = z.infer<
  (typeof VOICE_TOOL_SCHEMAS)[T]['request']
>;
export type VoiceToolResponse<T extends VoiceTool> = z.infer<
  (typeof VOICE_TOOL_SCHEMAS)[T]['response']
>;
