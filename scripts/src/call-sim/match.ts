/**
 * W3-15: how the call simulator compares field-api's answers with a script's. Pure.
 *
 * - `recorded`: the answer equals the recorded one but for the values a fresh run cannot repeat
 *   (`VOLATILE_KEYS`: ids, revisions, keys, the report number and date, the call token);
 * - a subset: every key the script names has that value (objects recursively; an array has the
 *   same length and each element matches); a key it leaves out is not checked.
 */

/** Keys whose values differ run to run: compared for presence and type only. */
export const VOLATILE_KEYS = [
  'callId',
  'callToken',
  'reportId',
  'draftRev',
  'id',
  'siteId',
  'confirmKey',
  'correctionId',
  'reportNo',
  'date',
  'retryAfterMs',
] as const;

/** The differences between `expected` and `actual`, as `path: expected … got …` lines. */
export function diffRecorded(expected: unknown, actual: unknown, path = '$'): string[] {
  return diff(expected, actual, path, 'exact');
}

/** The differences where `actual` does not have what the subset `expected` names. */
export function matchSubset(expected: unknown, actual: unknown, path = '$'): string[] {
  return diff(expected, actual, path, 'subset');
}

function show(v: unknown): string {
  const s = JSON.stringify(v);
  return s === undefined ? 'undefined' : s.length > 160 ? `${s.slice(0, 157)}...` : s;
}

function diff(
  expected: unknown,
  actual: unknown,
  path: string,
  mode: 'exact' | 'subset',
): string[] {
  if (Array.isArray(expected)) {
    if (!Array.isArray(actual)) return [`${path}: expected an array, got ${show(actual)}`];
    if (expected.length !== actual.length)
      return [`${path}: expected ${expected.length} items, got ${actual.length}: ${show(actual)}`];
    return expected.flatMap((e, i) => diff(e, actual[i], `${path}[${i}]`, mode));
  }
  if (expected && typeof expected === 'object') {
    if (!actual || typeof actual !== 'object' || Array.isArray(actual))
      return [`${path}: expected an object, got ${show(actual)}`];
    const a = actual as Record<string, unknown>;
    const e = expected as Record<string, unknown>;
    const out: string[] = [];
    const keys =
      mode === 'exact' ? new Set([...Object.keys(e), ...Object.keys(a)]) : new Set(Object.keys(e));
    for (const k of keys) {
      const p = `${path}.${k}`;
      if (mode === 'exact' && (VOLATILE_KEYS as readonly string[]).includes(k)) {
        if (!(k in a)) out.push(`${p}: missing`);
        else if (!(k in e)) out.push(`${p}: not expected, got ${show(a[k])}`);
        else if (e[k] === null ? a[k] !== null : typeof a[k] !== typeof e[k])
          out.push(`${p}: expected a ${e[k] === null ? 'null' : typeof e[k]}, got ${show(a[k])}`);
        continue;
      }
      if (!(k in a) && e[k] !== undefined) {
        out.push(`${p}: missing (expected ${show(e[k])})`);
        continue;
      }
      if (mode === 'exact' && !(k in e)) {
        out.push(`${p}: not expected, got ${show(a[k])}`);
        continue;
      }
      out.push(...diff(e[k], a[k], p, mode));
    }
    return out;
  }
  return Object.is(expected, actual)
    ? []
    : [`${path}: expected ${show(expected)}, got ${show(actual)}`];
}

/** A `pending` answer of a live tool (HTTP 202): timing, never part of a script's expectations. */
export function isPending(answer: unknown): boolean {
  return (
    !!answer &&
    typeof answer === 'object' &&
    (answer as Record<string, unknown>).status === 'pending'
  );
}
