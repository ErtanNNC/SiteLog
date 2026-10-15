import type {
  ConsentRow,
  ConsentType,
  CountryRow,
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
  UploadKind,
  UploadRow,
} from '@sitelog/shared';
import type { AuditEntry } from '../_shared/audit.ts';
import type { StoredObject } from './logic.ts';

/**
 * Everything field-api reads and writes, behind one interface: `store_supabase.ts` implements it
 * with the service role (production), the Deno tests with an in-memory fake (`fake_store.ts`).
 * field-api is the only scope: every method takes the ids the route already checked against the
 * link's reporter and sites, and the RPCs check the scope again in SQL.
 */

/** The org fields field-api needs, with its country pack row and settings. */
export interface OrgContext {
  org: Pick<OrgRow, 'id' | 'name' | 'country' | 'locale' | 'timezone' | 'is_demo'>;
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

/** field_set_day_status(). */
export interface DayStatusResult {
  siteDayId: string;
  status: SiteDayStatus;
  changed: boolean;
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
] as const;

export interface ReportMediaCounts {
  voiceNotes: number;
  transcribed: number;
  photos: number;
}

export type ReportWithDate = ReportRow & { date: string };

export interface FieldStore {
  // Links, reporters, orgs
  findLink(codeHash: string): Promise<FieldLinkRow | null>;
  /** Sets last_opened_at; true when the link had never been opened. */
  markLinkOpened(linkId: string, at: string): Promise<boolean>;
  getReporter(id: string): Promise<ReporterRow | null>;
  updateReporter(
    id: string,
    patch: Partial<Pick<ReporterRow, 'status' | 'activated_at' | 'contact_pref' | 'locale'>>,
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
        'verified_at' | 'last_seen_at' | 'user_agent' | 'code_hash' | 'code_expires_at'
      >
    >,
  ): Promise<void>;
  rateLimit(key: string, limit: number, windowSeconds: number): Promise<RateLimitResult>;

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
  setDayStatus(input: {
    reporterId: string;
    siteId: string;
    date: string;
    status: 'no_work' | 'weather_day';
    details: Json;
  }): Promise<DayStatusResult>;
  /** field_confirm_report(): reports/:id/confirm (F8) for that version, audited in SQL. */
  confirmReport(reportId: string, reporterId: string, version: number): Promise<ConfirmResult>;
  /** field_answer_question(): reports/:id/answer (F7), audited in SQL; enqueues decide_next. */
  answerQuestion(input: AnswerInput): Promise<AnswerResult>;
  audit(entry: AuditEntry): Promise<void>;
}
