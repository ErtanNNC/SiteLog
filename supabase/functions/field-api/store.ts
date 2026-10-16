import type {
  ConsentRow,
  DailyLinkStore,
  ConsentType,
  CountryRow,
  DailyReportData,
  FieldDeviceRow,
  FieldLinkRow,
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
    'default_deadline' | 'working_days' | 'default_shift_hours'
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
}

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
  'test_clip_not_found',
  'consent_required',
] as const;

export interface ReportMediaCounts {
  voiceNotes: number;
  transcribed: number;
  photos: number;
}

export type ReportWithDate = ReportRow & { date: string };

export interface FieldStore extends DailyLinkStore {
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
