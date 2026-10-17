/**
 * Retry timing of the upload queue (F5 step 3 "retried on online/app open"): exponential from
 * 2 s, capped at 5 minutes, with ±50 % jitter so phones that lost signal together do not retry
 * together. `online` and app-open events retry at once whatever the schedule.
 */
export const BACKOFF_BASE_MS = 2_000;
export const BACKOFF_MAX_MS = 5 * 60_000;

/** Milliseconds to wait before retry number `attempt` (1 = after the first failure). */
export function backoffDelay(attempt: number, random: () => number = Math.random): number {
  const n = Math.max(1, Math.floor(attempt));
  const base = Math.min(BACKOFF_MAX_MS, BACKOFF_BASE_MS * 2 ** (n - 1));
  const r = Math.min(Math.max(random(), 0), 0.999_999);
  return Math.round(base * (0.5 + r));
}
