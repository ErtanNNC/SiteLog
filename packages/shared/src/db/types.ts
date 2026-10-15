import type {
  CallDirection,
  CallOutcome,
  CallStatus,
  CallTransport,
  CompanyStatus,
  ConsentType,
  ContactPref,
  ConvoState,
  FieldChannel,
  JobStatus,
  LinkKind,
  MemberRole,
  MessageChannel,
  MsgDirection,
  MsgStatus,
  MsgType,
  PackStatus,
  ReportStatus,
  ReporterRole,
  ReporterStatus,
  ContactStatus,
  SiteDayStatus,
  SiteStatus,
  SourceKind,
  TermKind,
  TermStatus,
  UploadKind,
  VersionAuthor,
} from '../enums.ts';
import type { ReportLanguage, OrgLocale, ReporterLocale, UnitSystem } from '../locale.ts';
import type { PaperSize, SmsProvider, SmsSenderType, WhatsappProvider } from '../countries.ts';

/**
 * Hand-maintained Supabase `Database` type for @supabase/supabase-js (§6.3).
 * Regenerate with `supabase gen types typescript --local > packages/shared/src/db/generated.ts`
 * once a local Supabase is available; keep this file in sync with the migrations.
 */

type Json = string | number | boolean | null | { [key: string]: Json | undefined } | Json[];

/** Insert type: columns with defaults / nullable become optional. */
type Insert<Row, Optional extends keyof Row> = Omit<Row, Optional> & Partial<Pick<Row, Optional>>;

/**
 * A country pack (spec §4.6; 20261014000004_country_packs.sql, GAP D47). Every signed-in user
 * reads the table; policy values change only by migration, and sms_sender_id / voice_number only
 * through the service-role set_country_endpoints(). Parse a row with `CountryRowSchema`
 * (countries.ts), whose inferred type is this one.
 */
export type CountryRow = {
  /** ISO 3166-1 alpha-2, e.g. 'US', 'TR'. */
  code: string;
  default_locale: OrgLocale;
  field_locales: ReporterLocale[];
  units: UnitSystem;
  paper: PaperSize;
  /** ISO 4217. */
  currency: string;
  /** IANA; create_org's time zone when the wizard sends none. */
  default_timezone: string;
  message_channels: MessageChannel[];
  /** Column default 'twilio' (D48). */
  sms_provider: SmsProvider;
  whatsapp_provider: WhatsappProvider;
  sms_sender_type: SmsSenderType;
  /** Per environment; null = console (not registered in this database). */
  sms_sender_id: string | null;
  two_way_sms: boolean;
  sms_links_allowed: boolean;
  /** Per environment, E.164; null = Talk now only. */
  voice_number: string | null;
  legal_keys: { privacy_notice?: string; recording_notice?: string; consent?: string };
  created_at: string;
};

export type OrgRow = {
  id: string;
  name: string;
  address: string | null;
  license_no: string | null;
  logo_path: string | null;
  timezone: string;
  /**
   * Legacy (step 23 drops them): kept equal to billing_customer_id / billing_subscription_id by
   * the orgs_billing_ids trigger (20261014000003_renames_billing.sql). Read and write billing_*.
   */
  stripe_customer_id: string | null;
  stripe_subscription_id: string | null;
  billing_status: string | null;
  trial_ends_at: string | null;
  created_at: string;
  /**
   * §6.3 profile (20261013000007_schema_expand_v1_2.sql). An admin may update name, address,
   * license_no, tax_no, timezone, locale and units directly; country, currency, logo_path, the
   * billing columns and is_demo only through the service role or RPCs (column grants).
   * create_org presets locale, units, currency and timezone from the country pack.
   *
   * country: countries.code (a foreign key since 20261014000004), the org's country pack.
   */
  country: string;
  /** Report language and the panel's default (§0 Conventions). */
  locale: 'en-US' | 'tr-TR';
  units: 'imperial' | 'metric';
  currency: string;
  tax_no: string | null;
  /** Demo orgs: console transport on every message channel and the Demo phone (§4.5, §5.2). */
  is_demo: boolean;
  /** §6.3 billing (20261014000003): 'stripe' (US); service role and RPCs only. */
  billing_provider: string | null;
  billing_customer_id: string | null;
  billing_subscription_id: string | null;
};

export type OrgMemberRow = {
  org_id: string;
  user_id: string;
  role: MemberRole;
  display_name: string | null;
  title: string | null;
  created_at: string;
  /** The user's panel language; null → the org locale (§11.2). */
  ui_locale: string | null;
};

export type OrgSettingsRow = {
  org_id: string;
  default_deadline: string;
  working_days: number[];
  default_shift_hours: number;
  heads_up_enabled: boolean;
  heads_up_offset_min: number;
  reminder1_enabled: boolean;
  reminder1_offset_min: number;
  reminder2_enabled: boolean;
  reminder2_offset_min: number;
  missing_enabled: boolean;
  missing_offset_min: number;
  required_fields: string[];
  filing_mode: string;
  signoff_required: boolean;
  email_pdf_on_file: boolean;
  max_questions_per_report: number;
  payroll_csv_format: string;
  pdf_paper: string;
  pdf_footer_enabled: boolean;
  pdf_max_photos: number;
  letterhead_lines: string[];
  no_work_pdf: boolean;
  include_unconfirmed_in_payroll: boolean;
  past_due_grace_days: number;
  /**
   * Payroll CSV column order (20261012000001_web_gaps.sql; defaults to the §F15 order). Read it
   * through `normalizePayrollColumns()`.
   */
  payroll_columns: string[];
  updated_at: string;
  /** §6.3 field channels (20261013000007); nullable as in the spec, each with a default. */
  daily_link_time: string | null;
  auto_call_enabled: boolean | null;
  second_call_enabled: boolean | null;
  call_window_start: string | null;
  call_window_end: string | null;
};

export type SiteRow = {
  id: string;
  org_id: string;
  name: string;
  project_code: string;
  address: string | null;
  lat: number | null;
  lng: number | null;
  timezone: string;
  deadline: string | null;
  working_hours: string | null;
  status: SiteStatus;
  active_since: string | null;
  paused_at: string | null;
  report_seq: number;
  created_at: string;
};

export type ReporterRow = {
  id: string;
  org_id: string;
  name: string;
  phone_e164: string;
  role: ReporterRole;
  languages: string[];
  status: ReporterStatus;
  invited_at: string | null;
  verified_at: string | null;
  last_invite_error: string | null;
  created_at: string;
  /** Language SiteLog speaks and texts: en-US, es-US, tr-TR (§6.3). */
  locale: string;
  contact_pref: ContactPref;
  activated_at: string | null;
  opted_out_at: string | null;
  /** Preferred message channel (20261014000005); null = the country pack's order (§4.5). */
  message_channel: MessageChannel | null;
};

export type SiteReporterRow = {
  site_id: string;
  reporter_id: string;
  is_primary: boolean;
};

export type SiteRecipientRow = {
  site_id: string;
  email: string;
};

export type CompanyRow = {
  id: string;
  org_id: string;
  name: string;
  trade: string | null;
  aliases: string[];
  is_self_perform: boolean;
  status: CompanyStatus;
  created_at: string;
};

export type ConversationRow = {
  id: string;
  org_id: string | null;
  reporter_id: string | null;
  phone_e164: string;
  state: ConvoState;
  context: Json;
  last_inbound_at: string | null;
  last_outbound_at: string | null;
  state_changed_at: string;
  updated_at: string;
};

export type MessageRow = {
  id: string;
  /**
   * null for a photo uploaded in the panel (20261013000005_office_photos.sql) and for an SMS
   * (20261013000007, D15): org_id is set instead, or only phone_e164 for a text from an unknown
   * number (messages_conversation_or_org, 20261014000007_sms_layer.sql).
   */
  conversation_id: string | null;
  /**
   * Set on office uploads and SMS rows of a reporter; a WhatsApp message takes its org from the
   * conversation; null on a text to or from an unknown number (F13).
   */
  org_id: string | null;
  direction: MsgDirection;
  wa_message_id: string | null;
  /**
   * WhatsApp message type; null on SMS rows (nullable since 20261013000007). The W1-06 demo seed
   * is the first writer of SMS rows (the §18 texts, `copy_key` set).
   */
  type: MsgType | null;
  body: string | null;
  /**
   * WhatsApp payload; on SMS rows the Notifier's `{dedupe_key}` (an idempotent retry) and
   * sms-webhook's `{to, keyword, handled_at}` (W1-08).
   */
  payload: Json | null;
  media_id: string | null;
  media_mime: string | null;
  storage_path: string | null;
  duration_s: number | null;
  template_name: string | null;
  status: MsgStatus;
  error: string | null;
  created_at: string;
  /** SMS columns (§6.3 messages, D15): null on WhatsApp and office rows. */
  reporter_id: string | null;
  phone_e164: string | null;
  /** twilio | iletimerkezi | console */
  provider: string | null;
  provider_message_id: string | null;
  /** §9.2 copy key, e.g. `daily_link`. */
  copy_key: string | null;
  /**
   * The message channel (20261014000005): every v1.2 writer sets it. null = v1.0 Meta WhatsApp
   * or office-photo row (NOT NULL at step 23, D49).
   */
  channel: MessageChannel | null;
};

export type TranscriptRow = {
  id: string;
  /**
   * The WhatsApp voice note; null on a v1.2 transcript, which sets upload_id or call_id instead
   * (at most one; nullable since 20261013000007). The W1-06 demo seed writes the first ones (the
   * hero voice note, the unknown caller); the worker's `transcribe_upload` writes upload_id only
   * (W1-11). Readers key a transcript by `upload_id ?? message_id` (`transcriptMediaId`).
   */
  message_id: string | null;
  upload_id: string | null;
  call_id: string | null;
  language: string | null;
  text: string;
  segments: Json;
  model: string | null;
  created_at: string;
};

/**
 * What EMAIL_PROVIDER=console would have sent (20261014000007_sms_layer.sql, spec §6.3), for the
 * Demo phone's Email tab (§11.1). The worker writes it; admins of the org read it. Attachments are
 * named and sized, never stored.
 */
export type ConsoleEmailRow = {
  id: string;
  org_id: string;
  /** The send_email kind, e.g. `report_filed`. */
  kind: string;
  recipients: string[];
  subject: string;
  body_text: string;
  attachments: Array<{ filename: string; bytes: number }>;
  created_at: string;
  /** The send_email job's key (W1-15): a retried job files no second row. */
  dedupe_key: string | null;
};

/**
 * §6.3 unknown_contacts (unknown_senders until 20261014000003). channel is null for the WhatsApp
 * senders (D13); 'sms' or 'voice' from W1-08 and week 2. guessed_site_id is a repo addition.
 */
export type UnknownContactRow = {
  id: string;
  org_id: string | null;
  phone_e164: string;
  message_id: string | null;
  snippet: string | null;
  guessed_site_id: string | null;
  status: ContactStatus;
  created_at: string;
  channel: FieldChannel | null;
  call_id: string | null;
};

export type SiteDayRow = {
  id: string;
  site_id: string;
  date: string;
  status: SiteDayStatus;
  deadline_at: string;
  reminder_stage: number;
  reminders_paused: boolean;
  is_late: boolean;
  weather: Json | null;
  report_id: string | null;
  created_at: string;
  updated_at: string;
};

export type ReportRow = {
  id: string;
  org_id: string;
  site_id: string;
  site_day_id: string;
  report_no: string;
  status: ReportStatus;
  current_version: number;
  reporter_id: string | null;
  received_at: string | null;
  confirmed_at: string | null;
  filed_at: string | null;
  signed_off_by: string | null;
  signed_off_at: string | null;
  needs_review: boolean;
  review_reasons: string[];
  is_late: boolean;
  kind: string;
  created_at: string;
  updated_at: string;
  /** Channel of the first submission; null on WhatsApp-era reports (D13). */
  channel: FieldChannel | null;
  /**
   * Report output language (§6.3, §9.6), from the org locale (`reportLanguageFor`); NOT NULL
   * with no default since 20261014000002 (backfilled 'en'): every writer sets it.
   */
  language: ReportLanguage;
  confirmed_via: FieldChannel | null;
};

export type ReportVersionRow = {
  report_id: string;
  version: number;
  data: Json;
  summary: string | null;
  pdf_path: string | null;
  author: VersionAuthor;
  author_user_id: string | null;
  author_message_id: string | null;
  change_note: string | null;
  created_at: string;
  /** Channel of a reporter edit. */
  via: FieldChannel | null;
  /**
   * The draft revision (20261015000070, NOT NULL default 1): a trigger bumps it on every change of
   * `data` (drafts are overwritten in place), so a confirm names the draft the reporter saw. Always
   * present on a row read from the database; optional here only so in-memory rows (the panel's
   * demo store) need not carry it.
   */
  draft_rev?: number;
};

/**
 * `report_sources.kind`: the §6.2 `source_kind` labels, plus the WhatsApp-era `audio` and `reply`
 * that the WhatsApp worker writes until step 22 (20261014000002 re-keyed the stored ones:
 * audio → voice_note, reply → answer or text). Read with `isVoiceSourceKind` and
 * `isAnswerSourceKind` (report/media.ts), which accept both.
 */
export type ReportSourceKind = SourceKind | 'audio' | 'reply';

export type ReportSourceRow = {
  id: string;
  report_id: string;
  /**
   * The WhatsApp message (or an office photo's message from before 20261014000002). Null for a
   * source with no message: an office photo from 20261014000002 on (upload_id), and the v1.2
   * uploads, calls and answers. `sourceMediaId()` gives a source's media id.
   */
  message_id: string | null;
  kind: ReportSourceKind;
  caption: string | null;
  taken_at: string | null;
  /** The upload; the same UUID as message_id for media backfilled from a message. */
  upload_id: string | null;
  call_id: string | null;
  question_id: string | null;
  /** null on rows from before 20261013000007. */
  created_at: string | null;
};

export type ManpowerEntryRow = {
  id: string;
  report_id: string;
  version: number;
  company_id: string | null;
  company_name_heard: string | null;
  company_name: string | null;
  trade: string | null;
  area: string | null;
  workers: number;
  hours: number;
  hours_basis: string | null;
  source: Json | null;
  confidence: number | null;
};

export type WorkItemRow = {
  id: string;
  report_id: string;
  version: number;
  area: string | null;
  activity: string;
  status: string | null;
  percent: number | null;
  quantity: string | null;
  source: Json | null;
};

export type WeatherEventRow = {
  id: string;
  report_id: string;
  version: number;
  site_id: string;
  date: string;
  start_local: string | null;
  end_local: string | null;
  condition: string | null;
  impact: string | null;
  lost_hours: number;
  full_day: boolean;
  audio_source: Json | null;
  photo_count: number;
  observed: Json | null;
  claim_ready: boolean;
};

export type QuestionRow = {
  id: string;
  report_id: string;
  field: string;
  target: Json | null;
  prompt: string;
  options: Json | null;
  asked_message_id: string | null;
  answered_message_id: string | null;
  answer: Json | null;
  asked_at: string | null;
  answered_at: string | null;
  created_at: string;
  /** null on WhatsApp-era questions (D13). */
  channel: FieldChannel | null;
  call_id: string | null;
  answer_source: Json | null;
};

export type GlossaryTermRow = {
  id: string;
  org_id: string | null;
  scope_site_id: string | null;
  scope_reporter_id: string | null;
  heard: string;
  official: string | null;
  language: string;
  kind: TermKind;
  company_id: string | null;
  status: TermStatus;
  times_heard: number;
  first_seen_at: string;
  last_seen_at: string | null;
};

export type SubInvoiceRow = {
  id: string;
  org_id: string;
  company_id: string;
  invoice_no: string | null;
  period_start: string | null;
  period_end: string | null;
  lines: Json | null;
  total_hours: number | null;
  file_path: string | null;
  status: string;
  queried_at: string | null;
  resolved_at: string | null;
  created_at: string;
};

export type EvidencePackRow = {
  id: string;
  org_id: string;
  site_id: string | null;
  period_start: string;
  period_end: string;
  status: PackStatus;
  pdf_path: string | null;
  sections: string[];
  error: string | null;
  created_by: string | null;
  created_at: string;
  ready_at: string | null;
};

export type JobRow = {
  id: number;
  type: string;
  payload: Json;
  status: JobStatus;
  attempts: number;
  run_after: string;
  locked_at: string | null;
  locked_by: string | null;
  last_error: string | null;
  /**
   * Unique (constraint `jobs_dedupe_key_key`, GAP D16, 20261015000001): a key names one job for
   * good, whatever its status; `enqueue_job()` answers a taken key with that job's id.
   */
  dedupe_key: string | null;
  /** `convo:<id>`: jobs of one conversation run one at a time (20261012000004_queue_fairness.sql). */
  lock_key: string | null;
  created_at: string;
  finished_at: string | null;
};

/** §6.3 consents (20261013000007): admin and ops read them; written by field-api and RPCs. */
export type ConsentRow = {
  id: string;
  reporter_id: string;
  type: ConsentType;
  /** 'web_checkbox' | 'sms_reply_yes' | 'voice_yes' | 'office_attested' */
  method: string;
  text_version: string;
  evidence: Json | null;
  given_at: string;
  revoked_at: string | null;
};

/** §6.3 field_links: service role only (field-api). */
export type FieldLinkRow = {
  id: string;
  code_hash: string;
  reporter_id: string;
  site_id: string | null;
  kind: LinkKind;
  report_date: string | null;
  expires_at: string | null;
  revoked_at: string | null;
  last_opened_at: string | null;
  created_at: string | null;
};

/** §6.3 field_devices: service role only (field-api). */
export type FieldDeviceRow = {
  id: string;
  reporter_id: string;
  device_token_hash: string;
  user_agent: string | null;
  verified_at: string | null;
  last_seen_at: string | null;
  revoked_at: string | null;
  /**
   * The one-time code of F4 (20261014000006_field_api.sql): an HMAC of the device id and the
   * 6-digit code under LINK_SIGNING_SECRET (field-api), never the code; null once verified.
   */
  code_hash: string | null;
  code_expires_at: string | null;
};

/**
 * §6.3 uploads: web recorder files, and office photos (D14: no reporter, `uploaded_by` names the
 * office user). admin, pm and ops read them.
 */
export type UploadRow = {
  id: string;
  report_id: string | null;
  reporter_id: string | null;
  site_id: string;
  kind: UploadKind;
  storage_path: string;
  mime: string | null;
  bytes: number | null;
  duration_s: number | null;
  peaks: Json | null;
  recorded_at: string | null;
  received_at: string | null;
  caption: string | null;
  uploaded_by: string | null;
  /** + Retention deleted the file (20261014000002): the row and its sources' key stay (D12). */
  purged_at: string | null;
};

/** §6.3 calls (rows written from week 2): admin, pm and ops read them. */
export type CallRow = {
  id: string;
  org_id: string | null;
  reporter_id: string | null;
  site_id: string | null;
  report_id: string | null;
  direction: CallDirection;
  transport: CallTransport;
  /** 'daily_report' | 'reminder' | 'callback' | 'edit' */
  purpose: string | null;
  provider_call_id: string | null;
  from_e164: string | null;
  to_e164: string | null;
  status: CallStatus;
  outcome: CallOutcome | null;
  disclosure_played: boolean | null;
  started_at: string | null;
  answered_at: string | null;
  ended_at: string | null;
  duration_s: number | null;
  recording_path: string | null;
  peaks: Json | null;
  dialog_log: Json | null;
  metrics: Json | null;
  created_at: string | null;
};

/**
 * A phone's STOP on a pack's SMS sender (20261014000007_sms_layer.sql, spec §6.3, §9.5): kept with
 * or without a reporter, so the next invite of the number on the pack starts opted out and the
 * Notifier sends it nothing. Service role only.
 */
export type SmsOptOutRow = {
  phone_e164: string;
  /** The pack (`countries.code`). */
  country: string;
  /** `sms_keyword`: STOP or a synonym; `provider_opt_out`: Twilio refused a send (21610). */
  method: 'sms_keyword' | 'provider_opt_out';
  opted_out_at: string;
};

/** §6.3 rate_limits: field-api throttling, service role only. */
export type RateLimitRow = {
  /** 'dev:<device_id>' | 'code:<e164>' */
  key: string;
  window_start: string;
  count: number;
};

export type AuditLogRow = {
  id: number;
  org_id: string | null;
  actor_type: string | null;
  actor_id: string | null;
  action: string;
  entity: string | null;
  entity_id: string | null;
  diff: Json | null;
  created_at: string;
};

export type NotificationRow = {
  id: string;
  org_id: string;
  user_id: string | null;
  kind: string;
  title: string;
  body: string | null;
  target_path: string | null;
  read_at: string | null;
  created_at: string;
};

export type SchedulerStateRow = {
  key: string;
  value: Json;
  updated_at: string;
};

export type StripeEventRow = {
  id: string;
  type: string;
  received_at: string;
  processed_at: string | null;
};

/** SiteLog's own operators (/ops). Not an org role; managed with the service role (§15). */
export type PlatformAdminRow = {
  user_id: string;
  note: string | null;
  created_at: string;
};

/** Cost estimate of a filed report (§15 cost guardrail). Service role + ops RPCs only. */
export type ReportCostRow = {
  report_id: string;
  org_id: string;
  kind: string;
  filed_at: string;
  /** AI + WhatsApp estimate in integer cents. */
  cost_cents: number;
  /** Median of the baseline window when estimated; null when the sample was too small. */
  median_cents: number | null;
  sample: number;
  outlier: boolean;
  /** { aiUsd, waTemplates, waTemplateUsd, jobs } */
  detail: Json;
  computed_at: string;
};

/** ops_queue_stats() row. */
export type OpsQueueStatRow = {
  type: string;
  queued: number;
  running: number;
  dead: number;
  /** Seconds the oldest due (run_after passed) queued job has waited; null when none. */
  oldest_due_s: number | null;
};

/** ops_dead_jobs() row: payload reduced to ids / enum-like fields, error redacted. */
export type OpsDeadJobRow = {
  id: number;
  type: string;
  attempts: number;
  last_error: string | null;
  created_at: string;
  finished_at: string | null;
  payload: Json;
};

/** ops_unknown_contacts() row (20261015000040, spec §19 Q44): a pending contact with no org. */
export type OpsUnknownContactRow = {
  id: string;
  phone_e164: string;
  channel: FieldChannel | null;
  snippet: string | null;
  created_at: string;
};

/** ops_cost_outliers() row. */
export type OpsCostOutlierRow = {
  report_id: string;
  report_no: string;
  org_id: string;
  org_name: string;
  site_id: string;
  site_name: string;
  kind: string;
  filed_at: string;
  cost_cents: number;
  median_cents: number | null;
  sample: number;
  detail: Json;
};

export type CurrentManpowerRow = ManpowerEntryRow & {
  site_id: string;
  org_id: string;
  date: string;
  report_no: string;
  report_status: ReportStatus;
};

export type CurrentWeatherRow = WeatherEventRow & {
  org_id: string;
  report_no: string;
};

/** Reports archive (20261013000002_report_archive.sql): a filed report + its current version's flags. */
export type ReportArchiveRow = ReportRow & {
  date: string;
  site_name: string;
  project_code: string;
  lost_hours: number;
  has_incident: boolean;
  summary: string | null;
};

/**
 * The site names every member of an org reads (20261014000001_queue_rls_fixes.sql): Crew hours'
 * site names and filter for the accounts role, which cannot read `sites`, and the org switcher's
 * active-site count.
 */
export type SiteOptionRow = Pick<
  SiteRow,
  'id' | 'org_id' | 'name' | 'project_code' | 'timezone' | 'status'
>;

type Table<Row, OptionalInsert extends keyof Row> = {
  Row: Row;
  Insert: Insert<Row, OptionalInsert>;
  Update: Partial<Row>;
  Relationships: [];
};

export type Database = {
  public: {
    Tables: {
      countries: Table<
        CountryRow,
        | 'sms_provider'
        | 'whatsapp_provider'
        | 'sms_sender_id'
        | 'voice_number'
        | 'legal_keys'
        | 'created_at'
      >;
      orgs: Table<
        OrgRow,
        | 'id'
        | 'address'
        | 'license_no'
        | 'logo_path'
        | 'timezone'
        | 'stripe_customer_id'
        | 'stripe_subscription_id'
        | 'billing_status'
        | 'trial_ends_at'
        | 'created_at'
        | 'country'
        | 'locale'
        | 'units'
        | 'currency'
        | 'tax_no'
        | 'is_demo'
        | 'billing_provider'
        | 'billing_customer_id'
        | 'billing_subscription_id'
      >;
      org_members: Table<
        OrgMemberRow,
        'role' | 'display_name' | 'title' | 'created_at' | 'ui_locale'
      >;
      org_settings: Table<OrgSettingsRow, Exclude<keyof OrgSettingsRow, 'org_id'>>;
      sites: Table<
        SiteRow,
        | 'id'
        | 'address'
        | 'lat'
        | 'lng'
        | 'deadline'
        | 'working_hours'
        | 'status'
        | 'active_since'
        | 'paused_at'
        | 'report_seq'
        | 'created_at'
      >;
      reporters: Table<
        ReporterRow,
        | 'id'
        | 'role'
        | 'languages'
        | 'status'
        | 'invited_at'
        | 'verified_at'
        | 'last_invite_error'
        | 'created_at'
        | 'locale'
        | 'contact_pref'
        | 'activated_at'
        | 'opted_out_at'
        | 'message_channel'
      >;
      consents: Table<ConsentRow, 'id' | 'evidence' | 'given_at' | 'revoked_at'>;
      field_links: Table<
        FieldLinkRow,
        | 'id'
        | 'site_id'
        | 'report_date'
        | 'expires_at'
        | 'revoked_at'
        | 'last_opened_at'
        | 'created_at'
      >;
      field_devices: Table<
        FieldDeviceRow,
        | 'id'
        | 'user_agent'
        | 'verified_at'
        | 'last_seen_at'
        | 'revoked_at'
        | 'code_hash'
        | 'code_expires_at'
      >;
      site_reporters: Table<SiteReporterRow, 'is_primary'>;
      site_recipients: Table<SiteRecipientRow, never>;
      companies: Table<
        CompanyRow,
        'id' | 'trade' | 'aliases' | 'is_self_perform' | 'status' | 'created_at'
      >;
      conversations: Table<
        ConversationRow,
        | 'id'
        | 'org_id'
        | 'reporter_id'
        | 'state'
        | 'context'
        | 'last_inbound_at'
        | 'last_outbound_at'
        | 'state_changed_at'
        | 'updated_at'
      >;
      messages: Table<
        MessageRow,
        | 'id'
        | 'conversation_id'
        | 'org_id'
        | 'wa_message_id'
        | 'type'
        | 'body'
        | 'payload'
        | 'media_id'
        | 'media_mime'
        | 'storage_path'
        | 'duration_s'
        | 'template_name'
        | 'status'
        | 'error'
        | 'created_at'
        | 'reporter_id'
        | 'phone_e164'
        | 'provider'
        | 'provider_message_id'
        | 'copy_key'
        | 'channel'
      >;
      transcripts: Table<
        TranscriptRow,
        'id' | 'message_id' | 'upload_id' | 'call_id' | 'language' | 'model' | 'created_at'
      >;
      console_emails: Table<ConsoleEmailRow, 'id' | 'attachments' | 'created_at' | 'dedupe_key'>;
      unknown_contacts: Table<
        UnknownContactRow,
        | 'id'
        | 'org_id'
        | 'message_id'
        | 'snippet'
        | 'guessed_site_id'
        | 'status'
        | 'created_at'
        | 'channel'
        | 'call_id'
      >;
      site_days: Table<
        SiteDayRow,
        | 'id'
        | 'status'
        | 'reminder_stage'
        | 'reminders_paused'
        | 'is_late'
        | 'weather'
        | 'report_id'
        | 'created_at'
        | 'updated_at'
      >;
      reports: Table<
        ReportRow,
        | 'id'
        | 'status'
        | 'current_version'
        | 'reporter_id'
        | 'received_at'
        | 'confirmed_at'
        | 'filed_at'
        | 'signed_off_by'
        | 'signed_off_at'
        | 'needs_review'
        | 'review_reasons'
        | 'is_late'
        | 'kind'
        | 'created_at'
        | 'updated_at'
        | 'channel'
        | 'confirmed_via'
      >;
      uploads: Table<
        UploadRow,
        | 'id'
        | 'report_id'
        | 'reporter_id'
        | 'mime'
        | 'bytes'
        | 'duration_s'
        | 'peaks'
        | 'recorded_at'
        | 'received_at'
        | 'caption'
        | 'uploaded_by'
        | 'purged_at'
      >;
      calls: Table<
        CallRow,
        | 'id'
        | 'org_id'
        | 'reporter_id'
        | 'site_id'
        | 'report_id'
        | 'transport'
        | 'purpose'
        | 'provider_call_id'
        | 'from_e164'
        | 'to_e164'
        | 'status'
        | 'outcome'
        | 'disclosure_played'
        | 'started_at'
        | 'answered_at'
        | 'ended_at'
        | 'duration_s'
        | 'recording_path'
        | 'peaks'
        | 'dialog_log'
        | 'metrics'
        | 'created_at'
      >;
      report_versions: Table<
        ReportVersionRow,
        | 'summary'
        | 'pdf_path'
        | 'author_user_id'
        | 'author_message_id'
        | 'change_note'
        | 'created_at'
        | 'via'
        | 'draft_rev'
      >;
      report_sources: Table<
        ReportSourceRow,
        'id' | 'caption' | 'taken_at' | 'upload_id' | 'call_id' | 'question_id' | 'created_at'
      >;
      manpower_entries: Table<
        ManpowerEntryRow,
        | 'id'
        | 'company_id'
        | 'company_name_heard'
        | 'company_name'
        | 'trade'
        | 'area'
        | 'hours_basis'
        | 'source'
        | 'confidence'
      >;
      work_items: Table<WorkItemRow, 'id' | 'area' | 'status' | 'percent' | 'quantity' | 'source'>;
      weather_events: Table<
        WeatherEventRow,
        | 'id'
        | 'start_local'
        | 'end_local'
        | 'condition'
        | 'impact'
        | 'lost_hours'
        | 'full_day'
        | 'audio_source'
        | 'photo_count'
        | 'observed'
        | 'claim_ready'
      >;
      questions: Table<
        QuestionRow,
        | 'id'
        | 'target'
        | 'options'
        | 'asked_message_id'
        | 'answered_message_id'
        | 'answer'
        | 'asked_at'
        | 'answered_at'
        | 'created_at'
        | 'channel'
        | 'call_id'
        | 'answer_source'
      >;
      glossary_terms: Table<
        GlossaryTermRow,
        | 'id'
        | 'org_id'
        | 'scope_site_id'
        | 'scope_reporter_id'
        | 'official'
        | 'language'
        | 'kind'
        | 'company_id'
        | 'status'
        | 'times_heard'
        | 'first_seen_at'
        | 'last_seen_at'
      >;
      sub_invoices: Table<
        SubInvoiceRow,
        | 'id'
        | 'invoice_no'
        | 'period_start'
        | 'period_end'
        | 'lines'
        | 'total_hours'
        | 'file_path'
        | 'status'
        | 'queried_at'
        | 'resolved_at'
        | 'created_at'
      >;
      evidence_packs: Table<
        EvidencePackRow,
        | 'id'
        | 'site_id'
        | 'status'
        | 'pdf_path'
        | 'sections'
        | 'error'
        | 'created_by'
        | 'created_at'
        | 'ready_at'
      >;
      jobs: Table<
        JobRow,
        | 'id'
        | 'status'
        | 'attempts'
        | 'run_after'
        | 'locked_at'
        | 'locked_by'
        | 'last_error'
        | 'dedupe_key'
        | 'lock_key'
        | 'created_at'
        | 'finished_at'
      >;
      rate_limits: Table<RateLimitRow, 'count'>;
      sms_opt_outs: Table<SmsOptOutRow, 'opted_out_at'>;
      scheduler_state: Table<SchedulerStateRow, 'value' | 'updated_at'>;
      stripe_events: Table<StripeEventRow, 'received_at' | 'processed_at'>;
      audit_log: Table<
        AuditLogRow,
        'id' | 'org_id' | 'actor_type' | 'actor_id' | 'entity' | 'entity_id' | 'diff' | 'created_at'
      >;
      notifications: Table<
        NotificationRow,
        'id' | 'user_id' | 'body' | 'target_path' | 'read_at' | 'created_at'
      >;
      platform_admins: Table<PlatformAdminRow, 'note' | 'created_at'>;
      report_costs: Table<
        ReportCostRow,
        'median_cents' | 'sample' | 'outlier' | 'detail' | 'computed_at'
      >;
    };
    Views: {
      current_manpower: { Row: CurrentManpowerRow; Relationships: [] };
      current_weather: { Row: CurrentWeatherRow; Relationships: [] };
      report_archive: { Row: ReportArchiveRow; Relationships: [] };
      site_options: { Row: SiteOptionRow; Relationships: [] };
    };
    Functions: {
      is_member: { Args: { org: string }; Returns: boolean };
      has_role: { Args: { org: string; roles: MemberRole[] }; Returns: boolean };
      my_org_ids: { Args: Record<string, never>; Returns: string[] };
      create_org: {
        Args: {
          p_name: string;
          p_timezone?: string;
          p_address?: string | null;
          p_license_no?: string | null;
          /** countries.code (default 'US'); presets locale, units, currency, time zone, paper. */
          p_country?: string;
        };
        Returns: Json;
      };
      // Service role only (revoked from anon and authenticated): a pack's per-environment values.
      set_country_endpoints: {
        Args: { p_code: string; p_sms_sender_id: string | null; p_voice_number: string | null };
        Returns: CountryRow;
      };
      next_report_no: { Args: { p_site_id: string }; Returns: string };
      // field-api (20261014000006_field_api.sql), service role only: uploads/:id/complete numbers
      // and inserts the site-day's report in one transaction and enqueues transcribe_upload.
      field_complete_upload: {
        Args: { p_upload_id: string; p_reporter_id: string; p_bytes?: number | null };
        Returns: Json;
      };
      // Spec §19 Q53 (20261015000003_late_uploads.sql), service role only: a completed upload
      // that arrived after its day's window → report and site-day late, audited, one notice.
      field_flag_late_upload: {
        Args: { p_upload_id: string; p_reporter_id: string };
        Returns: Json;
      };
      // day-status (F12 buttons): pending or reminded → no_work or weather_day.
      field_set_day_status: {
        Args: {
          p_reporter_id: string;
          p_site_id: string;
          p_date: string;
          p_status: string;
          p_details?: Json;
        };
        Returns: Json;
      };
      // A rolling window per key over rate_limits: {allowed, count, resetAt}.
      field_rate_limit: {
        Args: { p_key: string; p_limit: number; p_window_seconds: number };
        Returns: Json;
      };
      // reports/:id/confirm (F8): enqueues file_report for the confirmed version and draft
      // revision (20261015000070) under the site-day lock: {status: 'queued' | 'filed', jobId, version}.
      field_confirm_report: {
        Args: {
          p_report_id: string;
          p_reporter_id: string;
          p_version: number;
          p_draft_rev: number;
        };
        Returns: Json;
      };
      // reports/:id/answer (W1-12, 20261015000002): stores the draft field-api computed (p_data,
      // over p_base), the answer and its source, report → processing, decide_next queued:
      // {status: 'processing' | 'already_answered', reportStatus, jobId}.
      field_answer_question: {
        Args: {
          p_report_id: string;
          p_question_id: string;
          p_reporter_id: string;
          p_base: Json;
          p_data: Json;
          p_answer: Json;
          p_answer_source: Json;
          /** "Add <company>": {name, manpowerIndex}; the unconfirmed company is created in SQL. */
          p_new_company?: Json | null;
        };
        Returns: Json;
      };
      sign_off_report: { Args: { p_report_id: string }; Returns: Json };
      undo_sign_off: { Args: { p_report_id: string }; Returns: Json };
      // p_photos: new uploads [{path, mime, caption?, takenAt?, position?}] (OfficePhotoUpload), max 20 per call.
      create_report_version: {
        Args: { p_report_id: string; p_data: Json; p_change_note: string; p_photos?: Json };
        Returns: Json;
      };
      mark_no_work: { Args: { p_site_day_id: string }; Returns: Json };
      // Office-entered reports (20261013000001_office_reports.sql): admin / pm / ops, checked in SQL;
      // report data v2 from W1-12 (20261015000002; v1 when the data says schemaVersion 1).
      create_office_report: {
        Args: { p_site_id: string; p_date: string; p_data: Json; p_photos?: Json };
        Returns: Json;
      };
      attach_version_pdf: {
        Args: { p_report_id: string; p_version: number; p_path: string };
        Returns: Json;
      };
      resolve_unknown_company: {
        Args: {
          p_report_id: string;
          p_name: string;
          p_action: string;
          p_company_id?: string | null;
        };
        Returns: Json;
      };
      review_glossary_term: {
        Args: {
          p_term_id: string;
          p_action: string;
          p_official?: string | null;
          p_company_id?: string | null;
        };
        Returns: Json;
      };
      // D16 (20261015000001): `insert … on conflict (dedupe_key) do nothing`; a taken key returns its
      // job's id, whatever its status.
      enqueue_job: {
        Args: {
          p_type: string;
          p_payload: Json;
          p_run_after?: string | null;
          p_dedupe_key?: string | null;
        };
        Returns: number;
      };
      // sms-webhook (20261014000008_sms_inbound.sql), service role only: the inbound text, its
      // `sms.received` audit and (Twilio, not yet handled) its `sms_inbound` job in one transaction.
      receive_sms_inbound: {
        Args: {
          p_id: string;
          p_org_id: string | null;
          p_reporter_id: string | null;
          p_phone_e164: string;
          p_provider: string;
          p_provider_message_id: string;
          p_body: string;
          p_payload: Json;
        };
        Returns: { id: string; duplicate: boolean; handled: boolean; jobId: number | null };
      };
      claim_jobs: { Args: { p_worker: string; p_limit: number }; Returns: JobRow[] };
      complete_job: { Args: { p_job_id: number }; Returns: undefined };
      fail_job: { Args: { p_job_id: number; p_error: string }; Returns: undefined };
      // A dead job back to queued with a fresh budget (D16, 20261015000001; service role only).
      requeue_dead_job: { Args: { p_job_id: number }; Returns: boolean };
      mark_notifications_read: { Args: { p_ids: string[] }; Returns: undefined };
      // §13 roles that see an org-wide notification of a kind (20261014000001), used by RLS.
      notification_audience: { Args: { p_kind: string }; Returns: MemberRole[] };
      set_org_logo: {
        Args: { p_org_id: string; p_logo_path: string | null };
        Returns: Json;
      };
      // Company details of an existing org (20261013000004_update_org.sql): admin, audited.
      update_org: {
        Args: {
          p_org_id: string;
          p_name: string;
          p_timezone?: string | null;
          p_address?: string | null;
          p_license_no?: string | null;
        };
        Returns: Json;
      };
      update_reporter: {
        Args: {
          p_reporter_id: string;
          p_name: string;
          p_role: ReporterRole;
          p_site_ids: string[];
          p_languages: string[];
        };
        Returns: Json;
      };
      log_audit: {
        Args: {
          p_org: string | null;
          p_actor_type: string;
          p_actor_id: string | null;
          p_action: string;
          p_entity: string | null;
          p_entity_id: string | null;
          p_diff?: Json | null;
        };
        Returns: undefined;
      };
      mark_site_day_missing: {
        Args: {
          p_site_day_id: string;
          p_missing_at: string;
          p_title: string;
          p_body: string;
        };
        Returns: boolean;
      };
      notify_org: {
        Args: {
          p_org: string;
          p_kind: string;
          p_title: string;
          p_body?: string | null;
          p_target_path?: string | null;
          p_user_id?: string | null;
        };
        Returns: string;
      };
      invoice_gaps: {
        Args: { p_org: string; p_start: string; p_end: string };
        Returns: Array<{
          company_id: string;
          company_name: string;
          invoiced: number;
          reported: number;
          gap: number;
          invoice_id: string;
          invoice_status: string;
        }>;
      };
      // Platform ops (20261012000003_ops.sql): platform admins only, checked in SQL.
      is_platform_admin: { Args: Record<string, never>; Returns: boolean };
      ops_queue_stats: { Args: Record<string, never>; Returns: OpsQueueStatRow[] };
      ops_dead_jobs: { Args: { p_limit?: number }; Returns: OpsDeadJobRow[] };
      ops_retry_job: { Args: { p_job_id: number }; Returns: Json };
      ops_discard_job: { Args: { p_job_id: number }; Returns: Json };
      ops_cost_outliers: { Args: { p_days?: number }; Returns: OpsCostOutlierRow[] };
      // Org-less unknown contacts (20261015000040_unknown_contacts_support.sql, spec §19 Q44).
      ops_unknown_contacts: { Args: { p_limit?: number }; Returns: OpsUnknownContactRow[] };
      ops_assign_unknown_contact: { Args: { p_id: string; p_org_id: string }; Returns: Json };
      ops_ignore_unknown_contact: { Args: { p_id: string }; Returns: Json };
      ops_real_orgs: {
        Args: Record<string, never>;
        Returns: Array<{ id: string; name: string; country: string }>;
      };
      // Worker (service role) only.
      report_cost_inputs: {
        Args: { p_report_id: string };
        Returns: Array<{ ai_usd: number; job_count: number; wa_templates: number }>;
      };
      report_cost_baseline: {
        Args: { p_kind: string; p_before: string; p_exclude?: string | null; p_days?: number };
        Returns: Array<{ median_cents: number | null; sample: number }>;
      };
    };
    Enums: {
      member_role: MemberRole;
      site_status: SiteStatus;
      reporter_role: ReporterRole;
      reporter_status: ReporterStatus;
      contact_pref: ContactPref;
      consent_type: ConsentType;
      company_status: CompanyStatus;
      field_channel: FieldChannel;
      message_channel: MessageChannel;
      msg_direction: MsgDirection;
      msg_type: MsgType;
      msg_status: MsgStatus;
      convo_state: ConvoState;
      link_kind: LinkKind;
      upload_kind: UploadKind;
      call_direction: CallDirection;
      call_transport: CallTransport;
      call_status: CallStatus;
      call_outcome: CallOutcome;
      site_day_status: SiteDayStatus;
      report_status: ReportStatus;
      version_author: VersionAuthor;
      source_kind: SourceKind;
      term_status: TermStatus;
      term_kind: TermKind;
      contact_status: ContactStatus;
      job_status: JobStatus;
      pack_status: PackStatus;
    };
    CompositeTypes: Record<string, never>;
  };
};

export type Tables<T extends keyof Database['public']['Tables']> =
  Database['public']['Tables'][T]['Row'];
export type TablesInsert<T extends keyof Database['public']['Tables']> =
  Database['public']['Tables'][T]['Insert'];
export type TablesUpdate<T extends keyof Database['public']['Tables']> =
  Database['public']['Tables'][T]['Update'];
export type Views<T extends keyof Database['public']['Views']> =
  Database['public']['Views'][T]['Row'];
export type { Json };
