/**
 * Pure billing helpers shared by api-billing, stripe-webhook and scheduler-tick
 * (§1.3 pricing, §F19, §19 #4 trial, #5 paused sites).
 */

export const PRICE_PER_SITE_CENTS = 39_900;
export const TRIAL_DAYS = 14;

/** orgs.billing_status values: Stripe's statuses collapsed to what the panel distinguishes. */
export type BillingStatus = 'trialing' | 'active' | 'past_due' | 'canceled' | 'paused';

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

export function monthlyTotalCents(activeSites: number): number {
  return PRICE_PER_SITE_CENTS * Math.max(0, Math.floor(activeSites));
}

/** 14-day trial once per org: no trial when the org already had one (`trial_ends_at` set). */
export function trialDaysFor(org: { trial_ends_at: string | null }): number | undefined {
  return org.trial_ends_at ? undefined : TRIAL_DAYS;
}

/**
 * Adding a site is prorated (Stripe default); removing/pausing one is not credited mid-cycle,
 * the lower quantity simply applies from the next invoice (§19 #5).
 */
export function prorationFor(
  previousQuantity: number,
  nextQuantity: number,
): 'create_prorations' | 'none' {
  return nextQuantity > previousQuantity ? 'create_prorations' : 'none';
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

/**
 * §F19 step 5: past_due orgs keep working for `graceDays`, then the scheduler stops creating
 * site-days and sending reminders. Canceled and paused subscriptions are blocked immediately.
 * A past_due org whose start of arrears is unknown is treated as still within the grace period.
 */
export function isBillingBlocked(
  org: { billingStatus: string | null; pastDueSince: string | null },
  now: Date,
  graceDays: number,
): boolean {
  switch (org.billingStatus) {
    case 'canceled':
    case 'paused':
      return true;
    case 'past_due': {
      if (!org.pastDueSince) return false;
      const since = new Date(org.pastDueSince).getTime();
      if (Number.isNaN(since)) return false;
      return now.getTime() - since > Math.max(0, graceDays) * 86_400_000;
    }
    default:
      return false;
  }
}
