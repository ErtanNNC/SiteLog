import { useCallback, useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import type { UiKey } from '@sitelog/shared/copy/ui/index.ts';
import { fieldLanguageOf, type FieldLanguage } from './language';

type Vars = Record<string, string | number>;

/**
 * The field app's copy in the current language (D9): `t` reads the shared `field` namespace, `tc`
 * the shared `common` one, both with typed keys (`UiKey`). Re-renders when the language changes.
 */
export function useFieldCopy(): {
  t: (key: UiKey<'field'>, vars?: Vars) => string;
  tc: (key: UiKey<'common'>, vars?: Vars) => string;
  language: FieldLanguage;
} {
  const { t: raw, i18n } = useTranslation(['field', 'common']);
  const language = fieldLanguageOf(i18n.resolvedLanguage) ?? 'en';
  const t = useCallback(
    (key: UiKey<'field'>, vars?: Vars) => raw(key, { ns: 'field', ...vars }) as string,
    [raw],
  );
  const tc = useCallback(
    (key: UiKey<'common'>, vars?: Vars) => raw(key, { ns: 'common', ...vars }) as string,
    [raw],
  );
  return useMemo(() => ({ t, tc, language }), [t, tc, language]);
}
