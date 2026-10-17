import postgres, { type Sql, type TransactionSql } from 'postgres';
import type {
  CallRow,
  CompanyRow,
  CorrectionChange,
  DailyReportData,
  Source,
  ConsentRow,
  PushSubscriptionRow,
  VoiceTurnRow,
  ConsoleEmailRow,
  ConversationRow,
  CountryRow,
  ConvoState,
  DraftCorrectionRow,
  EvidencePackRow,
  FieldChannel,
  GlossaryTermRow,
  InboundReporterRow,
  InboundScope,
  JobRow,
  JobType,
  MessageRow,
  MsgStatus,
  MsgType,
  OutboundMessageRow,
  PriorMessage,
  OrgRow,
  OrgSettingsRow,
  QuestionRow,
  ReportCostRow,
  ReportRow,
  NoticeData,
  PreciseCallSeconds,
  ReportSourceRow,
  ReportStatus,
  ReportVersionRow,
  ReporterRow,
  SiteDayRow,
  SiteRow,
  TestClipRow,
  SmsOptOutRow,
  TermKind,
  TermStatus,
  TranscriptRow,
  UnknownContactRow,
  UploadRow,
  WeatherEventRow,
} from '@sitelog/shared';

/**
 * Typed repository over the SiteLog schema (supabase/migrations). The worker uses the service
 * role connection string and the SQL functions of 20261011000005_rpcs.sql for every queue,
 * audit and denormalisation operation. Row types come from @sitelog/shared (`Tables<'…'>`).
 *
 * `Db` is an interface so the jobs and the router can be exercised with an in-memory fake.
 */

export type Json = Record<string, unknown> | unknown[] | string | number | boolean | null;

export interface ConversationPatch {
  org_id?: string | null;
  reporter_id?: string | null;
  state?: ConvoState;
  context?: Record<string, unknown>;
  last_outbound_at?: string | Date | null;
  last_inbound_at?: string | Date | null;
}

export interface OutboundMessageInput {
  conversation_id: string;
  type: MsgType;
  body: string | null;
  payload?: Json | null;
  wa_message_id?: string | null;
  template_name?: string | null;
  status: 'sent' | 'failed' | 'queued';
  error?: string | null;
  media_id?: string | null;
  media_mime?: string | null;
  storage_path?: string | null;
}

export interface MessagePatch {
  status?: MessageRow['status'];
  storage_path?: string | null;
  duration_s?: number | null;
  payload?: Json | null;
  error?: string | null;
  media_mime?: string | null;
  body?: string | null;
}

export interface TranscriptInput {
  message_id: string;
  language: string | null;
  text: string;
  segments: Array<{ start: number; end: number; text: string }>;
  model: string | null;
}

export interface SettleVoiceAnswerInput {
  questionId: string;
  uploadId: string;
  outcome: 'applied' | 'unclear';
  /** Kept on the try (`confidence`, `reason`); `reviewReasons` flag the report when applied. */
  detail: Record<string, unknown>;
  base?: Json;
  data?: Json;
  answer?: Json;
}

/** W2-10 (field_settle_correction(), 20261016000100): a correction's outcome. */
export interface SettleCorrectionResult {
  settled: boolean;
  status: DraftCorrectionRow['status'];
}

export interface SettleVoiceAnswerResult {
  settled: boolean;
  status: 'applied' | 'unclear' | 'stale' | 'listening';
  /** `unclear` and asked once more (the first unclear try). */
  retry?: boolean;
  jobId?: number | null;
}

/** A web recorder voice note's transcript, duration and peaks (W1-11, `saveUploadTranscript`). */
export interface UploadTranscriptInput {
  uploadId: string;
  language: string | null;
  text: string;
  segments: Array<{ start: number; end: number; text: string }>;
  model: string | null;
  /** Measured by ffmpeg, else the provider's; null leaves the column as it is. */
  durationS: number | null;
  /** About 600 normalised peaks for the players (§11.3); null leaves the column as it is. */
  peaks: number[] | null;
  /** Audit diff of `transcript.created` (provider, model, seconds; never the text). */
  audit: Record<string, unknown>;
}

/** A voice upload of a report and whether it has its transcript yet. */
export interface ReportVoiceUpload {
  id: string;
  received_at: string | null;
  transcribed: boolean;
}

export interface ReportInput {
  org_id: string;
  site_id: string;
  site_day_id: string;
  report_no: string;
  reporter_id: string | null;
  received_at: string | Date;
  kind: 'daily' | 'weather_day' | 'no_work';
  status?: ReportRow['status'];
  /**
   * §6.3 `reports.language`. Default: the org's report language (org_report_language(), from
   * `orgs.locale`, like `reportLanguageFor`). WhatsApp reports have no channel (D13).
   */
  language?: ReportRow['language'];
}

export interface ReportPatch {
  status?: ReportRow['status'];
  current_version?: number;
  confirmed_at?: string | Date | null;
  confirmed_via?: ReportRow['confirmed_via'];
  filed_at?: string | Date | null;
  signed_off_by?: string | null;
  signed_off_at?: string | Date | null;
  needs_review?: boolean;
  review_reasons?: string[];
  is_late?: boolean;
  received_at?: string | Date | null;
  reporter_id?: string | null;
}

export interface VersionInput {
  report_id: string;
  version: number;
  data: Json;
  summary: string | null;
  author: ReportVersionRow['author'];
  author_user_id?: string | null;
  author_message_id?: string | null;
  change_note?: string | null;
}

export interface FileVersionInput {
  reportId: string;
  siteDayId: string;
  version: number;
  /** What fileReport read: the filing is computed from this state. */
  expect: { status: ReportRow['status']; draftRev: number };
  data: Json;
  summary: string | null;
  report: ReportPatch;
  siteDay: SiteDayPatch;
  audit: AuditInput;
}

export type FileVersionOutcome =
  | { filed: true; report: ReportRow }
  /** The report or its draft changed since it was read: nothing written. */
  | { filed: false };

export interface SiteDayPatch {
  status?: SiteDayRow['status'];
  reminder_stage?: number;
  reminders_paused?: boolean;
  is_late?: boolean;
  weather?: Json | null;
  report_id?: string | null;
  deadline_at?: string | Date;
}

export interface QuestionInput {
  report_id: string;
  field: string;
  target: Json | null;
  prompt: string;
  options: Json | null;
  asked_message_id?: string | null;
  asked_at?: string | Date | null;
  /** 'web' for the web recorder's questions (W1-12, D13); null for the WhatsApp worker's. */
  channel?: FieldChannel | null;
  /** W3-09: the call that asked it (channel 'voice'). */
  call_id?: string | null;
}

export interface QuestionPatch {
  /** W3-09: the tries of an answer said on a call (`[{via: 'call', status, at, start}]`). */
  voice_answers?: Json;
  options?: Json | null;
  asked_message_id?: string | null;
  asked_at?: string | Date | null;
  answered_message_id?: string | null;
  answer?: Json | null;
  answered_at?: string | Date | null;
  answer_source?: Json | null;
}

export interface GlossaryUpsert {
  org_id: string;
  scope_site_id?: string | null;
  scope_reporter_id?: string | null;
  heard: string;
  official: string | null;
  kind: TermKind;
  status: TermStatus;
  language?: string;
  company_id?: string | null;
}

export interface AuditInput {
  org_id: string | null;
  actor_type: 'user' | 'reporter' | 'agent' | 'system';
  actor_id?: string | null;
  action: string;
  entity?: string | null;
  entity_id?: string | null;
  diff?: Json | null;
}

/** A row of `sms_opt_outs` (the time defaults to now). */
export type SmsOptOutInput = Pick<SmsOptOutRow, 'phone_e164' | 'country' | 'method'>;

/** One reporter change of an inbound keyword (§9.5), with its audit row and office notice. */
export interface InboundChangeInput {
  reporterId: string;
  patch: Partial<Pick<ReporterRow, 'status' | 'opted_out_at' | 'contact_pref'>>;
  audit: AuditInput;
  notification: {
    orgId: string;
    kind: string;
    title: string;
    body: string;
    targetPath: string;
    data?: NoticeData | null;
  } | null;
}

export interface EnqueueOptions {
  runAfter?: Date | string | null;
  /**
   * Run no sooner than this long after the database's `now()` (W2-07, the §7.2 clock): delays are
   * measured on the clock `claim_jobs()` reads, so a worker on a test clock
   * (WORKER_CLOCK_OVERRIDE) still waits the real 30 s, 30 min or 2 h. Ignored with `runAfter`.
   */
  delayMs?: number;
  /**
   * A key names one job for good (GAP D16, 20261015000001): enqueueing a taken key returns that
   * job's id whatever its status (done and dead included) and runs nothing. Use a per-occurrence
   * key (`jobKeys`) for work that must run again.
   */
  dedupeKey?: string | null;
}

export interface JobMetrics {
  tokens?: { input?: number; output?: number; cacheRead?: number; cacheWrite?: number };
  audioSeconds?: number;
  latencyMs?: number;
  estCostUsd?: number;
  [k: string]: unknown;
}

export interface QueueStats {
  queued: number;
  running: number;
  dead: number;
}

export interface SiteContext {
  site: SiteRow;
  org: OrgRow;
  settings: OrgSettingsRow;
  companies: CompanyRow[];
  glossary: GlossaryTermRow[];
  recipients: string[];
  reporters: ReporterRow[];
}

/**
 * A report source with its file (listReportSources): from its upload when there is one (office
 * photos since 20261014000002, and media the migration backfilled with the message id), else from
 * its WhatsApp message (report/media.ts).
 */
export interface ReportSourceWithMessage extends ReportSourceRow {
  /** The source's media id: upload_id, else message_id (one UUID for backfilled media). */
  media_id: string | null;
  /** The message type, or `audio` / `image` for an upload without a message; null for neither. */
  message_type: MsgType | null;
  storage_path: string | null;
  duration_s: number | null;
  /** When the file or message arrived (message, else upload, else the source row). */
  message_created_at: string;
  media_mime: string | null;
  /** The message body, else the upload's caption. */
  body: string | null;
}

/** A stored file past retention: an upload, or a message media without one. */
export interface ExpiredMedia {
  /** Upload id, else message id (the same UUID for backfilled media). */
  id: string;
  storage_path: string;
  bucket: 'audio' | 'photos';
  created_at: string;
}

export interface InvoiceSummary {
  id: string;
  org_id: string;
  company_name: string;
  invoice_no: string | null;
  period_start: string | null;
  period_end: string | null;
  invoiced_hours: number;
  reported_hours: number;
  lines: Array<{ date: string; hours: number; site_id?: string }>;
}

/** What a report's cost estimate is made of (report_cost_inputs(), §15 cost guardrail). */
export interface ReportCostInputs {
  /** Sum of jobs.payload.metrics cost (AI: Claude + transcription) of the report's jobs. */
  aiUsd: number;
  jobCount: number;
  /** Outbound template messages (billable) tagged with the report or its site-day. */
  waTemplates: number;
  /** W2-15: the report's Notifier texts a provider took (`payload.report_id`). */
  smsMessages: number;
  /** W2-15: its business-initiated WhatsApp templates (`whatsapp_mode 'template'`). */
  whatsappTemplates: number;
}

/** Median cost of comparable filed reports before a given time (report_cost_baseline()). */
export interface ReportCostBaseline {
  medianCents: number | null;
  sample: number;
}

export interface DigestStats {
  siteDays: number;
  filed: number;
  onTime: number;
  weatherHoursBySite: Array<{ siteName: string; hours: number }>;
  unsigned: Array<{ reportNo: string; siteName: string; date: string }>;
  invoiceGaps: Array<{ companyName: string; gap: number }>;
}

/** W2-12: today at a site an SMS NO WORK / WEATHER may answer for (`smsKeywordDays`). */
export interface SmsKeywordDay {
  reporter_id: string;
  site_id: string;
  site_name: string;
  timezone: string;
  /** Today in the site's time zone (YYYY-MM-DD). */
  date: string;
  day_status: SiteDayRow['status'] | null;
  has_report: boolean;
}

/** W2-16: an open web question a WhatsApp text may answer (`openWebQuestions`). */
export interface OpenWebQuestion {
  report_id: string;
  question_id: string;
  reporter_id: string;
}

/** W2-12: a web draft an SMS OK answers with (`smsKeywordDrafts`). */
export interface SmsKeywordDraft {
  report_id: string;
  reporter_id: string;
  org_id: string;
  site_name: string;
}

/** W2-12: a live report of the day an SMS EDIT names (`smsEditReports`). */
export interface SmsEditReport {
  report_id: string;
  /** A reporter of the phone who covers the report's site (the primary first). */
  reporter_id: string;
  org_id: string;
  site_id: string;
  site_name: string;
  timezone: string;
  site_status: string;
  status: ReportRow['status'];
  date: string;
}

/** W3-11: what post_call_settle() did (see `Db.postCallSettle`). */
export interface PostCallSettle {
  action: 'continue' | 'voided' | 'kept' | 'none' | 'closed' | 'filing';
  outcome: CallRow['outcome'];
  reportId: string | null;
  status: string | null;
  handed?: number;
}

/** The §13 review notice a flag sends with it (`needs_review`; the English fallback and data). */
export interface ReviewNotice {
  title: string;
  body: string;
  data: NoticeData;
}

export interface Db {
  // conversations
  /** null for a message without a conversation (a photo uploaded in the panel). */
  getConversation(id: string | null): Promise<ConversationRow | null>;
  getConversationByPhone(phone: string): Promise<ConversationRow | null>;
  ensureConversation(phone: string, patch: ConversationPatch): Promise<ConversationRow>;
  updateConversation(id: string, patch: ConversationPatch): Promise<ConversationRow>;
  listConversationsByState(states: ConvoState[], changedBefore?: Date): Promise<ConversationRow[]>;

  // messages
  getMessage(id: string): Promise<MessageRow | null>;
  getMessageByWaId(waId: string): Promise<MessageRow | null>;
  insertOutboundMessage(input: OutboundMessageInput): Promise<MessageRow>;
  updateMessage(id: string, patch: MessagePatch): Promise<void>;
  listMessagesBetween(
    conversationId: string,
    from: Date,
    to: Date,
    types?: MsgType[],
  ): Promise<MessageRow[]>;

  // transcripts
  getTranscript(messageId: string): Promise<TranscriptRow | null>;
  /**
   * Transcripts of these voice notes, by media id (a transcript's upload_id, else its message_id),
   * in the order given.
   */
  listTranscripts(mediaIds: string[]): Promise<TranscriptRow[]>;
  /** Transcripts of these calls (`transcripts.call_id`, §6.3), in the order given (W3-07). */
  listCallTranscripts(callIds: string[]): Promise<TranscriptRow[]>;
  /** A call (W3-09: the call of a live turn). */
  getCall(id: string): Promise<CallRow | null>;
  /** W3-09: a live tool turn of a call (`voice_turns`). */
  getVoiceTurn(id: string): Promise<VoiceTurnRow | null>;
  /**
   * W3-09: settles a pending turn with its answer (`done`) or its failure (`failed`, the error
   * code field-api maps); false when the turn was not pending (settled before).
   */
  settleVoiceTurn(
    id: string,
    outcome: { status: 'done'; result: Json } | { status: 'failed'; error: string },
  ): Promise<boolean>;
  upsertTranscript(input: TranscriptInput): Promise<TranscriptRow>;
  /** The transcript of a web recorder upload (W1-11). */
  getUploadTranscript(uploadId: string): Promise<TranscriptRow | null>;
  /**
   * W1-11, in one transaction: the upload's transcript (`upload_id`, no message; kept when it
   * exists, so a retry never writes a second one), its duration and peaks, and a
   * `transcript.created` audit row for a new transcript only.
   */
  saveUploadTranscript(
    input: UploadTranscriptInput,
  ): Promise<{ transcript: TranscriptRow; created: boolean }>;

  // uploads (web recorder, W1-07)
  getUpload(id: string): Promise<UploadRow | null>;
  /**
   * The report's voice uploads whose file is kept (not purged), oldest first (received_at, id),
   * each with whether its transcript exists.
   */
  listReportVoiceUploads(reportId: string): Promise<ReportVoiceUpload[]>;
  /** F9 (W2-04): how many photos a batch added after filing holds. */
  countBatchPhotos(batchId: string): Promise<number>;
  /**
   * field_attach_photos() (20261016000030, F9): a whole batch as the filed report's next version
   * with `changeNote` and the caption; render_pdf and the "Updated" email; audited in SQL. A batch
   * attached before answers its version (`alreadyAttached`).
   */
  attachPhotos(
    reportId: string,
    batchId: string,
    changeNote: string,
    caption: string | null,
  ): Promise<{ version: number; alreadyAttached: boolean }>;

  // reporters, sites, orgs
  listReportersByPhone(phone: string): Promise<ReporterRow[]>;
  getReporter(id: string): Promise<ReporterRow | null>;
  updateReporter(
    id: string,
    patch: Partial<
      Pick<
        ReporterRow,
        | 'status'
        | 'verified_at'
        | 'activated_at'
        | 'invited_at'
        | 'last_invite_error'
        | 'opted_out_at'
        | 'contact_pref'
      >
    >,
  ): Promise<void>;
  /**
   * The reporter row follows an opt-out the provider reported (Twilio 21610): `opted_out` with
   * `opted_out_at`, except a disabled reporter, who keeps `disabled` and gets `opted_out_at`. An
   * `opted_out_at` already set is kept.
   */
  optOutReporter(reporterId: string, at: string): Promise<void>;
  /**
   * Reporters with this phone in orgs of the pack (`orgs.country`), every status, with their org:
   * real orgs only (`realOnly`, the Twilio route) or one org (the Demo phone).
   */
  listInboundReporters(
    phone: string,
    country: string,
    scope: InboundScope,
  ): Promise<InboundReporterRow[]>;
  listSitesForReporter(reporterId: string): Promise<SiteRow[]>;
  listReportersForSite(siteId: string): Promise<ReporterRow[]>;
  getSite(id: string): Promise<SiteRow | null>;
  listSitesByOrg(orgId: string): Promise<SiteRow[]>;
  listActiveSites(): Promise<
    Array<Pick<SiteRow, 'id' | 'org_id' | 'name' | 'project_code' | 'address'>>
  >;
  getOrg(id: string): Promise<OrgRow | null>;
  listOrgs(): Promise<OrgRow[]>;
  getOrgSettings(orgId: string): Promise<OrgSettingsRow | null>;
  listCompanies(orgId: string): Promise<CompanyRow[]>;
  getCompany(id: string): Promise<CompanyRow | null>;
  insertCompany(
    orgId: string,
    name: string,
    status: CompanyRow['status'],
    trade?: string | null,
  ): Promise<CompanyRow>;
  listGlossary(
    orgId: string,
    siteId?: string | null,
    reporterId?: string | null,
  ): Promise<GlossaryTermRow[]>;
  /**
   * A learned term: the org's row with the same heard phrase (any case), kind and site scope is
   * heard once more, else a new row. `inserted` says which (W3-08: only a new term notifies).
   */
  upsertGlossaryTerm(input: GlossaryUpsert): Promise<{ row: GlossaryTermRow; inserted: boolean }>;
  listSiteRecipients(siteId: string): Promise<string[]>;
  listMemberEmails(
    orgId: string,
    roles: string[],
  ): Promise<Array<{ email: string; user_id: string; display_name: string | null }>>;
  getUserContact(
    userId: string,
  ): Promise<{ email: string | null; display_name: string | null } | null>;
  siteContext(siteId: string): Promise<SiteContext | null>;

  // site days
  getSiteDay(id: string): Promise<SiteDayRow | null>;
  findSiteDay(siteId: string, date: string): Promise<SiteDayRow | null>;
  getOrCreateSiteDay(siteId: string, date: string, deadlineAt: Date): Promise<SiteDayRow>;
  updateSiteDay(id: string, patch: SiteDayPatch): Promise<SiteDayRow>;

  // reports
  getReport(id: string): Promise<ReportRow | null>;
  insertReport(input: ReportInput): Promise<ReportRow>;
  updateReport(id: string, patch: ReportPatch): Promise<ReportRow>;
  findOpenReportForSiteDay(siteDayId: string): Promise<ReportRow | null>;
  findReportsByDate(siteIds: string[], date: string): Promise<ReportRow[]>;
  findReportForSiteDay(siteDayId: string): Promise<ReportRow | null>;
  listReportsForSitePeriod(siteId: string, start: string, end: string): Promise<ReportRow[]>;
  nextReportNo(siteId: string): Promise<string>;
  getVersion(reportId: string, version: number): Promise<ReportVersionRow | null>;
  listVersions(reportId: string): Promise<ReportVersionRow[]>;
  insertVersion(input: VersionInput): Promise<ReportVersionRow>;
  /**
   * A draft write (storeWebDraft): under the report's row lock, so a filing in progress commits
   * first. Null (nothing written) unless the report is still a draft (collecting, processing,
   * awaiting_answer, awaiting_confirmation) at `input.version`.
   */
  storeDraftVersion(input: VersionInput): Promise<ReportVersionRow | null>;
  /**
   * fileReport's commit, in one transaction under the site-day and report row locks (the order
   * field_confirm_report() and field_answer_question() take them): the report must still be at
   * `expect` (status, version) and the version at `expect.draftRev`, the revision the frozen data
   * was computed from, else nothing is written. Then the report patch (status filed first, so the
   * version write is no new draft revision, 20261015000090), the version's data, its denormalised
   * rows, the site-day and the audit row.
   */
  fileVersion(input: FileVersionInput): Promise<FileVersionOutcome>;
  updateVersion(
    reportId: string,
    version: number,
    patch: {
      data?: Json;
      summary?: string | null;
      pdf_path?: string | null;
      change_note?: string | null;
    },
  ): Promise<void>;
  denormalizeVersion(reportId: string, version: number): Promise<void>;
  insertReportSource(input: {
    report_id: string;
    message_id: string;
    kind: ReportSourceRow['kind'];
    caption?: string | null;
    taken_at?: string | Date | null;
  }): Promise<void>;
  listReportSources(reportId: string): Promise<ReportSourceWithMessage[]>;

  // questions
  insertQuestion(input: QuestionInput): Promise<QuestionRow>;
  getQuestion(id: string): Promise<QuestionRow | null>;
  listQuestions(reportId: string): Promise<QuestionRow[]>;
  updateQuestion(id: string, patch: QuestionPatch): Promise<void>;
  /**
   * §7.2 (W2-07): records a still-open question as unanswered (`answer {unanswered, timeout}`) and
   * answers whether it was still open. One guarded update: field_answer_question() holds the
   * question's row lock, so an answer that commits first wins and this changes nothing.
   */
  timeOutQuestion(id: string, at: Date): Promise<boolean>;
  /**
   * W2-09 (field_settle_voice_answer(), 20261016000060): a spoken answer's outcome. `applied`
   * writes the draft built in code (refused `draft_changed` when the draft moved since `base`),
   * answers the question and enqueues decide_next; `unclear` marks the try and, at the second,
   * records the question unanswered (flagged) and enqueues decide_next. `settled` false for a try
   * settled before or a question answered meanwhile (`status` says which).
   */
  settleVoiceAnswer(input: SettleVoiceAnswerInput): Promise<SettleVoiceAnswerResult>;

  /** W2-10 (F8 *Fix by voice*): a correction of a web draft and its preview. */
  getCorrection(id: string): Promise<DraftCorrectionRow | null>;
  /** W2-12: the correction an SMS EDIT made (`draft_corrections.message_id`), if any. */
  getCorrectionByMessage(messageId: string): Promise<DraftCorrectionRow | null>;
  /**
   * W2-10 (field_settle_correction()): `ready` with the preview built in code (`detail`: data,
   * changes, operations, source, changeNote, baseVersion, baseRev; refused `draft_changed` when
   * the draft moved since), `unclear` (`reason`, `clarification`) or `stale`. `settled` false for
   * a correction settled before.
   */
  settleCorrection(
    id: string,
    outcome: 'ready' | 'unclear' | 'stale',
    detail: Record<string, unknown>,
  ): Promise<SettleCorrectionResult>;
  /** The fixes saved on a report's draft, oldest first (Q96: re-applied after a re-extraction). */
  listAppliedCorrections(
    reportId: string,
  ): Promise<Array<Pick<DraftCorrectionRow, 'id' | 'via' | 'changes' | 'source' | 'applied_at'>>>;
  /**
   * W3-10 (F8 on a call): a change said on the call, applied at once. In one transaction under
   * the site-day and report locks: the report still open and not being filed, its draft still at
   * `baseVersion` / `baseRev`, then the draft written (a new revision) and the fix recorded as
   * applied (`draft_corrections`, via `voice`, its words; re-applied after a later re-extraction,
   * Q96). False when the draft moved (nothing written).
   */
  applyCallCorrection(input: {
    reportId: string;
    reporterId: string;
    orgId: string;
    baseVersion: number;
    baseRev: number;
    data: DailyReportData;
    text: string;
    changes: CorrectionChange[];
    operations: unknown[];
    source: Source;
    changeNote: string | null;
  }): Promise<{ applied: boolean; correctionId: string | null; draftRev: number | null }>;

  // After a call (W3-11, 20261016000360_post_call.sql) ----------------------------------------
  /**
   * §19 Q122: a call that ended before the yes. With a report value in its draft (`hasValue`):
   * outcome `draft_saved`, the call's open question handed to the web (`continue`); else
   * `abandoned`, and a report the call alone made is voided with its site-day back to its status
   * before the call (`voided`), or left as it was when it has other sources (`kept`). `closed` /
   * `filing`: the report is filed or being filed; `none`: the call drafted nothing.
   */
  postCallSettle(callId: string, hasValue: boolean): Promise<PostCallSettle>;
  /**
   * The recording's two-lane peaks and duration and the reporter lane's batch transcript, which
   * replaces the live row (§19 Q162); each part only when given. Audited.
   */
  postCallRecording(input: {
    callId: string;
    peaks: { reporter: number[]; agent: number[] } | null;
    durationS: number | null;
    transcript: {
      language: string | null;
      text: string;
      segments: Array<{ start: number; end: number; speaker: 'reporter'; text: string }>;
      model: string;
    } | null;
  }): Promise<{ stored: boolean; replaced: string | null }>;
  /**
   * F6 failure handling: the fallback recording as a voice note of today's report of the call's
   * site (created or merged), `extract_report` queued (`extract:<report>:call:<call>`).
   */
  postCallFallbackReport(callId: string): Promise<{
    status: 'queued' | 'site_required' | 'report_closed';
    reportId?: string | null;
    jobId?: number;
    created?: boolean;
  }>;
  /**
   * §10.9: the reconcile's outcome on the filed report: precise seconds as `report_sources` rows,
   * the `call_mismatch` reasons with the §13 notice (only the reasons not already there), and
   * `calls.reconcile`. A second call for the same call changes nothing (`repeat`).
   */
  postCallReconciled(input: {
    callId: string;
    reportId: string;
    reasons: string[];
    precise: PreciseCallSeconds[];
    result: Json;
    notice: ReviewNotice;
  }): Promise<{ repeat: boolean; status: string; added: string[]; precise?: number }>;
  /** §19 Q123: a reconcile that cannot run: `call_unreconciled` on the filed report, once. */
  postCallUnreconciled(input: {
    callId: string;
    reason: string;
    notice: ReviewNotice;
  }): Promise<{ changed: boolean; status: string; added?: string[] }>;
  /** §10.5 step 2: `no_photo` on a report with a call source and no photo, once. */
  reportNoPhotoCheck(
    reportId: string,
    notice: ReviewNotice,
  ): Promise<{ flagged: boolean; reason: string }>;

  // SMS report keywords (W2-12)
  /**
   * Today at each active site the reporters cover (in the site's time zone): the site, its day's
   * status (null without a row yet) and whether the day has a live report (§19 Q79). NO WORK and
   * WEATHER answer with the day sheet's link of the days still open.
   */
  smsKeywordDays(reporterIds: string[]): Promise<SmsKeywordDay[]>;
  /** The reporters' web drafts awaiting confirmation, newest first (OK, spec §19 Q82). */
  smsKeywordDrafts(reporterIds: string[]): Promise<SmsKeywordDraft[]>;
  /** The live reports of `date` at the sites the reporters cover (EDIT), with who covers them. */
  smsEditReports(reporterIds: string[], date: string): Promise<SmsEditReport[]>;
  /** sms_request_filed_correction(): an SMS EDIT's change of a filed report (P0001 codes thrown). */
  requestSmsCorrection(input: {
    reportId: string;
    reporterId: string;
    text: string;
    messageId: string;
  }): Promise<{ id: string; status: string; jobId: number | null; repeat?: boolean }>;
  /** The reporter's live daily links of a site and day, newest first (`ensureDailyLink`). */
  listDailyLinks(
    reporterId: string,
    siteId: string,
    reportDate: string,
  ): Promise<Array<{ id: string; code_hash: string; expires_at: string | null }>>;
  /** false when the code hash is taken (unique); nothing written then. */
  insertDailyLink(row: {
    id: string;
    code_hash: string;
    reporter_id: string;
    site_id: string;
    report_date: string;
    expires_at: string;
  }): Promise<boolean>;
  /** W3-10 (F9): the reporter's photos links for a site and report date, not revoked, newest first. */
  listPhotosLinks(
    reporterId: string,
    siteId: string,
    reportDate: string,
  ): Promise<Array<{ id: string; code_hash: string; expires_at: string | null }>>;
  /** false when the code hash is taken (unique); nothing written then. */
  insertPhotosLink(row: {
    id: string;
    code_hash: string;
    reporter_id: string;
    site_id: string;
    report_date: string;
    expires_at: string;
  }): Promise<boolean>;

  // web pipeline (W1-12)
  /**
   * Sets a report's status only while it is one of `from` (a report filed, voided or reopened by
   * an upload meanwhile keeps its status); true when it changed.
   */
  setReportStatus(id: string, to: ReportStatus, from: readonly ReportStatus[]): Promise<boolean>;
  /** When a device of the reporter (not revoked) last called field-api (D25), else null. */
  reporterDeviceLastSeen(reporterId: string): Promise<string | null>;
  /** A queued or running job of this type for the report, other than `exceptJobId`. */
  hasActiveReportJob(type: JobType, reportId: string, exceptJobId?: number): Promise<boolean>;
  /**
   * The jobs of a re-armable timer (W2-07, `jobKeys.timerKeys`), by their dedupe keys (the base
   * key and its re-arms), oldest first.
   */
  listJobsByKeys(
    keys: readonly string[],
  ): Promise<Array<Pick<JobRow, 'id' | 'status' | 'dedupe_key'>>>;

  // unknown contacts (§6.3; the WhatsApp router writes them with no channel, D13)
  findPendingUnknownContact(phone: string): Promise<UnknownContactRow | null>;
  getUnknownContact(id: string): Promise<UnknownContactRow | null>;
  insertUnknownContact(input: {
    org_id: string | null;
    phone_e164: string;
    channel: UnknownContactRow['channel'];
    message_id: string | null;
    snippet: string | null;
    guessed_site_id?: string | null;
  }): Promise<UnknownContactRow>;
  updateUnknownContact(
    id: string,
    patch: { org_id?: string | null; snippet?: string | null; guessed_site_id?: string | null },
  ): Promise<void>;

  // messaging (W1-08: the Notifier's store, personal links, console emails)
  getCountry(code: string): Promise<CountryRow | null>;
  listCountries(): Promise<CountryRow[]>;
  listConsents(reporterId: string): Promise<Array<Pick<ConsentRow, 'type' | 'revoked_at'>>>;
  /**
   * W2-14: the reporter's live push subscriptions (not revoked, from a device that is not signed out
   * or revoked), oldest first.
   */
  listLivePushSubscriptions(
    reporterId: string,
  ): Promise<Array<Pick<PushSubscriptionRow, 'id' | 'endpoint' | 'p256dh' | 'auth'>>>;
  /** W2-14: the push service answered 404/410: revoked `gone`, audited (push_subscription_gone()). */
  pushSubscriptionGone(id: string, status: number): Promise<boolean>;
  /**
   * W2-15: when this phone last wrote to SiteLog on WhatsApp (the newest inbound `whatsapp`
   * message), the start of its 24-hour window; null when never.
   */
  /**
   * W2-15: when the phone last wrote to `sender` (the pack's WhatsApp sender) through Twilio: the
   * start of its 24-hour window there. Console (Demo phone) rows and other senders never count.
   */
  lastInboundWhatsapp(phone: string, sender: string): Promise<string | null>;
  insertSmsMessage(row: OutboundMessageRow): Promise<void>;
  updateSmsMessage(
    id: string,
    patch: {
      status: MsgStatus;
      provider_message_id?: string | null;
      error?: string | null;
      /** Replaces the whole payload (the Notifier passes its dedupe key back with the code). */
      payload?: Json | null;
    },
  ): Promise<void>;
  /**
   * The reporter's messages written under a Notifier dedupe key (`payload.dedupe_key`): every
   * attempt, on every channel (W2-01), with the provider's code of a refused send
   * (`payload.error_code`) and the attempt number (`payload.attempt`).
   */
  listMessagesByDedupeKey(reporterId: string, dedupeKey: string): Promise<PriorMessage[]>;
  /** `messages.payload.handled_at` of an inbound text (sms_inbound). */
  markSmsHandled(messageId: string, at: string): Promise<void>;
  /**
   * A pending `unknown_contacts` row of the phone on this channel exists, other than the one the
   * inbound text `excludeMessageId` created (its retry still sends the F13 auto-reply).
   */
  hasPendingUnknownContact(
    phone: string,
    channel: 'sms' | 'whatsapp',
    excludeMessageId?: string | null,
  ): Promise<boolean>;
  /**
   * The F13 `unknown_contacts` row of an inbound text (no org, channel 'sms', pending), once per
   * message: a retry of the same text gets the first row back with `created: false`.
   */
  insertSmsUnknownContact(row: {
    phone_e164: string;
    message_id: string;
    snippet: string;
    /** The guessed org (spec §19 Q44), else null. */
    org_id: string | null;
    /** W2-16: the message's channel (default 'sms'). */
    channel?: 'sms' | 'whatsapp';
  }): Promise<{ id: string; created: boolean }>;
  /**
   * W2-16: STOP (`grant` false) / START on WhatsApp: the reporter's `whatsapp` consent
   * (`inbound_whatsapp_consent()`, audited); true when it changed.
   */
  inboundWhatsappConsent(reporterId: string, grant: boolean, messageId: string): Promise<boolean>;
  /**
   * W2-16 (§19 Q26): the open web questions of these reporters' reports that await an answer,
   * newest first (`whatsapp_answer`).
   */
  openWebQuestions(reporterIds: string[]): Promise<OpenWebQuestion[]>;
  /** W2-16: a WhatsApp answer applied (`field_answer_question()` with channel 'whatsapp'). */
  answerQuestionByWhatsapp(input: {
    reportId: string;
    questionId: string;
    reporterId: string;
    messageId: string;
    base: Json;
    data: Json;
    answer: Json;
    newCompany: Json | null;
  }): Promise<{ status: string; reportStatus: string; jobId: number | null }>;
  /** Real (non-demo) orgs of the pack that linked an earlier contact of this phone (§19 Q44). */
  linkedContactOrgs(phone: string, country: string): Promise<string[]>;
  /**
   * One reporter change of an inbound keyword, its audit row and its office notice in one
   * transaction, so a failure leaves none of them and the job's retry writes all three.
   */
  applyInboundChange(input: InboundChangeInput): Promise<void>;
  /** `sms_opt_outs`: the phone sent STOP on the pack's sender, or its provider refused it. */
  isSmsOptedOut(phone: string, country: string): Promise<boolean>;
  /** Records the phone's opt-out on the pack; a row already there keeps its method and time. */
  recordSmsOptOut(row: SmsOptOutInput): Promise<void>;
  clearSmsOptOut(phone: string, country: string): Promise<void>;
  /** Live personal links of a reporter, newest first. */
  listPersonalLinks(reporterId: string): Promise<Array<{ id: string; code_hash: string }>>;
  /** false when the code hash is taken (unique); nothing written then. */
  insertPersonalLink(row: { id: string; code_hash: string; reporter_id: string }): Promise<boolean>;
  /** A row with a taken `dedupe_key` (a retried send_email) is not filed again: its id is returned. */
  insertConsoleEmail(
    row: Omit<ConsoleEmailRow, 'id' | 'created_at' | 'dedupe_key'> & { dedupe_key?: string | null },
  ): Promise<string>;

  // notifications & audit
  notifyOrg(
    orgId: string,
    kind: string,
    title: string,
    body?: string | null,
    targetPath?: string | null,
    userId?: string | null,
    /** What the panel renders in the reader's language (title and body: the English fallback). */
    data?: NoticeData | null,
  ): Promise<string>;
  logAudit(input: AuditInput): Promise<void>;

  // jobs
  claimJobs(worker: string, limit: number): Promise<JobRow[]>;
  completeJob(id: number): Promise<void>;
  failJob(id: number, error: string): Promise<void>;
  /**
   * The runner's heartbeat (W1-10): refreshes `locked_at` of a job this worker still holds
   * (`running`, `locked_by` = worker), so claim_jobs() does not take it back while its handler
   * runs, a timed-out one included. False when the job is no longer this worker's.
   */
  heartbeatJob(id: number, worker: string): Promise<boolean>;
  getJob(id: number): Promise<JobRow | null>;
  /** Whose an upload is (a dead `transcribe_upload` job's office notice, W1-10). */
  getUploadOwner(id: string): Promise<{
    id: string;
    report_id: string | null;
    reporter_id: string | null;
    site_id: string;
  } | null>;
  enqueueJob(type: JobType, payload: Json, opts?: EnqueueOptions): Promise<number>;
  updateJobMetrics(id: number, metrics: JobMetrics): Promise<void>;
  queueStats(): Promise<QueueStats>;

  // cost per report (§15 cost guardrail; src/cost.ts)
  reportCostInputs(reportId: string): Promise<ReportCostInputs>;
  reportCostBaseline(input: {
    kind: string;
    before: string;
    excludeReportId: string;
    days: number;
  }): Promise<ReportCostBaseline>;
  getReportCost(reportId: string): Promise<ReportCostRow | null>;
  upsertReportCost(input: Omit<ReportCostRow, 'computed_at'>): Promise<ReportCostRow>;

  // evidence packs, weather, retention, digest
  getEvidencePack(id: string): Promise<EvidencePackRow | null>;
  updateEvidencePack(
    id: string,
    patch: Partial<Pick<EvidencePackRow, 'status' | 'pdf_path' | 'error' | 'ready_at'>>,
  ): Promise<void>;
  listWeatherEvents(siteId: string, start: string, end: string): Promise<WeatherEventRow[]>;
  listExpiredMedia(before: Date, limit: number): Promise<ExpiredMedia[]>;
  /**
   * `photos` bucket paths of office uploads created before `before` that no upload or office
   * message stores (the report call never attached them): list_orphan_office_photos(), empty
   * without storage.
   */
  listOrphanOfficePhotos(before: Date, limit: number): Promise<string[]>;

  // F4's test recording (W2-13, 20261016000070)
  getTestClip(id: string): Promise<TestClipRow | null>;
  /**
   * What the worker heard (`snippet`, `heard`) or that it could not transcribe it (`failed`),
   * audited `test_clip.transcribed` / `test_clip.failed`; false when the clip was deleted or
   * settled meanwhile (nothing written).
   */
  saveTestClipResult(
    id: string,
    result: { heard: boolean; snippet: string | null; provider: string } | { failed: true },
  ): Promise<boolean>;
  /**
   * The file's row marked deleted with its words (`reason`: `expired` for the 10-minute job and
   * the retention backstop), audited `test_clip.deleted`; null when it was deleted already.
   */
  deleteTestClip(id: string, reason: string): Promise<TestClipRow | null>;
  /**
   * The retention backstop's test recordings, made before `before`: those not deleted yet, first,
   * then those deleted but made in the 2 days before `before`, whose file is removed once more
   * (a removal that failed after the clip was read leaves no file behind).
   */
  listExpiredTestClips(before: Date, limit: number): Promise<TestClipRow[]>;
  getInvoiceSummary(invoiceId: string): Promise<InvoiceSummary | null>;
  /**
   * Retention, after the file is deleted: the transcript goes; the upload keeps its row with
   * purged_at (its report sources keep their upload_id, so a purged photo stays listed) and the
   * message keeps its row with storage_path null and payload.purged_at. Readers treat either as a
   * missing file.
   */
  purgeMedia(id: string, purgedAt: Date): Promise<void>;
  /** Deletes `done` jobs finished before `before` (dead / failed ones stay for /ops). */
  purgeFinishedJobs(before: Date, limit: number): Promise<number>;
  /**
   * §19 Q124 (W3-14, purge_unknown_callers()): unknown callers' contacts made before `before`
   * that the office did not link are deleted, with their call's dialog log and recording path;
   * the recording paths (in the `calls` bucket) come back for the storage delete.
   */
  purgeUnknownCallers(before: Date, limit: number): Promise<{ recordingPath: string | null }[]>;
  digestStats(orgId: string, weekStart: string, weekEnd: string): Promise<DigestStats>;

  /** Close the connection pool (no-op for fakes). */
  close(): Promise<void>;
}

// ---------------------------------------------------------------------------------------------
// postgres (porsager) implementation
// ---------------------------------------------------------------------------------------------

const JSON_COLUMNS = new Set([
  'context',
  'payload',
  'segments',
  'target',
  'options',
  'answer',
  'answer_source',
  'data',
  'weather',
  'source',
  'diff',
  'lines',
  'observed',
  'audio_source',
  'voice_answers',
]);

/** Report statuses whose current version is a draft (overwritten in place until filing). */
const DRAFT_STATUSES: readonly ReportRow['status'][] = [
  'collecting',
  'processing',
  'awaiting_answer',
  'awaiting_confirmation',
];

export function connectSql(url: string, opts: { max?: number } = {}): Sql {
  return postgres(url, {
    max: opts.max ?? 8,
    idle_timeout: 30,
    connect_timeout: 15,
    prepare: false,
    onnotice: () => {},
    types: {
      numeric: {
        to: 1700,
        from: [1700],
        serialize: (x: number | string) => String(x),
        parse: (x: string) => Number(x),
      },
      bigint: {
        to: 20,
        from: [20],
        serialize: (x: number | string) => String(x),
        parse: (x: string) => Number(x),
      },
      date: { to: 1082, from: [1082], serialize: (x: string) => x, parse: (x: string) => x },
      timestamptz: {
        to: 1184,
        from: [1114, 1184],
        serialize: (x: Date | string) => (x instanceof Date ? x : new Date(x)).toISOString(),
        parse: (x: string) => {
          const d = new Date(x);
          return Number.isNaN(d.getTime()) ? x : d.toISOString();
        },
      },
    },
  });
}

function one<T>(rows: readonly T[]): T | null {
  return rows[0] ?? null;
}

/**
 * The unique indexes over jobs.dedupe_key an enqueue may still race on: the pre-W1-10 partial index
 * (20261011000003). The W1-10 constraint `jobs_dedupe_key_key` never raises from enqueue_job().
 */
export const LEGACY_DEDUPE_INDEXES = ['jobs_dedupe_key_active'] as const;

/** A Postgres unique_violation (23505) on the given constraint, as postgres.js reports it. */
export function isUniqueViolation(err: unknown, constraint: string): boolean {
  const e = err as { code?: string; constraint_name?: string } | null;
  return !!e && e.code === '23505' && e.constraint_name === constraint;
}

function iso(v: string | Date | null | undefined): string | null {
  if (v === null || v === undefined) return null;
  return v instanceof Date ? v.toISOString() : v;
}

/**
 * A Postgres array literal (`{"a","b"}`) for a bind parameter, cast in the query
 * (`${pgArray(ids)}::uuid[]`). postgres.js's sql.array() needs the server's array type oids,
 * which it loads after connecting; a query sent before they arrive (the worker's first timeout
 * sweep, through the Supabase pooler) went out as `a,b,c` and Postgres refused it as a malformed
 * array literal. A text literal the server parses needs no type cache.
 */
export function pgArray(values: readonly unknown[]): string {
  return `{${values
    .map((v) => (v === null ? 'NULL' : `"${String(v).replace(/[\\"]/g, (c) => `\\${c}`)}"`))
    .join(',')}}`;
}

export function createDb(sql: Sql): Db {
  const toParam = (col: string, v: unknown): unknown => {
    if (v === null) return null;
    if (JSON_COLUMNS.has(col)) return sql.json(v as never);
    if (Array.isArray(v)) return sql.array(v as never);
    if (v instanceof Date) return v.toISOString();
    return v;
  };

  /** `set "a" = $1, "b" = $2` from a patch object; undefined values are skipped. */
  const setClause = (patch: Record<string, unknown>, within: Sql | TransactionSql = sql) => {
    const s = within as Sql;
    const entries = Object.entries(patch).filter(([, v]) => v !== undefined);
    if (entries.length === 0) throw new Error('empty patch');
    const frags = entries.map(([k, v]) => s`${s(k)} = ${toParam(k, v) as never}`);
    return frags.reduce((acc, f) => s`${acc}, ${f}`);
  };

  const reportPatchParams = (patch: ReportPatch): Record<string, unknown> => {
    const p: Record<string, unknown> = { ...patch };
    for (const k of ['confirmed_at', 'filed_at', 'signed_off_at', 'received_at'] as const) {
      if (patch[k] !== undefined) p[k] = iso(patch[k]);
    }
    return p;
  };

  const siteDayPatchParams = (patch: SiteDayPatch): Record<string, unknown> => {
    const p: Record<string, unknown> = { ...patch };
    if (patch.deadline_at !== undefined) p.deadline_at = iso(patch.deadline_at);
    return p;
  };

  const db: Db = {
    // conversations -----------------------------------------------------------------------
    async getConversation(id) {
      if (!id) return null;
      return one(await sql<ConversationRow[]>`select * from conversations where id = ${id}`);
    },
    async getConversationByPhone(phone) {
      return one(
        await sql<ConversationRow[]>`select * from conversations where phone_e164 = ${phone}`,
      );
    },
    async ensureConversation(phone, patch) {
      const hasPatch = Object.values(patch).some((v) => v !== undefined);
      const existing = await db.getConversationByPhone(phone);
      if (existing) return hasPatch ? db.updateConversation(existing.id, patch) : existing;
      const rows = await sql<ConversationRow[]>`
        insert into conversations (phone_e164, org_id, reporter_id, state, context, last_inbound_at, last_outbound_at)
        values (${phone}, ${patch.org_id ?? null}, ${patch.reporter_id ?? null}, ${patch.state ?? 'new'}, ${sql.json((patch.context ?? {}) as never)},
                ${iso(patch.last_inbound_at)}, ${iso(patch.last_outbound_at)})
        on conflict (phone_e164) do nothing
        returning *`;
      if (rows[0]) return rows[0];
      // Lost an insert race for this phone (webhook vs. welcome): apply the patch to the winner.
      const winner = await db.getConversationByPhone(phone);
      if (!winner) throw new Error('conversation insert conflicted but no row was found');
      return hasPatch ? db.updateConversation(winner.id, patch) : winner;
    },
    async updateConversation(id, patch) {
      const p: Record<string, unknown> = { ...patch };
      if (patch.last_outbound_at !== undefined) p.last_outbound_at = iso(patch.last_outbound_at);
      if (patch.last_inbound_at !== undefined) p.last_inbound_at = iso(patch.last_inbound_at);
      const rows = await sql<
        ConversationRow[]
      >`update conversations set ${setClause(p)} where id = ${id} returning *`;
      const row = rows[0];
      if (!row) throw new Error(`conversation ${id} not found`);
      return row;
    },
    async listConversationsByState(states, changedBefore) {
      if (changedBefore) {
        return sql<
          ConversationRow[]
        >`select * from conversations where state = any(${pgArray(states)}::convo_state[]) and state_changed_at < ${changedBefore.toISOString()} order by state_changed_at`;
      }
      return sql<
        ConversationRow[]
      >`select * from conversations where state = any(${pgArray(states)}::convo_state[]) order by state_changed_at`;
    },

    // messages ----------------------------------------------------------------------------
    async getMessage(id) {
      return one(await sql<MessageRow[]>`select * from messages where id = ${id}`);
    },
    async getMessageByWaId(waId) {
      return one(await sql<MessageRow[]>`select * from messages where wa_message_id = ${waId}`);
    },
    async insertOutboundMessage(input) {
      const rows = await sql<MessageRow[]>`
        insert into messages (conversation_id, direction, wa_message_id, type, body, payload, media_id, media_mime, storage_path, template_name, status, error)
        values (${input.conversation_id}, 'out', ${input.wa_message_id ?? null}, ${input.type}, ${input.body}, ${sql.json((input.payload ?? null) as never)},
                ${input.media_id ?? null}, ${input.media_mime ?? null}, ${input.storage_path ?? null}, ${input.template_name ?? null}, ${input.status}, ${input.error ?? null})
        returning *`;
      return rows[0]!;
    },
    async updateMessage(id, patch) {
      await sql`update messages set ${setClause(patch as Record<string, unknown>)} where id = ${id}`;
    },
    async listMessagesBetween(conversationId, from, to, types) {
      if (types && types.length) {
        return sql<
          MessageRow[]
        >`select * from messages where conversation_id = ${conversationId} and direction = 'in'
          and created_at between ${from.toISOString()} and ${to.toISOString()} and type = any(${pgArray(types)}::msg_type[]) order by created_at`;
      }
      return sql<
        MessageRow[]
      >`select * from messages where conversation_id = ${conversationId} and direction = 'in'
        and created_at between ${from.toISOString()} and ${to.toISOString()} order by created_at`;
    },

    // transcripts -------------------------------------------------------------------------
    async getTranscript(messageId) {
      return one(
        await sql<TranscriptRow[]>`select * from transcripts where message_id = ${messageId}`,
      );
    },
    async listTranscripts(mediaIds) {
      if (mediaIds.length === 0) return [];
      // Callers pass voice notes in chronological order; keep it (heap/index order is arbitrary
      // and transcription jobs finish out of order), so PDFs and evidence packs stay stable.
      const ids = pgArray(mediaIds);
      return sql<TranscriptRow[]>`select * from transcripts
        where upload_id = any(${ids}::uuid[]) or message_id = any(${ids}::uuid[])
        order by array_position(${ids}::uuid[], coalesce(upload_id, message_id))`;
    },
    async listCallTranscripts(callIds) {
      if (callIds.length === 0) return [];
      const ids = pgArray(callIds);
      return sql<TranscriptRow[]>`select * from transcripts where call_id = any(${ids}::uuid[])
        order by array_position(${ids}::uuid[], call_id)`;
    },
    async getCall(id) {
      return one(await sql<CallRow[]>`select * from calls where id = ${id}`);
    },
    async getVoiceTurn(id) {
      return one(await sql<VoiceTurnRow[]>`select * from voice_turns where id = ${id}`);
    },
    async settleVoiceTurn(id, outcome) {
      const rows = await sql<Array<{ id: string }>>`
        update voice_turns set
          status = ${outcome.status},
          result = ${outcome.status === 'done' ? sql.json(outcome.result as never) : null},
          error = ${outcome.status === 'failed' ? outcome.error.slice(0, 500) : null},
          finished_at = now()
        where id = ${id} and status = 'pending'
        returning id`;
      return rows.length > 0;
    },
    async upsertTranscript(input) {
      const rows = await sql<TranscriptRow[]>`
        insert into transcripts (message_id, language, text, segments, model)
        values (${input.message_id}, ${input.language}, ${input.text}, ${sql.json(input.segments as never)}, ${input.model})
        on conflict (message_id) do update set language = excluded.language, text = excluded.text, segments = excluded.segments, model = excluded.model
        returning *`;
      return rows[0]!;
    },

    async getUploadTranscript(uploadId) {
      return one(
        await sql<TranscriptRow[]>`select * from transcripts where upload_id = ${uploadId}`,
      );
    },
    async saveUploadTranscript(input) {
      return sql.begin(async (tx) => {
        const inserted = await tx<TranscriptRow[]>`
          insert into transcripts (upload_id, language, text, segments, model)
          values (${input.uploadId}, ${input.language}, ${input.text}, ${tx.json(input.segments as never)}, ${input.model})
          on conflict (upload_id) do nothing
          returning *`;
        const transcript =
          inserted[0] ??
          (
            await tx<TranscriptRow[]>`select * from transcripts where upload_id = ${input.uploadId}`
          )[0];
        if (!transcript) throw new Error(`transcript of upload ${input.uploadId} not saved`);
        await tx`update uploads set
            duration_s = coalesce(${input.durationS}::numeric, duration_s),
            peaks = coalesce(${input.peaks === null ? null : tx.json(input.peaks as never)}::jsonb, peaks)
          where id = ${input.uploadId}`;
        if (inserted[0]) {
          await tx`select log_audit(s.org_id, 'agent', null, 'transcript.created', 'upload', u.id,
              ${tx.json(input.audit as never)})
            from uploads u join sites s on s.id = u.site_id where u.id = ${input.uploadId}`;
        }
        return { transcript, created: inserted.length > 0 };
      });
    },

    // uploads -----------------------------------------------------------------------------
    async getUpload(id) {
      return one(await sql<UploadRow[]>`select * from uploads where id = ${id}`);
    },
    async listReportVoiceUploads(reportId) {
      return sql<ReportVoiceUpload[]>`
        select u.id, u.received_at,
               exists (select 1 from transcripts t where t.upload_id = u.id) as transcribed
        from uploads u
        where u.report_id = ${reportId} and u.kind = 'audio' and u.purged_at is null
          and u.batch_id is null and u.question_id is null and u.correction_report_id is null
        order by u.received_at nulls first, u.id`;
    },
    async countBatchPhotos(batchId) {
      const [row] = await sql<Array<{ n: number }>>`
        select count(*)::int as n from uploads where batch_id = ${batchId} and kind = 'photo'`;
      return row?.n ?? 0;
    },
    async attachPhotos(reportId, batchId, changeNote, caption) {
      const [row] = await sql<Array<{ r: { version: number; alreadyAttached: boolean } }>>`
        select field_attach_photos(${reportId}, ${batchId}, ${changeNote}, ${caption}) as r`;
      return { version: row!.r.version, alreadyAttached: row!.r.alreadyAttached };
    },

    // reporters, sites, orgs --------------------------------------------------------------
    async listReportersByPhone(phone) {
      return sql<
        ReporterRow[]
      >`select * from reporters where phone_e164 = ${phone} and status <> 'disabled' order by created_at`;
    },
    async getReporter(id) {
      return one(await sql<ReporterRow[]>`select * from reporters where id = ${id}`);
    },
    async updateReporter(id, patch) {
      await sql`update reporters set ${setClause(patch as Record<string, unknown>)} where id = ${id}`;
    },
    async optOutReporter(reporterId, at) {
      await sql`update reporters
        set status = case when status = 'disabled' then status else 'opted_out'::reporter_status end,
            opted_out_at = coalesce(opted_out_at, ${at}::timestamptz)
        where id = ${reporterId}`;
    },
    async listInboundReporters(phone, country, scope) {
      const rows = await sql<
        Array<{
          id: string;
          org_id: string;
          name: string;
          status: ReporterRow['status'];
          contact_pref: ReporterRow['contact_pref'];
          activated_at: string | null;
          opted_out_at: string | null;
          created_at: string;
          phone_e164: string;
          locale: string;
          org_name: string;
          org_is_demo: boolean;
        }>
      >`select r.id, r.org_id, r.name, r.status, r.contact_pref, r.activated_at, r.opted_out_at,
               r.created_at, r.phone_e164, r.locale, o.name as org_name, o.is_demo as org_is_demo
        from reporters r join orgs o on o.id = r.org_id
        where r.phone_e164 = ${phone} and o.country = ${country}
          and ${'realOnly' in scope ? sql`o.is_demo = false` : sql`o.id = ${scope.orgId}`}
        order by r.created_at`;
      return rows.map((r) => ({
        id: r.id,
        orgId: r.org_id,
        status: r.status,
        contactPref: r.contact_pref,
        activatedAt: r.activated_at,
        optedOutAt: r.opted_out_at,
        createdAt: r.created_at,
        name: r.name,
        phone: r.phone_e164,
        locale: r.locale,
        orgName: r.org_name,
        orgIsDemo: r.org_is_demo,
      }));
    },
    async listSitesForReporter(reporterId) {
      return sql<SiteRow[]>`select s.* from sites s join site_reporters sr on sr.site_id = s.id
        where sr.reporter_id = ${reporterId} and s.status <> 'archived' order by sr.is_primary desc, s.name`;
    },
    async listReportersForSite(siteId) {
      return sql<
        ReporterRow[]
      >`select r.* from reporters r join site_reporters sr on sr.reporter_id = r.id
        where sr.site_id = ${siteId} order by sr.is_primary desc, r.created_at`;
    },
    async getSite(id) {
      return one(await sql<SiteRow[]>`select * from sites where id = ${id}`);
    },
    async listSitesByOrg(orgId) {
      return sql<SiteRow[]>`select * from sites where org_id = ${orgId} order by name`;
    },
    async listActiveSites() {
      return sql<
        Array<Pick<SiteRow, 'id' | 'org_id' | 'name' | 'project_code' | 'address'>>
      >`select id, org_id, name, project_code, address from sites where status = 'active'`;
    },
    async getOrg(id) {
      return one(await sql<OrgRow[]>`select * from orgs where id = ${id}`);
    },
    async listOrgs() {
      return sql<OrgRow[]>`select * from orgs order by created_at`;
    },
    async getOrgSettings(orgId) {
      return one(await sql<OrgSettingsRow[]>`select * from org_settings where org_id = ${orgId}`);
    },
    async listCompanies(orgId) {
      return sql<CompanyRow[]>`select * from companies where org_id = ${orgId} order by name`;
    },
    async getCompany(id) {
      return one(await sql<CompanyRow[]>`select * from companies where id = ${id}`);
    },
    async insertCompany(orgId, name, status, trade = null) {
      const rows = await sql<CompanyRow[]>`
        insert into companies (org_id, name, status, trade) values (${orgId}, ${name}, ${status}, ${trade})
        on conflict (org_id, name) do update set name = excluded.name
        returning *`;
      return rows[0]!;
    },
    async listGlossary(orgId, siteId = null, reporterId = null) {
      return sql<GlossaryTermRow[]>`select * from glossary_terms
        where (org_id = ${orgId} or org_id is null)
          and (scope_site_id is null or scope_site_id = ${siteId})
          and (scope_reporter_id is null or scope_reporter_id = ${reporterId})
        order by times_heard desc, heard`;
    },
    async upsertGlossaryTerm(input) {
      const existing = await sql<GlossaryTermRow[]>`select * from glossary_terms
        where org_id = ${input.org_id} and lower(heard) = lower(${input.heard}) and kind = ${input.kind}
          and scope_site_id is not distinct from ${input.scope_site_id ?? null} limit 1`;
      const row = existing[0];
      if (row) {
        const rows = await sql<
          GlossaryTermRow[]
        >`update glossary_terms set times_heard = times_heard + 1, last_seen_at = now(),
          official = coalesce(official, ${input.official}) where id = ${row.id} returning *`;
        return { row: rows[0]!, inserted: false };
      }
      const rows = await sql<GlossaryTermRow[]>`
        insert into glossary_terms (org_id, scope_site_id, scope_reporter_id, heard, official, language, kind, company_id, status, times_heard, last_seen_at)
        values (${input.org_id}, ${input.scope_site_id ?? null}, ${input.scope_reporter_id ?? null}, ${input.heard}, ${input.official},
                ${input.language ?? 'en'}, ${input.kind}, ${input.company_id ?? null}, ${input.status}, 1, now())
        returning *`;
      return { row: rows[0]!, inserted: true };
    },
    async listSiteRecipients(siteId) {
      const rows = await sql<
        Array<{ email: string }>
      >`select email from site_recipients where site_id = ${siteId} order by email`;
      return rows.map((r) => r.email);
    },
    async listMemberEmails(orgId, roles) {
      return sql<Array<{ email: string; user_id: string; display_name: string | null }>>`
        select u.email, m.user_id, m.display_name from org_members m join auth.users u on u.id = m.user_id
        where m.org_id = ${orgId} and m.role = any(${pgArray(roles)}::member_role[]) and u.email is not null order by u.email`;
    },
    async getUserContact(userId) {
      return one(
        await sql<Array<{ email: string | null; display_name: string | null }>>`
        select u.email, (select m.display_name from org_members m where m.user_id = u.id limit 1) as display_name
        from auth.users u where u.id = ${userId}`,
      );
    },
    async siteContext(siteId) {
      const site = await db.getSite(siteId);
      if (!site) return null;
      const [org, settings, companies, glossary, recipients, reporters] = await Promise.all([
        db.getOrg(site.org_id),
        db.getOrgSettings(site.org_id),
        db.listCompanies(site.org_id),
        db.listGlossary(site.org_id, site.id),
        db.listSiteRecipients(site.id),
        db.listReportersForSite(site.id),
      ]);
      if (!org || !settings) return null;
      return { site, org, settings, companies, glossary, recipients, reporters };
    },

    // site days ---------------------------------------------------------------------------
    async getSiteDay(id) {
      return one(await sql<SiteDayRow[]>`select * from site_days where id = ${id}`);
    },
    async findSiteDay(siteId, date) {
      return one(
        await sql<
          SiteDayRow[]
        >`select * from site_days where site_id = ${siteId} and date = ${date}`,
      );
    },
    async getOrCreateSiteDay(siteId, date, deadlineAt) {
      const rows = await sql<SiteDayRow[]>`
        insert into site_days (site_id, date, deadline_at) values (${siteId}, ${date}, ${deadlineAt.toISOString()})
        on conflict (site_id, date) do update set updated_at = now()
        returning *`;
      return rows[0]!;
    },
    async updateSiteDay(id, patch) {
      const p = siteDayPatchParams(patch);
      const rows = await sql<
        SiteDayRow[]
      >`update site_days set ${setClause(p)} where id = ${id} returning *`;
      const row = rows[0];
      if (!row) throw new Error(`site_day ${id} not found`);
      return row;
    },

    // reports -----------------------------------------------------------------------------
    async getReport(id) {
      return one(await sql<ReportRow[]>`select * from reports where id = ${id}`);
    },
    async insertReport(input) {
      const rows = await sql<ReportRow[]>`
        insert into reports (org_id, site_id, site_day_id, report_no, reporter_id, received_at, kind, status, language)
        values (${input.org_id}, ${input.site_id}, ${input.site_day_id}, ${input.report_no}, ${input.reporter_id}, ${iso(input.received_at)}, ${input.kind}, ${input.status ?? 'collecting'},
                coalesce(${input.language ?? null}::text, org_report_language(${input.org_id})))
        returning *`;
      return rows[0]!;
    },
    async updateReport(id, patch) {
      const p = reportPatchParams(patch);
      const rows = await sql<
        ReportRow[]
      >`update reports set ${setClause(p)} where id = ${id} returning *`;
      const row = rows[0];
      if (!row) throw new Error(`report ${id} not found`);
      return row;
    },
    async findOpenReportForSiteDay(siteDayId) {
      return one(
        await sql<ReportRow[]>`select * from reports where site_day_id = ${siteDayId}
        and status in ('collecting','awaiting_answer','awaiting_confirmation') order by created_at desc limit 1`,
      );
    },
    async findReportForSiteDay(siteDayId) {
      return one(
        await sql<
          ReportRow[]
        >`select * from reports where site_day_id = ${siteDayId} and status <> 'void' order by created_at desc limit 1`,
      );
    },
    async findReportsByDate(siteIds, date) {
      if (siteIds.length === 0) return [];
      return sql<ReportRow[]>`select r.* from reports r join site_days sd on sd.id = r.site_day_id
        where r.site_id = any(${pgArray(siteIds)}::uuid[]) and sd.date = ${date} and r.status in ('filed','signed_off')
        order by r.filed_at desc`;
    },
    async listReportsForSitePeriod(siteId, start, end) {
      return sql<ReportRow[]>`select r.* from reports r join site_days sd on sd.id = r.site_day_id
        where r.site_id = ${siteId} and sd.date between ${start} and ${end} and r.status in ('filed','signed_off') order by sd.date`;
    },
    async nextReportNo(siteId) {
      const rows = await sql<
        Array<{ next_report_no: string }>
      >`select next_report_no(${siteId}) as next_report_no`;
      return rows[0]!.next_report_no;
    },
    async getVersion(reportId, version) {
      return one(
        await sql<
          ReportVersionRow[]
        >`select * from report_versions where report_id = ${reportId} and version = ${version}`,
      );
    },
    async listVersions(reportId) {
      return sql<
        ReportVersionRow[]
      >`select * from report_versions where report_id = ${reportId} order by version`;
    },
    async insertVersion(input) {
      // Drafts (report not filed yet) are overwritten in place, and so is a version left dangling
      // above current_version by a failed attempt (retry stays idempotent). A version that is
      // already current on a filed report is immutable: e.g. an office edit (create_report_version)
      // committed v3 while a WhatsApp edit was computing its own v3 — never overwrite it.
      //
      // The report's row lock comes first: the ON CONFLICT condition reads reports with the
      // statement's snapshot, so without it a draft write waiting on the version row a filing
      // holds would still see the report as a draft after the filing committed, and overwrite
      // the filed version.
      const row = await sql.begin(async (tx) => {
        await tx`select 1 from reports where id = ${input.report_id} for update`;
        const rows = await tx<ReportVersionRow[]>`
          insert into report_versions (report_id, version, data, summary, author, author_user_id, author_message_id, change_note)
          values (${input.report_id}, ${input.version}, ${tx.json(input.data as never)}, ${input.summary}, ${input.author}, ${input.author_user_id ?? null}, ${input.author_message_id ?? null}, ${input.change_note ?? null})
          on conflict (report_id, version) do update set data = excluded.data, summary = excluded.summary, change_note = excluded.change_note, author_message_id = excluded.author_message_id
            where exists (select 1 from reports r where r.id = excluded.report_id
                            and (r.status in ('collecting','processing','awaiting_answer','awaiting_confirmation') or excluded.version > r.current_version))
          returning *`;
        return rows[0];
      });
      if (!row)
        throw new Error(
          `report ${input.report_id} version ${input.version} already exists and is immutable`,
        );
      return row;
    },
    async storeDraftVersion(input) {
      return sql.begin(async (tx) => {
        const [r] = await tx<Array<Pick<ReportRow, 'status' | 'current_version'>>>`
          select status, current_version from reports where id = ${input.report_id} for update`;
        if (!r || !DRAFT_STATUSES.includes(r.status) || (r.current_version || 1) !== input.version)
          return null;
        const rows = await tx<ReportVersionRow[]>`
          insert into report_versions (report_id, version, data, summary, author, author_user_id, author_message_id, change_note)
          values (${input.report_id}, ${input.version}, ${tx.json(input.data as never)}, ${input.summary}, ${input.author}, ${input.author_user_id ?? null}, ${input.author_message_id ?? null}, ${input.change_note ?? null})
          on conflict (report_id, version) do update set data = excluded.data, summary = excluded.summary, change_note = excluded.change_note, author_message_id = excluded.author_message_id
          returning *`;
        return rows[0] ?? null;
      });
    },
    async fileVersion(input) {
      return sql.begin(async (tx): Promise<FileVersionOutcome> => {
        await tx`select 1 from site_days where id = ${input.siteDayId} for update`;
        const [r] = await tx<
          Array<Pick<ReportRow, 'status' | 'current_version'>>
        >`select status, current_version from reports where id = ${input.reportId} for update`;
        if (!r || r.status !== input.expect.status || (r.current_version || 1) !== input.version)
          return { filed: false };
        const [v] = await tx<Array<{ draft_rev: number }>>`
          select draft_rev from report_versions
          where report_id = ${input.reportId} and version = ${input.version} for update`;
        if (!v || v.draft_rev !== input.expect.draftRev) return { filed: false };
        // The report first: the version write below is then no new draft revision (20261015000090).
        const [report] = await tx<ReportRow[]>`
          update reports set ${setClause(reportPatchParams(input.report), tx)}
          where id = ${input.reportId} returning *`;
        await tx`update report_versions set data = ${tx.json(input.data as never)}, summary = ${input.summary}
          where report_id = ${input.reportId} and version = ${input.version}`;
        await tx`select denormalize_report_version(${input.reportId}, ${input.version})`;
        await tx`update site_days set ${setClause(siteDayPatchParams(input.siteDay), tx)}
          where id = ${input.siteDayId}`;
        const a = input.audit;
        await tx`select log_audit(${a.org_id}, ${a.actor_type}, ${a.actor_id ?? null}, ${a.action},
          ${a.entity ?? null}, ${a.entity_id ?? null}, ${tx.json((a.diff ?? null) as never)})`;
        return { filed: true, report: report! };
      });
    },
    async updateVersion(reportId, version, patch) {
      await sql`update report_versions set ${setClause(patch as Record<string, unknown>)} where report_id = ${reportId} and version = ${version}`;
    },
    async denormalizeVersion(reportId, version) {
      await sql`select denormalize_report_version(${reportId}, ${version})`;
    },
    async insertReportSource(input) {
      await sql`insert into report_sources (report_id, message_id, kind, caption, taken_at)
        values (${input.report_id}, ${input.message_id}, ${input.kind}, ${input.caption ?? null}, ${iso(input.taken_at)})
        on conflict (report_id, message_id) do nothing`;
    },
    async listReportSources(reportId) {
      return sql<ReportSourceWithMessage[]>`
        select rs.*, coalesce(rs.upload_id, rs.message_id) as media_id,
               coalesce(m.type, case u.kind when 'audio' then 'audio'::msg_type when 'photo' then 'image'::msg_type end) as message_type,
               coalesce(case when u.purged_at is null then u.storage_path end, m.storage_path) as storage_path,
               coalesce(u.duration_s, m.duration_s) as duration_s,
               coalesce(m.created_at, u.received_at, rs.created_at) as message_created_at,
               coalesce(u.mime, m.media_mime) as media_mime,
               coalesce(m.body, u.caption) as body
        from report_sources rs
        left join uploads u on u.id = coalesce(rs.upload_id, rs.message_id)
        left join messages m on m.id = rs.message_id
        where rs.report_id = ${reportId}
        order by coalesce(m.created_at, u.received_at, rs.created_at), rs.id`;
    },

    // questions ---------------------------------------------------------------------------
    async insertQuestion(input) {
      const rows = await sql<QuestionRow[]>`
        insert into questions (report_id, field, target, prompt, options, asked_message_id, asked_at, channel, call_id)
        values (${input.report_id}, ${input.field}, ${sql.json((input.target ?? null) as never)}, ${input.prompt}, ${sql.json((input.options ?? null) as never)}, ${input.asked_message_id ?? null}, ${iso(input.asked_at)}, ${input.channel ?? null}, ${input.call_id ?? null})
        returning *`;
      return rows[0]!;
    },
    async getQuestion(id) {
      return one(await sql<QuestionRow[]>`select * from questions where id = ${id}`);
    },
    async listQuestions(reportId) {
      return sql<
        QuestionRow[]
      >`select * from questions where report_id = ${reportId} order by created_at`;
    },
    async updateQuestion(id, patch) {
      const p: Record<string, unknown> = { ...patch };
      if (patch.asked_at !== undefined) p.asked_at = iso(patch.asked_at);
      if (patch.answered_at !== undefined) p.answered_at = iso(patch.answered_at);
      await sql`update questions set ${setClause(p)} where id = ${id}`;
    },
    async timeOutQuestion(id, at) {
      const rows = await sql<Array<{ id: string }>>`
        update questions set answered_at = ${iso(at)},
          answer = ${sql.json({ unanswered: true, timeout: true } as never)}
        where id = ${id} and answered_at is null
        returning id`;
      return rows.length > 0;
    },

    async settleVoiceAnswer(input) {
      const [row] = await sql<Array<{ r: SettleVoiceAnswerResult }>>`
        select field_settle_voice_answer(${input.questionId}, ${input.uploadId}, ${input.outcome},
          ${sql.json(input.detail as never)},
          ${input.base === undefined ? null : sql.json(input.base as never)},
          ${input.data === undefined ? null : sql.json(input.data as never)},
          ${input.answer === undefined ? null : sql.json(input.answer as never)}) as r`;
      return row!.r;
    },

    // corrections (W2-10) ----------------------------------------------------------------------
    async getCorrection(id) {
      return one(await sql<DraftCorrectionRow[]>`select * from draft_corrections where id = ${id}`);
    },
    async settleCorrection(id, outcome, detail) {
      const [row] = await sql<Array<{ r: SettleCorrectionResult }>>`
        select field_settle_correction(${id}, ${outcome}, ${sql.json(detail as never)}) as r`;
      return row!.r;
    },
    async listAppliedCorrections(reportId) {
      return sql<
        Array<Pick<DraftCorrectionRow, 'id' | 'via' | 'changes' | 'source' | 'applied_at'>>
      >`
        select id, via, changes, source, applied_at from draft_corrections
        where report_id = ${reportId} and status = 'applied' and not after_filing
        order by applied_at, created_at`;
    },
    async applyCallCorrection(input) {
      return sql.begin(async (tx) => {
        const none = { applied: false, correctionId: null, draftRev: null };
        await tx`select 1 from site_days where id = (select site_day_id from reports where id = ${input.reportId}) for update`;
        const [r] = await tx<Array<Pick<ReportRow, 'status' | 'current_version'>>>`
          select status, current_version from reports where id = ${input.reportId} for update`;
        if (
          !r ||
          !DRAFT_STATUSES.includes(r.status) ||
          (r.current_version || 1) !== input.baseVersion
        )
          return none;
        const [filing] = await tx<Array<{ id: number }>>`
          select id from jobs where type = 'file_report' and payload ->> 'reportId' = ${input.reportId}
            and status in ('queued', 'running') limit 1`;
        if (filing) return none;
        const [v] = await tx<Array<{ draft_rev: number }>>`
          select draft_rev from report_versions
          where report_id = ${input.reportId} and version = ${input.baseVersion} for update`;
        if (!v || v.draft_rev !== input.baseRev) return none;
        const [written] = await tx<Array<{ draft_rev: number }>>`
          update report_versions set data = ${tx.json(input.data as never)}, summary = ${input.data.summary || null}
          where report_id = ${input.reportId} and version = ${input.baseVersion}
          returning draft_rev`;
        const [c] = await tx<Array<{ id: string }>>`
          insert into draft_corrections (org_id, report_id, reporter_id, via, text, status,
                                         base_version, base_rev, data, changes, operations, source,
                                         change_note, settled_at, applied_at)
          values (${input.orgId}, ${input.reportId}, ${input.reporterId}, 'voice', ${input.text},
                  'applied', ${input.baseVersion}, ${input.baseRev}, ${tx.json(input.data as never)},
                  ${tx.json(input.changes as never)}, ${tx.json(input.operations as never)},
                  ${tx.json(input.source as never)}, ${input.changeNote}, now(), now())
          returning id`;
        return { applied: true, correctionId: c!.id, draftRev: written!.draft_rev };
      });
    },

    // After a call (W3-11) ---------------------------------------------------------------------
    async postCallSettle(callId, hasValue) {
      const [row] = await sql<Array<{ r: PostCallSettle }>>`
        select post_call_settle(${callId}, ${hasValue}) as r`;
      return row!.r;
    },
    async postCallRecording(input) {
      const [row] = await sql<Array<{ r: { stored: boolean; replaced: string | null } }>>`
        select post_call_recording(${input.callId},
          ${input.peaks ? sql.json(input.peaks as never) : null}::jsonb,
          ${input.durationS}::numeric,
          ${input.transcript ? sql.json(input.transcript as never) : null}::jsonb) as r`;
      return row!.r;
    },
    async postCallFallbackReport(callId) {
      const [row] = await sql<
        Array<{ r: Awaited<ReturnType<Db['postCallFallbackReport']>> }>
      >`select post_call_fallback_report(${callId}) as r`;
      return row!.r;
    },
    async postCallReconciled(input) {
      const [row] = await sql<Array<{ r: Awaited<ReturnType<Db['postCallReconciled']>> }>>`
        select post_call_reconciled(${input.callId}, ${input.reportId},
          ${pgArray(input.reasons)}::text[], ${sql.json(input.precise as never)}::jsonb,
          ${sql.json(input.result as never)}::jsonb, ${input.notice.title}, ${input.notice.body},
          ${sql.json(input.notice.data as never)}::jsonb) as r`;
      return row!.r;
    },
    async postCallUnreconciled(input) {
      const [row] = await sql<Array<{ r: Awaited<ReturnType<Db['postCallUnreconciled']>> }>>`
        select post_call_unreconciled(${input.callId}, ${input.reason}, ${input.notice.title},
          ${input.notice.body}, ${sql.json(input.notice.data as never)}::jsonb) as r`;
      return row!.r;
    },
    async reportNoPhotoCheck(reportId, notice) {
      const [row] = await sql<Array<{ r: { flagged: boolean; reason: string } }>>`
        select report_no_photo_check(${reportId}, ${notice.title}, ${notice.body},
          ${sql.json(notice.data as never)}::jsonb) as r`;
      return row!.r;
    },

    // SMS report keywords (W2-12) -------------------------------------------------------------
    async smsKeywordDays(reporterIds) {
      if (reporterIds.length === 0) return [];
      return sql<SmsKeywordDay[]>`
        select sr.reporter_id, s.id as site_id, s.name as site_name, s.timezone,
               to_char((now() at time zone s.timezone)::date, 'YYYY-MM-DD') as date,
               sd.status::text as day_status,
               exists (select 1 from reports x where x.site_day_id = sd.id and x.status <> 'void')
                 as has_report
        from site_reporters sr
        join reporters r on r.id = sr.reporter_id
        join sites s on s.id = sr.site_id and s.org_id = r.org_id and s.status = 'active'
        left join site_days sd on sd.site_id = s.id
                              and sd.date = (now() at time zone s.timezone)::date
        where sr.reporter_id = any(${pgArray(reporterIds)}::uuid[])
        order by sr.is_primary desc, s.name, s.id`;
    },
    async smsKeywordDrafts(reporterIds) {
      if (reporterIds.length === 0) return [];
      return sql<SmsKeywordDraft[]>`
        select r.id as report_id, r.reporter_id, r.org_id, s.name as site_name
        from reports r join sites s on s.id = r.site_id
        where r.reporter_id = any(${pgArray(reporterIds)}::uuid[]) and r.status = 'awaiting_confirmation'
          and r.channel = 'web'
        order by r.created_at desc`;
    },
    async smsEditReports(reporterIds, date) {
      if (reporterIds.length === 0) return [];
      return sql<SmsEditReport[]>`
        select distinct on (r.id) r.id as report_id, sr.reporter_id, r.org_id, s.id as site_id,
               s.name as site_name, s.timezone, s.status::text as site_status,
               r.status::text as status, to_char(sd.date, 'YYYY-MM-DD') as date
        from site_reporters sr
        join reporters rp on rp.id = sr.reporter_id
        join sites s on s.id = sr.site_id and s.org_id = rp.org_id
        join site_days sd on sd.site_id = s.id and sd.date = ${date}::date
        join reports r on r.site_day_id = sd.id and r.status <> 'void'
        where sr.reporter_id = any(${pgArray(reporterIds)}::uuid[])
        order by r.id, sr.is_primary desc, sr.reporter_id`;
    },
    async getCorrectionByMessage(messageId) {
      return one(
        await sql<
          DraftCorrectionRow[]
        >`select * from draft_corrections where message_id = ${messageId}`,
      );
    },
    async requestSmsCorrection(input) {
      const [row] = await sql<
        Array<{ r: { id: string; status: string; jobId: number | null; repeat?: boolean } }>
      >`select sms_request_filed_correction(${input.reportId}, ${input.reporterId},
          ${input.text}, ${input.messageId}) as r`;
      return row!.r;
    },
    async listDailyLinks(reporterId, siteId, reportDate) {
      return sql<Array<{ id: string; code_hash: string; expires_at: string | null }>>`
        select id, code_hash, expires_at from field_links
        where reporter_id = ${reporterId} and kind = 'daily' and site_id = ${siteId}
          and report_date = ${reportDate}::date and revoked_at is null
        order by created_at desc`;
    },
    async insertDailyLink(row) {
      const rows = await sql<Array<{ id: string }>>`
        insert into field_links (id, code_hash, reporter_id, kind, site_id, report_date, expires_at)
        values (${row.id}, ${row.code_hash}, ${row.reporter_id}, 'daily', ${row.site_id},
                ${row.report_date}::date, ${row.expires_at})
        on conflict (code_hash) do nothing returning id`;
      return rows.length > 0;
    },
    async listPhotosLinks(reporterId, siteId, reportDate) {
      const rows = await sql<Array<{ id: string; code_hash: string; expires_at: Date | null }>>`
        select id, code_hash, expires_at from field_links
        where reporter_id = ${reporterId} and kind = 'photos' and site_id = ${siteId}
          and report_date = ${reportDate}::date and revoked_at is null
        order by created_at desc`;
      return rows.map((r) => ({
        ...r,
        expires_at: r.expires_at === null ? null : new Date(r.expires_at).toISOString(),
      }));
    },
    async insertPhotosLink(row) {
      const rows = await sql<Array<{ id: string }>>`
        insert into field_links (id, code_hash, reporter_id, kind, site_id, report_date, expires_at)
        values (${row.id}, ${row.code_hash}, ${row.reporter_id}, 'photos', ${row.site_id},
                ${row.report_date}::date, ${row.expires_at})
        on conflict (code_hash) do nothing returning id`;
      return rows.length > 0;
    },

    // web pipeline (W1-12) -------------------------------------------------------------------
    async setReportStatus(id, to, from) {
      const rows = await sql<Array<{ id: string }>>`
        update reports set status = ${to}::report_status
        where id = ${id} and status = any(${pgArray([...from])}::report_status[])
        returning id`;
      return rows.length > 0;
    },
    async reporterDeviceLastSeen(reporterId) {
      const rows = await sql<Array<{ seen: Date | string | null }>>`
        select max(last_seen_at) as seen from field_devices
        where reporter_id = ${reporterId} and revoked_at is null`;
      const seen = rows[0]?.seen ?? null;
      return seen === null ? null : new Date(seen).toISOString();
    },
    async hasActiveReportJob(type, reportId, exceptJobId) {
      const rows = await sql<Array<{ id: number }>>`
        select id from jobs
        where type = ${type} and payload ->> 'reportId' = ${reportId}
          and status in ('queued', 'running') and id <> ${exceptJobId ?? -1}
        limit 1`;
      return rows.length > 0;
    },

    async listJobsByKeys(keys) {
      if (keys.length === 0) return [];
      return sql<Array<Pick<JobRow, 'id' | 'status' | 'dedupe_key'>>>`
        select id, status, dedupe_key from jobs
        where dedupe_key = any(${pgArray([...keys])}::text[])
        order by id`;
    },

    // unknown contacts --------------------------------------------------------------------
    async findPendingUnknownContact(phone) {
      return one(
        await sql<
          UnknownContactRow[]
        >`select * from unknown_contacts where phone_e164 = ${phone} and status = 'pending' order by created_at desc limit 1`,
      );
    },
    async getUnknownContact(id) {
      return one(await sql<UnknownContactRow[]>`select * from unknown_contacts where id = ${id}`);
    },
    async insertUnknownContact(input) {
      const rows = await sql<UnknownContactRow[]>`
        insert into unknown_contacts (org_id, phone_e164, channel, message_id, snippet, guessed_site_id)
        values (${input.org_id}, ${input.phone_e164}, ${input.channel}, ${input.message_id}, ${input.snippet}, ${input.guessed_site_id ?? null}) returning *`;
      return rows[0]!;
    },
    async updateUnknownContact(id, patch) {
      await sql`update unknown_contacts set ${setClause(patch as Record<string, unknown>)} where id = ${id}`;
    },

    // messaging (W1-08) ---------------------------------------------------------------------
    async getCountry(code) {
      return one(await sql<CountryRow[]>`select * from countries where code = ${code}`);
    },
    async listCountries() {
      return sql<CountryRow[]>`select * from countries order by code`;
    },
    async listConsents(reporterId) {
      return sql<Array<Pick<ConsentRow, 'type' | 'revoked_at'>>>`
        select type, revoked_at from consents where reporter_id = ${reporterId}`;
    },
    async listLivePushSubscriptions(reporterId) {
      return sql<Array<Pick<PushSubscriptionRow, 'id' | 'endpoint' | 'p256dh' | 'auth'>>>`
        select s.id, s.endpoint, s.p256dh, s.auth from push_subscriptions s
        left join field_devices d on d.id = s.device_id
        where s.reporter_id = ${reporterId} and s.revoked_at is null
          and (s.device_id is null or d.revoked_at is null)
        order by s.created_at, s.id`;
    },
    async lastInboundWhatsapp(phone, sender) {
      const rows = await sql<Array<{ at: Date | string }>>`
        select created_at as at from messages
        where phone_e164 = ${phone} and channel = 'whatsapp' and direction = 'in'
          and provider = 'twilio' and payload->>'to' = ${sender}
        order by created_at desc limit 1`;
      const at = rows[0]?.at;
      return at === undefined ? null : new Date(at).toISOString();
    },
    async pushSubscriptionGone(id, status) {
      const rows = await sql<
        Array<{ v: boolean }>
      >`select push_subscription_gone(${id}, ${status}) as v`;
      return rows[0]?.v === true;
    },
    async insertSmsMessage(row) {
      await sql`
        insert into messages (id, org_id, reporter_id, phone_e164, channel, direction, provider,
          provider_message_id, copy_key, body, status, error, payload)
        values (${row.id}, ${row.org_id}, ${row.reporter_id}, ${row.phone_e164}, ${row.channel},
          ${row.direction}, ${row.provider}, ${row.provider_message_id}, ${row.copy_key}, ${row.body},
          ${row.status}, ${row.error}, ${sql.json((row.payload ?? null) as never)})`;
    },
    async updateSmsMessage(id, patch) {
      await sql`update messages set ${setClause(patch as Record<string, unknown>)} where id = ${id}`;
    },
    async listMessagesByDedupeKey(reporterId, dedupeKey) {
      return await sql<PriorMessage[]>`
        select id, channel, status, provider, provider_message_id, error,
          payload->>'error_code' as error_code,
          case when jsonb_typeof(payload->'attempt') = 'number' then (payload->>'attempt')::int end
            as attempt,
          case when jsonb_typeof(payload->'tries') = 'number' then (payload->>'tries')::int end
            as tries
        from messages
        where reporter_id = ${reporterId} and payload->>'dedupe_key' = ${dedupeKey}
        order by created_at, id`;
    },
    async markSmsHandled(messageId, at) {
      await sql`update messages
        set payload = coalesce(payload, '{}'::jsonb) || jsonb_build_object('handled_at', ${at}::text)
        where id = ${messageId}`;
    },
    async hasPendingUnknownContact(phone, channel, excludeMessageId = null) {
      const rows = await sql<Array<{ n: number }>>`
        select count(*)::int as n from unknown_contacts
        where phone_e164 = ${phone} and channel = ${channel} and status = 'pending'
          and (${excludeMessageId}::uuid is null or message_id is distinct from ${excludeMessageId}::uuid)`;
      return (rows[0]?.n ?? 0) > 0;
    },
    async insertSmsUnknownContact(row) {
      const rows = await sql<Array<{ id: string; created: boolean }>>`
        with existing as (
          select id from unknown_contacts where message_id = ${row.message_id} limit 1
        ), inserted as (
          insert into unknown_contacts (org_id, phone_e164, channel, message_id, snippet)
          select ${row.org_id}, ${row.phone_e164}, ${row.channel ?? 'sms'}::field_channel,
                 ${row.message_id}, ${row.snippet}
          where not exists (select 1 from existing)
          returning id
        )
        select id, true as created from inserted
        union all
        select id, false as created from existing`;
      return rows[0]!;
    },
    async inboundWhatsappConsent(reporterId, grant, messageId) {
      const rows = await sql<
        Array<{ r: { changed?: boolean } }>
      >`select inbound_whatsapp_consent(${reporterId}, ${grant}, ${messageId}) as r`;
      return rows[0]?.r?.changed === true;
    },
    async openWebQuestions(reporterIds) {
      if (reporterIds.length === 0) return [];
      return sql<OpenWebQuestion[]>`
        select r.id as report_id, q.id as question_id, r.reporter_id
        from reports r join questions q on q.report_id = r.id
        where r.reporter_id = any(${pgArray(reporterIds)}::uuid[]) and r.status = 'awaiting_answer'
          and q.channel = 'web' and q.answered_at is null
        order by q.created_at desc, q.id`;
    },
    async answerQuestionByWhatsapp(input) {
      const rows = await sql<
        Array<{ r: { status: string; reportStatus: string; jobId: number | null } }>
      >`
        select field_answer_question(${input.reportId}::uuid, ${input.questionId}::uuid,
          ${input.reporterId}::uuid, ${sql.json(input.base as never)}::jsonb,
          ${sql.json(input.data as never)}::jsonb, ${sql.json(input.answer as never)}::jsonb,
          ${sql.json({ type: 'answer', questionId: input.questionId } as never)}::jsonb,
          ${input.newCompany === null ? null : sql.json(input.newCompany as never)}::jsonb,
          'whatsapp'::field_channel, ${input.messageId}::uuid) as r`;
      return rows[0]!.r;
    },
    async linkedContactOrgs(phone, country) {
      const rows = await sql<Array<{ org_id: string }>>`
        select distinct u.org_id from unknown_contacts u
        join orgs o on o.id = u.org_id
        where u.phone_e164 = ${phone} and u.status = 'linked'
          and o.country = ${country} and not o.is_demo`;
      return rows.map((r) => r.org_id);
    },
    async applyInboundChange(input) {
      const patch = Object.fromEntries(
        Object.entries(input.patch).filter(([, v]) => v !== undefined),
      ) as Record<string, string | null>;
      const a = input.audit;
      const n = input.notification;
      await sql.begin(async (tx) => {
        await tx`update reporters set ${tx(patch, Object.keys(patch))} where id = ${input.reporterId}`;
        await tx`select log_audit(${a.org_id}, ${a.actor_type}, ${a.actor_id ?? null}, ${a.action},
          ${a.entity ?? null}, ${a.entity_id ?? null}, ${tx.json((a.diff ?? null) as never)})`;
        if (n) {
          await tx`select notify_org(${n.orgId}, ${n.kind}, ${n.title}, ${n.body}, ${n.targetPath}, null,
            ${n.data ? tx.json(n.data as never) : null}::jsonb)`;
        }
      });
    },
    async isSmsOptedOut(phone, country) {
      const rows = await sql<Array<{ n: number }>>`
        select count(*)::int as n from sms_opt_outs where phone_e164 = ${phone} and country = ${country}`;
      return (rows[0]?.n ?? 0) > 0;
    },
    async recordSmsOptOut(row) {
      await sql`insert into sms_opt_outs (phone_e164, country, method)
        values (${row.phone_e164}, ${row.country}, ${row.method})
        on conflict (phone_e164, country) do nothing`;
    },
    async clearSmsOptOut(phone, country) {
      await sql`delete from sms_opt_outs where phone_e164 = ${phone} and country = ${country}`;
    },
    async listPersonalLinks(reporterId) {
      return sql<Array<{ id: string; code_hash: string }>>`
        select id, code_hash from field_links
        where reporter_id = ${reporterId} and kind = 'personal' and revoked_at is null
        order by created_at desc`;
    },
    async insertPersonalLink(row) {
      const rows = await sql<Array<{ id: string }>>`
        insert into field_links (id, code_hash, reporter_id, kind)
        values (${row.id}, ${row.code_hash}, ${row.reporter_id}, 'personal')
        on conflict (code_hash) do nothing returning id`;
      return rows.length > 0;
    },
    async insertConsoleEmail(row) {
      const key = row.dedupe_key ?? null;
      const rows = await sql<Array<{ id: string }>>`
        insert into console_emails (org_id, kind, recipients, subject, body_text, attachments, dedupe_key)
        values (${row.org_id}, ${row.kind}, ${row.recipients}, ${row.subject}, ${row.body_text},
          ${sql.json(row.attachments as never)}, ${key})
        on conflict (dedupe_key) do nothing
        returning id`;
      if (rows[0]) return rows[0].id;
      // A retried send_email: the key's row is already filed.
      const [existing] = await sql<Array<{ id: string }>>`
        select id from console_emails where dedupe_key = ${key}`;
      return existing!.id;
    },

    // notifications & audit ---------------------------------------------------------------
    async notifyOrg(
      orgId,
      kind,
      title,
      body = null,
      targetPath = null,
      userId = null,
      data = null,
    ) {
      const rows = await sql<Array<{ notify_org: string }>>`select notify_org(${orgId}, ${kind},
        ${title}, ${body}, ${targetPath}, ${userId},
        ${data ? sql.json(data as never) : null}::jsonb) as notify_org`;
      return rows[0]!.notify_org;
    },
    async logAudit(input) {
      await sql`select log_audit(${input.org_id}, ${input.actor_type}, ${input.actor_id ?? null}, ${input.action}, ${input.entity ?? null}, ${input.entity_id ?? null}, ${sql.json((input.diff ?? null) as never)})`;
    },

    // jobs --------------------------------------------------------------------------------
    async claimJobs(worker, limit) {
      return sql<JobRow[]>`select * from claim_jobs(${worker}, ${limit})`;
    },
    async completeJob(id) {
      await sql`select complete_job(${id})`;
    },
    async failJob(id, error) {
      await sql`select fail_job(${id}, ${error.slice(0, 4000)})`;
    },
    async heartbeatJob(id, worker) {
      const rows = await sql`
        update jobs set locked_at = now()
        where id = ${id} and status = 'running' and locked_by = ${worker}
        returning id`;
      return rows.length > 0;
    },
    async getJob(id) {
      return one(await sql<JobRow[]>`select * from jobs where id = ${id}`);
    },
    async getUploadOwner(id) {
      return one(
        await sql<
          Array<{
            id: string;
            report_id: string | null;
            reporter_id: string | null;
            site_id: string;
          }>
        >`select id, report_id, reporter_id, site_id from uploads where id = ${id}`,
      );
    },
    async enqueueJob(type, payload, opts = {}) {
      const enqueue = async () => {
        const rows = await sql<
          Array<{ enqueue_job: number }>
        >`select enqueue_job(${type}, ${sql.json(payload as never)},
          coalesce(${iso(opts.runAfter) ?? null}::timestamptz,
                   now() + ${Math.max(0, Math.round(opts.delayMs ?? 0))}::bigint * interval '1 millisecond'),
          ${opts.dedupeKey ?? null}) as enqueue_job`;
        return rows[0]!.enqueue_job;
      };
      try {
        return await enqueue();
      } catch (err) {
        // Since W1-10 (GAP D16) enqueue_job() inserts `on conflict (dedupe_key) do nothing` and
        // answers a taken key with its job, so a concurrent enqueue of one key no longer raises.
        // Before that migration (a worker deployed ahead of it) the loser of two concurrent
        // enqueues hit the partial index jobs_dedupe_key_active; the winner's job is the answer.
        if (opts.dedupeKey && LEGACY_DEDUPE_INDEXES.some((c) => isUniqueViolation(err, c)))
          return enqueue();
        throw err;
      }
    },
    async updateJobMetrics(id, metrics) {
      await sql`update jobs set payload = payload || jsonb_build_object('metrics', ${sql.json(metrics as never)}::jsonb) where id = ${id}`;
    },
    async queueStats() {
      const rows = await sql<
        Array<{ status: string; n: number }>
      >`select status::text as status, count(*)::int as n from jobs where status in ('queued','running','dead') group by status`;
      const get = (s: string) => rows.find((r) => r.status === s)?.n ?? 0;
      return { queued: get('queued'), running: get('running'), dead: get('dead') };
    },

    // cost per report ------------------------------------------------------------------
    async reportCostInputs(reportId) {
      const rows = await sql<
        Array<{
          ai_usd: number;
          job_count: number;
          wa_templates: number;
          sms_messages: number;
          whatsapp_templates: number;
        }>
      >`select ai_usd, job_count, wa_templates, sms_messages, whatsapp_templates
          from report_cost_inputs(${reportId})`;
      const r = rows[0];
      return {
        aiUsd: Number(r?.ai_usd ?? 0),
        jobCount: r?.job_count ?? 0,
        waTemplates: r?.wa_templates ?? 0,
        smsMessages: r?.sms_messages ?? 0,
        whatsappTemplates: r?.whatsapp_templates ?? 0,
      };
    },
    async reportCostBaseline({ kind, before, excludeReportId, days }) {
      const rows = await sql<
        Array<{ median_cents: number | null; sample: number }>
      >`select median_cents, sample from report_cost_baseline(${kind}, ${before}, ${excludeReportId}, ${days})`;
      const r = rows[0];
      return {
        medianCents: r?.median_cents == null ? null : Number(r.median_cents),
        sample: r?.sample ?? 0,
      };
    },
    async getReportCost(reportId) {
      return one(
        await sql<ReportCostRow[]>`select * from report_costs where report_id = ${reportId}`,
      );
    },
    async upsertReportCost(input) {
      const rows = await sql<ReportCostRow[]>`
        insert into report_costs (report_id, org_id, kind, filed_at, cost_cents, median_cents, sample, outlier, detail, computed_at)
        values (${input.report_id}, ${input.org_id}, ${input.kind}, ${iso(input.filed_at)}, ${input.cost_cents},
                ${input.median_cents}, ${input.sample}, ${input.outlier}, ${sql.json(input.detail as never)}, now())
        on conflict (report_id) do update set
          cost_cents = excluded.cost_cents, median_cents = excluded.median_cents, sample = excluded.sample,
          outlier = excluded.outlier, detail = excluded.detail, computed_at = excluded.computed_at
        returning *`;
      return rows[0]!;
    },

    // packs, weather, retention, digest ---------------------------------------------------
    async getEvidencePack(id) {
      return one(await sql<EvidencePackRow[]>`select * from evidence_packs where id = ${id}`);
    },
    async updateEvidencePack(id, patch) {
      await sql`update evidence_packs set ${setClause(patch as Record<string, unknown>)} where id = ${id}`;
    },
    async listWeatherEvents(siteId, start, end) {
      return sql<
        WeatherEventRow[]
      >`select * from current_weather where site_id = ${siteId} and date between ${start} and ${end} order by date, start_local`;
    },
    async listExpiredMedia(before, limit) {
      // Uploads not purged yet; a message's file only when no upload holds it (WhatsApp media
      // the worker stored after the backfill, or never attached to a report).
      return sql<ExpiredMedia[]>`
        select id, storage_path, bucket, created_at from (
          select u.id, u.storage_path, case u.kind when 'audio' then 'audio' else 'photos' end as bucket,
                 coalesce(u.received_at, u.recorded_at) as created_at
          from uploads u
          where u.purged_at is null and coalesce(u.received_at, u.recorded_at) < ${before.toISOString()}
          union all
          select m.id, m.storage_path, case m.type when 'audio' then 'audio' else 'photos' end, m.created_at
          from messages m
          where m.direction = 'in' and m.storage_path is not null and m.type in ('audio','image','document')
            and m.created_at < ${before.toISOString()}
            and not exists (select 1 from uploads u where u.id = m.id)
        ) media
        order by created_at, id limit ${limit}`;
    },
    async getTestClip(id) {
      return one(await sql<TestClipRow[]>`select * from test_clips where id = ${id}`);
    },
    async saveTestClipResult(id, result) {
      return sql.begin(async (tx) => {
        const failed = 'failed' in result;
        const rows = await tx<TestClipRow[]>`
          update test_clips set
            transcribed_at = ${failed ? null : sql`now()`},
            failed_at = ${failed ? sql`now()` : null},
            heard = ${failed ? null : result.heard},
            snippet = ${failed ? null : result.snippet}
          where id = ${id} and deleted_at is null and transcribed_at is null and failed_at is null
          returning *`;
        const row = rows[0];
        if (!row) return false;
        await tx`select log_audit(${row.org_id}, 'agent', null,
            ${failed ? 'test_clip.failed' : 'test_clip.transcribed'}, 'test_clip', ${row.id},
            ${tx.json((failed ? {} : { heard: result.heard, provider: result.provider }) as never)})`;
        return true;
      });
    },
    async deleteTestClip(id, reason) {
      return sql.begin(async (tx) => {
        const rows = await tx<TestClipRow[]>`
          update test_clips set deleted_at = now(), snippet = null
          where id = ${id} and deleted_at is null
          returning *`;
        const row = rows[0];
        if (!row) return null;
        await tx`select log_audit(${row.org_id}, 'system', null, 'test_clip.deleted', 'test_clip',
            ${row.id}, ${tx.json({ reason, read: row.read_at !== null } as never)})`;
        return row;
      });
    },
    async listExpiredTestClips(before, limit) {
      return sql<TestClipRow[]>`select * from test_clips
        where created_at < ${before.toISOString()}
          and (deleted_at is null
               or created_at >= ${before.toISOString()}::timestamptz - interval '2 days')
        order by (deleted_at is null) desc, created_at limit ${limit}`;
    },
    async listOrphanOfficePhotos(before, limit) {
      const rows = await sql<Array<{ name: string }>>`
        select name from list_orphan_office_photos(${before.toISOString()}, ${limit}) name`;
      return rows.map((r) => r.name);
    },
    async getInvoiceSummary(invoiceId) {
      const rows = await sql<
        Array<{
          id: string;
          org_id: string;
          company_name: string;
          invoice_no: string | null;
          period_start: string | null;
          period_end: string | null;
          invoiced_hours: number | null;
          reported_hours: number | null;
          lines: unknown;
        }>
      >`
        select i.id, i.org_id, c.name as company_name, i.invoice_no, i.period_start, i.period_end, i.total_hours as invoiced_hours, i.lines,
          (select sum(cm.hours) from current_manpower cm where cm.company_id = i.company_id and cm.date between coalesce(i.period_start, '1970-01-01') and coalesce(i.period_end, '2999-12-31')) as reported_hours
        from sub_invoices i join companies c on c.id = i.company_id where i.id = ${invoiceId}`;
      const r = rows[0];
      if (!r) return null;
      return {
        id: r.id,
        org_id: r.org_id,
        company_name: r.company_name,
        invoice_no: r.invoice_no,
        period_start: r.period_start,
        period_end: r.period_end,
        invoiced_hours: Number(r.invoiced_hours ?? 0),
        reported_hours: Number(r.reported_hours ?? 0),
        lines: Array.isArray(r.lines) ? (r.lines as InvoiceSummary['lines']) : [],
      };
    },
    async purgeFinishedJobs(before, limit) {
      const rows = await sql<Array<{ id: number }>>`
        delete from jobs where id in (
          select id from jobs where status = 'done' and finished_at < ${before.toISOString()}
          order by id limit ${limit}
        ) returning id`;
      return rows.length;
    },
    async purgeUnknownCallers(before, limit) {
      const rows = await sql<Array<{ recording_path: string | null }>>`
        select recording_path from purge_unknown_callers(${before.toISOString()}::timestamptz, ${limit})`;
      return rows.map((r) => ({ recordingPath: r.recording_path }));
    },
    async purgeMedia(id, purgedAt) {
      await sql.begin(async (tx) => {
        await tx`delete from transcripts where message_id = ${id} or upload_id = ${id}`;
        // The upload row stays (storage_path is required and keeps the deleted object's name):
        // an office photo's source has no other key, and a version still lists the photo.
        await tx`update uploads set purged_at = coalesce(purged_at, ${purgedAt.toISOString()}::timestamptz) where id = ${id}`;
        await tx`update messages set storage_path = null, payload = coalesce(payload, '{}'::jsonb) || jsonb_build_object('purged_at', ${purgedAt.toISOString()}::text) where id = ${id}`;
      });
    },
    async digestStats(orgId, weekStart, weekEnd) {
      const days = await sql<Array<{ status: string; is_late: boolean; n: number }>>`
        select sd.status::text as status, coalesce(r.is_late, sd.is_late) as is_late, count(*)::int as n
        from site_days sd join sites s on s.id = sd.site_id left join reports r on r.id = sd.report_id
        where s.org_id = ${orgId} and sd.date between ${weekStart} and ${weekEnd}
        group by 1, 2`;
      const siteDays = days.reduce((a, d) => a + d.n, 0);
      const filed = days.filter((d) => d.status === 'filed').reduce((a, d) => a + d.n, 0);
      const onTime = days
        .filter((d) => d.status === 'filed' && !d.is_late)
        .reduce((a, d) => a + d.n, 0);
      const weather = await sql<Array<{ site_name: string; hours: number }>>`
        select s.name as site_name, sum(w.lost_hours)::numeric as hours from current_weather w join sites s on s.id = w.site_id
        where w.org_id = ${orgId} and w.date between ${weekStart} and ${weekEnd} group by s.id, s.name order by hours desc, s.name`;
      const unsigned = await sql<Array<{ report_no: string; site_name: string; date: string }>>`
        select r.report_no, s.name as site_name, sd.date from reports r join sites s on s.id = r.site_id join site_days sd on sd.id = r.site_day_id
        where r.org_id = ${orgId} and r.status = 'filed' and sd.date between ${weekStart} and ${weekEnd} order by sd.date`;
      const gaps = await sql<Array<{ company_name: string; gap: number }>>`
        select c.name as company_name, (coalesce(i.total_hours, 0) - coalesce((
          select sum(cm.hours) from current_manpower cm where cm.company_id = i.company_id and cm.date between i.period_start and i.period_end), 0))::numeric as gap
        from sub_invoices i join companies c on c.id = i.company_id
        where i.org_id = ${orgId} and i.status <> 'resolved' and i.period_start <= ${weekEnd} and i.period_end >= ${weekStart}`;
      return {
        siteDays,
        filed,
        onTime,
        weatherHoursBySite: weather.map((w) => ({ siteName: w.site_name, hours: Number(w.hours) })),
        unsigned: unsigned.map((u) => ({
          reportNo: u.report_no,
          siteName: u.site_name,
          date: u.date,
        })),
        invoiceGaps: gaps
          .filter((g) => Number(g.gap) !== 0)
          .map((g) => ({ companyName: g.company_name, gap: Number(g.gap) })),
      };
    },

    async close() {
      await sql.end({ timeout: 5 });
    },
  };
  return db;
}

export function connectDb(url: string, opts: { max?: number } = {}): Db {
  return createDb(connectSql(url, opts));
}
