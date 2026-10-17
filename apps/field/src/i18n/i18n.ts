import i18next, { type Resource } from 'i18next';
import { initReactI18next } from 'react-i18next';
import { UI_RESOURCES, type UiResources } from '@sitelog/shared/copy/ui/index.ts';
import {
  browserLanguages,
  FIELD_LANGUAGES,
  fieldLanguageOf,
  resolveFieldLanguage,
  type FieldLanguage,
} from './language';

/**
 * i18next resources of the field app (D9): the shared `common` and `field` namespaces in EN, ES and
 * TR (`packages/shared/src/copy/ui`). The panel's Turkish (`panel`) is not loaded here.
 */
export const FIELD_RESOURCES = Object.fromEntries(
  FIELD_LANGUAGES.map((lng) => [
    lng,
    { common: UI_RESOURCES[lng].common, field: UI_RESOURCES[lng].field },
  ]),
) as Record<FieldLanguage, UiResources>;

/**
 * The field app's i18next instance. The resources are bundled, so it is initialised synchronously
 * and the first render already speaks the resolved language. Components read it through
 * `useFieldCopy()`.
 */
export const i18n = i18next.createInstance();

void i18n.use(initReactI18next).init({
  resources: FIELD_RESOURCES as unknown as Resource,
  lng: resolveFieldLanguage({ browser: browserLanguages() }),
  fallbackLng: 'en',
  supportedLngs: [...FIELD_LANGUAGES],
  load: 'languageOnly',
  ns: ['field', 'common'],
  defaultNS: 'field',
  initAsync: false,
  // React escapes text; i18next escaping would show "&amp;".
  interpolation: { escapeValue: false },
  // An empty translation falls back to English instead of rendering nothing.
  returnEmptyString: false,
  react: { useSuspense: false },
});

/** The field app's current language. */
export function currentLanguage(): FieldLanguage {
  return fieldLanguageOf(i18n.resolvedLanguage ?? i18n.language) ?? 'en';
}

/** `<html lang>` follows the app's language (screen readers, Turkish upper-casing of i). */
function syncDocumentLanguage(): void {
  if (typeof document !== 'undefined') document.documentElement.lang = currentLanguage();
}

syncDocumentLanguage();
i18n.on('languageChanged', syncDocumentLanguage);
