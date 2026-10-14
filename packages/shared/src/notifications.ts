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
  reporter_wrong_site: ['admin', 'ops'], // §2.2 "Manage reporters": admin, ops
};

/** A kind §13 does not list (needs_review, glossary_review, processing_delayed, …). */
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
