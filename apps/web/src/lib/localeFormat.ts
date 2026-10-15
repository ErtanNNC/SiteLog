import { intlLocaleOf } from '@sitelog/shared/locale.ts';
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
