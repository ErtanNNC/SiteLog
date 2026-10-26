/**
 * SMS segment counter (§9.2: keep each message to one segment where possible).
 *
 * An SMS carries 140 octets. Text goes as GSM-7 (7-bit septets: 160 per message) when every
 * character is in the GSM 03.38 basic table or its extension table (an extension character costs
 * two septets, escape + code); otherwise the whole message goes as UCS-2 (UTF-16: 70 code units).
 * A long message is split into concatenated segments, each of which loses 6 octets to the
 * concatenation header (153 septets / 67 code units). An escape pair or a surrogate pair is
 * never split across two segments.
 *
 * Turkish: ç, ğ, Ğ, ı, İ, ş and Ş are not in the GSM basic table, so plain Turkish text falls
 * back to UCS-2. With the Turkish national language single shift table (3GPP TS 23.038 A.2.1),
 * which Turkish operators and providers such as İletimerkezi support, those seven letters are
 * escape pairs (two septets each) and the message stays GSM-7. The table is announced in a 3-octet
 * header element, so a segment holds 155 septets alone or 149 when concatenated.
 *
 * `countSmsSegments` returns both counts: `default` (what a sender without the Turkish table
 * pays, e.g. Twilio) and `turkishShift` (a sender that uses the table when the text needs it).
 */

export type SmsEncoding = 'gsm7' | 'gsm7-turkish-shift' | 'ucs2';

export interface SegmentCount {
  encoding: SmsEncoding;
  /** Septets (GSM-7) or UTF-16 code units (UCS-2) in the whole message. */
  units: number;
  /** Number of SMS segments the message is billed as; 0 for an empty text. */
  segments: number;
  /** Capacity of each segment in `units`: the single-message size, or the concatenated size. */
  perSegment: number;
}

export interface SmsSegments {
  default: SegmentCount;
  turkishShift: SegmentCount;
  /** Characters outside the GSM-7 basic and extension tables (they force UCS-2 by default). */
  nonGsm: string[];
}

/** GSM 03.38 basic character set, in code order 0x00–0x7F (0x1B is the escape, not a char). */
const GSM7_BASIC =
  '@£$¥èéùìòÇ\nØø\rÅåΔ_ΦΓΛΩΠΨΣΘΞ\u001bÆæßÉ !"#¤%&\'()*+,-./0123456789:;<=>?' +
  '¡ABCDEFGHIJKLMNOPQRSTUVWXYZÄÖÑÜ§¿abcdefghijklmnopqrstuvwxyzäöñüà';

/** GSM 03.38 default extension table: each costs escape + code = 2 septets. */
const GSM7_EXTENSION = '\f^{}\\[~]|€';

/** Turkish single shift table (3GPP TS 23.038 A.2.1): the default extension plus seven letters. */
const TURKISH_SINGLE_SHIFT = `${GSM7_EXTENSION}ĞİŞçğış`;

const BASIC = new Set(Array.from(GSM7_BASIC).filter((c) => c !== '\u001b'));
const EXTENSION = new Set(Array.from(GSM7_EXTENSION));
const TURKISH_SHIFT = new Set(Array.from(TURKISH_SINGLE_SHIFT));

/** Segment capacities. The Turkish shift header element takes 3 octets of every segment. */
export const SMS_SEGMENT_SIZES = {
  gsm7: { single: 160, concatenated: 153 },
  'gsm7-turkish-shift': { single: 155, concatenated: 149 },
  ucs2: { single: 70, concatenated: 67 },
} as const satisfies Record<SmsEncoding, { single: number; concatenated: number }>;

/** Cost of each character (by code point), or null when the encoding cannot carry it. */
function costs(chars: string[], encoding: SmsEncoding): number[] | null {
  const out: number[] = [];
  for (const c of chars) {
    if (encoding === 'ucs2') {
      out.push(c.length); // 1, or 2 for a character outside the BMP (a surrogate pair)
    } else if (BASIC.has(c)) {
      out.push(1);
    } else if ((encoding === 'gsm7' ? EXTENSION : TURKISH_SHIFT).has(c)) {
      out.push(2);
    } else {
      return null;
    }
  }
  return out;
}

/** Greedy fill: a character that does not fit opens the next segment. */
function pack(charCosts: number[], encoding: SmsEncoding): SegmentCount {
  const units = charCosts.reduce((a, b) => a + b, 0);
  const size = SMS_SEGMENT_SIZES[encoding];
  if (units === 0) return { encoding, units, segments: 0, perSegment: size.single };
  if (units <= size.single) return { encoding, units, segments: 1, perSegment: size.single };
  let segments = 1;
  let used = 0;
  for (const cost of charCosts) {
    if (used + cost > size.concatenated) {
      segments += 1;
      used = 0;
    }
    used += cost;
  }
  return { encoding, units, segments, perSegment: size.concatenated };
}

/** Count the segments of an SMS body, with and without the Turkish single shift table. */
export function countSmsSegments(text: string): SmsSegments {
  const chars = Array.from(text);
  const nonGsm = [...new Set(chars.filter((c) => !BASIC.has(c) && !EXTENSION.has(c)))];

  const gsm = costs(chars, 'gsm7');
  const ucs2 = pack(costs(chars, 'ucs2')!, 'ucs2');
  const byDefault = gsm ? pack(gsm, 'gsm7') : ucs2;

  // The shift table is only announced when the text needs it; otherwise the plain GSM-7 count holds.
  let turkishShift = byDefault;
  if (!gsm) {
    const shifted = costs(chars, 'gsm7-turkish-shift');
    if (shifted) turkishShift = pack(shifted, 'gsm7-turkish-shift');
  }
  return { default: byDefault, turkishShift, nonGsm };
}
