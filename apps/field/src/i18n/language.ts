import { UI_LANGUAGES } from '@sitelog/shared/copy/ui/index.ts';
import type { ReporterLocale } from '@sitelog/shared/locale.ts';

/** The field app has EN, ES and TR copy (CLAUDE.md, spec §9.6; `UI_LANGUAGES.field`). */
export const ALL_FIELD_LANGUAGES = UI_LANGUAGES.field;
export type FieldLanguage = (typeof ALL_FIELD_LANGUAGES)[number];

/**
 * §19 Q378 (2026-10-25): Turkish is off. Its copy stays in the repo, and a build with
 * `VITE_TURKISH=true` speaks it again (the test and e2e builds do, to keep it working).
 */
export const TURKISH_ON = import.meta.env.VITE_TURKISH === 'true';

/** The languages a build offers: EN and ES while Turkish is off. */
export function fieldLanguagesFor(turkish: boolean): readonly FieldLanguage[] {
  return turkish ? ALL_FIELD_LANGUAGES : ALL_FIELD_LANGUAGES.filter((l) => l !== 'tr');
}

/** The languages this build offers. */
export const FIELD_LANGUAGES = fieldLanguagesFor(TURKISH_ON);

export function isFieldLanguage(
  value: unknown,
  languages: readonly FieldLanguage[] = FIELD_LANGUAGES,
): value is FieldLanguage {
  return typeof value === 'string' && (languages as readonly string[]).includes(value);
}

/** 'es-US' → 'es', 'TR' → 'tr'; a language the build does not offer ('de-DE') → null. */
export function fieldLanguageOf(
  tag: string | null | undefined,
  languages: readonly FieldLanguage[] = FIELD_LANGUAGES,
): FieldLanguage | null {
  const lang = tag?.trim().split(/[-_]/)[0]?.toLowerCase();
  return isFieldLanguage(lang, languages) ? lang : null;
}

/**
 * The pack's field locales this build offers (Welcome and Settings list them). A pack whose
 * locales are all off still gets English.
 */
export function offeredFieldLocales(
  locales: readonly ReporterLocale[],
  languages: readonly FieldLanguage[] = FIELD_LANGUAGES,
): ReporterLocale[] {
  const offered = locales.filter((l) => fieldLanguageOf(l, languages) !== null);
  return offered.length > 0 ? offered : ['en-US'];
}

/**
 * The field app's language. The reporter's locale wins once the link tells us who is reporting
 * (`field-api` resolve, W1-07); until then, the first of the phone's preferred languages the app
 * speaks, so a phone set to Portuguese then Spanish gets Spanish; else English.
 */
export function resolveFieldLanguage(
  input: {
    reporterLocale?: ReporterLocale | null;
    browser?: readonly (string | null | undefined)[];
  },
  languages: readonly FieldLanguage[] = FIELD_LANGUAGES,
): FieldLanguage {
  const reporter = fieldLanguageOf(input.reporterLocale, languages);
  if (reporter) return reporter;
  for (const tag of input.browser ?? []) {
    const lang = fieldLanguageOf(tag, languages);
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
