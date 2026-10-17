import { isActiveReporterStatus } from '@sitelog/shared';

/** Pure rules of the WhatsApp unknown-sender link (§F11 step 5) until W1-16 (D38). */

/** `activate`: the existing reporter is set to 'active' (a new reporter is created active). */
export type LinkCheck = { ok: true; activate: boolean } | { ok: false; reason: string };

/**
 * Whether the office may link this contact to a reporter here. The function keeps the v1.0 rule
 * for a WhatsApp sender only: the number already wrote to us on WhatsApp, so its reporter is
 * active. A contact from a text or a call (channel 'sms' / 'voice', W1-08 and week 2) needs F3
 * consent before it is active (§6.2, §F13 step 4), which api-link-unknown-contact brings in W1-16.
 * A reporter who opted out (STOP) stays opted out: only their START reactivates them, never the
 * office (guard_reporter_status refuses the office the same change).
 */
export function checkLink(
  contact: { status: string; channel: string | null },
  existing: { status: string } | null,
): LinkCheck {
  if (contact.status !== 'pending') {
    return { ok: false, reason: `This contact was already ${contact.status}` };
  }
  if (contact.channel !== null) {
    return {
      ok: false,
      reason:
        'A contact from a text or a call is linked with consent by api-link-unknown-contact (W1-16)',
    };
  }
  if (existing?.status === 'opted_out') {
    return {
      ok: false,
      reason: 'This number opted out (STOP). It is linked again only after it texts START',
    };
  }
  return { ok: true, activate: existing !== null && !isActiveReporterStatus(existing.status) };
}
