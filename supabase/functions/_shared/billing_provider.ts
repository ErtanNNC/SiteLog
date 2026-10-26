/**
 * The billing provider behind api-billing (W4-10; spec P13 "US via Stripe; TR provider (§19)",
 * F23, §19 Q8, Q234, Q236). `orgs.billing_provider` picks it:
 *   - `stripe`: Checkout (the org's price, the rest of its 14-day trial), the customer portal,
 *     the quantity sync, invoices and the payment method, on a structural Stripe client so tests
 *     need no SDK and no key;
 *   - `manual`: TalkOlog invoices the org directly (a TR org until Q8 names a provider): no
 *     Checkout, no portal, nothing to sync, no invoices here; TalkOlog staff set its status on /ops.
 * A new provider (iyzico, PayTR, … once Q8 is decided) is one more implementation of this
 * interface and one more `billing_provider` value.
 */
import {
  billingPrice,
  billingProviderOf,
  checkoutTrial,
  periodEndOf,
  stripePriceEnvName,
  syncDecision,
  unixToIso,
  type BillingProviderName,
  type CheckoutTrial,
} from './billing.ts';
import { EnvError } from './env.ts';
import { HttpError } from './http.ts';

/** The orgs columns a provider reads. */
export interface BillingOrg {
  id: string;
  name: string;
  billing_provider: string | null;
  billing_status: string | null;
  billing_customer_id: string | null;
  billing_subscription_id: string | null;
  trial_ends_at: string | null;
  price_per_site_minor: number | null;
  price_currency: string | null;
  is_demo: boolean;
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

export interface CheckoutResult {
  url: string | null;
  sessionId: string;
  quantity: number;
  trialDays: number;
  trialEnd: string | null;
}

export type SyncResult =
  | {
      synced: false;
      reason: 'no_subscription' | 'no_subscription_item' | 'manual';
      activeSites: number;
    }
  | { synced: true; changed: false; quantity: number; activeSites: number }
  | { synced: true; changed: true; quantity: number; previous: number | null; activeSites: number };

/** What the provider adds to the Billing page's summary. */
export interface ProviderStatus {
  subscriptionStatus: string | null;
  subscriptionQuantity: number | null;
  nextInvoiceAt: string | null;
  paymentMethod: { brand: string; last4: string } | null;
}

export interface BillingProvider {
  readonly name: BillingProviderName;
  /** Hosted payment pages exist (Checkout and the portal). */
  readonly hostedPages: boolean;
  checkout(org: BillingOrg, activeSites: number, email: string | null): Promise<CheckoutResult>;
  portal(org: BillingOrg): Promise<{ url: string }>;
  syncQuantity(org: BillingOrg, activeSites: number): Promise<SyncResult>;
  invoices(org: BillingOrg): Promise<InvoiceSummary[]>;
  status(org: BillingOrg): Promise<ProviderStatus>;
}

const NO_PROVIDER_STATUS: ProviderStatus = {
  subscriptionStatus: null,
  subscriptionQuantity: null,
  nextInvoiceAt: null,
  paymentMethod: null,
};

/** §19 Q236: TalkOlog invoices the org directly. 409 `manual_billing` for the hosted pages. */
export const manualProvider: BillingProvider = {
  name: 'manual',
  hostedPages: false,
  checkout() {
    return Promise.reject(
      new HttpError(409, 'TalkOlog invoices this organisation directly', {
        code: 'manual_billing',
      }),
    );
  },
  portal() {
    return Promise.reject(
      new HttpError(409, 'TalkOlog invoices this organisation directly', {
        code: 'manual_billing',
      }),
    );
  },
  syncQuantity(_org, activeSites) {
    return Promise.resolve({ synced: false, reason: 'manual', activeSites });
  },
  invoices() {
    return Promise.resolve([]);
  },
  status() {
    return Promise.resolve({ ...NO_PROVIDER_STATUS });
  },
};

// ─── Stripe ───────────────────────────────────────────────────────────────────────────────────

/** The parts of Stripe's SDK the provider calls, typed structurally (tests pass a fake). */
export interface StripeLike {
  customers: {
    create(params: {
      name: string;
      email?: string;
      metadata: Record<string, string>;
    }): Promise<{ id: string }>;
    retrieve(id: string, params: { expand: string[] }): Promise<unknown>;
  };
  checkout: {
    sessions: {
      create(params: Record<string, unknown>): Promise<{ id: string; url: string | null }>;
    };
  };
  billingPortal: {
    sessions: {
      create(params: { customer: string; return_url: string }): Promise<{ url: string }>;
    };
  };
  prices: {
    retrieve(id: string): Promise<{ id: string; unit_amount: number | null; currency: string }>;
  };
  subscriptions: {
    retrieve(id: string): Promise<{
      id: string;
      status: string;
      items: { data: Array<{ id: string; quantity?: number | null }> };
    }>;
  };
  subscriptionItems: {
    update(
      id: string,
      params: { quantity: number; proration_behavior: 'create_prorations' | 'none' },
    ): Promise<unknown>;
  };
  invoices: { list(params: { customer: string; limit: number }): Promise<{ data: InvoiceLike[] }> };
  paymentMethods: {
    retrieve(id: string): Promise<{ card?: { brand: string; last4: string } | null }>;
    list(params: {
      customer: string;
      type: 'card';
      limit: number;
    }): Promise<{ data: Array<{ card?: { brand: string; last4: string } | null }> }>;
  };
}

export interface InvoiceLike {
  id: string;
  created: number;
  total: number;
  currency: string;
  status: string | null;
  hosted_invoice_url?: string | null;
  lines: { data: Array<{ quantity: number | null }> };
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

/**
 * The Stripe price of one active site in `currency` (§19 Q234: the price id per currency in env):
 * `STRIPE_PRICE_ID_SITE_<CURRENCY>` (`STRIPE_PRICE_ID_SITE_US` for USD, which still falls back
 * to the old `STRIPE_PRICE_ID_SITE` until GAP 9.1's rename is done everywhere). Null when unset.
 */
export function sitePriceId(
  env: (name: string) => string | undefined,
  currency = 'USD',
): string | null {
  const c = currency.toUpperCase();
  if (c === 'USD') return env('STRIPE_PRICE_ID_SITE_US') ?? env('STRIPE_PRICE_ID_SITE') ?? null;
  return env(stripePriceEnvName(c)) ?? null;
}

export interface StripeProviderDeps {
  stripe: StripeLike;
  env: (name: string) => string | undefined;
  /** The panel's origin, for Checkout's and the portal's return URLs. */
  appUrl: () => string;
  /** Stores a new Stripe customer on the org (`billing_customer_id`). */
  saveCustomer: (orgId: string, customerId: string) => Promise<void>;
  now: () => Date;
  log?: (event: string, data: Record<string, unknown>) => void;
}

export function stripeProvider(deps: StripeProviderDeps): BillingProvider {
  const log = deps.log ?? (() => undefined);

  async function ensureCustomer(org: BillingOrg, email: string | null): Promise<string> {
    if (org.billing_customer_id) return org.billing_customer_id;
    const customer = await deps.stripe.customers.create({
      name: org.name,
      email: email ?? undefined,
      metadata: { orgId: org.id },
    });
    await deps.saveCustomer(org.id, customer.id);
    org.billing_customer_id = customer.id;
    log('billing.customer_created', { orgId: org.id, customerId: customer.id });
    return customer.id;
  }

  async function syncQuantity(org: BillingOrg, activeSites: number): Promise<SyncResult> {
    if (!org.billing_subscription_id) {
      return { synced: false, reason: 'no_subscription', activeSites };
    }
    const subscription = await deps.stripe.subscriptions.retrieve(org.billing_subscription_id);
    const item = subscription.items.data[0];
    if (!item) return { synced: false, reason: 'no_subscription_item', activeSites };
    const decision = syncDecision(item.quantity ?? null, activeSites);
    if (!decision.update) {
      return { synced: true, changed: false, quantity: decision.quantity, activeSites };
    }
    await deps.stripe.subscriptionItems.update(item.id, {
      quantity: decision.quantity,
      proration_behavior: decision.proration,
    });
    log('billing.quantity_synced', {
      orgId: org.id,
      subscriptionId: subscription.id,
      from: item.quantity ?? null,
      to: decision.quantity,
      proration: decision.proration,
    });
    return {
      synced: true,
      changed: true,
      quantity: decision.quantity,
      previous: item.quantity ?? null,
      activeSites,
    };
  }

  return {
    name: 'stripe',
    hostedPages: true,

    async checkout(org, activeSites, email) {
      if (org.billing_subscription_id && org.billing_status !== 'canceled') {
        throw new HttpError(
          409,
          'This organisation already has a subscription; use the billing portal to manage it',
        );
      }
      // Checked before a Stripe customer is created: with no active site there is nothing to bill.
      const quantity = checkoutQuantity(activeSites);
      if (quantity === null) {
        throw new HttpError(
          409,
          'Add a site before starting the subscription; billing is per active site',
        );
      }
      const price = billingPrice(org);
      if (!price) {
        throw new HttpError(409, 'TalkOlog has not set a price for this organisation yet', {
          code: 'no_price',
        });
      }
      const priceId = sitePriceId(deps.env, price.currency);
      if (!priceId) throw new EnvError(stripePriceEnvName(price.currency));
      // Never bill an amount the Billing page does not show (§19 Q270): the Stripe price of the
      // currency must be the org's price.
      const stripePrice = await deps.stripe.prices.retrieve(priceId);
      if (
        stripePrice.unit_amount !== price.minor ||
        stripePrice.currency.toUpperCase() !== price.currency
      ) {
        throw new HttpError(
          409,
          'This organisation has its own price; TalkOlog sets up its subscription',
          { code: 'price_mismatch' },
        );
      }
      const customer = await ensureCustomer(org, email);
      const trial: CheckoutTrial = checkoutTrial(org, deps.now());
      const base = deps.appUrl();
      const session = await deps.stripe.checkout.sessions.create({
        mode: 'subscription',
        customer,
        client_reference_id: org.id,
        line_items: [{ price: priceId, quantity }],
        subscription_data: { metadata: { orgId: org.id }, ...trial },
        success_url: `${base}/billing?checkout=success&session_id={CHECKOUT_SESSION_ID}`,
        cancel_url: `${base}/billing?checkout=canceled`,
        metadata: { orgId: org.id },
      });
      const trialEnd = unixToIso(trial.trial_end);
      const trialDays = trial.trial_period_days ?? 0;
      log('billing.checkout_created', {
        orgId: org.id,
        sessionId: session.id,
        quantity,
        trialDays,
        trialEnd,
        currency: price.currency,
      });
      return { url: session.url, sessionId: session.id, quantity, trialDays, trialEnd };
    },

    async portal(org) {
      if (!org.billing_customer_id) {
        throw new HttpError(409, 'No Stripe customer yet; start a subscription first');
      }
      const session = await deps.stripe.billingPortal.sessions.create({
        customer: org.billing_customer_id,
        return_url: `${deps.appUrl()}/billing`,
      });
      return { url: session.url };
    },

    syncQuantity,

    async invoices(org) {
      if (!org.billing_customer_id) return [];
      const list = await deps.stripe.invoices.list({
        customer: org.billing_customer_id,
        limit: 12,
      });
      return list.data.map(invoiceSummary);
    },

    async status(org) {
      const out: ProviderStatus = { ...NO_PROVIDER_STATUS };
      if (org.billing_subscription_id) {
        const subscription = await deps.stripe.subscriptions.retrieve(org.billing_subscription_id);
        out.subscriptionStatus = subscription.status;
        out.subscriptionQuantity = subscription.items.data[0]?.quantity ?? null;
        out.nextInvoiceAt = unixToIso(periodEndOf(subscription));
      }
      if (org.billing_customer_id) {
        out.paymentMethod = await defaultPaymentMethod(deps.stripe, org.billing_customer_id);
      }
      return out;
    },
  };
}

async function defaultPaymentMethod(
  stripe: StripeLike,
  customerId: string,
): Promise<{ brand: string; last4: string } | null> {
  const customer = (await stripe.customers.retrieve(customerId, {
    expand: ['invoice_settings.default_payment_method'],
  })) as {
    deleted?: boolean;
    invoice_settings?: {
      default_payment_method?: string | { card?: { brand: string; last4: string } | null } | null;
    };
  };
  if (customer.deleted === true) return null;
  const preferred = customer.invoice_settings?.default_payment_method ?? null;
  let card: { brand: string; last4: string } | null | undefined = null;
  if (preferred && typeof preferred !== 'string') card = preferred.card;
  else if (typeof preferred === 'string')
    card = (await stripe.paymentMethods.retrieve(preferred)).card;
  if (!card) {
    const list = await stripe.paymentMethods.list({ customer: customerId, type: 'card', limit: 1 });
    card = list.data[0]?.card ?? null;
  }
  return card ? { brand: card.brand, last4: card.last4 } : null;
}

/** `orgs.billing_provider` → the provider; Stripe's client is made only when an org needs it. */
export function pickProvider(
  org: Pick<BillingOrg, 'billing_provider'>,
  stripe: () => BillingProvider,
): BillingProvider {
  return billingProviderOf(org) === 'manual' ? manualProvider : stripe();
}
