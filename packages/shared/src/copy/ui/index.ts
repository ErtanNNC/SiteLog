import type { Language } from '../../locale.ts';
import { uiEn } from './en.ts';
import { uiEs } from './es.ts';
import { uiTr } from './tr.ts';
import type { PanelCopyTree, UiNamespace, UiResources } from './types.ts';

export type { PanelCopyTree, UiCopy, UiKey, UiNamespace, UiResources } from './types.ts';
export { uiEn, uiEs, uiTr };

/** i18next namespaces (D9). */
export const UI_NAMESPACES = ['common', 'panel', 'field'] as const satisfies readonly UiNamespace[];

/** Languages per surface (CLAUDE.md, §9.6): panel EN/TR, field app EN/ES/TR. */
export const UI_LANGUAGES = {
  panel: ['en', 'tr'],
  field: ['en', 'es', 'tr'],
} as const satisfies Record<'panel' | 'field', readonly Language[]>;

/**
 * Resources in i18next's shape (`{ [lng]: { [ns]: tree } }`), ready for `i18next.init({ resources })`.
 * `panel` is Turkish only: its English is `apps/web/src/copy/en.ts`, which W1-03 adds as the `en`
 * `panel` resource, and Spanish has no panel (UI_LANGUAGES).
 */
export const UI_RESOURCES: {
  en: UiResources;
  tr: UiResources & { panel: PanelCopyTree };
  es: UiResources;
} = { en: uiEn, tr: uiTr, es: uiEs };
