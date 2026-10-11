/**
 * TypeScript mirrors of the Postgres enums in supabase/migrations/0001_enums.sql (§6.2).
 * Keep both in sync — the DB tests assert the values match.
 */

export const MEMBER_ROLES = ['admin', 'pm', 'ops', 'accounts'] as const;
export type MemberRole = (typeof MEMBER_ROLES)[number];

export const SITE_STATUSES = ['active', 'paused', 'archived'] as const;
export type SiteStatus = (typeof SITE_STATUSES)[number];

export const REPORTER_ROLES = ['site_manager', 'backup'] as const;
export type ReporterRole = (typeof REPORTER_ROLES)[number];

export const REPORTER_STATUSES = ['invited', 'verified', 'disabled'] as const;
export type ReporterStatus = (typeof REPORTER_STATUSES)[number];

export const COMPANY_STATUSES = ['confirmed', 'unconfirmed'] as const;
export type CompanyStatus = (typeof COMPANY_STATUSES)[number];

export const MSG_DIRECTIONS = ['in', 'out'] as const;
export type MsgDirection = (typeof MSG_DIRECTIONS)[number];

export const MSG_TYPES = [
  'text',
  'audio',
  'image',
  'document',
  'interactive',
  'template',
  'reaction',
  'unsupported',
] as const;
export type MsgType = (typeof MSG_TYPES)[number];

export const MSG_STATUSES = ['received', 'queued', 'sent', 'delivered', 'read', 'failed'] as const;
export type MsgStatus = (typeof MSG_STATUSES)[number];

export const CONVO_STATES = [
  'new',
  'welcome_sent',
  'test_mode',
  'idle',
  'selecting_site',
  'processing',
  'awaiting_answer',
  'awaiting_confirmation',
  'editing',
] as const;
export type ConvoState = (typeof CONVO_STATES)[number];

export const SITE_DAY_STATUSES = [
  'pending',
  'reminded',
  'processing',
  'filed',
  'weather_day',
  'no_work',
  'missing',
] as const;
export type SiteDayStatus = (typeof SITE_DAY_STATUSES)[number];

export const REPORT_STATUSES = [
  'collecting',
  'awaiting_answer',
  'awaiting_confirmation',
  'filed',
  'signed_off',
  'void',
] as const;
export type ReportStatus = (typeof REPORT_STATUSES)[number];

export const VERSION_AUTHORS = ['agent', 'reporter_reply', 'office_user'] as const;
export type VersionAuthor = (typeof VERSION_AUTHORS)[number];

export const TERM_STATUSES = [
  'built_in',
  'auto_learned',
  'needs_review',
  'confirmed',
  'rejected',
] as const;
export type TermStatus = (typeof TERM_STATUSES)[number];

export const TERM_KINDS = ['term', 'company', 'area', 'unit'] as const;
export type TermKind = (typeof TERM_KINDS)[number];

export const SENDER_STATUSES = ['pending', 'linked', 'ignored'] as const;
export type SenderStatus = (typeof SENDER_STATUSES)[number];

export const JOB_STATUSES = ['queued', 'running', 'done', 'failed', 'dead'] as const;
export type JobStatus = (typeof JOB_STATUSES)[number];

export const PACK_STATUSES = ['queued', 'building', 'ready', 'failed'] as const;
export type PackStatus = (typeof PACK_STATUSES)[number];

/** Job types handled by apps/worker (§10.1). */
export const JOB_TYPES = [
  'inbound_message',
  'transcribe_audio',
  'extract_report',
  'decide_next',
  'parse_reply',
  'file_report',
  'render_pdf',
  'send_email',
  'fetch_weather',
  'send_welcome',
  'send_template',
  'build_evidence_pack',
  'send_message',
  'retention_cleanup',
  'weekly_digest',
] as const;
export type JobType = (typeof JOB_TYPES)[number];

/** Required-field keys accepted in org_settings.required_fields. */
export const REQUIRED_FIELD_KEYS = [
  'manpower',
  'hours',
  'weather',
  'work_performed',
  'safety',
  'photo',
] as const;
export type RequiredFieldKey = (typeof REQUIRED_FIELD_KEYS)[number];

export const FILING_MODES = ['confirm', 'auto_15min'] as const;
export type FilingMode = (typeof FILING_MODES)[number];

export const INVOICE_STATUSES = ['open', 'queried', 'resolved'] as const;
export type InvoiceStatus = (typeof INVOICE_STATUSES)[number];

/** All enum names → values, for the DB sync test. */
export const PG_ENUMS = {
  member_role: MEMBER_ROLES,
  site_status: SITE_STATUSES,
  reporter_role: REPORTER_ROLES,
  reporter_status: REPORTER_STATUSES,
  company_status: COMPANY_STATUSES,
  msg_direction: MSG_DIRECTIONS,
  msg_type: MSG_TYPES,
  msg_status: MSG_STATUSES,
  convo_state: CONVO_STATES,
  site_day_status: SITE_DAY_STATUSES,
  report_status: REPORT_STATUSES,
  version_author: VERSION_AUTHORS,
  term_status: TERM_STATUSES,
  term_kind: TERM_KINDS,
  sender_status: SENDER_STATUSES,
  job_status: JOB_STATUSES,
  pack_status: PACK_STATUSES,
} as const;
