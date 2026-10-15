import { formatDate, formatHoursIn, formatTimeInTz } from '@sitelog/shared/format.ts';
import type { CopyRef, CopyVarValue } from '@/data/types';
import type { CopyArgs, CopyKey, CopyVars } from './keys';
import type { PanelLanguage } from './language';
import type { CopyT } from './useCopy';

type RefArgs<K extends CopyKey> =
  CopyArgs<K> extends []
    ? []
    : [vars: { [V in keyof CopyVars<K>]: CopyVars<K>[V] | Exclude<CopyVarValue, string | number> }];

/** A typed `CopyRef`: the key's `{{variables}}`, each a value or a formatted one (`{ hours }` …). */
export function copyRef<K extends CopyKey>(key: K, ...args: RefArgs<K>): CopyRef {
  const vars = args[0] as Record<string, CopyVarValue> | undefined;
  return vars ? { key, vars } : { key };
}

/** A `{ hours }` / `{ time, tz }` / `{ date }` value in the panel's language (184 h · 184 sa). */
export function formatCopyVar(value: CopyVarValue, language: PanelLanguage): string | number {
  if (typeof value === 'string' || typeof value === 'number') return value;
  if ('hours' in value) return formatHoursIn(value.hours, language);
  if ('time' in value) return formatTimeInTz(value.time, value.tz);
  return formatDate(value.date, 'monthDay', language);
}

/** A view model's `CopyRef` as text (W1-16): its key through `t()`, its values formatted. */
export function renderCopyRef(t: CopyT, language: PanelLanguage, ref: CopyRef): string {
  const vars = Object.fromEntries(
    Object.entries(ref.vars ?? {}).map(([k, v]) => [k, formatCopyVar(v, language)]),
  );
  // The key and its variables were typed where the ref was built (`copyRef`).
  return (t as (key: string, vars?: Record<string, string | number>) => string)(ref.key, vars);
}
