import { formatDate, formatHoursIn, isoWeekRange, parseIsoDate } from '@sitelog/shared/format.ts';
import { intlLocaleOf, upperIn } from '@sitelog/shared/locale.ts';
import type { PanelLanguage } from '@/i18n/language';

/**
 * Numbers in the panel's language (W1-18, Sites and Site detail): 1248 → "1,248" · "1.248",
 * 3.5 → "3.5" · "3,5", at most two decimals; null → "—".
 */
export function formatNumberIn(n: number | null | undefined, language: PanelLanguage): string {
  if (n === null || n === undefined) return '—';
  return new Intl.NumberFormat(intlLocaleOf(language), { maximumFractionDigits: 2 }).format(
    Math.round(n * 100) / 100,
  );
}

/**
 * A site's time zone as a short name for the deadline line (Web-Site: "Report deadline 17:30 CT"):
 * the browser's generic short name ("CT"), else its offset ("GMT+3"), else the IANA id.
 */
export function zoneShortName(tz: string, language: PanelLanguage, at = new Date()): string {
  for (const timeZoneName of ['shortGeneric', 'shortOffset'] as const) {
    try {
      const part = new Intl.DateTimeFormat(intlLocaleOf(language), { timeZone: tz, timeZoneName })
        .formatToParts(at)
        .find((p) => p.type === 'timeZoneName');
      if (part?.value) return part.value;
    } catch {
      // An unknown zone or an engine without this style: try the next one.
    }
  }
  return tz;
}

/** ["es", "en"] → "ES & EN" (Web-Site "speaks ES & EN"); three or more: "ES, EN & PL". */
export function joinLanguageCodes(
  codes: readonly string[],
  and: (first: string, last: string) => string,
): string {
  const upper = codes.map((c) => c.toUpperCase());
  if (upper.length < 2) return upper.join('');
  return and(upper.slice(0, -1).join(', '), upper.at(-1)!);
}

/** "OCT 5 – OCT 9, 2026" · "5 EKİ – 9 EKİ, 2026": an ISO week, Monday to Friday. */
export function formatWeekLabelIn(isoWeek: string, language: PanelLanguage): string {
  const { start, end } = isoWeekRange(isoWeek);
  const day = (d: string) => upperIn(language, formatDate(d, 'monthDay', language));
  return `${day(start)} – ${day(end)}, ${parseIsoDate(end).y}`;
}

/** A signed gap: +16 → "+16 h", −8 → "−8 sa"; with `unit: false` the number only ("+16"). */
export function formatSignedHoursIn(
  gap: number,
  language: PanelLanguage,
  opts: { unit?: boolean } = {},
): string {
  if (Math.abs(gap) < 0.005) return '0';
  const sign = gap > 0 ? '+' : '−';
  const abs = Math.abs(gap);
  return `${sign}${opts.unit === false ? formatNumberIn(abs, language) : formatHoursIn(abs, language)}`;
}
