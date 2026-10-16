import { z } from 'zod';

/**
 * TypeScript mirrors of the Postgres enums (§6.2): supabase/migrations/20261011000001_enums.sql
 * and the v1.2 additions in 20261013000006_enums_v1_2.sql. Labels are in the database's order.
 * Keep both in sync: supabase/db-tests asserts that every PG_ENUMS entry matches pg_enum and that
 * PG_ENUMS lists every enum in `public`; CI's db-types-drift compares db/types.ts `Enums` with the
 * generated types. Each enum also has a Zod schema built from the same array (`…Schema`, listed in
 * PG_ENUM_SCHEMAS).
 *
 * Expand/contract (docs/GAP_ANALYSIS.md §7): step 11 (20261014000003_renames_billing.sql) renamed
 * `reporter_status` `verified` → `active`, `version_author` `reporter_reply` → `reporter` and the
 * type `sender_status` → `contact_status`; `msg_type` and `convo_state` go in step 23. W1-06a
 * (20261014000004_country_packs.sql) added `message_channel`.
 */

export const MEMBER_ROLES = ['admin', 'pm', 'ops', 'accounts'] as const;
export type MemberRole = (typeof MEMBER_ROLES)[number];

export const SITE_STATUSES = ['active', 'paused', 'archived'] as const;
export type SiteStatus = (typeof SITE_STATUSES)[number];

export const REPORTER_ROLES = ['site_manager', 'backup'] as const;
export type ReporterRole = (typeof REPORTER_ROLES)[number];

/** §6.2: `opted_out` and `active` (WhatsApp's `verified` until step 11) from v1.2. */
export const REPORTER_STATUSES = ['invited', 'active', 'opted_out', 'disabled'] as const;
export type ReporterStatus = (typeof REPORTER_STATUSES)[number];

/** The reporter's preferred channel (§2.3): `link` (SMS + web recorder) or `call`. */
export const CONTACT_PREFS = ['link', 'call'] as const;
export type ContactPref = (typeof CONTACT_PREFS)[number];

export const CONSENT_TYPES = ['sms', 'auto_call', 'recording', 'data_processing'] as const;
export type ConsentType = (typeof CONSENT_TYPES)[number];

export const COMPANY_STATUSES = ['confirmed', 'unconfirmed'] as const;
export type CompanyStatus = (typeof COMPANY_STATUSES)[number];

/**
 * How a report or answer reached SiteLog (§6.2 `field_channel`), plus `office` for reports typed
 * in the panel (GAP D13, a recorded deviation). null = v1.0 Meta WhatsApp rows (D13, amended by
 * D49).
 */
export const FIELD_CHANNELS = ['web', 'voice', 'sms', 'office'] as const;
export type FieldChannel = (typeof FIELD_CHANNELS)[number];

/**
 * How SiteLog reaches a person (§6.2 `message_channel`, §4.5; GAP D48): the Notifier's channel
 * order is the person's `reporters.message_channel`, then the country pack's `message_channels`.
 * Separate from `field_channel` (how a report reached SiteLog): push is never inbound. Week 1
 * builds SMS only; WhatsApp (through Twilio) and web push come with M6 (week 2).
 */
export const MESSAGE_CHANNELS = ['sms', 'whatsapp', 'push'] as const;
export type MessageChannel = (typeof MESSAGE_CHANNELS)[number];

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

/**
 * `undeliverable` from v1.2 (SMS). `read` is kept for WhatsApp receipts (D49); step 23 does not
 * recreate msg_status.
 */
export const MSG_STATUSES = [
  'received',
  'queued',
  'sent',
  'delivered',
  'read',
  'failed',
  'undeliverable',
] as const;
export type MsgStatus = (typeof MSG_STATUSES)[number];

export const LINK_KINDS = ['personal', 'daily', 'photos'] as const;
export type LinkKind = (typeof LINK_KINDS)[number];

export const UPLOAD_KINDS = ['audio', 'photo'] as const;
export type UploadKind = (typeof UPLOAD_KINDS)[number];

export const CALL_DIRECTIONS = ['inbound', 'outbound'] as const;
export type CallDirection = (typeof CALL_DIRECTIONS)[number];

/** Phone network (SIP) or Talk now in the browser. */
export const CALL_TRANSPORTS = ['pstn', 'web'] as const;
export type CallTransport = (typeof CALL_TRANSPORTS)[number];

export const CALL_STATUSES = [
  'queued',
  'ringing',
  'in_progress',
  'completed',
  'no_answer',
  'busy',
  'failed',
  'voicemail',
] as const;
export type CallStatus = (typeof CALL_STATUSES)[number];

export const CALL_OUTCOMES = [
  'filed',
  'draft_saved',
  'no_work',
  'weather_day',
  'edit_applied',
  'callback_requested',
  'fallback_recording',
  'abandoned',
  'not_reached',
] as const;
export type CallOutcome = (typeof CALL_OUTCOMES)[number];

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

/** `processing` from v1.2 (§7.2). */
export const REPORT_STATUSES = [
  'collecting',
  'processing',
  'awaiting_answer',
  'awaiting_confirmation',
  'filed',
  'signed_off',
  'void',
] as const;
export type ReportStatus = (typeof REPORT_STATUSES)[number];

/** §6.2: `reporter` (WhatsApp's `reporter_reply` until step 11) is a version the site manager wrote. */
export const VERSION_AUTHORS = ['agent', 'reporter', 'office_user'] as const;
export type VersionAuthor = (typeof VERSION_AUTHORS)[number];

/*
 * Step 10 read both labels of a renamed enum while step 11 was pending. Since step 11 the database
 * holds only the new ones (the rename changes every row with it), and no code of this commit runs
 * against a database without that migration (the W1-19 cut-over pushes the database before it
 * deploys the functions, the worker and the panel), so these accept the §6.2 labels only.
 */

/** A reporter who has accepted (§6.2 `active`). */
export function isActiveReporterStatus(status: string): boolean {
  return status === 'active';
}

/** A version the site manager wrote (§6.2 `reporter`), not the agent or the office. */
export function isReporterAuthor(author: string): boolean {
  return author === 'reporter';
}

/** What a report source is (§6.3 `report_sources.kind`, §10.3 `source[].type`). */
export const SOURCE_KINDS = ['voice_note', 'call', 'photo', 'answer', 'text'] as const;
export type SourceKind = (typeof SOURCE_KINDS)[number];

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

/** An unknown caller or texter held for the office (§6.3 `unknown_contacts.status`). */
export const CONTACT_STATUSES = ['pending', 'linked', 'ignored'] as const;
export type ContactStatus = (typeof CONTACT_STATUSES)[number];

export const JOB_STATUSES = ['queued', 'running', 'done', 'failed', 'dead'] as const;
export type JobStatus = (typeof JOB_STATUSES)[number];

export const PACK_STATUSES = ['queued', 'building', 'ready', 'failed'] as const;
export type PackStatus = (typeof PACK_STATUSES)[number];

/** Job types handled by apps/worker (§10.1). */
export const JOB_TYPES = [
  'inbound_message',
  /** A Twilio text stored by sms-webhook (W1-08): the keywords and the reply run in the worker. */
  'sms_inbound',
  'transcribe_audio',
  /** A field upload's voice note (W1-07 enqueues it; the handler is W1-11). */
  'transcribe_upload',
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
  /** A message to a field reporter through the Notifier (§10.1, D48; W1-10). */
  'notify',
  /**
   * §10.7 (W2-09): a spoken *Other…* answer of the web recorder: the clip transcribed, then
   * `parse_answer` (the model) and the value applied in code, or the question asked once more.
   */
  'parse_answer',
  /** F4's test recording (W2-13): transcribed into the snippet, the file deleted at once. */
  'transcribe_test_clip',
  /** F4: the test recording and its words gone 10 minutes after it was made, read or not. */
  'delete_test_clip',
  /**
   * §10.6 (W2-10, F8 *Fix by voice*): a correction of the web draft (a short clip, or typed
   * words): the clip transcribed, `apply_correction` (the model) proposes operations, code applies
   * them and makes the preview; nothing changes the draft until the reporter saves it.
   */
  'apply_correction',
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

/** All enum names → values, for the DB sync test (every Postgres enum in `public`). */
export const PG_ENUMS = {
  member_role: MEMBER_ROLES,
  site_status: SITE_STATUSES,
  reporter_role: REPORTER_ROLES,
  reporter_status: REPORTER_STATUSES,
  contact_pref: CONTACT_PREFS,
  consent_type: CONSENT_TYPES,
  company_status: COMPANY_STATUSES,
  field_channel: FIELD_CHANNELS,
  message_channel: MESSAGE_CHANNELS,
  msg_direction: MSG_DIRECTIONS,
  msg_type: MSG_TYPES,
  msg_status: MSG_STATUSES,
  convo_state: CONVO_STATES,
  link_kind: LINK_KINDS,
  upload_kind: UPLOAD_KINDS,
  call_direction: CALL_DIRECTIONS,
  call_transport: CALL_TRANSPORTS,
  call_status: CALL_STATUSES,
  call_outcome: CALL_OUTCOMES,
  site_day_status: SITE_DAY_STATUSES,
  report_status: REPORT_STATUSES,
  version_author: VERSION_AUTHORS,
  source_kind: SOURCE_KINDS,
  term_status: TERM_STATUSES,
  term_kind: TERM_KINDS,
  contact_status: CONTACT_STATUSES,
  job_status: JOB_STATUSES,
  pack_status: PACK_STATUSES,
} as const;
export type PgEnumName = keyof typeof PG_ENUMS;

// Zod schemas, built from the arrays above ----------------------------------------------------------
export const MemberRoleSchema = z.enum(MEMBER_ROLES);
export const SiteStatusSchema = z.enum(SITE_STATUSES);
export const ReporterRoleSchema = z.enum(REPORTER_ROLES);
export const ReporterStatusSchema = z.enum(REPORTER_STATUSES);
export const ContactPrefSchema = z.enum(CONTACT_PREFS);
export const ConsentTypeSchema = z.enum(CONSENT_TYPES);
export const CompanyStatusSchema = z.enum(COMPANY_STATUSES);
export const FieldChannelSchema = z.enum(FIELD_CHANNELS);
export const MessageChannelSchema = z.enum(MESSAGE_CHANNELS);
export const MsgDirectionSchema = z.enum(MSG_DIRECTIONS);
export const MsgTypeSchema = z.enum(MSG_TYPES);
export const MsgStatusSchema = z.enum(MSG_STATUSES);
export const ConvoStateSchema = z.enum(CONVO_STATES);
export const LinkKindSchema = z.enum(LINK_KINDS);
export const UploadKindSchema = z.enum(UPLOAD_KINDS);
export const CallDirectionSchema = z.enum(CALL_DIRECTIONS);
export const CallTransportSchema = z.enum(CALL_TRANSPORTS);
export const CallStatusSchema = z.enum(CALL_STATUSES);
export const CallOutcomeSchema = z.enum(CALL_OUTCOMES);
export const SiteDayStatusSchema = z.enum(SITE_DAY_STATUSES);
export const ReportStatusSchema = z.enum(REPORT_STATUSES);
export const VersionAuthorSchema = z.enum(VERSION_AUTHORS);
export const SourceKindSchema = z.enum(SOURCE_KINDS);
export const TermStatusSchema = z.enum(TERM_STATUSES);
export const TermKindSchema = z.enum(TERM_KINDS);
export const ContactStatusSchema = z.enum(CONTACT_STATUSES);
export const JobStatusSchema = z.enum(JOB_STATUSES);
export const PackStatusSchema = z.enum(PACK_STATUSES);

/** Postgres enum name → its Zod schema (same keys as PG_ENUMS). */
export const PG_ENUM_SCHEMAS = {
  member_role: MemberRoleSchema,
  site_status: SiteStatusSchema,
  reporter_role: ReporterRoleSchema,
  reporter_status: ReporterStatusSchema,
  contact_pref: ContactPrefSchema,
  consent_type: ConsentTypeSchema,
  company_status: CompanyStatusSchema,
  field_channel: FieldChannelSchema,
  message_channel: MessageChannelSchema,
  msg_direction: MsgDirectionSchema,
  msg_type: MsgTypeSchema,
  msg_status: MsgStatusSchema,
  convo_state: ConvoStateSchema,
  link_kind: LinkKindSchema,
  upload_kind: UploadKindSchema,
  call_direction: CallDirectionSchema,
  call_transport: CallTransportSchema,
  call_status: CallStatusSchema,
  call_outcome: CallOutcomeSchema,
  site_day_status: SiteDayStatusSchema,
  report_status: ReportStatusSchema,
  version_author: VersionAuthorSchema,
  source_kind: SourceKindSchema,
  term_status: TermStatusSchema,
  term_kind: TermKindSchema,
  contact_status: ContactStatusSchema,
  job_status: JobStatusSchema,
  pack_status: PackStatusSchema,
} as const satisfies Record<PgEnumName, z.ZodEnum>;
