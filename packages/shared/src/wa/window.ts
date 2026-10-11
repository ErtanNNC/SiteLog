/** §9.2 — the 24 h customer service window. */
export const SERVICE_WINDOW_MS = 24 * 60 * 60 * 1000;

export function isServiceWindowOpen(
  lastInboundAt: Date | string | null | undefined,
  now: Date = new Date(),
  safetyMarginMs = 5 * 60 * 1000,
): boolean {
  if (!lastInboundAt) return false;
  const t =
    typeof lastInboundAt === 'string' ? new Date(lastInboundAt).getTime() : lastInboundAt.getTime();
  if (Number.isNaN(t)) return false;
  const age = now.getTime() - t;
  return age >= 0 && age < SERVICE_WINDOW_MS - safetyMarginMs;
}

export type SendMode = 'free_form' | 'template';

export function sendMode(
  lastInboundAt: Date | string | null | undefined,
  now: Date = new Date(),
): SendMode {
  return isServiceWindowOpen(lastInboundAt, now) ? 'free_form' : 'template';
}
