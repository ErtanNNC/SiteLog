import i18next, { type Resource } from 'i18next';
import { initReactI18next } from 'react-i18next';
import {
  browserLanguage,
  chosenLanguage,
  PANEL_LANGUAGES,
  panelLanguageOf,
  resolveLanguage,
  type PanelLanguage,
} from './language';
import { PANEL_RESOURCES } from './resources';

/**
 * The panel's i18next instance (D9, §11.2). The resources are bundled, so it is initialised
 * synchronously and the first render already speaks the resolved language. Components read it
 * through `useCopy()`; code outside React through `translate()`.
 */
export const i18n = i18next.createInstance();

void i18n.use(initReactI18next).init({
  resources: PANEL_RESOURCES as unknown as Resource,
  lng: resolveLanguage({ chosen: chosenLanguage(), browser: browserLanguage() }),
  fallbackLng: 'en',
  supportedLngs: [...PANEL_LANGUAGES],
  load: 'languageOnly',
  ns: ['panel', 'common'],
  defaultNS: 'panel',
  initAsync: false,
  // React escapes text; i18next escaping would show "&amp;" in "Weather &amp; delays".
  interpolation: { escapeValue: false },
  // An empty Turkish string falls back to English instead of rendering nothing.
  returnEmptyString: false,
  react: { useSuspense: false },
});

/** The panel's current language. */
export function currentLanguage(): PanelLanguage {
  return panelLanguageOf(i18n.resolvedLanguage ?? i18n.language) ?? 'en';
}

/** `<html lang>` follows the panel's language (screen readers, CSS upper-casing of Turkish i). */
function syncDocumentLanguage(): void {
  if (typeof document !== 'undefined') document.documentElement.lang = currentLanguage();
}

syncDocumentLanguage();
i18n.on('languageChanged', syncDocumentLanguage);
