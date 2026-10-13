/**
 * Locales, languages and unit systems (spec Conventions, §9.6).
 *
 * - The org locale (`orgs.locale`, `en-US` | `tr-TR`) sets the report language, units and currency.
 * - The reporter locale (`reporters.locale`, `en-US` | `es-US` | `tr-TR`) is the language SiteLog
 *   texts and speaks with that person.
 * - The panel speaks EN and TR; the field app and SMS speak EN, ES and TR.
 *
 * These are TypeScript constants only. The matching DB columns arrive with W1-05.
 */

export const LANGUAGES = ['en', 'es', 'tr'] as const;
export type Language = (typeof LANGUAGES)[number];

export const ORG_LOCALES = ['en-US', 'tr-TR'] as const;
export type OrgLocale = (typeof ORG_LOCALES)[number];

export const REPORTER_LOCALES = ['en-US', 'es-US', 'tr-TR'] as const;
export type ReporterLocale = (typeof REPORTER_LOCALES)[number];

/** Anything the formatters accept: a full locale or a bare language. */
export type AnyLocale = OrgLocale | ReporterLocale | Language;

export const UNIT_SYSTEMS = ['imperial', 'metric'] as const;
export type UnitSystem = (typeof UNIT_SYSTEMS)[number];

/** Report languages (§10.3 `reportLanguage`): the org's language, never Spanish. */
export const REPORT_LANGUAGES = ['en', 'tr'] as const;
export type ReportLanguage = (typeof REPORT_LANGUAGES)[number];

const INTL_LOCALE: Record<Language, string> = { en: 'en-US', es: 'es-US', tr: 'tr-TR' };

export function isLanguage(value: string): value is Language {
  return (LANGUAGES as readonly string[]).includes(value);
}

/** 'es-US' → 'es', 'tr' → 'tr'. Throws on a language SiteLog does not support. */
export function languageOf(locale: AnyLocale | string): Language {
  const lang = locale.split('-')[0]?.toLowerCase() ?? '';
  if (!isLanguage(lang)) throw new Error(`Unsupported locale: ${locale}`);
  return lang;
}

/** The BCP 47 tag handed to `Intl` (and `toLocaleUpperCase`) for a locale or bare language. */
export function intlLocaleOf(locale: AnyLocale): string {
  return INTL_LOCALE[languageOf(locale)];
}

/** §9.6: US orgs report in imperial units, TR orgs in metric. */
export function unitsFor(locale: OrgLocale): UnitSystem {
  return languageOf(locale) === 'tr' ? 'metric' : 'imperial';
}

/** §9.6: the report and PDF language of an org. */
export function reportLanguageFor(locale: OrgLocale): ReportLanguage {
  return languageOf(locale) === 'tr' ? 'tr' : 'en';
}

/** Upper case with the locale's rules (Turkish: i → İ, ı → I). */
export function upperIn(locale: AnyLocale, text: string): string {
  return text.toLocaleUpperCase(intlLocaleOf(locale));
}
