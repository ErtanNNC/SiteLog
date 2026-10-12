import type {
  CompanyStatus,
  ConvoState,
  JobStatus,
  MemberRole,
  MsgDirection,
  MsgStatus,
  MsgType,
  PackStatus,
  ReportStatus,
  ReporterRole,
  ReporterStatus,
  SenderStatus,
  SiteDayStatus,
  SiteStatus,
  TermKind,
  TermStatus,
  VersionAuthor,
} from '../enums.ts';

/**
 * Hand-maintained Supabase `Database` type for @supabase/supabase-js (§6.3).
 * Regenerate with `supabase gen types typescript --local > packages/shared/src/db/generated.ts`
 * once a local Supabase is available; keep this file in sync with the migrations.
 */

type Json = string | number | boolean | null | { [key: string]: Json | undefined } | Json[];

/** Insert type: columns with defaults / nullable become optional. */
type Insert<Row, Optional extends keyof Row> = Omit<Row, Optional> & Partial<Pick<Row, Optional>>;

export type OrgRow = {
  id: string;
  name: string;
  address: string | null;
  license_no: string | null;
  logo_path: string | null;
  timezone: string;
  stripe_customer_id: string | null;
  stripe_subscription_id: string | null;
  billing_status: string | null;
  trial_ends_at: string | null;
  created_at: string;
};

export type OrgMemberRow = {
  org_id: string;
  user_id: string;
  role: MemberRole;
  display_name: string | null;
  title: string | null;
  created_at: string;
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
  conversation_id: string;
  direction: MsgDirection;
  wa_message_id: string | null;
  type: MsgType;
  body: string | null;
  payload: Json | null;
  media_id: string | null;
  media_mime: string | null;
  storage_path: string | null;
  duration_s: number | null;
  template_name: string | null;
  status: MsgStatus;
  error: string | null;
  created_at: string;
};

export type TranscriptRow = {
  id: string;
  message_id: string;
  language: string | null;
  text: string;
  segments: Json;
  model: string | null;
  created_at: string;
};

export type UnknownSenderRow = {
  id: string;
  org_id: string | null;
  phone_e164: string;
  first_message_id: string | null;
  snippet: string | null;
  guessed_site_id: string | null;
  status: SenderStatus;
  created_at: string;
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
};

export type ReportSourceRow = {
  id: string;
  report_id: string;
  message_id: string;
  kind: 'audio' | 'photo' | 'text' | 'reply';
  caption: string | null;
  taken_at: string | null;
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
  dedupe_key: string | null;
  /** `convo:<id>`: jobs of one conversation run one at a time (20261012000004_queue_fairness.sql). */
  lock_key: string | null;
  created_at: string;
  finished_at: string | null;
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

type Table<Row, OptionalInsert extends keyof Row> = {
  Row: Row;
  Insert: Insert<Row, OptionalInsert>;
  Update: Partial<Row>;
  Relationships: [];
};

export type Database = {
  public: {
    Tables: {
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
      >;
      org_members: Table<OrgMemberRow, 'role' | 'display_name' | 'title' | 'created_at'>;
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
        | 'wa_message_id'
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
      >;
      transcripts: Table<TranscriptRow, 'id' | 'language' | 'model' | 'created_at'>;
      unknown_senders: Table<
        UnknownSenderRow,
        | 'id'
        | 'org_id'
        | 'first_message_id'
        | 'snippet'
        | 'guessed_site_id'
        | 'status'
        | 'created_at'
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
      >;
      report_versions: Table<
        ReportVersionRow,
        | 'summary'
        | 'pdf_path'
        | 'author_user_id'
        | 'author_message_id'
        | 'change_note'
        | 'created_at'
      >;
      report_sources: Table<ReportSourceRow, 'id' | 'caption' | 'taken_at'>;
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
        };
        Returns: Json;
      };
      next_report_no: { Args: { p_site_id: string }; Returns: string };
      sign_off_report: { Args: { p_report_id: string }; Returns: Json };
      undo_sign_off: { Args: { p_report_id: string }; Returns: Json };
      create_report_version: {
        Args: { p_report_id: string; p_data: Json; p_change_note: string };
        Returns: Json;
      };
      mark_no_work: { Args: { p_site_day_id: string }; Returns: Json };
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
      enqueue_job: {
        Args: {
          p_type: string;
          p_payload: Json;
          p_run_after?: string | null;
          p_dedupe_key?: string | null;
        };
        Returns: number;
      };
      claim_jobs: { Args: { p_worker: string; p_limit: number }; Returns: JobRow[] };
      complete_job: { Args: { p_job_id: number }; Returns: undefined };
      fail_job: { Args: { p_job_id: number; p_error: string }; Returns: undefined };
      mark_notifications_read: { Args: { p_ids: string[] }; Returns: undefined };
      set_org_logo: {
        Args: { p_org_id: string; p_logo_path: string | null };
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
      company_status: CompanyStatus;
      msg_direction: MsgDirection;
      msg_type: MsgType;
      msg_status: MsgStatus;
      convo_state: ConvoState;
      site_day_status: SiteDayStatus;
      report_status: ReportStatus;
      version_author: VersionAuthor;
      term_status: TermStatus;
      term_kind: TermKind;
      sender_status: SenderStatus;
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
