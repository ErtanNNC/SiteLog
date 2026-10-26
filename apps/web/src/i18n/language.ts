import type { OrgLocale } from '@sitelog/shared/locale.ts';
import { storage } from '@/lib/utils';

/** The panel has EN and TR copy (CLAUDE.md, `UI_LANGUAGES.panel` in `@sitelog/shared`). */
export const ALL_PANEL_LANGUAGES = ['en', 'tr'] as const;
export type PanelLanguage = (typeof ALL_PANEL_LANGUAGES)[number];

/**
 * §19 Q378 (2026-10-25): Turkish is off. Its copy stays in the repo, and a build with
 * `VITE_TURKISH=true` speaks it again (the test and e2e builds do, to keep it working).
 */
export const TURKISH_ON = import.meta.env.VITE_TURKISH === 'true';

/** The languages a build offers: English only while Turkish is off. */
export function panelLanguagesFor(turkish: boolean): readonly PanelLanguage[] {
  return turkish ? ALL_PANEL_LANGUAGES : ['en'];
}

/** The languages this build offers (the switch, the menu, i18next's `supportedLngs`). */
export const PANEL_LANGUAGES = panelLanguagesFor(TURKISH_ON);

/** localStorage key of the viewer's language choice on this device. */
export const LANGUAGE_KEY = 'sitelog.language';

export function isPanelLanguage(
  value: unknown,
  languages: readonly PanelLanguage[] = PANEL_LANGUAGES,
): value is PanelLanguage {
  return typeof value === 'string' && (languages as readonly string[]).includes(value);
}

/** 'tr-TR' → 'tr', 'en' → 'en'; a language the build does not offer ('es-US') → null. */
export function panelLanguageOf(
  tag: string | null | undefined,
  languages: readonly PanelLanguage[] = PANEL_LANGUAGES,
): PanelLanguage | null {
  const lang = tag?.split('-')[0]?.toLowerCase();
  return isPanelLanguage(lang, languages) ? lang : null;
}

/**
 * §11.2 / F1, §6.3 (`org_members.ui_locale`: null → org locale): the panel's language. The viewer's
 * own choice wins; without one, the org's locale once the org is known. Before that (`/login`,
 * `/auth/callback`, the boot skeleton) the browser's language when the panel speaks it, else English.
 */
export function resolveLanguage(
  input: {
    chosen?: PanelLanguage | null;
    browser?: string | null;
    orgLocale?: OrgLocale | null;
  },
  languages: readonly PanelLanguage[] = PANEL_LANGUAGES,
): PanelLanguage {
  if (input.chosen && isPanelLanguage(input.chosen, languages)) return input.chosen;
  const org = panelLanguageOf(input.orgLocale, languages);
  if (org) return org;
  return panelLanguageOf(input.browser, languages) ?? 'en';
}

/** The browser's preferred language tag ('tr-TR'), or null outside a browser. */
export function browserLanguage(): string | null {
  if (typeof navigator === 'undefined') return null;
  return navigator.languages?.[0] ?? navigator.language ?? null;
}

/** The language the viewer chose on this device, or null when they never chose one. */
export function chosenLanguage(): PanelLanguage | null {
  const value = storage.get<unknown>(LANGUAGE_KEY, null);
  return isPanelLanguage(value) ? value : null;
}

/**
 * Saves the viewer's language choice: the one place a choice is stored. Today that is this device
 * (localStorage; the `storage` helper swallows private-mode errors), on `/login` and after sign-in
 * alike. W1-05 adds `org_members.ui_locale` (§6.3), and saving it for a signed-in user belongs here.
 */
export function rememberLanguage(lang: PanelLanguage): void {
  storage.set(LANGUAGE_KEY, lang);
}
