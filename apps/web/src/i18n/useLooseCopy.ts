import { useMemo } from 'react';
import type { CopyKey } from './keys';
import { useCopy } from './useCopy';

/** `t()` for a key chosen at run time (an entry's kind, a flag): values unchecked. */
export type LooseT = (key: CopyKey, vars?: Record<string, string | number>) => string;

/**
 * `useCopy()` with a `t` that takes a key built at run time (`report.activity.events.${kind}`)
 * and its values as a plain record. Prefer `useCopy().t` where the key is written out.
 */
export function useLooseCopy(): ReturnType<typeof useCopy> & { tx: LooseT } {
  const copy = useCopy();
  return useMemo(() => ({ ...copy, tx: copy.t as unknown as LooseT }), [copy]);
}
