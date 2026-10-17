import type { FieldCountryView } from './countries.ts';
import type {
  ConsentType,
  ContactPref,
  FieldChannel,
  MessageChannel,
  LinkKind,
  ReportStatus,
  ReporterStatus,
  SiteDayStatus,
  SiteStatus,
  UploadKind,
} from './enums.ts';
import type { ReporterLocale } from './locale.ts';
import type { CorrectionChange } from './report/correction.ts';
import type { DailyReportData } from './schemas/report.ts';

/**
 * The contract between the field app (`apps/field`) and `field-api` (W1-07; spec §6.5, Appendix B,
 * F4, F5, F12): response shapes, error codes and the constants both sides use. No zod here, so the
 * field app imports it without the schema library; the request schemas are `field-api.ts`.
 * The field app reaches field-api only same-origin at `/api/<route>` (D39); field-api mounts its
 * routes under `/field-api` (Hono, D6).
 *
 * Authentication: `resolve` takes the link code in its body; every other route takes it in the
 * `X-Link-Code` header, with the reporter's device cookie (`sl_dev_<8 hex>`, one per reporter;
 * httpOnly, so the app never sees it). Every route but `resolve` and `device/*` needs a device
 * verified within the last 180 days (and answers an unknown link like a valid one without one: 401
 * `device_unverified`), and every route but `resolve`, `device/*` and `consent` the reporter's
 * recording and data-processing consents.
 *
 * Errors are JSON `{ error: FieldApiErrorCode, message?, details?, retryAfter? }`; the app maps
 * the code to its own copy (no server text reaches the screen).
 */

/** The header that carries the link code on every route but `resolve`. */
export const FIELD_LINK_HEADER = 'X-Link-Code';

/**
 * The device cookie (§6.5, F4): httpOnly, Secure, SameSite=Lax, 180 days. One per reporter, named
 * `sl_dev_` + the first 8 hex characters of the SHA-256 of the reporter id (`deviceCookieName()`,
 * field-api.ts), so a phone that opens two reporters' links (a demo phone, a person in two orgs)
 * keeps both verifications. field-api also counts the 180 days from `verified_at`.
 */
export const DEVICE_COOKIE_PREFIX = 'sl_dev_';
export const DEVICE_COOKIE_MAX_AGE_S = 180 * 24 * 60 * 60;

/** F4 step 2: a 6-digit code by SMS, valid for 10 minutes. */
export const VERIFY_CODE_LENGTH = 6;
export const VERIFY_CODE_TTL_S = 10 * 60;

/**
 * Rate limits on `rate_limits` (spec §6.5, GAP D26): 30 requests a minute per device; 5 code sends
 * and 5 code verifications an hour per phone. A window starts at the key's first hit.
 */
export const FIELD_RATE_LIMITS = {
  device: { limit: 30, windowSeconds: 60 },
  codeSend: { limit: 5, windowSeconds: 60 * 60 },
  codeVerify: { limit: 5, windowSeconds: 60 * 60 },
  /**
   * F16 "Send me today's link" (W2-03): 3 a day per expired link (a window of 24 h from its first
   * request), besides the device's 30 a minute when the phone sends a device cookie.
   */
  expiredLink: { limit: 3, windowSeconds: 24 * 60 * 60 },
  /** F4's test recording (W2-13): 3 an hour per device. */
  testClip: { limit: 3, windowSeconds: 60 * 60 },
  /** Talk now (W3-13): 3 call starts an hour per device. */
  talkNow: { limit: 3, windowSeconds: 60 * 60 },
} as const;

/** `history`: the last 14 days (F10 "Past reports"), in each site's time zone. */
export const HISTORY_DAYS = 14;

/** Signed download URLs field-api hands out (a filed report's PDF): 10 minutes (§6.5). */
export const SIGNED_URL_SECONDS = 10 * 60;

/** The largest file field-api signs an upload for: Supabase Storage's default per-file limit. */
export const UPLOAD_MAX_BYTES = 50 * 1024 * 1024;

/**
 * F9: at most this many photos are added to a filed report after filing (per F9 window, until
 * 23:59 the day after the report's date, site time); field_complete_upload() checks it again.
 */
export const FILED_PHOTOS_MAX = 4;

/**
 * The media types the recorder may upload, with the kind and file extension field-api stores them
 * under (§9.3: `audio/webm;codecs=opus` on Chrome and Android, `audio/mp4` on iOS Safari; the
 * `<input capture>` fallback and photos).
 */
export const UPLOAD_MEDIA_TYPES: Readonly<Record<string, { kind: UploadKind; ext: string }>> = {
  'audio/webm': { kind: 'audio', ext: 'webm' },
  'audio/mp4': { kind: 'audio', ext: 'm4a' },
  'audio/x-m4a': { kind: 'audio', ext: 'm4a' },
  'audio/aac': { kind: 'audio', ext: 'aac' },
  'audio/ogg': { kind: 'audio', ext: 'ogg' },
  'audio/mpeg': { kind: 'audio', ext: 'mp3' },
  'audio/wav': { kind: 'audio', ext: 'wav' },
  'image/jpeg': { kind: 'photo', ext: 'jpg' },
  'image/png': { kind: 'photo', ext: 'png' },
  'image/webp': { kind: 'photo', ext: 'webp' },
  'image/heic': { kind: 'photo', ext: 'heic' },
  'image/heif': { kind: 'photo', ext: 'heif' },
};

/** The base media type (lower case, parameters dropped) and its storage extension, or null. */
export function uploadMediaType(
  mime: string,
): { mime: string; kind: UploadKind; ext: string } | null {
  const base = (mime.split(';')[0] ?? '').trim().toLowerCase();
  const known = UPLOAD_MEDIA_TYPES[base];
  return known ? { mime: base, ...known } : null;
}

/** The private bucket of an upload kind (20261011000006_platform.sql). */
export function uploadBucket(kind: UploadKind): 'audio' | 'photos' {
  return kind === 'audio' ? 'audio' : 'photos';
}

/** The `error` of a field-api answer. */
export const FIELD_API_ERRORS = [
  'invalid_request',
  'not_found',
  'origin_not_allowed',
  'link_required',
  'link_not_found',
  'link_expired',
  'link_revoked',
  'reporter_disabled',
  'device_unverified',
  'device_required',
  'no_code',
  'code_invalid',
  'code_expired',
  'code_undeliverable',
  'consent_required',
  'text_version_mismatch',
  'locale_not_offered',
  'site_inactive',
  'date_not_allowed',
  'kind_not_allowed',
  'media_type_not_allowed',
  'upload_missing',
  'upload_too_large',
  'report_filed',
  'report_filing',
  'draft_changed',
  'report_in_progress',
  'day_closed',
  'wrong_state',
  'question_closed',
  'answer_not_accepted',
  /** W2-09: a spoken answer to this question is still being listened to (`parse_answer`). */
  'answer_pending',
  /** W2-10: a fix of this draft is still being listened to (`apply_correction`). */
  'correction_pending',
  /** W2-10: the correction has no preview to save (still listening, unclear, saved or replaced). */
  'correction_not_ready',
  /** W2-10: a stepper's numbers do not fit the crew line (no such line, or no change). */
  'edit_not_accepted',
  /**
   * F10 (W2-11): the filed report is older than the last 14 days (site time): "That report is
   * locked. Ask the office to change it."
   */
  'report_locked',
  /** F9 (W2-04): the filed report takes no more photos (its window ended at 23:59 the next day). */
  'photos_window_closed',
  /** F9: FILED_PHOTOS_MAX photos were added after filing already. */
  'photo_limit',
  'channel_not_offered',
  /**
   * W3-17 (spec §19 Q33, Q131): the automated-call consent where the org places no calls (no
   * outbound trunk in its pack here, not a demo org); `resolve` says so with `placesCalls: false`.
   */
  'calls_not_offered',
  /**
   * Spec §19 Q86: *Turn on* for texts refused because the phone opted out of texts (SMS STOP or
   * the provider's opt-out list); only START undoes it (§9.5).
   */
  'texts_opted_out',
  'link_not_expired',
  /**
   * W3-13 (§19 Q121): Talk now is not offered here (no LiveKit in this environment, or the org is
   * billing-blocked); `resolve` / `today` say so with `talkNow: false` first.
   */
  'talk_now_unavailable',
  /** W3-13: LiveKit refused the room or the agent dispatch; the call was ended at once. */
  'voice_unavailable',
  'rate_limited',
  'internal',
] as const;
export type FieldApiErrorCode = (typeof FIELD_API_ERRORS)[number];

export interface FieldApiErrorBody {
  error: FieldApiErrorCode;
  /** English, for logs and developers; the app shows its own copy. */
  message?: string;
  details?: unknown;
  /** Seconds until a rate-limited caller may try again (also the Retry-After header). */
  retryAfter?: number;
  /** `code_invalid`: the code checks left in this hour's window (F16). */
  attemptsLeft?: number;
}

/** The consents without which the reporter cannot submit (F4 "required", F15 revoking). */
export const REQUIRED_CONSENTS = [
  'recording',
  'data_processing',
] as const satisfies readonly ConsentType[];

/**
 * The version of the field app's own consent wording (`field.welcome.*`, W1-09), stored as
 * `consents.text_version` while the pack names no consent key (spec §19 Q28, Appendix B); when
 * `legalKeys.consent` is set the app sends that key instead. Bump it when the wording changes.
 */
export const FIELD_CONSENT_TEXT_VERSION = 'field.consent.v1';

/** The recorder's cap per clip (§9.3, F5): 15 minutes, then the clip is sent and another may start. */
export const MAX_CLIP_SECONDS = 15 * 60;

/** Shorter clips are not sent (F5 edge case "recording < 5 s or silent → I couldn't hear anything"). */
export const MIN_CLIP_SECONDS = 5;

/**
 * How often the Processing screen polls `GET reports/:id` (F5 step 4, W1-09): every 2 s for the
 * first 20 s, every 5 s until a minute has passed, then every 10 s. A draft typically takes 20–60 s,
 * and every route counts against the device's limit (`FIELD_RATE_LIMITS.device`, 30 a minute,
 * refused hits included), which the clip's own upload and the photos behind it share.
 */
export const REPORT_POLL = {
  fastMs: 2_000,
  fastForMs: 20_000,
  slowMs: 5_000,
  slowForMs: 60_000,
  maxMs: 10_000,
} as const;

/** The wait before the next poll, `elapsedMs` after the screen started polling. */
export function reportPollDelay(elapsedMs: number): number {
  if (elapsedMs < REPORT_POLL.fastForMs) return REPORT_POLL.fastMs;
  if (elapsedMs < REPORT_POLL.slowForMs) return REPORT_POLL.slowMs;
  return REPORT_POLL.maxMs;
}

// ───────────────────────────── Responses ─────────────────────────────

export interface FieldSite {
  id: string;
  name: string;
  timezone: string;
  status: SiteStatus;
}

/** `POST resolve`. Sites are listed once the device is verified. */
export interface ResolveResponse {
  reporter: {
    name: string;
    firstName: string;
    locale: ReporterLocale;
    contactPref: ContactPref;
    status: ReporterStatus;
  };
  /** The org the reporter reports for: its name is in the consent notice (F4 "for {company}"). */
  org: { name: string };
  link: {
    kind: LinkKind;
    siteId: string | null;
    reportDate: string | null;
    expiresAt: string | null;
  };
  needsDeviceCheck: boolean;
  needsConsent: boolean;
  sites: FieldSite[];
  /** The org's country pack, the subset the field app needs (§4.6): never a sender or provider. */
  country: FieldCountryView;
  /**
   * W3-13 (§19 Q121): Today offers **Talk now**: this environment has LiveKit configured and the
   * org is not billing-blocked. Every reporter sees it (the second-largest button for a reporter who
   * prefers calls, §9.3).
   */
  talkNow: boolean;
  /**
   * W3-17 (spec §19 Q51's first option, Q125, Q132): SiteLog places automated calls for this
   * reporter's org: a pack with an outbound trunk in this environment, or a demo org (its calls
   * ring the panel's Demo phone). Only then does Field-02 show *Call me at report time
   * (automated)* and Settings its row and "Don't call me today" (§19 Q33: never asked otherwise).
   */
  placesCalls: boolean;
}

/** The body of a 410 `link_expired`: enough for the Expired screen's language and call option. */
export interface LinkExpiredBody extends FieldApiErrorBody {
  error: 'link_expired';
  locale: ReporterLocale;
  country: FieldCountryView;
}

/** `POST device/send-code`. */
export type SendCodeResponse =
  | { sent: true; expiresAt: string; alreadyVerified?: never }
  | { alreadyVerified: true; sent?: never };

/** `POST device/verify`. */
export interface VerifyResponse {
  verified: true;
  needsConsent: boolean;
}

/** `POST consent`. */
export interface ConsentResponse {
  consents: ConsentType[];
  status: ReporterStatus;
  contactPref: ContactPref;
  locale: ReporterLocale;
}

/** `GET today?site=` (F5 step 1, Field-03; F14 switcher). */
export interface TodayResponse {
  site: FieldSite;
  /** The reporter's active sites in this link's scope (the switcher when there is more than one). */
  sites: FieldSite[];
  /** The report date: the link's date, else today in the site's time zone. */
  date: string;
  /**
   * The dates an upload or day-status may name (first = `date`): a daily link its own; a personal
   * link today, and before 12:00 site time also the previous working day (F5 "today or
   * yesterday?", spec §19 Q43).
   */
  allowedDates: string[];
  deadlineAt: string;
  /** `pending` while the scheduler has not created the day yet. */
  dayStatus: SiteDayStatus;
  /**
   * The day's live report. `kind` (W2-08): a `weather_day` or `no_work` report is the record the
   * F12 buttons made (spec §19 Q41), so Today shows the day closed with it.
   */
  report: { id: string; reportNo: string; status: ReportStatus; kind: FieldReportKind } | null;
  /** W3-13 (§19 Q121): as `ResolveResponse.talkNow`, read again with each day. */
  talkNow: boolean;
}

/**
 * `POST voice/token {siteId}` (W3-13; §9.4, Appendix B): Talk now's call. `livekitUrl` is the
 * LiveKit project's WebSocket URL, `token` the participant token of the room `call-{callId}` (its
 * identity the call id, never the phone), minted server-side; the agent is dispatched to the room
 * before this answers. 3 starts an hour per device (`FIELD_RATE_LIMITS.talkNow`).
 */
export interface VoiceTokenResponse {
  livekitUrl: string;
  token: string;
  room: string;
  callId: string;
}

/** `reports.kind` (§6.3): a daily report, or the record of a weather day or a no-work day (F12). */
export type FieldReportKind = 'daily' | 'weather_day' | 'no_work';

/** `reports.kind` as the field app reads it (an unknown value reads as a daily report). */
export function fieldReportKind(kind: string): FieldReportKind {
  return kind === 'weather_day' || kind === 'no_work' ? kind : 'daily';
}

/**
 * `POST uploads`: PUT the file to `signedUrl` (Supabase Storage's signed upload URL; its lifetime
 * is Storage's, 2 hours, README "Deliberate deviations"), then `POST uploads/:id/complete`.
 */
export interface UploadResponse {
  uploadId: string;
  bucket: 'audio' | 'photos';
  path: string;
  signedUrl: string;
  token: string;
}

/**
 * `POST uploads/:id/complete`. field-api checks the stored object first: there (409
 * `upload_missing`), of the media type the upload named (409 `media_type_not_allowed`), at most
 * `UPLOAD_MAX_BYTES` (409 `upload_too_large`); `uploads.bytes` is the stored size. While the report
 * is being filed it refuses (409 `report_filing`).
 */
export interface CompleteResponse {
  reportId: string;
  reportNo: string;
  reportStatus: ReportStatus;
  /** This upload started the day's report. */
  created: boolean;
  /** The upload was completed before (a retry): nothing changed. */
  alreadyComplete: boolean;
  /**
   * F9 (W2-04): an upload of a batch added to a filed report. `ready` once every upload of the
   * batch completed; `version` is the new version, once made (null while the caption is being
   * transcribed: the worker makes it, so poll `reports/:id`).
   */
  batch?: { id: string; ready: boolean; version: number | null };
}

/** `GET reports/:id`: the question, draft or filed view model (Field-05, -06, -07; processing). */
export interface ReportView {
  id: string;
  reportNo: string;
  status: ReportStatus;
  /** W2-08: a weather-day or no-work record (F12) shows its own Filed line. */
  kind: FieldReportKind;
  siteId: string;
  siteName: string;
  date: string;
  channel: FieldChannel | null;
  currentVersion: number;
  needsReview: boolean;
  filedAt: string | null;
  confirmedAt: string | null;
  /** The open question (one at a time, §10.5), if any. */
  question: {
    id: string;
    field: string;
    prompt: string;
    /**
     * ≤ 2 answers to tap; null for a question with none (D28: the app asks for the number, with
     * "full day" as the default hours for a headcount). _Other…_ is not an option (M6).
     */
    options: { id: string; label: string }[] | null;
    /**
     * The crew the question is about (`data.manpower[i]`), for "Heard at 1:20 in your note"
     * (Field-05: the crew's voice-note source); null when it names no crew.
     */
    manpowerIndex: number | null;
    /**
     * W2-09 (F7 *Other…*): the spoken answer to this question, while it matters: `listening`
     * while the worker transcribes and parses the clip ("Listening to your answer…"), `retry`
     * after a clip it could not read (below `PARSE_ANSWER_MIN_CONFIDENCE`): "I didn't catch
     * that", the question asked once more with its choices. `unclear`: the tries it could not
     * read so far (the app tells a new outcome from the one it saw before sending). Null otherwise.
     */
    voice: { state: 'listening' | 'retry'; unclear: number } | null;
  } | null;
  /**
   * W2-09: the last spoken answer the worker settled, for F7's line on the screens that follow
   * it: `confirmation` (code's numbers, as after a tap) when it was applied, `unclear` when it
   * could not be read twice and the question was left for the office (`unanswered:<field>`, F7
   * "then move on and flag"). Null when no spoken answer was settled.
   */
  lastVoiceAnswer:
    | { questionId: string; outcome: 'applied'; confirmation: AnswerConfirmation }
    | { questionId: string; outcome: 'unclear' }
    | null;
  /** The current version's data in §10.3 v2 terms; null before the first draft. */
  data: DailyReportData | null;
  /**
   * The revision of that data (`report_versions.draft_rev`, bumped on every change of the draft):
   * Confirm & send names it with `currentVersion`; null before the first draft.
   */
  draftRev: number | null;
  /** For the Processing ticks (F5 step 4). */
  progress: { voiceNotes: number; transcribed: number; photos: number };
  /** A filed report's PDF, signed for 10 minutes. */
  pdfUrl: string | null;
  /**
   * F9 (W2-04): photos after filing; null unless the report is filed (or signed off).
   * `canAdd`: this link may add photos now (F9's window, the link's kind: spec §19 Q89) and
   * `remaining` > 0; `until`: the window's end (ISO); `pending`: photos received but not yet in a
   * version (their caption is being transcribed). The change note of the latest version
   * (`changeNote`, e.g. "2 photos added") says what the last version changed.
   */
  addPhotos: {
    canAdd: boolean;
    remaining: number;
    until: string;
    pending: number;
  } | null;
  /** The current version's change note (null for version 1 and drafts). */
  changeNote: string | null;
  /**
   * W2-10 (F8 *Fix by voice*): the latest fix of this draft while it matters (listening, a preview
   * to save, or one it could not read); null otherwise. A reload shows the preview again.
   */
  correction: CorrectionView | null;
  /**
   * F10 (W2-11, spec §19 Q81): *Change something* on a filed (or signed-off) report; null
   * otherwise. `canChange`: the report is of the last `HISTORY_DAYS` days (site time) and its site
   * is active; `locked`: older ("That report is locked. Ask the office to change it."). A change
   * goes through the same correction routes as a draft's fix (`correction.afterFiling`), and Save
   * change makes version n+1.
   */
  change: { canChange: boolean; locked: boolean } | null;
}

/** F8 *Fix by voice* (W2-10): a correction clip is short; the recorder stops it at 30 seconds. */
export const CORRECTION_CLIP_MAX_MS = 30_000;

/**
 * W2-10: a fix still being listened to after this long (its job keeps failing) no longer holds the
 * draft: the view shows it as unclear (`reason: 'timeout'`) and a new fix may be made (the same
 * 5 minutes in field_request_correction()).
 */
export const CORRECTION_LISTEN_TIMEOUT_S = 5 * 60;

/**
 * W2-10 review: a fix the worker found the report had moved on from (a late clip or photo sent the
 * draft back to processing first) is shown this long after it settled (`ReportView.correction`,
 * status `stale`), so the draft shown again tells the reporter to say it again.
 */
export const CORRECTION_STALE_SHOWN_S = 10 * 60;

/**
 * W2-10 (F8 *Fix by voice*, §10.6, Appendix B `reports/:id/correction`): a correction of the draft
 * and its preview. `listening` while the worker transcribes and parses it; `ready` with the
 * preview (`changes`, code's numbers: "Apex Concrete 6 → 7 workers, 48 → 56 h") made from the
 * draft at `version` / `draftRev`, which **Save change** applies there only (else 409
 * `draft_changed`); `unclear` when code could not apply it (`reason`) or the model asked which
 * line was meant (`clarification`, the model's words in the reporter's language); `applied` once
 * saved; `stale` when the draft changed first; `discarded` when a newer fix replaced it.
 */
export interface CorrectionView {
  id: string;
  status: 'listening' | 'ready' | 'unclear' | 'applied' | 'stale' | 'discarded';
  via: 'voice' | 'text';
  changes: CorrectionChange[] | null;
  clarification: string | null;
  reason: string | null;
  version: number | null;
  draftRev: number | null;
  /** W2-11 (F10): a change of the filed report (Save change makes version n+1). */
  afterFiling: boolean;
}

/**
 * `POST reports/:id/correction/:cid/apply` (W2-10): the fix is in the draft; decide_next shows it.
 * W2-11 (F10): for a change of a filed report, `version` is the new version (n+1), `filed`.
 */
export interface ApplyCorrectionResponse {
  status: 'applied';
  reportStatus: ReportStatus;
  version?: number;
}

/** `POST reports/:id/edit` (W2-10, the draft's steppers): the crew line changed; decide_next runs. */
export interface EditResponse {
  status: 'processing';
  reportStatus: ReportStatus;
}

/**
 * `POST reports/:id/confirm` `{version?, draftRev}`: `queued` (file_report enqueued for that
 * version, the current one when omitted, at that draft revision) or `filed` already. 409
 * `wrong_state` unless awaiting confirmation, 409 `draft_changed` when a newer draft replaced the
 * one confirmed (another version, or the same version re-extracted in place: another revision).
 */
export interface ConfirmResponse {
  status: 'queued' | 'filed';
}

/**
 * `POST reports/:id/answer` (W1-12): `processing` when the answer was applied (the draft updated,
 * the question answered, decide_next queued: poll `GET reports/:id` for the next question or the
 * draft); `already_answered` when this question was answered before with the same answer (a retry).
 * 409 `wrong_state` unless the report awaits an answer, 409 `question_closed` when the question is
 * not the open one, 400 `answer_not_accepted` when the option or the number does not answer it.
 */
export interface AnswerResponse {
  /**
   * `listening` (W2-09): a spoken answer was taken; the worker parses it (`parse_answer`), so the
   * app polls `GET reports/:id` (`question.voice`, then `lastVoiceAnswer`). No confirmation yet.
   */
  status: 'processing' | 'already_answered' | 'listening';
  reportStatus: ReportStatus;
  /**
   * F7's confirmation line, in numbers code read from the draft the answer made (W1-13); null
   * while a spoken answer is being listened to.
   */
  confirmation: AnswerConfirmation | null;
}

/**
 * F7 *Other…* (W2-09): a spoken answer is a short clip; the recorder stops it at 30 seconds, and
 * field-api refuses a longer one when it can measure it.
 */
export const ANSWER_CLIP_MAX_MS = 30_000;

/** §10.7: a parsed answer below this confidence is not applied; the question is asked once more. */
export const PARSE_ANSWER_MIN_CONFIDENCE = 0.7;

/** F7: a spoken answer that cannot be read this many times leaves the question for the office. */
export const VOICE_ANSWER_TRIES = 2;

/** F4's optional test recording (W2-13): the recorder stops it at 20 seconds. */
export const TEST_CLIP_MAX_MS = 20_000;
/** …and field-api signs at most this much for it (20 s of any browser's audio fits easily). */
export const TEST_CLIP_MAX_BYTES = 5 * 1024 * 1024;
/** The test recording and its words are deleted this long after it was made, read or not. */
export const TEST_CLIP_TTL_S = 10 * 60;

/**
 * `POST test-clip` (F4, W2-13): a signed upload for the test recording, under `test/` in the
 * `audio` bucket, outside any report. Needs the recording consent (it is what covers the clip).
 */
export interface TestClipResponse {
  testClipId: string;
  bucket: 'audio';
  path: string;
  signedUrl: string;
  token: string;
}

/**
 * `GET test-clip/:id` (F4, W2-13): `pending` until the worker transcribed it; then once, `heard`
 * with the words ("Heard you clearly: '…'") or `silent` ("I couldn't hear anything"), after which
 * the words are deleted (`gone` from then on); `failed` when it could not be transcribed.
 */
export interface TestClipView {
  status: 'pending' | 'heard' | 'silent' | 'failed' | 'gone';
  snippet: string | null;
}

/**
 * What an answer changed, for F7's confirmation line ("Delta Mechanical: 5 workers, 8 hours each
 * — 40 hours."): the app words it in the reporter's language (`field.confirmation.*`). The numbers
 * are the draft's after `applyAnswer` (totals computed in code; `answerConfirmation()`), null
 * where the draft still has none.
 */
export type AnswerConfirmation =
  | {
      kind: 'crew';
      company: string;
      workers: number | null;
      hoursPerWorker: number | null;
      totalHours: number | null;
    }
  | { kind: 'company_added'; company: string }
  | { kind: 'company_mapped'; company: string }
  | { kind: 'weather'; lostHours: number }
  /** Safety, a photo, anything without a number to repeat: "Got it." */
  | { kind: 'noted' };

/**
 * `POST day-status` (F12; W2-08, spec §19 Q41): the site-day's new status and, for a weather day
 * (always) or a no-work day (when the org keeps a no-work PDF, `no_work_pdf`), the report it made,
 * which the worker files (`file_report`, trigger `weather_day` / `no_work`); null otherwise.
 */
export interface DayStatusResponse {
  siteDayId: string;
  status: SiteDayStatus;
  changed: boolean;
  report: { id: string; reportNo: string } | null;
}

/** `GET history` (F10 Past reports). */
export interface HistoryResponse {
  reports: {
    id: string;
    reportNo: string;
    status: ReportStatus;
    siteId: string;
    siteName: string;
    date: string;
    filedAt: string | null;
    currentVersion: number;
    /** `reports.is_late` (filed after its deadline, or a late clip): the list's Late badge. */
    isLate: boolean;
  }[];
}

/**
 * Why `POST expired/daily-link` sent nothing (F16; W2-03): the site is paused (`site_paused`, the
 * wording of the SMS key of that name), no longer active or no longer the reporter's
 * (`site_inactive`), today is not one of the org's working days (`not_working_day`), or the
 * Notifier skipped the message (`no_consent`, `opted_out`, `no_channel`).
 */
export const EXPIRED_LINK_NOT_SENT = [
  'site_paused',
  'site_inactive',
  'not_working_day',
  'no_consent',
  'opted_out',
  'no_channel',
] as const;
export type ExpiredLinkNotSent = (typeof EXPIRED_LINK_NOT_SENT)[number];

/**
 * `POST expired/daily-link {code}` (F16 "Send me today's link"; W2-03): today's daily link of the
 * expired link's site, sent to the reporter's phone on file through the Notifier. Only for an
 * expired daily link: an unknown code is 404 `link_not_found`, a revoked one 410 `link_revoked`, a
 * live or personal one 409 `link_not_expired` (what `resolve` already tells), a disabled reporter
 * 403 `reporter_disabled`; 429 `rate_limited` after `FIELD_RATE_LIMITS.expiredLink`. The answer
 * never holds the new link.
 */
export type ExpiredLinkResponse =
  { sent: true; channel: MessageChannel } | { sent: false; reason: ExpiredLinkNotSent };

/** One consent as Settings shows it (F15): given at least once; `held` while not revoked. */
export interface SettingsConsent {
  type: ConsentType;
  held: boolean;
}

/**
 * `GET preferences`, `PATCH preferences`, `POST consent/revoke`, `POST consent/grant` (F15,
 * Settings; W2-02, §19 Q86): what the Settings screen shows. `messageChannels` are the pack's
 * message channels that are built, in the pack's order (`settingsMessageChannels`): the choice is
 * shown only when there is more than one. `messageChannel` null = the pack's order (spec §19 Q21).
 */
export interface PreferencesResponse {
  contactPref: ContactPref;
  locale: ReporterLocale;
  messageChannel: MessageChannel | null;
  messageChannels: MessageChannel[];
  /**
   * Every consent type the reporter has given, in `CONSENT_TYPES` order; the texts consent (`sms`)
   * also when never given, while the pack sends texts, so Settings can offer *Turn on* (§19 Q86).
   */
  consents: SettingsConsent[];
  /**
   * The phone opted out of texts on the org's pack: SMS STOP or the provider's opt-out list
   * (`reporters.status 'opted_out'` or an `sms_opt_outs` row). No texts go, whatever the consent,
   * and *Turn on* is refused (`texts_opted_out`): on a two-way pack Settings says to text START.
   */
  textsOptedOut: boolean;
  /**
   * Web push to this phone (W2-14, spec §19 Q27): `offered` when the pack lists push and this
   * environment has a VAPID key pair (`GET push/key`); `on` when this device has a live
   * subscription and the `push` consent is held. The `push` consent is not in `consents`: the
   * *Notifications* toggle is its control.
   */
  push: { offered: boolean; on: boolean };
  /**
   * W3-17: SiteLog places automated calls for the reporter's org (`ResolveResponse.placesCalls`):
   * the `auto_call` row is listed (*Turn on* / *Turn off*) and, for a reporter who prefers calls,
   * "Don't call me today".
   */
  placesCalls: boolean;
  /**
   * §19 Q129 (W3-17): `reporters.no_calls_until`, "Don't call me today" said in Settings or on a
   * call; no automated calls until then (the end of that day, the org's time zone). null = none.
   */
  noCallsUntil: string | null;
}

/** `GET push/key` (W2-14): the VAPID public key the browser subscribes with; null = no push here. */
export interface PushKeyResponse {
  publicKey: string | null;
}

/**
 * The consents a revocation stops reporting with (F15 "Revoking recording consent → reporter can
 * no longer submit; office notified"): the required pair. Revoking one tells the office
 * (`reporter_consent_revoked`, ops and admin) and every route but `resolve`, `device/*`, `consent`
 * and Settings' own (`preferences`, `consent/revoke`, `device/sign-out`) answers 403
 * `consent_required` until the reporter consents again on the Welcome screen.
 */
export const OFFICE_NOTIFIED_REVOCATIONS = REQUIRED_CONSENTS;

/** `POST device/sign-out` (F15, Settings): this phone's device is revoked and its cookie cleared. */
export interface SignOutResponse {
  signedOut: true;
}
