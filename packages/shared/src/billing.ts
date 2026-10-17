import { intlLocaleOf, type AnyLocale } from './locale.ts';

/**
 * Billing rules shared by the panel, the edge functions (api-billing, stripe-webhook,
 * scheduler-tick, field-api's Talk now) and the worker (W4-10; spec §1.3, F2 step 4, F23, P13,
 * §13 Billing, §19 Q7, Q8, Q9, Q10, Q30, Q174, Q234–Q236). Pure and Deno-safe; money in minor
 * units (integer cents, kuruş).
 *
 * - The price lives on the org (§19 Q234 `BILLING_PRICE_POLICY`): `orgs.price_per_site_minor`
 *   and `orgs.price_currency`, preset by create_org() from `billing_default_prices` for the pack's
 *   currency (null when SiteLog has set none, e.g. TRY until Q9) and changed only by SiteLog
 *   staff on /ops (`ops_set_org_billing()`, audited). The Stripe price of a currency is env
 *   (`STRIPE_PRICE_ID_SITE_<CURRENCY>`, `STRIPE_PRICE_ID_SITE_US` for USD).
 * - The provider is per org (`orgs.billing_provider`): `stripe`, or `manual` (§19 Q236: a TR org
 *   until Q8 names the entity and the provider; SiteLog invoices it directly and sets its status).
 * - A lapsed trial (§19 Q235 `TRIAL_END_POLICY`): an org still `trialing` after `trial_ends_at`
 *   with no subscription counts as past due from that instant (the banner, the org's grace days,
 *   then `isBillingBlocked`); never a demo org, never a `manual` org.
 */

export const BILLING_PROVIDERS = ['stripe', 'manual'] as const;
export type BillingProviderName = (typeof BILLING_PROVIDERS)[number];

/** orgs.billing_status values: Stripe's statuses collapsed to what the panel distinguishes. */
export const BILLING_STATUSES = ['trialing', 'active', 'past_due', 'canceled', 'paused'] as const;
export type BillingStatus = (typeof BILLING_STATUSES)[number];

export const TRIAL_DAYS = 14;

/** §19 Q234: where the price per site lives. Built: the org's own price (the recommended default). */
export type BillingPricePolicy = 'org';
export const BILLING_PRICE_POLICY: BillingPricePolicy = 'org';

/**
 * §19 Q235: what a trial that ends without a subscription does. `past_due` (recommended, built as
 * the default): past due from `trial_ends_at`, so the org's grace days apply; `block`: blocked at
 * once; `never`: nothing happens (the behaviour before W4-10).
 */
export type TrialEndPolicy = 'past_due' | 'block' | 'never';
export const TRIAL_END_POLICY: TrialEndPolicy = 'past_due';

/**
 * §19 Q236: the packs whose orgs are billed `manual` until §19 Q8 names a provider for them. A
 * new org's provider comes from its pack through create_org() (the SQL twin of
 * `billingProviderForCountry`, `20261017000450_billing_per_org.sql`).
 */
export const MANUAL_BILLING_COUNTRIES: readonly string[] = ['TR'];

export function billingProviderForCountry(country: string): BillingProviderName {
  return MANUAL_BILLING_COUNTRIES.includes(country.toUpperCase()) ? 'manual' : 'stripe';
}

/** `orgs.billing_provider` read safely: anything but `manual` is Stripe (the column default). */
export function billingProviderOf(org: {
  billing_provider: string | null | undefined;
}): BillingProviderName {
  return org.billing_provider === 'manual' ? 'manual' : 'stripe';
}

export interface BillingPrice {
  /** Minor units (cents, kuruş) per active site per month. */
  minor: number;
  /** ISO 4217, upper case. */
  currency: string;
}

/** The org's price per active site and month, or null when SiteLog has not set one (§19 Q234). */
export function billingPrice(org: {
  price_per_site_minor: number | null | undefined;
  price_currency: string | null | undefined;
}): BillingPrice | null {
  const minor = org.price_per_site_minor;
  const currency = org.price_currency;
  if (typeof minor !== 'number' || !Number.isInteger(minor) || minor <= 0) return null;
  if (!currency || !/^[A-Z]{3}$/.test(currency)) return null;
  return { minor, currency };
}

/** Price × active sites, in minor units (computed here, never trusted from elsewhere). */
export function monthlyTotalMinor(price: BillingPrice, activeSites: number): number {
  return price.minor * Math.max(0, Math.floor(activeSites));
}

/**
 * Money in the currency's own minor digits, in the viewer's language: 39900 USD → "$399.00" (en),
 * 239400 USD → "$2,394.00"; 150000 TRY → "₺1.500,00" (tr).
 */
export function formatBillingMoney(minor: number, currency: string, locale: AnyLocale): string {
  const format = new Intl.NumberFormat(intlLocaleOf(locale), { style: 'currency', currency });
  const digits = format.resolvedOptions().maximumFractionDigits ?? 2;
  return format.format(minor / 10 ** digits);
}

export interface BillingStateInput {
  billing_status: string | null;
  billing_provider: string | null;
  billing_subscription_id: string | null;
  trial_ends_at: string | null;
  is_demo: boolean;
  /** When the org last went past due (the audited `billing.status_changed` → past_due). */
  past_due_since?: string | null;
}

export interface BillingState {
  /** The status the rules act on (`past_due` for a lapsed trial, else the stored one). */
  status: string | null;
  /** The start of arrears: the audited change, or `trial_ends_at` for a lapsed trial. */
  pastDueSince: string | null;
  /** Why the org is past due, when it is. */
  reason: 'payment' | 'trial_ended' | null;
  /** §19 Q235 `block`: no grace days. */
  noGrace: boolean;
}

/** True when the trial of an org with no subscription ended at or before `now` (§19 Q235). */
export function trialLapsed(org: BillingStateInput, now: Date): boolean {
  if (org.billing_status !== 'trialing') return false;
  if (org.is_demo || billingProviderOf(org) === 'manual') return false;
  if (org.billing_subscription_id) return false;
  if (!org.trial_ends_at) return false;
  const end = Date.parse(org.trial_ends_at);
  return Number.isFinite(end) && end <= now.getTime();
}

/** The billing state the scheduler, Talk now and the banner act on (§19 Q235). */
export function effectiveBilling(
  org: BillingStateInput,
  now: Date,
  policy: TrialEndPolicy = TRIAL_END_POLICY,
): BillingState {
  if (policy !== 'never' && trialLapsed(org, now)) {
    return {
      status: 'past_due',
      pastDueSince: new Date(Date.parse(org.trial_ends_at!)).toISOString(),
      reason: 'trial_ended',
      noGrace: policy === 'block',
    };
  }
  if (org.billing_status === 'past_due') {
    return {
      status: 'past_due',
      pastDueSince: org.past_due_since ?? null,
      reason: 'payment',
      noGrace: false,
    };
  }
  return { status: org.billing_status, pastDueSince: null, reason: null, noGrace: false };
}

const DAY_MS = 86_400_000;

/**
 * §F19 step 5: past_due orgs keep working for `graceDays`, then the scheduler stops creating
 * site-days and sending reminders and Talk now is withheld. Canceled and paused subscriptions are
 * blocked at once. A past_due org whose start of arrears is unknown is within its grace period.
 */
export function isBillingBlocked(
  org: { billingStatus: string | null; pastDueSince: string | null; noGrace?: boolean },
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
      const grace = org.noGrace ? 0 : Math.max(0, graceDays);
      return now.getTime() - since > grace * DAY_MS;
    }
    default:
      return false;
  }
}

/** `isBillingBlocked` on the effective state: the rule every blocker reads (§19 Q235). */
export function isOrgBillingBlocked(
  org: BillingStateInput,
  now: Date,
  graceDays: number,
  policy: TrialEndPolicy = TRIAL_END_POLICY,
): boolean {
  const s = effectiveBilling(org, now, policy);
  return isBillingBlocked(
    { billingStatus: s.status, pastDueSince: s.pastDueSince, noGrace: s.noGrace },
    now,
    graceDays,
  );
}

/** What the admin banner says on every page (F23 "past-due banner", §19 Q235). */
export interface BillingAlert {
  kind: 'past_due' | 'trial_ended' | 'canceled';
  /** Who bills the org: a `manual` org pays SiteLog's invoice, not a card. */
  provider: BillingProviderName;
  /** The start of arrears (the trial's end for `trial_ended`), when known. */
  since: string | null;
  /** When reminders and calls stop (or stopped): the start of arrears plus the grace days. */
  blocksAt: string | null;
  /** Already blocked (the grace days are over, or the subscription is canceled). */
  blocked: boolean;
}

export function billingAlert(
  org: BillingStateInput,
  now: Date,
  graceDays: number,
  policy: TrialEndPolicy = TRIAL_END_POLICY,
): BillingAlert | null {
  const s = effectiveBilling(org, now, policy);
  const provider = billingProviderOf(org);
  if (s.status === 'canceled') {
    return { kind: 'canceled', provider, since: null, blocksAt: null, blocked: true };
  }
  if (s.status !== 'past_due') return null;
  const since = s.pastDueSince ? Date.parse(s.pastDueSince) : NaN;
  const grace = s.noGrace ? 0 : Math.max(0, graceDays);
  const blocksAt = Number.isFinite(since) ? new Date(since + grace * DAY_MS).toISOString() : null;
  return {
    kind: s.reason === 'trial_ended' ? 'trial_ended' : 'past_due',
    provider,
    since: Number.isFinite(since) ? new Date(since).toISOString() : null,
    blocksAt,
    blocked: isBillingBlocked(
      { billingStatus: s.status, pastDueSince: s.pastDueSince, noGrace: s.noGrace },
      now,
      graceDays,
    ),
  };
}

/**
 * The env name of a currency's Stripe price (§19 Q234: "the Stripe price id per currency in
 * env"): USD keeps its §5.1 name `STRIPE_PRICE_ID_SITE_US`, any other currency is
 * `STRIPE_PRICE_ID_SITE_<CURRENCY>` (e.g. `STRIPE_PRICE_ID_SITE_TRY`, once Q8/Q9 put TR on Stripe).
 */
export function stripePriceEnvName(currency: string): string {
  const c = currency.toUpperCase();
  return c === 'USD' ? 'STRIPE_PRICE_ID_SITE_US' : `STRIPE_PRICE_ID_SITE_${c}`;
}

/**
 * Adding a site is prorated (Stripe's default); removing or pausing one is not credited mid-cycle,
 * the lower quantity simply applies from the next invoice (§19 Q10).
 */
export function prorationFor(
  previousQuantity: number,
  nextQuantity: number,
): 'create_prorations' | 'none' {
  return nextQuantity > previousQuantity ? 'create_prorations' : 'none';
}

export interface SyncDecision {
  update: boolean;
  quantity: number;
  proration: 'create_prorations' | 'none';
}

/**
 * The subscription's quantity must equal the active sites (F23 steps 1–3): api-billing's `sync`
 * and the worker's `billing_sync` retry (W4-10) both decide with this.
 */
export function syncDecision(currentQuantity: number | null, activeSites: number): SyncDecision {
  const quantity = Math.max(0, Math.floor(activeSites));
  const current = currentQuantity ?? 0;
  return { update: quantity !== current, quantity, proration: prorationFor(current, quantity) };
}

/** The currency's minor digits per Intl (USD and TRY 2, JPY 0). */
export function currencyDigits(currency: string): number {
  try {
    return (
      new Intl.NumberFormat('en-US', { style: 'currency', currency }).resolvedOptions()
        .maximumFractionDigits ?? 2
    );
  } catch {
    return 2;
  }
}

/**
 * A price typed in the currency's main unit ("399", "399.00", "1500,5") → minor units, or null
 * when it is not a positive amount with at most the currency's minor digits (/ops, W4-10).
 */
export function minorFromInput(text: string, currency: string): number | null {
  const digits = currencyDigits(currency);
  const m = /^\s*(\d{1,9})(?:[.,](\d+))?\s*$/.exec(text);
  if (!m) return null;
  const frac = m[2] ?? '';
  if (frac.length > digits) return null;
  const minor = Number(m[1]) * 10 ** digits + Number(frac.padEnd(digits, '0') || '0');
  return minor > 0 ? minor : null;
}
