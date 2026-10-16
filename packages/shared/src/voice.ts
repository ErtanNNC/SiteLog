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

// ───────────────────────────── POST /voice/calls/start ─────────────────────────────

/**
 * `POST /voice/calls/start` (§9.4 "How a call starts"): the agent's first request in a room. A SIP
 * call passes the caller's number (`from`, from the SIP participant's attributes) and the reporter
 * is found by it in the real orgs of the pack whose voice number was called (§19 Q44); a Talk now
 * call (`web`) and an outbound call pass the `callId` the call row already has.
 */
export const VoiceCallStartRequestSchema = z
  .strictObject({
    room: z.string().regex(VOICE_ROOM_RE, 'call-{uuid}'),
    from: e164.optional(),
    callId: uuid.optional(),
    transport: z.enum(CALL_TRANSPORTS),
  })
  .refine((b) => b.transport !== 'web' || b.callId !== undefined, {
    message: 'a web call passes its callId',
    path: ['callId'],
  })
  .refine((b) => b.from !== undefined || b.callId !== undefined, {
    message: 'from or callId',
    path: ['from'],
  })
  .describe('A web call passes callId; every call passes from or callId.');

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
export const UpdateDraftResponseSchema = VoiceDraftStateSchema;

/** `record_answer` (§9.4, F7 on a call): the answer to the open question, as said. */
export const RecordAnswerRequestSchema = z.strictObject({
  ...toolBase,
  questionId: uuid,
  utterance,
  start: callSeconds,
  end: callSeconds.optional(),
});
export const RecordAnswerResponseSchema = z.strictObject({
  /** `not_understood`: the answer did not give the value; the agent asks once more or moves on. */
  status: z.enum(['applied', 'not_understood']),
  /** F7's confirmation line, in the call language, numbers from code; null when not applied. */
  confirmation: z.string().min(1).max(400).nullable(),
  draft: VoiceDraftStateSchema,
});

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
export const ApplyCorrectionResponseSchema = z.strictObject({
  status: z.enum(['applied', 'not_understood', 'nothing_to_change']),
  /** The changed lines, worded by code in the call language. */
  lines: z.array(z.string().min(1).max(400)).max(20),
  /** The read-back of the change only (§9.4 rule 5); null when nothing changed. */
  readBack: z.string().min(1).max(800).nullable(),
  draft: VoiceDraftStateSchema.nullable(),
});

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
]);

/** `set_day_status` (§9.4, F12 on a call): no work today, or a weather day with its details. */
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
  })
  .refine((b) => b.status !== 'weather_day' || b.details?.since !== undefined, {
    message: 'a weather day needs details.since',
    path: ['details', 'since'],
  })
  .describe('A weather_day needs details.since.');
export const SetDayStatusResponseSchema = z.strictObject({
  status: z.enum(['ok', 'report_in_progress', 'site_paused']),
  /** The sentence to say, in the call language. */
  confirmation: z.string().min(1).max(400),
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
export const SetPreferenceResponseSchema = z.strictObject({ ok: z.literal(true) });

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

/** The tools of §9.4's table, in its order, plus `pick_site` (W3-03, F14). */
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
  ...Object.fromEntries(
    VOICE_TOOLS.flatMap((tool) => [
      [`tool_${tool}_request`, VOICE_TOOL_SCHEMAS[tool].request],
      [`tool_${tool}_response`, VOICE_TOOL_SCHEMAS[tool].response],
    ]),
  ),
};

// ───────────────────────────── The per-call token (§6.5) ─────────────────────────────

/**
 * The per-call token (§6.5: "minted when the call starts, bound to `call_id` + reporter"):
 * HMAC-SHA-256 of `sitelog/call_token/v1/<callId>` (the id in lower case) under a server secret,
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
export type DialogLogEntry = z.infer<typeof DialogLogEntrySchema>;
export type CallMetrics = z.infer<typeof CallMetricsSchema>;
export type CallPeaks = z.infer<typeof CallPeaksSchema>;
export type VoiceToolRequest<T extends VoiceTool> = z.infer<
  (typeof VOICE_TOOL_SCHEMAS)[T]['request']
>;
export type VoiceToolResponse<T extends VoiceTool> = z.infer<
  (typeof VOICE_TOOL_SCHEMAS)[T]['response']
>;
