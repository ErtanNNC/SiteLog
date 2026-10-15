import type { NoticeData } from '@sitelog/shared/notifications.ts';
import type { AppClient } from './supabase.ts';

/** `notify_org(...)` RPC wrapper → in-app notification center (§13). Returns the notification id. */

export type NotificationKind =
  | 'missing_report'
  | 'needs_review'
  | 'unknown_contact'
  | 'invoice_gap'
  | 'glossary_review'
  | 'pack_ready'
  | 'billing'
  | 'report_edited'
  // §13 "Message undeliverable / opted out" (W1-08): admin and ops.
  | 'reporter_invite_failed'
  | 'reporter_opted_out';

export interface Notification {
  orgId: string;
  kind: NotificationKind;
  title: string;
  body?: string | null;
  targetPath?: string | null;
  /** null = every member of the org sees it. */
  userId?: string | null;
  /**
   * What it says as data, rendered by the panel in the reader's language (migration
   * 20261015000080); `title` / `body` stay the English fallback.
   */
  data?: NoticeData | null;
}

export async function notifyOrg(admin: AppClient, n: Notification): Promise<string> {
  const { data } = await admin
    .rpc('notify_org', {
      p_org: n.orgId,
      p_kind: n.kind,
      p_title: n.title,
      p_body: n.body ?? null,
      p_target_path: n.targetPath ?? null,
      p_user_id: n.userId ?? null,
      ...(n.data ? { p_data: n.data } : {}),
    })
    .throwOnError();
  return data;
}
