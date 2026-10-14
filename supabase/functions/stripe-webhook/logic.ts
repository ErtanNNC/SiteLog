import { idOf, mapStripeStatus, unixToIso, type BillingStatus } from '../_shared/billing.ts';

/** Pure parts of the Stripe webhook; Stripe objects are typed structurally so tests need no SDK. */

export const HANDLED_EVENTS = [
  'checkout.session.completed',
  'customer.subscription.created',
  'customer.subscription.updated',
  'customer.subscription.deleted',
  'invoice.payment_failed',
  'invoice.paid',
] as const;
export type HandledEvent = (typeof HANDLED_EVENTS)[number];

export function isHandledEvent(type: string): type is HandledEvent {
  return (HANDLED_EVENTS as readonly string[]).includes(type);
}

/** The org a Checkout Session belongs to: `metadata.orgId` first, then `client_reference_id`. */
export function checkoutOrgId(session: {
  metadata?: Record<string, string> | null;
  client_reference_id?: string | null;
}): string | null {
  return session.metadata?.orgId ?? session.client_reference_id ?? null;
}

export interface SubscriptionLike {
  id: string;
  status: string;
  customer: string | { id: string } | null;
  trial_end?: number | null;
}

/**
 * The §6.3 billing columns (20261014000003_renames_billing.sql). The legacy stripe_* columns
 * follow them through the orgs_billing_ids trigger until step 23.
 */
export interface OrgBillingPatch {
  billing_status?: BillingStatus;
  billing_subscription_id?: string;
  billing_customer_id?: string;
  trial_ends_at?: string;
}

/** orgs columns to update from a subscription event; unknown Stripe statuses leave the status alone. */
export function subscriptionPatch(sub: SubscriptionLike, deleted = false): OrgBillingPatch {
  const patch: OrgBillingPatch = { billing_subscription_id: sub.id };
  const status = deleted ? 'canceled' : mapStripeStatus(sub.status);
  if (status) patch.billing_status = status;
  const customerId = idOf(sub.customer);
  if (customerId) patch.billing_customer_id = customerId;
  const trialEndsAt = unixToIso(sub.trial_end);
  if (trialEndsAt) patch.trial_ends_at = trialEndsAt;
  return patch;
}
