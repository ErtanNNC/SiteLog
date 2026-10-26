import { UI_RESOURCES } from '@sitelog/shared/copy/ui/index.ts';
import { copy } from '@/copy/en';
import type { PanelLanguage } from './language';

type Tree = { [key: string]: string | readonly string[] | Tree };

/**
 * The i18next resource of `copy/en.ts`: its plain strings (and string lists). The functions are
 * left out; pages that have not moved to `t()` yet call them directly.
 */
export function stringTree(node: object): Tree {
  const out: Tree = {};
  for (const [key, value] of Object.entries(node)) {
    if (typeof value === 'string') out[key] = value;
    else if (Array.isArray(value)) {
      if (value.every((v) => typeof v === 'string')) out[key] = value as string[];
    } else if (value && typeof value === 'object') out[key] = stringTree(value);
  }
  return out;
}

/**
 * D9 resources: namespace `panel` is `copy/en.ts` in English and the shared Turkish panel copy in
 * Turkish; `common` is the shared UI copy both apps use (language names, "Language"). A key with no
 * Turkish falls back to English (`fallbackLng: 'en'`).
 */
export const PANEL_RESOURCES: Record<PanelLanguage, { panel: Tree; common: Tree }> = {
  en: { panel: stringTree(copy), common: stringTree(UI_RESOURCES.en.common) },
  tr: { panel: stringTree(UI_RESOURCES.tr.panel), common: stringTree(UI_RESOURCES.tr.common) },
};
