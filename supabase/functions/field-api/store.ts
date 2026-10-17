import type {
  CallOutcome,
  CallRow,
  CallTransport,
  CompanyRow,
  ConsentRow,
  DailyLinkStore,
  ConsentType,
  CountryRow,
  DailyReportData,
  DraftCorrectionRow,
  FieldDeviceRow,
  FieldLinkRow,
  GlossaryTermRow,
  Json,
  OrgRow,
  OrgSettingsRow,
  QuestionRow,
  ReportRow,
  ReportStatus,
  ReportVersionRow,
  ReporterRow,
  SiteDayRow,
  SiteDayStatus,
  SiteRow,
  TestClipRow,
  TestClipView,
  UploadKind,
  UploadRow,
  VoiceTurnKind,
} from '@sitelog/shared';
import type { AuditEntry } from '../_shared/audit.ts';
import type { DayOffQuestion, StoredObject } from './logic.ts';

/**
 * Everything field-api reads and writes, behind one interface: `store_supabase.ts` implements it
 * with the service role (production), the Deno tests with an in-memory fake (`fake_store.ts`).
 * field-api is the only scope: every method takes the ids the route already checked against the
 * link's reporter and sites, and the RPCs check the scope again in SQL.
 */

/** The org fields field-api needs, with its country pack row and settings. */
export interface OrgContext {
  org: Pick<OrgRow, 'id' | 'name' | 'country' | 'locale' | 'timezone' | 'is_demo' | 'units'>;
  country: CountryRow;
  settings: Pick<
    OrgSettingsRow,
    | 'default_deadline'
    | 'working_days'
    | 'default_shift_hours'
    | 'max_questions_per_report'
    | 'required_fields'
  > | null;
}

export interface RateLimitResult {
  allowed: boolean;
  count: number;
  resetAt: string;
}

/** field_complete_upload() (20261014000006_field_api.sql). */
export interface CompleteUploadResult {
  reportId: string;
  reportNo: string;
  reportStatus: ReportStatus;
  created: boolean;
  alreadyComplete: boolean;
  jobId: number | null;
  /**
   * F9 (20261016000030): an upload of a batch added to a filed report, staged. `ready` once the
   * batch's last upload completed; `captionUploadId` when it holds a voice caption (then the
   * worker attaches it after the transcription, which this call enqueued).
   */
  batch?: { id: string; ready: boolean; captionUploadId: string | null };
  /** W2-09: a spoken answer's clip, staged on its question's report (no source, no job). */
  answerClip?: boolean;
  /** W2-10: a correction clip, staged on the draft it fixes (no source, no job). */
  correctionClip?: boolean;
}

/** field_request_correction() (20261016000100, W2-10): the fix handed to apply_correction. */
export interface RequestCorrectionResult {
  id: string;
  status: DraftCorrectionRow['status'];
  jobId: number | null;
  repeat?: boolean;
}

/**
 * field_apply_correction() / field_edit_draft() (W2-10): the fix written to the draft (the report
 * to processing, decide_next queued), or `stale` when the draft is not the one it was made from.
 */
export type DraftWriteResult =
  | { status: 'applied' | 'processing'; reportStatus: ReportStatus; jobId: number | null }
  | {
      status: 'stale';
      reportStatus: ReportStatus;
      currentVersion: number;
      draftRev: number | null;
    };

/**
 * field_save_filed_correction() (20261016000110, W2-11, F10): Save change of a filed report's
 * preview: version n+1 (or the version a first save made), or `stale` when the report has a newer
 * version than the preview was made from.
 */
export type FiledSaveResult =
  | { status: 'applied'; reportStatus: ReportStatus; version: number; repeat?: boolean }
  | {
      status: 'stale';
      reportStatus: ReportStatus;
      currentVersion: number;
      draftRev: number | null;
    };

/** field_attach_photos() (20261016000030, F9): the version the batch made (or made before). */
export interface AttachPhotosResult {
  version: number;
  alreadyAttached: boolean;
}

/** F9: a filed report's photos added after filing (uploads of a batch the report holds). */
export interface FiledPhotoState {
  /** Photos completed on the report after filing (staged or in a version): F9's limit. */
  added: number;
  /** Of those, the ones no version holds yet (their batch is incomplete or being captioned). */
  pending: number;
}

/** field_confirm_report(): the file_report job for the confirmed version, or filed already. */
export interface ConfirmResult {
  status: 'queued' | 'filed';
  jobId: number | null;
  version: number;
}

/** field_answer_question() (20261015000002, W1-12). */
export interface AnswerResult {
  status: 'processing' | 'already_answered';
  reportStatus: ReportStatus;
  jobId: number | null;
}

/** What `reports/:id/answer` hands field_answer_question(). */
export interface AnswerInput {
  reportId: string;
  questionId: string;
  reporterId: string;
  /** The draft the answer was applied to (the RPC refuses when it changed: `draft_changed`). */
  base: Json;
  /** The draft with the answer applied in code (applyAnswer). */
  data: Json;
  /** questions.answer: the request (option or number), its label and the value applied. */
  answer: Json;
  /** questions.answer_source: `{type:'answer', questionId}` (§10.3). */
  answerSource: Json;
  /** "Add <company>": the unconfirmed company the RPC creates and points the crew at. */
  newCompany: { name: string; manpowerIndex: number } | null;
}

/** field_answer_question_voice() (20261016000060, W2-09): the clip handed to parse_answer. */
export interface VoiceAnswerResult {
  status: 'listening';
  reportStatus: ReportStatus;
  jobId: number | null;
}

/** field_report_day_off() (W2-08; field_set_day_status() before it). */
export interface DayStatusResult {
  siteDayId: string;
  status: SiteDayStatus;
  changed: boolean;
  /** The weather-day or no-work report it made (and the worker files), or null. */
  report: { id: string; reportNo: string } | null;
}

/** voice_call_start() (20261016000300, W3-03): the call the room is, and whose. */
export interface VoiceCallStartResult {
  callId: string;
  /** Null for an unknown caller (F13). */
  reporterId: string | null;
  orgId: string | null;
  siteId: string | null;
  /**
   * `calls.purpose` (W4-05: `settings_test` is Settings' Call me now, a test call with no
   * reporter; 20261017000530). Absent from an older database's answer.
   */
  purpose?: string | null;
  /** The room's call had started already (the agent retried). */
  repeat: boolean;
}

/** A live tool turn as field-api waits on it (`voice_turns`, W3-09). */
export interface VoiceTurnState {
  status: 'pending' | 'done' | 'failed';
  /** The tool's answer once done. */
  result: Json | null;
  /** The error code a failed turn settled with (`report_closed`, `turn_failed`, …). */
  error: string | null;
}

/** voice_turn_submit() (20261016000330, W3-09). */
export interface VoiceTurnSubmitResult extends VoiceTurnState {
  turnId: string;
  reportId: string;
  /** The same words of the call were submitted before: this is that turn. */
  repeat: boolean;
}

/** voice_file_report() (W3-10). */
export type VoiceFileReportResult =
  | { status: 'filed' | 'not_confirmed'; reportNo: string }
  | { status: 'queued'; reportNo: string; jobId: number }
  | { status: 'draft_changed'; reportNo: string; draftRev: number | null; reportStatus: string };

/** voice_call_end(): `ended` false on a repeat; the post_call_reconcile job of a known caller. */
export interface VoiceCallEndResult {
  ended: boolean;
  jobId: number | null;
}

/**
 * The calls data behind field-api's `/voice/*` routes (W3-03): the service-only RPCs of
 * 20261016000300_voice_calls.sql and the reads the tools need. Never hands a phone number to a
 * route that could answer it: `callerReporters` takes the number from the call row.
 */
export interface VoiceStore {
  voiceCallStart(input: {
    room: string;
    transport: CallTransport;
    callId: string | null;
    from: string | null;
    to: string | null;
  }): Promise<VoiceCallStartResult>;
  getCall(id: string): Promise<CallRow | null>;
  /**
   * §19 Q44: the reporters a SIP call's number belongs to in the real orgs of a pack (not
   * disabled), active first, then invited, then opted out, newest first.
   */
  callerReporters(callId: string, country: string): Promise<ReporterRow[]>;
  voiceCallPickSite(
    callId: string,
    siteId: string,
    reporterId: string,
  ): Promise<{ siteId: string; changed: boolean }>;
  voiceCallFallback(callId: string, reason: string, at: number): Promise<{ marked: boolean }>;
  /**
   * W3-12 follow-up (§19 Q205): the recording notice was played to the end
   * (`voice_call_update(p_disclosure_played => true)`; once played, always played; audited
   * `call.updated` when it changed), with the recording notice version played (W4-06,
   * `calls.disclosure_version`, kept once set).
   */
  voiceCallDisclosure(callId: string, version: string | null): Promise<{ changed: boolean }>;
  voiceCallRecording(callId: string, path: string): Promise<void>;
  voiceCallEnd(input: {
    callId: string;
    outcome: CallOutcome;
    dialogLog: Json;
    metrics: Json;
  }): Promise<VoiceCallEndResult>;
  /**
   * `voice_tool_requests` (W3-03): claims a named request of a call. `claimed` false gives the
   * first request's tool and kept answer (`status` null while it still runs).
   */
  claimToolRequest(
    callId: string,
    key: string,
    tool: string,
  ): Promise<
    | { claimed: true }
    | { claimed: false; tool: string; status: number | null; response: Json | null }
  >;
  /**
   * A named request's claim as it stands (W3-09, §19 Q151: a retry of a live tool waits for the
   * first copy's answer); null when no request holds the key.
   */
  getToolRequest(
    callId: string,
    key: string,
  ): Promise<{ tool: string; status: number | null; response: Json | null } | null>;
  /** Keeps the claimed request's 2xx answer for its retries. */
  finishToolRequest(callId: string, key: string, status: number, response: Json): Promise<void>;
  /**
   * voice_turn_submit() (20261016000330, W3-09): a live tool turn of the call (the report, its
   * call source and live transcript, the priority `voice_turn` job); the same words are the same
   * turn (`repeat`, with its status and answer).
   */
  voiceTurnSubmit(
    callId: string,
    kind: VoiceTurnKind,
    key: string,
    input: Json,
  ): Promise<VoiceTurnSubmitResult>;
  /** A turn's status and answer, while field-api waits for the worker (W3-09). */
  getVoiceTurn(id: string): Promise<VoiceTurnState | null>;
  /**
   * voice_file_report() (20261016000350, W3-10, §19 Q119): `confirmed` is code's verdict on the
   * reporter's words (`isCallConfirm`); the filing of the read-back's revision, queued once.
   */
  voiceFileReport(input: {
    callId: string;
    reportId: string;
    draftRev: number;
    utterance: string;
    confirmed: boolean;
  }): Promise<VoiceFileReportResult>;
  /** Frees a claimed key whose request failed, so a retry runs it again. */
  releaseToolRequest(callId: string, key: string): Promise<void>;
  /** The orgs' companies (names and aliases), for the agent and its speech hints. */
  listCompanies(orgIds: string[]): Promise<Pick<CompanyRow, 'org_id' | 'name' | 'aliases'>[]>;
  /**
   * Glossary terms for speech hints: SiteLog's, the orgs', those scoped to one of the sites, and
   * (spec §19 Q143) those scoped to one of the reporters.
   */
  listGlossary(
    orgIds: string[],
    siteIds: string[],
    reporterIds: string[],
  ): Promise<
    Pick<GlossaryTermRow, 'heard' | 'official' | 'language' | 'kind' | 'status' | 'times_heard'>[]
  >;
}

/** An RPC refused the call; `code` is the exception message the SQL raises (a field-api error). */
export class FieldDbError extends Error {
  constructor(readonly code: string) {
    super(code);
    this.name = 'FieldDbError';
  }
}

/** The RPC refusals field-api maps to an answer (any other database error is a 500). */
export const FIELD_DB_ERRORS = [
  'upload_not_found',
  'upload_path_mismatch',
  'site_not_found',
  'report_not_found',
  'report_filed',
  'report_filing',
  'draft_changed',
  'report_in_progress',
  'day_closed',
  'wrong_state',
  'invalid_status',
  'question_not_found',
  'question_closed',
  'photos_window_closed',
  'photo_limit',
  'invalid_batch',
  'batch_not_found',
  'batch_incomplete',
  'answer_pending',
  'correction_pending',
  'correction_not_ready',
  'correction_not_found',
  'report_locked',
  'invalid_request',
  'invalid_edit',
  'test_clip_not_found',
  'consent_required',
  'consent_not_offered',
  'texts_opted_out',
  'channel_not_offered',
  // W3-03 (20261016000300_voice_calls.sql)
  'call_not_found',
  'call_conflict',
  'call_ended',
  'voice_number_unknown',
  'reporter_disabled',
  // W3-09 (20261016000330_voice_turns.sql)
  'unknown_caller',
  'site_required',
  'report_closed',
  // W3-10 (20261016000350_voice_filing.sql)
  'draft_required',
  'out_of_scope',
] as const;

export interface ReportMediaCounts {
  voiceNotes: number;
  transcribed: number;
  photos: number;
}

export type ReportWithDate = ReportRow & { date: string };

export interface FieldStore extends DailyLinkStore, VoiceStore {
  // Links, reporters, orgs (and, from DailyLinkStore, today's daily link for F16's
  // "Send me today's link": `listDailyLinks`, `insertDailyLink`)
  findLink(codeHash: string): Promise<FieldLinkRow | null>;
  /** Sets last_opened_at; true when the link had never been opened. */
  markLinkOpened(linkId: string, at: string): Promise<boolean>;
  getReporter(id: string): Promise<ReporterRow | null>;
  updateReporter(
    id: string,
    patch: Partial<
      Pick<ReporterRow, 'status' | 'activated_at' | 'contact_pref' | 'locale' | 'message_channel'>
    >,
  ): Promise<ReporterRow>;
  getOrgContext(orgId: string): Promise<OrgContext | null>;
  /** The sites the reporter is linked to (site_reporters), in the reporter's org. */
  listReporterSites(reporterId: string): Promise<SiteRow[]>;

  // Devices
  findDevice(tokenHash: string): Promise<FieldDeviceRow | null>;
  insertDevice(row: {
    reporter_id: string;
    device_token_hash: string;
    user_agent: string | null;
  }): Promise<FieldDeviceRow>;
  updateDevice(
    id: string,
    patch: Partial<
      Pick<
        FieldDeviceRow,
        | 'verified_at'
        | 'last_seen_at'
        | 'user_agent'
        | 'code_hash'
        | 'code_expires_at'
        | 'revoked_at'
      >
    >,
  ): Promise<void>;
  rateLimit(key: string, limit: number, windowSeconds: number): Promise<RateLimitResult>;
  /**
   * field_claim_send() (20261016000090, W2-03): the one sender of a Notifier key at a time; false
   * while another request holds it (a claim older than `ttlSeconds` is taken over).
   */
  claimSend(key: string, ttlSeconds: number): Promise<boolean>;
  /** field_release_send(): lets the key go once the Notifier answered. */
  releaseSend(key: string): Promise<void>;
  /**
   * field_device_verify_locked() (20261016000020, F16): the device check's lock audited
   * `device.verify_locked` with the office notice (`device_verify_locked`), once per window
   * (`until`); `locked` false on a repeat.
   */
  deviceVerifyLocked(
    reporterId: string,
    deviceId: string,
    until: string,
  ): Promise<{ locked: boolean }>;

  // Consents
  listConsents(reporterId: string): Promise<ConsentRow[]>;
  insertConsents(
    rows: {
      reporter_id: string;
      type: ConsentType;
      method: string;
      text_version: string;
      evidence: Json;
    }[],
  ): Promise<ConsentRow[]>;

  /**
   * field_revoke_consent() (20261016000010, F15 Settings): `revoked_at` on the reporter's
   * unrevoked consents of the type, audited `consent.revoked`; a required consent also tells the
   * office (`reporter_consent_revoked`). `revoked` false when none was held.
   */
  revokeConsent(
    reporterId: string,
    type: ConsentType,
    deviceId: string,
  ): Promise<{ revoked: boolean; notified: boolean }>;
  /**
   * field_grant_consent() (20261016000080, Settings' *Turn on* for texts, spec §19 Q86): a fresh
   * `sms` consent with the wording's version and the evidence, audited `consent.given` (`via
   * settings`); `granted` false when one is held. Refuses an opted-out phone (`texts_opted_out`).
   */
  grantConsent(
    reporterId: string,
    type: 'sms' | 'whatsapp' | 'auto_call',
    textVersion: string,
    deviceId: string,
    evidence: Json,
  ): Promise<{ granted: boolean }>;
  /**
   * field_no_calls_today() (W3-17, spec §19 Q129): Settings' "Don't call me today", the end of
   * today in the org's time zone (`now` the caller's clock), audited `reporter.preferences_changed`.
   */
  noCallsToday(
    reporterId: string,
    deviceId: string,
    now: Date,
  ): Promise<{ until: string; changed: boolean }>;
  /**
   * field_push_subscribe() (20261016000180, W2-14): stores the browser subscription of this device
   * and, when not held, the `push` consent (`web_checkbox`), audited `push.subscribed` and
   * `consent.given`. Refuses a pack without push (`channel_not_offered`).
   */
  pushSubscribe(input: {
    reporterId: string;
    deviceId: string;
    endpoint: string;
    p256dh: string;
    auth: string;
    userAgent: string | null;
    textVersion: string;
    evidence: Json;
  }): Promise<{ subscription_id: string }>;
  /**
   * field_push_unsubscribe(): revokes this device's live subscriptions (`unsubscribed` from the
   * toggle, `signed_out` from *Sign out this phone*), audited; `unsubscribed` also revokes the
   * `push` consent once no live subscription is left (spec §19 Q40, Q108).
   */
  pushUnsubscribe(
    reporterId: string,
    deviceId: string,
    reason: 'unsubscribed' | 'signed_out',
  ): Promise<{ revoked: number; consent_revoked: boolean }>;
  /** Whether this device has a live push subscription of the reporter. */
  devicePushSubscribed(reporterId: string, deviceId: string): Promise<boolean>;
  /** `sms_opt_outs`: the phone sent STOP on this pack's sender, or its provider refused it. */
  phoneOptedOut(phone: string, country: string): Promise<boolean>;

  // Days and reports
  getSiteDay(siteId: string, date: string): Promise<SiteDayRow | null>;
  getSiteDayById(id: string): Promise<SiteDayRow | null>;
  /** The site-day's report that is not void (one at most: reports_one_live_per_site_day). */
  getLiveReport(siteDayId: string): Promise<ReportRow | null>;
  getReport(id: string): Promise<ReportRow | null>;
  getVersion(reportId: string, version: number): Promise<ReportVersionRow | null>;
  /** The open question (not answered), latest first. */
  getOpenQuestion(reportId: string): Promise<QuestionRow | null>;
  getQuestion(id: string): Promise<QuestionRow | null>;
  /** The report's answered questions, the latest answer first (W2-09: the last spoken one). */
  listAnsweredQuestions(reportId: string): Promise<QuestionRow[]>;
  countReportMedia(reportId: string): Promise<ReportMediaCounts>;
  /** Reports (not void) of these sites from `sinceDate` on, with their date. */
  listRecentReports(siteIds: string[], sinceDate: string): Promise<ReportWithDate[]>;

  // Uploads and storage
  insertUpload(row: {
    id: string;
    reporter_id: string;
    site_id: string;
    kind: UploadKind;
    storage_path: string;
    mime: string;
    bytes: number;
    recorded_at: string | null;
    /** F9: the batch of photos added to a filed report (both set, or neither). */
    batch_id?: string | null;
    batch_size?: number | null;
    /** W2-09: the web question a spoken answer's clip answers. */
    question_id?: string | null;
    /** W2-10: the draft a correction clip fixes. */
    correction_report_id?: string | null;
  }): Promise<UploadRow>;
  getUpload(id: string): Promise<UploadRow | null>;
  createSignedUploadUrl(
    bucket: string,
    path: string,
  ): Promise<{ signedUrl: string; token: string }>;
  /** The stored object's size and content type (Storage's metadata), or null when there is none. */
  objectInfo(bucket: string, path: string): Promise<StoredObject | null>;
  removeObject(bucket: string, path: string): Promise<void>;
  createSignedUrl(bucket: string, path: string, seconds: number): Promise<string | null>;

  // RPCs (20261014000006_field_api.sql); refusals throw FieldDbError
  completeUpload(
    uploadId: string,
    reporterId: string,
    bytes: number | null,
  ): Promise<CompleteUploadResult>;
  /**
   * field_flag_late_upload() (spec §19 Q53): a completed upload that arrived after its day's
   * window: the report and the site-day marked late, audited `upload.accepted_late`, one office
   * notice per report. Once per upload (`flagged` false on a repeat).
   */
  flagLateUpload(uploadId: string, reporterId: string): Promise<{ flagged: boolean }>;
  /**
   * field_attach_photos() (20261016000030, F9): a complete batch as a new version of the filed
   * report with `changeNote` (and the caption), render_pdf and the "Updated" email; audited in SQL.
   */
  attachPhotos(
    reportId: string,
    batchId: string,
    changeNote: string,
    caption: string | null,
  ): Promise<AttachPhotosResult>;
  /**
   * F9: the photos added to the report after filing (`FiledPhotoState`); with `exceptBatch`, the
   * completed photos of that batch are left out (a batch's own photos are not counted twice).
   */
  filedPhotoState(reportId: string, exceptBatch?: string): Promise<FiledPhotoState>;
  /**
   * field_report_day_off() (W2-08, spec §19 Q41): the site-day's status and, for a weather day (or
   * a no-work day with `no_work_pdf`), the report with its answered questions, version 1 and its
   * file_report job, in one transaction under the site-day lock.
   */
  setDayStatus(input: {
    reporterId: string;
    siteId: string;
    date: string;
    status: 'no_work' | 'weather_day';
    details: Json;
    questions: DayOffQuestion[];
    data: DailyReportData;
  }): Promise<DayStatusResult>;
  /**
   * field_confirm_report(): reports/:id/confirm (F8) for that version at that draft revision
   * (20261015000070), audited in SQL.
   */
  confirmReport(
    reportId: string,
    reporterId: string,
    version: number,
    draftRev: number,
  ): Promise<ConfirmResult>;
  /** field_answer_question(): reports/:id/answer (F7), audited in SQL; enqueues decide_next. */
  answerQuestion(input: AnswerInput): Promise<AnswerResult>;
  /**
   * field_answer_question_voice() (W2-09, F7 Other…): a completed clip of the open question as
   * its spoken answer: the `listening` try and the parse_answer job, audited in SQL.
   */
  answerQuestionVoice(input: {
    reportId: string;
    questionId: string;
    reporterId: string;
    uploadId: string;
  }): Promise<VoiceAnswerResult>;
  /**
   * W2-10 (20261016000100, F8 *Fix by voice* and the steppers): field_request_correction() (a fix
   * of a draft awaiting confirmation, spoken or typed: apply_correction queued, audited),
   * field_apply_correction() (Save change at the preview's revision, else `stale`) and
   * field_edit_draft() (a stepper's line built in code on the draft the reporter saw, else
   * `stale`). The correction rows: one by id, and a report's latest.
   */
  requestCorrection(input: {
    reportId: string;
    reporterId: string;
    uploadId: string | null;
    text: string | null;
  }): Promise<RequestCorrectionResult>;
  getCorrection(id: string): Promise<DraftCorrectionRow | null>;
  /** The reporter's latest fix of the report (another reporter's fix is theirs to see). */
  latestCorrection(reportId: string, reporterId: string): Promise<DraftCorrectionRow | null>;
  /**
   * W2-11 (20261016000110, F10 *Change something*): field_request_filed_correction() (a change of
   * a filed report of the last 14 days, spoken or typed: apply_correction queued, audited;
   * `report_locked` older) and field_save_filed_correction() (Save change: version n+1 from the
   * preview, the signer told, render_pdf with the "Updated" email and `edit_applied` queued).
   */
  requestFiledCorrection(input: {
    reportId: string;
    reporterId: string;
    uploadId: string | null;
    text: string | null;
  }): Promise<RequestCorrectionResult>;
  saveFiledCorrection(input: {
    correctionId: string;
    reportId: string;
    reporterId: string;
    changeNote: string;
    /** `edit_applied`'s `{weekday}` and `{change}` in the reporter's language. */
    message: { weekday: string; change: string } | null;
  }): Promise<FiledSaveResult>;
  applyCorrection(
    correctionId: string,
    reportId: string,
    reporterId: string,
  ): Promise<DraftWriteResult>;
  editDraft(input: {
    reportId: string;
    reporterId: string;
    version: number;
    draftRev: number;
    base: Json;
    data: Json;
    changes: Json;
    source: Json;
  }): Promise<DraftWriteResult>;
  /**
   * F4's test recording (W2-13, 20261016000070): field_test_clip_create() (the row, audited
   * `test_clip.created`, the 10-minute delete_test_clip; refused without the recording consent),
   * field_test_clip_complete() (queues transcribe_test_clip) and field_test_clip_read() (the
   * snippet once, then deleted, audited `test_clip.deleted`).
   */
  createTestClip(input: {
    id: string;
    reporterId: string;
    deviceId: string;
    path: string;
    mime: string;
    bytes: number;
  }): Promise<void>;
  getTestClip(id: string): Promise<TestClipRow | null>;
  completeTestClip(
    id: string,
    reporterId: string,
    bytes: number | null,
  ): Promise<{ status: 'pending' | 'gone' }>;
  readTestClip(id: string, reporterId: string): Promise<TestClipView>;
  audit(entry: AuditEntry): Promise<void>;
}
