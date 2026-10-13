import type { OrgLocale } from '@sitelog/shared/locale.ts';
import type { UiKey } from '@sitelog/shared/copy/ui/index.ts';
import { useCallback, useContext, useEffect, useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import { PinnedLanguage } from './context';
import { currentLanguage, i18n } from './i18n';
import type { CopyArgs, CopyKey } from './keys';
import {
  browserLanguage,
  chosenLanguage,
  panelLanguageOf,
  rememberLanguage,
  resolveLanguage,
  type PanelLanguage,
} from './language';

/** Typed `t()`: keys are the paths of `copy/en.ts`, variables its `{{name}}` placeholders. */
export type CopyT = <K extends CopyKey>(key: K, ...args: CopyArgs<K>) => string;

/** `t()` outside React (toasts from mutation hooks): the panel's current language. */
export const translate: CopyT = (key, ...args) =>
  i18n.t(key, { ns: 'panel', ...args[0] }) as string;

/**
 * The panel's copy in the current language (D9): `t` reads `copy/en.ts` keys (Turkish when there
 * is a translation, English otherwise), `tc` the shared `common` namespace. Inside
 * `<EnglishOnly>` both stay English. Re-renders when the language changes.
 */
export function useCopy(): {
  t: CopyT;
  tc: (key: UiKey<'common'>) => string;
  language: PanelLanguage;
} {
  const pinned = useContext(PinnedLanguage);
  const { t: raw, i18n: instance } = useTranslation(['panel', 'common'], {
    lng: pinned ?? undefined,
  });
  const language = pinned ?? panelLanguageOf(instance.resolvedLanguage) ?? 'en';
  const t = useCallback<CopyT>(
    (key, ...args) => raw(key, { ns: 'panel', ...args[0] }) as string,
    [raw],
  );
  const tc = useCallback((key: UiKey<'common'>) => raw(key, { ns: 'common' }) as string, [raw]);
  return useMemo(() => ({ t, tc, language }), [t, tc, language]);
}

/**
 * The language switch (§11.2, F1): the current language and a setter that applies it everywhere
 * at once, saves the choice and leaves the route alone (§11.5 "language switch keeps the current
 * route").
 */
export function useLanguage(): {
  language: PanelLanguage;
  setLanguage: (lang: PanelLanguage) => void;
} {
  const { i18n: instance } = useTranslation();
  const language = panelLanguageOf(instance.resolvedLanguage) ?? 'en';
  const setLanguage = useCallback(
    (lang: PanelLanguage) => {
      rememberLanguage(lang);
      void instance.changeLanguage(lang);
    },
    [instance],
  );
  return { language, setLanguage };
}

/**
 * Applies the org's locale as the panel's default (§6.3: no saved choice → org locale). Not
 * saved: it is a default, not a choice. `AuthProvider` calls it as the org memberships arrive,
 * before the shell mounts, so the shell's first paint is already in the org's language.
 */
export function applyOrgLanguage(orgLocale: OrgLocale | null | undefined): void {
  if (!orgLocale) return;
  const lang = resolveLanguage({
    chosen: chosenLanguage(),
    browser: browserLanguage(),
    orgLocale,
  });
  if (lang !== currentLanguage()) void i18n.changeLanguage(lang);
}

/** The same default when the viewer switches to an org with another locale (`AppShell`). */
export function useOrgLanguageDefault(orgLocale: OrgLocale | null | undefined): void {
  useEffect(() => applyOrgLanguage(orgLocale), [orgLocale]);
}
