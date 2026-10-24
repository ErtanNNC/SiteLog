import { parsePhoneNumberFromString } from 'libphonenumber-js/max';
import type { CountryPack } from './countries.ts';
import type { ContactPref } from './enums.ts';
import { placesCalls } from './voice-outbound.ts';

/**
 * F2's line check for an invite (W4-02, spec §19 Q229): can TalkOlog reach the number the office
 * typed in the way the office chose? Kept out of the package index on purpose: it reads
 * libphonenumber's "max" metadata (the per-type patterns, about 145 kB), which the panel loads only
 * with the setup wizard and the field app never loads (`format.ts` keeps the "min" metadata).
 *
 * Q229's recommendation, built as the default (`INVITE_LINE_CHECK = 'delivery'`): no paid lookup
 * before the invite. The welcome's own delivery decides whether texts reach the number (F3,
 * _Can't text this number_); the only check here is offline: a number libphonenumber knows to be a
 * fixed line (not "fixed line or mobile", as every US number reads) is refused for _Text link_,
 * and allowed for _Phone call_ only where TalkOlog can reach it by phone (the pack's voice number to
 * call in, or TalkOlog places calls, F2 and §19 Q38), else the invite is blocked (Talk now needs
 * the personal link and a device code, both sent by SMS). A number libphonenumber cannot type
 * (the fictional 555-01xx demo numbers, a range it does not know) passes.
 */

/** §19 Q229: `delivery` (the welcome's delivery decides; offline fixed-line check only). */
export type InviteLineCheckPolicy = 'delivery';
export const INVITE_LINE_CHECK: InviteLineCheckPolicy = 'delivery';

/** Why an invite is refused: a landline for a text link, or a landline TalkOlog cannot reach. */
export type LineCheckProblem = 'landline_text' | 'landline_unreachable';

export type LineCheck = { ok: true } | { ok: false; problem: LineCheckProblem };

/** Whether libphonenumber knows the number to be a fixed line (never true for "fixed or mobile"). */
export function isFixedLine(e164: string): boolean {
  const parsed = parsePhoneNumberFromString(e164.trim());
  return parsed?.getType() === 'FIXED_LINE';
}

/**
 * Whether TalkOlog can reach a reporter by phone in this org (F2 edge case, §19 Q38): the pack has
 * a voice number they can call, or TalkOlog places calls (`placesCalls`: a demo org, or the pack's
 * outbound trunk in this environment).
 */
export function reachableByPhone(
  org: { isDemo: boolean },
  pack: Pick<CountryPack, 'voiceNumber' | 'outboundTrunkId'>,
): boolean {
  return pack.voiceNumber !== null || placesCalls(org, pack);
}

/**
 * The invite's line check. `landline_text`: a fixed line with _Text link_ (the office may choose
 * _Phone call_ when `reachable`); `landline_unreachable`: a fixed line TalkOlog cannot reach by
 * phone either, whatever the preference.
 */
export function inviteLineCheck(
  e164: string,
  contactPref: ContactPref,
  opts: { reachable: boolean; policy?: InviteLineCheckPolicy },
): LineCheck {
  if ((opts.policy ?? INVITE_LINE_CHECK) !== 'delivery') return { ok: true };
  if (!isFixedLine(e164)) return { ok: true };
  if (!opts.reachable) return { ok: false, problem: 'landline_unreachable' };
  return contactPref === 'call' ? { ok: true } : { ok: false, problem: 'landline_text' };
}
