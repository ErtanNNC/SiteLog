import { parsePhoneNumberFromString } from 'libphonenumber-js/min';

/**
 * Which pack an inbound text or WhatsApp message belongs to when its sender serves several packs
 * (spec §19 Q370, decided 2026-10-19: one Twilio number for every country). A sender of one pack
 * is that pack, as before. For a shared sender, in order:
 *
 *   1. the pack of the last message sent to that phone on this channel in the last 30 days (a reply
 *      answers the text before it);
 *   2. the one pack of the phone's reporters among the sender's packs (a real org's reporter);
 *   3. the phone's own country, if the sender serves that pack (an unknown number);
 *   4. the sender's own country, if the sender serves that pack;
 *   5. the first of the sender's packs by code, so the answer never depends on row order.
 */

/** How long a sent message decides the pack of a reply (rule 1). */
export const INBOUND_PACK_WINDOW_DAYS = 30;

export interface InboundPackInput {
  /** The codes of the packs whose sender received the message. */
  candidates: readonly string[];
  /** The pack of the last message sent to the phone on this channel within the window, or null. */
  lastOutboundPack: string | null;
  /** The packs of the phone's reporters in real orgs (duplicates allowed). */
  reporterPacks: readonly string[];
  /** The phone that wrote, E.164. */
  from: string;
  /** The sender that received it, E.164 (an alphanumeric title has no country). */
  to: string;
}

/** The region (`US`, `TR`, `GR` …) of an E.164 number, or null. */
export function phoneRegion(e164: string): string | null {
  const parsed = parsePhoneNumberFromString(e164.trim());
  return parsed?.country ?? null;
}

/** The pack of an inbound message; null only when the sender serves no pack. */
export function chooseInboundPack(input: InboundPackInput): string | null {
  const candidates = [...new Set(input.candidates)].sort();
  if (candidates.length <= 1) return candidates[0] ?? null;
  const has = (code: string | null): code is string => code !== null && candidates.includes(code);
  if (has(input.lastOutboundPack)) return input.lastOutboundPack;
  const reporterPacks = [...new Set(input.reporterPacks.filter(has))];
  if (reporterPacks.length === 1) return reporterPacks[0]!;
  const fromRegion = phoneRegion(input.from);
  if (has(fromRegion)) return fromRegion;
  const toRegion = phoneRegion(input.to);
  if (has(toRegion)) return toRegion;
  return candidates[0]!;
}
