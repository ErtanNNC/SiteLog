/**
 * Locales, languages and unit systems (spec Conventions, §4.6, §9.6).
 *
 * - `ORG_LOCALES`, `REPORTER_LOCALES`: the locales with copy. A country pack (`countries`, spec
 *   §4.6) chooses among them (`default_locale`, `field_locales`); the DB checks mirror them, so a
 *   new language is code (copy, prompts, PDF labels, voices) before any pack can name it.
 * - The org locale (`orgs.locale`, `en-US` | `tr-TR`) sets the report language and the panel's
 *   default. Units and currency are org columns, preset from the pack by `create_org`.
 * - The reporter locale (`reporters.locale`, `en-US` | `es-US` | `tr-TR`) is the language TalkOlog
 *   texts and speaks with that person.
 * - The panel speaks EN and TR; the field app and SMS speak EN, ES and TR.
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

/** 'es-US' → 'es', 'tr' → 'tr'. Throws on a language TalkOlog does not support. */
export function languageOf(locale: AnyLocale | string): Language {
  const lang = locale.split('-')[0]?.toLowerCase() ?? '';
  if (!isLanguage(lang)) throw new Error(`Unsupported locale: ${locale}`);
  return lang;
}

/** The BCP 47 tag handed to `Intl` (and `toLocaleUpperCase`) for a locale or bare language. */
export function intlLocaleOf(locale: AnyLocale): string {
  return INTL_LOCALE[languageOf(locale)];
}

/** §9.6: the report and PDF language of an org. */
export function reportLanguageFor(locale: OrgLocale): ReportLanguage {
  return languageOf(locale) === 'tr' ? 'tr' : 'en';
}

/** Upper case with the locale's rules (Turkish: i → İ, ı → I). */
export function upperIn(locale: AnyLocale, text: string): string {
  return text.toLocaleUpperCase(intlLocaleOf(locale));
}
