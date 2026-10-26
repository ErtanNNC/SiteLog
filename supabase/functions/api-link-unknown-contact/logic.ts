import { isActiveReporterStatus } from '@sitelog/shared';

/**
 * Pure rules of linking an unknown contact (F13 step 4, P10; W1-16, D38). The contact becomes a
 * reporter of the site's org:
 * - a text or a call (`channel` 'sms' / 'voice') is `invited` until F3 consent: the welcome texts
 *   the personal link, and the reporter becomes active on their first consent (F4, or YES by SMS);
 *   an existing invited or active reporter keeps their status;
 * - a WhatsApp-era sender (`channel` null) keeps the v1.0 rule of api-link-unknown-sender, which
 *   this function replaces (deploy new, switch the panel, delete the old after the demo): the
 *   number already wrote to us, so its reporter is active;
 * - a reporter who opted out (STOP) stays opted out: only their START reactivates them, never the
 *   office; a disabled one is invited again from Team & numbers, not here;
 * - the contact must still be pending and belong to the site's org. A contact with no org (an SMS
 *   from an unknown number, spec §19 Q44) is seen by no office user, so it is never linked here.
 */

export type ContactLinkCheck =
  | { ok: true; mode: 'consent' }
  | { ok: true; mode: 'whatsapp'; activate: boolean }
  | { ok: false; status: 404 | 409; reason: string };

export function checkContactLink(
  contact: { status: string; channel: string | null; org_id: string | null },
  siteOrgId: string,
  existing: { status: string } | null,
): ContactLinkCheck {
  if (contact.org_id === null) {
    return {
      ok: false,
      status: 409,
      reason: 'This contact is not attributed to an organisation and cannot be linked here',
    };
  }
  if (contact.org_id !== siteOrgId) {
    return { ok: false, status: 404, reason: 'Unknown contact not found' };
  }
  if (contact.status !== 'pending') {
    return { ok: false, status: 409, reason: `This contact was already ${contact.status}` };
  }
  if (existing?.status === 'opted_out') {
    return {
      ok: false,
      status: 409,
      reason: 'This number opted out (STOP). It is linked again only after it texts START',
    };
  }
  if (existing?.status === 'disabled') {
    return {
      ok: false,
      status: 409,
      reason: 'This number belongs to a disabled reporter. Invite them again from Team & numbers',
    };
  }
  if (contact.channel === null) {
    return {
      ok: true,
      mode: 'whatsapp',
      activate: existing !== null && !isActiveReporterStatus(existing.status),
    };
  }
  return { ok: true, mode: 'consent' };
}
