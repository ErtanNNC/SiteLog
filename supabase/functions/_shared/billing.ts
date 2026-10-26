/**
 * Billing helpers of the edge functions (api-billing, stripe-webhook, scheduler-tick, field-api;
 * §1.3, F23, P13, §19 Q234–Q236). The rules shared with the panel and the worker (the org's
 * price, the provider pick, the trial-end rule, `isBillingBlocked`, the quantity sync) live in
 * `@sitelog/shared/billing.ts` and are re-exported here; this file adds the Stripe specifics.
 */
import { TRIAL_DAYS, type BillingStatus } from '@sitelog/shared/billing.ts';

export {
  billingAlert,
  billingPrice,
  billingProviderOf,
  effectiveBilling,
  isBillingBlocked,
  isOrgBillingBlocked,
  monthlyTotalMinor,
  prorationFor,
  stripePriceEnvName,
  syncDecision,
  TRIAL_DAYS,
  type BillingPrice,
  type BillingProviderName,
  type BillingStateInput,
  type BillingStatus,
  type SyncDecision,
} from '@sitelog/shared/billing.ts';

/** Stripe subscription status → orgs.billing_status; null for a status we do not know. */
export function mapStripeStatus(status: string): BillingStatus | null {
  switch (status) {
    case 'trialing':
      return 'trialing';
    case 'active':
      return 'active';
    case 'past_due':
    case 'unpaid':
    case 'incomplete':
      return 'past_due';
    case 'canceled':
    case 'incomplete_expired':
      return 'canceled';
    case 'paused':
      return 'paused';
    default:
      return null;
  }
}

/** Stripe Checkout refuses a `subscription_data.trial_end` less than 48 hours away. */
export const MIN_CHECKOUT_TRIAL_MS = 48 * 3_600_000;
/** Head room for the time between building the session and Stripe validating it. */
const CHECKOUT_TRIAL_MARGIN_MS = 3_600_000;

/** The trial part of Checkout's `subscription_data`: nothing, a length, or an end (Unix s). */
export interface CheckoutTrial {
  trial_period_days?: number;
  trial_end?: number;
}

/**
 * 14-day trial once per org (§19 #4). create_org() starts it (`trial_ends_at` = +14 days), and
 * card details are added during it, so Checkout keeps the time left instead of charging at once:
 *   - no `trial_ends_at` (an org from before trials were stored): a full trial;
 *   - trial still running: it ends at `trial_ends_at`, or 48 h + 1 h from now when it is closer,
 *     since Checkout needs 48 h (a few extra free hours rather than an early charge);
 *   - trial over (or unreadable): none, the first invoice is charged at once.
 */
export function checkoutTrial(org: { trial_ends_at: string | null }, now: Date): CheckoutTrial {
  if (!org.trial_ends_at) return { trial_period_days: TRIAL_DAYS };
  const end = Date.parse(org.trial_ends_at);
  const nowMs = now.getTime();
  if (!Number.isFinite(end) || end <= nowMs) return {};
  const earliest = nowMs + MIN_CHECKOUT_TRIAL_MS + CHECKOUT_TRIAL_MARGIN_MS;
  return { trial_end: Math.ceil(Math.max(end, earliest) / 1000) };
}

/** New billing status after `invoice.paid`, or null when nothing should change. */
export function statusAfterInvoicePaid(
  current: string | null,
  amountPaidCents: number,
): BillingStatus | null {
  if (current === 'canceled') return null;
  if (current === 'past_due') return 'active';
  if (amountPaidCents > 0 && current !== 'active') return 'active';
  return null;
}

/** Stripe expandable references: either the id or the expanded object. */
export function idOf(ref: string | { id: string } | null | undefined): string | null {
  if (!ref) return null;
  return typeof ref === 'string' ? ref : ref.id;
}

export function unixToIso(seconds: number | null | undefined): string | null {
  if (typeof seconds !== 'number' || !Number.isFinite(seconds)) return null;
  return new Date(seconds * 1000).toISOString();
}

/**
 * `current_period_end` lives on the subscription item since API version 2025-03-31 (basil) and
 * on the subscription before that; read whichever is present without depending on the SDK types.
 */
export function periodEndOf(subscription: unknown): number | null {
  if (!subscription || typeof subscription !== 'object') return null;
  const sub = subscription as {
    current_period_end?: unknown;
    items?: { data?: Array<{ current_period_end?: unknown }> };
  };
  const fromItem = sub.items?.data?.[0]?.current_period_end;
  if (typeof fromItem === 'number') return fromItem;
  return typeof sub.current_period_end === 'number' ? sub.current_period_end : null;
}
