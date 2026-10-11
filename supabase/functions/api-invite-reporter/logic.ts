/** Pure rules of the reporter invite flow (§F3). */

export const RESEND_AFTER_HOURS = 48;
export const MAX_RESENDS = 1;

export type ResendCheck = { ok: true } | { ok: false; reason: string; retryAt?: string };

/**
 * §F3 edge case: a reporter who never replied may get one re-send, 48 h after the first invite.
 * `invited_at` is set by the worker when the welcome template was actually sent; while it is
 * null the first send has not happened (or failed → "Not on WhatsApp"), so a re-send is allowed.
 */
export function canResend(
  reporter: { status: string; invited_at: string | null },
  previousResends: number,
  now: Date,
): ResendCheck {
  if (reporter.status === 'disabled') return { ok: false, reason: 'This reporter is disabled.' };
  if (reporter.status === 'verified') {
    return { ok: false, reason: 'This reporter already replied; no welcome re-send is needed.' };
  }
  if (previousResends >= MAX_RESENDS) {
    return { ok: false, reason: 'The welcome was already re-sent once. Check the number instead.' };
  }
  if (reporter.invited_at) {
    const retryAt = new Date(
      new Date(reporter.invited_at).getTime() + RESEND_AFTER_HOURS * 3_600_000,
    );
    if (now.getTime() < retryAt.getTime()) {
      return {
        ok: false,
        reason: `A re-send is allowed ${RESEND_AFTER_HOURS} h after the first invite.`,
        retryAt: retryAt.toISOString(),
      };
    }
  }
  return { ok: true };
}

export interface LinkRow {
  site_id: string;
  reporter_id: string;
  is_primary: boolean;
}

/** site_reporters rows: the reporter becomes primary on every site that has no primary yet. */
export function linkRows(
  reporterId: string,
  siteIds: readonly string[],
  sitesWithPrimary: ReadonlySet<string>,
): LinkRow[] {
  return [...new Set(siteIds)].map((siteId) => ({
    site_id: siteId,
    reporter_id: reporterId,
    is_primary: !sitesWithPrimary.has(siteId),
  }));
}
