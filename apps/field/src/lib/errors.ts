import { apiErrorBody, apiErrorCode, isOfflineError, retryAfterSeconds } from '@/api/field';

/** A copy key under a screen's `errors` map, with its variables. */
export interface CopyError {
  key: string;
  vars?: Record<string, string | number>;
}

/** Minutes a rate-limited caller waits, at least 1 (the copy says "in {{minutes}} min"). */
export function retryMinutes(err: unknown): number {
  return Math.max(1, Math.ceil((retryAfterSeconds(err) ?? 60) / 60));
}

/**
 * The copy key for a failed call, inside a screen's `errors` map: the field-api code when the map
 * names it, `rate_limited` with its minutes, `offline` for no answer, else `generic`.
 */
export function copyError(err: unknown, known: readonly string[]): CopyError {
  const code = apiErrorCode(err);
  if (code === 'rate_limited') return { key: 'rate_limited', vars: { minutes: retryMinutes(err) } };
  if (code === 'code_invalid') {
    const details = apiErrorBody(err)?.details as { attemptsLeft?: number } | undefined;
    return { key: 'code_invalid', vars: { attemptsLeft: details?.attemptsLeft ?? 0 } };
  }
  if (code && known.includes(code)) return { key: code };
  if (isOfflineError(err)) return { key: 'offline' };
  return { key: 'generic' };
}
