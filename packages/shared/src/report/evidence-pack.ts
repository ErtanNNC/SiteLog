import type { FieldChannel } from '../enums.ts';

/**
 * F20 / §19 Q134 (decided 2026-10-16): how a report in an EOT evidence pack, and in P9's delay
 * log, was confirmed. A pack includes every report of the period; each day says how it was
 * confirmed, and a day filed without the site manager's confirmation counts as claim-ready only
 * once the office signs it off. Pure; the worker's pack and the panel's delay log both use it.
 *
 * - `recorder`, `call`, `sms`, `whatsapp`: the site manager confirmed the report on that channel
 *   (`reports.confirmed_via`; a v1.0 report, which has no channel, was confirmed on WhatsApp).
 * - `weather_day`: the site manager logged the day as a weather day on the recorder (F12, or the
 *   v1.0 R1 button); a weather day has no draft to confirm, so it counts as the site manager's own
 *   record (proposed for spec §19 with W3-07; Q134 names only timeout, auto and office filings).
 * - `office`: typed in the panel (`create_office_report`: no reporter, channel `office`).
 * - `unconfirmed`: filed without the site manager's confirmation (the 2 h timeout, reason
 *   `unconfirmed`; `filing_mode = auto_15min`).
 */
export type PackConfirmation =
  'recorder' | 'call' | 'sms' | 'whatsapp' | 'weather_day' | 'office' | 'unconfirmed';

/** The report columns that tell how it was confirmed (§6.3). */
export interface PackConfirmationFacts {
  confirmed_at: string | null;
  confirmed_via: FieldChannel | null;
  channel: FieldChannel | null;
  kind: string;
  reporter_id: string | null;
  review_reasons: readonly string[];
}

const BY_CHANNEL: Record<FieldChannel, PackConfirmation> = {
  web: 'recorder',
  voice: 'call',
  sms: 'sms',
  whatsapp: 'whatsapp',
  office: 'office',
};

/**
 * How the report was confirmed. `confirmed_at` is set by a reporter's confirm (with
 * `confirmed_via`) and by an office filing (no `confirmed_via`); a timeout or auto filing leaves
 * it null and a timeout adds the review reason `unconfirmed`.
 */
export function packConfirmation(r: PackConfirmationFacts): PackConfirmation {
  if (!r.reporter_id || r.channel === 'office') return 'office';
  if (r.confirmed_at && !r.review_reasons.includes('unconfirmed')) {
    if (r.confirmed_via) return BY_CHANNEL[r.confirmed_via];
    // No confirm channel: a v1.0 report (no channel either) was confirmed on WhatsApp; a v1.2
    // report confirmed without one was filed by the office.
    return r.channel === null ? 'whatsapp' : 'office';
  }
  if (r.kind === 'weather_day') return 'weather_day';
  return 'unconfirmed';
}

/** The site manager confirmed (or, for a weather day, logged) the report themselves. */
export function confirmedBySiteManager(c: PackConfirmation): boolean {
  return c !== 'office' && c !== 'unconfirmed';
}

/**
 * Claim-ready (P9, F20): the delay record has voice evidence, a photo and observed weather
 * (`weather_events.claim_ready`), and, per §19 Q134, the site manager confirmed the report or the
 * office signed it off.
 */
export function packClaimReady(
  evidenceReady: boolean,
  confirmation: PackConfirmation,
  signedOff: boolean,
): boolean {
  return evidenceReady && (confirmedBySiteManager(confirmation) || signedOff);
}

/** The sections of an EOT pack (F20; `evidence_packs.sections`, the dialog's checklist). */
export const PACK_SECTIONS = ['summary', 'reports', 'transcripts', 'photos', 'weather'] as const;
export type PackSection = (typeof PACK_SECTIONS)[number];

/** A pack row's sections in their order; an empty or unreadable list means all of them. */
export function packSections(stored: readonly string[] | null | undefined): PackSection[] {
  const set = new Set(stored ?? []);
  const picked = PACK_SECTIONS.filter((s) => set.has(s));
  return picked.length ? picked : [...PACK_SECTIONS];
}
