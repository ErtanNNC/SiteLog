import { PRICE_PER_SITE_CENTS, prorationFor } from '../_shared/billing.ts';

/** Pure pieces of api-billing (§F19, §P13). Stripe objects are typed structurally for tests. */

export interface InvoiceLike {
  id: string;
  created: number;
  total: number;
  currency: string;
  status: string | null;
  hosted_invoice_url?: string | null;
  lines: { data: Array<{ quantity: number | null }> };
}

export interface InvoiceSummary {
  id: string;
  date: string;
  amount_cents: number;
  currency: string;
  status: string | null;
  hosted_invoice_url: string | null;
  /** Billed site count (sum of line quantities). */
  sites: number;
}

export function invoiceSummary(inv: InvoiceLike): InvoiceSummary {
  return {
    id: inv.id,
    date: new Date(inv.created * 1000).toISOString(),
    amount_cents: inv.total,
    currency: inv.currency,
    status: inv.status,
    hosted_invoice_url: inv.hosted_invoice_url ?? null,
    sites: inv.lines.data.reduce((sum, line) => sum + (line.quantity ?? 0), 0),
  };
}

/**
 * Checkout subscribes one unit per active site. With none there is nothing to bill yet (Stripe
 * Checkout needs a quantity of at least 1), so the caller refuses instead of billing one site.
 */
export function checkoutQuantity(activeSites: number): number | null {
  const n = Math.max(0, Math.floor(activeSites));
  return n > 0 ? n : null;
}

export interface SyncDecision {
  update: boolean;
  quantity: number;
  proration: 'create_prorations' | 'none';
}

/** Subscription quantity must equal the number of active sites (§F19 steps 1–3). */
export function syncDecision(currentQuantity: number | null, activeSites: number): SyncDecision {
  const quantity = Math.max(0, Math.floor(activeSites));
  const current = currentQuantity ?? 0;
  return { update: quantity !== current, quantity, proration: prorationFor(current, quantity) };
}

export interface BillingSummary {
  billingStatus: string | null;
  trialEndsAt: string | null;
  activeSites: number;
  pricePerSiteCents: number;
  monthlyTotalCents: number;
  hasCustomer: boolean;
  hasSubscription: boolean;
  subscriptionStatus: string | null;
  subscriptionQuantity: number | null;
  nextInvoiceAt: string | null;
  paymentMethod: { brand: string; last4: string } | null;
}

export function baseSummary(
  org: {
    billing_status: string | null;
    trial_ends_at: string | null;
    billing_customer_id: string | null;
    billing_subscription_id: string | null;
  },
  activeSites: number,
): BillingSummary {
  return {
    billingStatus: org.billing_status,
    trialEndsAt: org.trial_ends_at,
    activeSites,
    pricePerSiteCents: PRICE_PER_SITE_CENTS,
    monthlyTotalCents: PRICE_PER_SITE_CENTS * activeSites,
    hasCustomer: org.billing_customer_id !== null,
    hasSubscription: org.billing_subscription_id !== null,
    subscriptionStatus: null,
    subscriptionQuantity: null,
    nextInvoiceAt: null,
    paymentMethod: null,
  };
}

/**
 * The Stripe price of one active site (§5.1 `STRIPE_PRICE_ID_SITE_US`). Until the secret is
 * renamed on every project (GAP 9.1: set the new one, read new with fallback, unset the old), the
 * old name `STRIPE_PRICE_ID_SITE` still works. Null when neither is set.
 */
export function sitePriceId(env: (name: string) => string | undefined): string | null {
  return env('STRIPE_PRICE_ID_SITE_US') ?? env('STRIPE_PRICE_ID_SITE') ?? null;
}
