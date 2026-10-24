import { UI_LANGUAGES } from '@sitelog/shared/copy/ui/index.ts';
import type { ReporterLocale } from '@sitelog/shared/locale.ts';

/** The field app speaks EN, ES and TR (CLAUDE.md, spec §9.6; `UI_LANGUAGES.field`). */
export const FIELD_LANGUAGES = UI_LANGUAGES.field;
export type FieldLanguage = (typeof FIELD_LANGUAGES)[number];

export function isFieldLanguage(value: unknown): value is FieldLanguage {
  return typeof value === 'string' && (FIELD_LANGUAGES as readonly string[]).includes(value);
}

/** 'es-US' → 'es', 'TR' → 'tr'; a language the field app does not speak ('de-DE') → null. */
export function fieldLanguageOf(tag: string | null | undefined): FieldLanguage | null {
  const lang = tag?.trim().split(/[-_]/)[0]?.toLowerCase();
  return isFieldLanguage(lang) ? lang : null;
}

/**
 * The field app's language. The reporter's locale wins once the link tells us who is reporting
 * (`field-api` resolve, W1-07); until then, the first of the phone's preferred languages the app
 * speaks, so a phone set to Portuguese then Spanish gets Spanish; else English.
 */
export function resolveFieldLanguage(input: {
  reporterLocale?: ReporterLocale | null;
  browser?: readonly (string | null | undefined)[];
}): FieldLanguage {
  const reporter = fieldLanguageOf(input.reporterLocale);
  if (reporter) return reporter;
  for (const tag of input.browser ?? []) {
    const lang = fieldLanguageOf(tag);
    if (lang) return lang;
  }
  return 'en';
}

/** The phone's preferred language tags, most preferred first (empty outside a browser). */
export function browserLanguages(): string[] {
  if (typeof navigator === 'undefined') return [];
  if (navigator.languages?.length) return [...navigator.languages];
  return navigator.language ? [navigator.language] : [];
}
