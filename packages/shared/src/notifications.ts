import { z } from 'zod';
import type { MemberRole } from './enums.ts';

/**
 * The office roles that see an org-wide panel notification (`user_id` null) of a kind: the §13
 * recipients, plus admin, who holds every §2.2 capability. The same table as the SQL
 * `notification_audience()` that the notifications policy and `mark_notifications_read()` use
 * (supabase/migrations/20261014000001_queue_rls_fixes.sql; supabase/db-tests compares the two).
 * The demo data source filters with it, so a demo user sees what RLS shows on Supabase.
 */
const AUDIENCE: Readonly<Record<string, readonly MemberRole[]>> = {
  invoice_gap: ['admin', 'ops', 'accounts'], // §13 "Invoice gap: ops, accounts"
  billing: ['admin'], // §13 "Billing: admin"
  missing_report: ['admin', 'ops'], // §13 "Report missing: ops + admin"
  unknown_contact: ['admin', 'ops'], // §13 "Unknown contact: ops, admin"
  unknown_sender: ['admin', 'ops'], // the same, written before step 11 (legacy rows)
  reporter_invite_failed: ['admin', 'ops'], // §13 "Message undeliverable / opted out"
  reporter_opted_out: ['admin', 'ops'], // the same row of §13 (a STOP, W1-08)
  message_failed: ['admin', 'ops'], // the same row of §13: a message job that died (W1-10)
  reporter_wrong_site: ['admin', 'ops'], // §2.2 "Manage reporters": admin, ops
  reporter_consent_revoked: ['admin', 'ops'], // §13 "Consent revoked" (F15, W2-02)
  device_verify_locked: ['admin', 'ops'], // §13 "Device check locked" (F16, W2-03)
};

/** A kind §13 does not list (needs_review, glossary_review, processing_delayed, processing_failed, …). */
const OFFICE: readonly MemberRole[] = ['admin', 'pm', 'ops'];

/** The kinds with their own audience, for tests that compare this table with the SQL one. */
export const NOTIFICATION_AUDIENCE_KINDS = Object.keys(AUDIENCE);

export function notificationAudience(kind: string): readonly MemberRole[] {
  return AUDIENCE[kind] ?? OFFICE;
}

/** Whether a member with `role` sees a notification: their own, or an org-wide one for the role. */
export function seesNotification(
  n: { user_id: string | null; kind: string },
  user: { id: string; role: MemberRole },
): boolean {
  return n.user_id === null
    ? notificationAudience(n.kind).includes(user.role)
    : n.user_id === user.id;
}

/*
 * What a panel notice says, as data (`notifications.data`, migration 20261015000080): the copy key
 * of its wording and the values it names. The panel renders it through its copy in the reader's
 * language (EN/TR, `shell.notifications.notices.<key>`); the row's English `title` / `body` stay
 * the fallback for rows without data (written before the column, or by a deployed producer that
 * does not send it yet) and for a key this panel does not know. A body the office or a reporter
 * wrote (a change note, a heard snippet, glossary terms, a provider's error) is not translated:
 * keys without a body copy show the stored `body`.
 *
 * Values are what the producer knows, never pre-formatted text in a language: dates are ISO
 * (`YYYY-MM-DD`), hours numbers, review reasons their §10.5 codes; names, report numbers and
 * phone numbers (already formatted) as they are.
 */

const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const name = z.string().min(1);
const nameOrNull = z.string().min(1).nullable();
const notice = <K extends string, P extends z.ZodRawShape>(key: K, params: P) =>
  z.object({ key: z.literal(key), params: z.object(params) });

/** Why the welcome text was not sent (the Notifier's refusal, or no sender for the country here). */
export const WELCOME_NOT_SENT_REASONS = [
  'opted_out',
  'no_consent',
  'no_channel',
  'console_real_org',
] as const;

export const noticeDataSchema = z.discriminatedUnion('key', [
  // late_upload (field_flag_late_upload)
  notice('late_upload', {
    site: name,
    media: z.enum(['audio', 'photo']),
    date: isoDate,
    reporter: nameOrNull,
    reportNo: name,
  }),
  // missing_report (scheduler-tick → mark_site_day_missing): `reminders` when the ladder reached them (W2-06)
  notice('missing_report', {
    site: name,
    first: nameOrNull,
    reminders: z.number().int().positive().optional(),
  }),
  // report_edited (create_report_version, the worker's versions.ts); body: the change note
  notice('report_edited', { reportNo: name }),
  // needs_review (pipeline/file.ts): the §10.5 / §10.9 reason codes
  notice('needs_review', { reportNo: name, reasons: z.array(z.string()) }),
  // glossary_review (pipeline/glossary.ts); body: the terms heard
  notice('glossary_review', { count: z.number().int().positive() }),
  // pack_ready (build_evidence_pack; the demo's packs may cover every site: site null)
  notice('pack_ready', { site: nameOrNull, from: isoDate, to: isoDate }),
  // processing_delayed (router/timeouts.ts)
  notice('processing_delayed', { reportNo: name }),
  // processing_failed / message_failed for a dead job (dead-jobs.ts): `job` is the job type
  notice('processing_failed', { reportNo: name, job: name, tries: z.number().int().positive() }),
  notice('message_not_sent', { name, job: name, tries: z.number().int().positive() }),
  notice('message_not_handled', { name, job: name, tries: z.number().int().positive() }),
  // message_failed of a `notify` job (jobs/notify.ts)
  notice('message_opted_out', { name }),
  notice('message_refused', { name, error: z.string() }),
  notice('message_no_sender', { name }),
  // every channel of the order failed for one message (W2-01, spec §19 Q22)
  notice('message_channels_failed', { name, channels: name, error: z.string() }),
  // a text other than the welcome failed for the account (sms-webhook /status, once an hour)
  notice('message_account_fault', { name: nameOrNull, error: z.string() }),
  // reporter_invite_failed (jobs/send_welcome.ts; sms-webhook's status route)
  notice('welcome_undeliverable', { name }), // body: the provider's error
  notice('welcome_provider_fault', { name, error: z.string() }),
  notice('welcome_not_sent', { name, reason: z.enum(WELCOME_NOT_SENT_REASONS) }),
  notice('welcome_carrier_undelivered', { name, error: z.string() }),
  notice('welcome_account_fault', { name: nameOrNull, error: z.string() }),
  // reporter_opted_out: the provider's opt-out list (send_welcome), or a STOP reply (sms inbound)
  notice('reporter_opted_out', { name, phone: name }),
  notice('reporter_stop', { name, phone: name }),
  // unknown_contact (router/handlers/unknown.ts); body: what they said
  notice('unknown_contact', {}),
  // reporter_consent_revoked (field_revoke_consent(), the recorder's Settings; W2-02)
  notice('reporter_consent_revoked', { name, type: z.enum(['recording', 'data_processing']) }),
  // device_verify_locked (field_device_verify_locked(), 5 wrong device codes; F16, W2-03)
  notice('device_verify_locked', { name }),
  // reporter_wrong_site (router/handlers/welcome.ts)
  notice('reporter_wrong_site', { name }),
  // billing (stripe-webhook)
  notice('payment_failed', {}),
  notice('subscription_canceled', {}),
  // report_filed: the demo's simulated late report (§13 "Report filed" is email-only otherwise)
  notice('late_report', {
    site: name,
    reportNo: name,
    crew: z.number().int().nonnegative(),
    hours: z.number().nonnegative(),
  }),
  // invoice_gap: hours as numbers
  notice('invoice_gap', {
    company: name,
    invoiceNo: name,
    invoiced: z.number(),
    reported: z.number(),
    gap: z.number(),
  }),
]);

export type NoticeData = z.infer<typeof noticeDataSchema>;
export type NoticeKey = NoticeData['key'];
export type NoticeParams<K extends NoticeKey> = Extract<NoticeData, { key: K }>['params'];

/** Every notice key, for tests that check each has its copy. */
export const NOTICE_KEYS = noticeDataSchema.options.map(
  (o) => o.shape.key.value,
) as readonly NoticeKey[];

/** A typed notice: `noticeData('late_upload', { … })`. */
export function noticeData<K extends NoticeKey>(key: K, params: NoticeParams<K>): NoticeData {
  return { key, params } as NoticeData;
}

/** A stored `notifications.data` as a notice, or null (no data, an unknown key, bad values). */
export function parseNoticeData(value: unknown): NoticeData | null {
  if (value === null || value === undefined) return null;
  const parsed = noticeDataSchema.safeParse(value);
  return parsed.success ? parsed.data : null;
}
