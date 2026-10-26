import type { Copy } from '@/copy/en';

/**
 * Typed keys for `t()` (D9). The keys are the dotted paths of the plain strings in `copy/en.ts`;
 * a counted phrase (`activeSites_one` / `activeSites_other`) is one key, `activeSites`, that takes
 * `{ count }`. Variables come from the English text's `{{name}}` placeholders, so a missing or
 * misspelt variable is a type error.
 */

type Fn = (...args: never[]) => unknown;

/** Dotted paths of the string leaves (functions and arrays are not i18next resources). */
type StringPaths<T, P extends string = ''> = {
  [K in keyof T & string]: T[K] extends string
    ? `${P}${K}`
    : T[K] extends Fn | readonly unknown[]
      ? never
      : T[K] extends object
        ? StringPaths<T[K], `${P}${K}.`>
        : never;
}[keyof T & string];

type PluralSuffix = 'one' | 'other';
type RawKey = StringPaths<Copy>;
type PluralBase<K> = K extends `${infer B}_${PluralSuffix}` ? B : never;

/** Every key `t()` accepts. */
export type CopyKey = Exclude<RawKey, `${string}_${PluralSuffix}`> | PluralBase<RawKey>;

type At<T, P extends string> = P extends `${infer H}.${infer R}`
  ? H extends keyof T
    ? At<T[H], R>
    : never
  : P extends keyof T
    ? T[P]
    : never;

/** The English text of a key (a counted phrase: its `_other` form). */
export type CopyText<K extends CopyKey> = K extends RawKey ? At<Copy, K> : At<Copy, `${K}_other`>;

type Placeholders<S> = S extends `${string}{{${infer V}}}${infer Rest}`
  ? V | Placeholders<Rest>
  : never;

type VarNames<K extends CopyKey> = Placeholders<CopyText<K>> | (K extends RawKey ? never : 'count');

/** The variables a key needs: `count` is a number, the others are text or numbers. */
export type CopyVars<K extends CopyKey> = {
  [V in VarNames<K>]: V extends 'count' ? number : string | number;
};

/** `t('nav.sites')` takes no variables; `t('shell.orgSwitcher.activeSites', { count })` must. */
export type CopyArgs<K extends CopyKey> = [VarNames<K>] extends [never] ? [] : [vars: CopyVars<K>];
