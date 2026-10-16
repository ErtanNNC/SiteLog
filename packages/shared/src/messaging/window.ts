/**
 * The WhatsApp 24-hour customer service window (spec §4.4, §9.2; GAP D49 (1)): a business-initiated
 * WhatsApp message needs an approved template unless the person's last inbound WhatsApp message is
 * less than 24 hours old, when free-form text may go. Channel-neutral since W2-15 (moved from
 * `wa/window.ts`): the Twilio WhatsApp transport (`whatsapp/transport.ts`) and, until step 22, the
 * v1.0 Meta worker (`apps/worker/src/wa/send.ts`) read it from here.
 */

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
