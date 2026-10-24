import type { uiEn } from './en.ts';

/** The same tree with every leaf widened to `string`, so translations can differ from EN. */
export type UiCopy<T> = { readonly [K in keyof T]: T[K] extends string ? string : UiCopy<T[K]> };

/** The namespaces whose English lives here (`common`, `field`). */
export type UiResources = UiCopy<typeof uiEn>;

/**
 * The panel's Turkish (`panel` namespace). Its English is `apps/web/src/copy/en.ts`, so the key
 * structure is checked against that file by a test in `apps/web`, not by this type.
 */
export interface PanelCopyTree {
  readonly [key: string]: string | PanelCopyTree;
}

export type UiNamespace = keyof UiResources | 'panel';

/** Dotted keys of a namespace, for typed `t()`: `UiKey<'field'>` → 'routes.today' | … */
export type UiKey<NS extends keyof UiResources, T = UiResources[NS], P extends string = ''> = {
  [K in keyof T & string]: T[K] extends string ? `${P}${K}` : UiKey<NS, T[K], `${P}${K}.`>;
}[keyof T & string];
