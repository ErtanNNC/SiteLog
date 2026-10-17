import { describe, expect, it } from 'vitest';
import {
  billingAlert,
  billingPrice,
  billingProviderForCountry,
  billingProviderOf,
  effectiveBilling,
  formatBillingMoney,
  minorFromInput,
  isBillingBlocked,
  isOrgBillingBlocked,
  monthlyTotalMinor,
  stripePriceEnvName,
  trialLapsed,
  type BillingStateInput,
} from './billing.ts';

const NOW = new Date('2026-10-17T12:00:00Z');
const YESTERDAY = '2026-10-16T12:00:00.000Z';

/** A real US org whose 14-day trial ended yesterday, with no card (W4-10 Done when). */
const lapsed: BillingStateInput = {
  billing_status: 'trialing',
  billing_provider: 'stripe',
  billing_subscription_id: null,
  trial_ends_at: YESTERDAY,
  is_demo: false,
};

describe('billingPrice (§19 Q234)', () => {
  it('reads the org price and its currency', () => {
    expect(billingPrice({ price_per_site_minor: 39900, price_currency: 'USD' })).toEqual({
      minor: 39900,
      currency: 'USD',
    });
  });
  it('is null when SiteLog set no price, or the row is malformed', () => {
    expect(billingPrice({ price_per_site_minor: null, price_currency: null })).toBeNull();
    expect(billingPrice({ price_per_site_minor: 39900, price_currency: null })).toBeNull();
    expect(billingPrice({ price_per_site_minor: 0, price_currency: 'USD' })).toBeNull();
    expect(billingPrice({ price_per_site_minor: 399.5, price_currency: 'USD' })).toBeNull();
    expect(billingPrice({ price_per_site_minor: 39900, price_currency: 'usd' })).toBeNull();
  });
  it('totals price × active sites in minor units', () => {
    expect(monthlyTotalMinor({ minor: 39900, currency: 'USD' }, 6)).toBe(239400);
    expect(monthlyTotalMinor({ minor: 39900, currency: 'USD' }, -1)).toBe(0);
  });
});

describe('formatBillingMoney', () => {
  it('writes the currency minor digits in the viewer language', () => {
    expect(formatBillingMoney(39900, 'USD', 'en')).toBe('$399.00');
    expect(formatBillingMoney(239400, 'USD', 'en-US')).toBe('$2,394.00');
    expect(formatBillingMoney(150000, 'TRY', 'tr')).toBe('₺1.500,00');
    expect(formatBillingMoney(239400, 'USD', 'tr')).toBe('$2.394,00');
  });
});

describe('the provider pick (§19 Q236)', () => {
  it('bills a TR org manually until Q8, every other pack on Stripe', () => {
    expect(billingProviderForCountry('TR')).toBe('manual');
    expect(billingProviderForCountry('tr')).toBe('manual');
    expect(billingProviderForCountry('US')).toBe('stripe');
  });
  it('reads the column: anything but manual is Stripe', () => {
    expect(billingProviderOf({ billing_provider: 'manual' })).toBe('manual');
    expect(billingProviderOf({ billing_provider: 'stripe' })).toBe('stripe');
    expect(billingProviderOf({ billing_provider: null })).toBe('stripe');
  });
  it('names the Stripe price of a currency', () => {
    expect(stripePriceEnvName('USD')).toBe('STRIPE_PRICE_ID_SITE_US');
    expect(stripePriceEnvName('try')).toBe('STRIPE_PRICE_ID_SITE_TRY');
  });
});

describe('the trial-end rule (§19 Q235)', () => {
  it('treats a lapsed trial without a subscription as past due from trial_ends_at', () => {
    expect(trialLapsed(lapsed, NOW)).toBe(true);
    expect(effectiveBilling(lapsed, NOW)).toEqual({
      status: 'past_due',
      pastDueSince: YESTERDAY,
      reason: 'trial_ended',
      noGrace: false,
    });
  });
  it('never for a demo org, a manual org, a subscription, a running trial or no trial end', () => {
    expect(trialLapsed({ ...lapsed, is_demo: true }, NOW)).toBe(false);
    expect(trialLapsed({ ...lapsed, billing_provider: 'manual' }, NOW)).toBe(false);
    expect(trialLapsed({ ...lapsed, billing_subscription_id: 'sub_1' }, NOW)).toBe(false);
    expect(trialLapsed({ ...lapsed, trial_ends_at: '2026-10-20T00:00:00Z' }, NOW)).toBe(false);
    expect(trialLapsed({ ...lapsed, trial_ends_at: null }, NOW)).toBe(false);
    expect(trialLapsed({ ...lapsed, trial_ends_at: 'garbage' }, NOW)).toBe(false);
    expect(trialLapsed({ ...lapsed, billing_status: 'active' }, NOW)).toBe(false);
  });
  it('blocks after the grace days, not before', () => {
    expect(isOrgBillingBlocked(lapsed, NOW, 14)).toBe(false);
    const later = new Date('2026-10-30T12:00:01Z');
    expect(isOrgBillingBlocked(lapsed, later, 14)).toBe(true);
    expect(isOrgBillingBlocked({ ...lapsed, is_demo: true }, later, 14)).toBe(false);
    expect(isOrgBillingBlocked({ ...lapsed, billing_provider: 'manual' }, later, 14)).toBe(false);
  });
  it('the other answers: block at once, or never', () => {
    expect(isOrgBillingBlocked(lapsed, NOW, 14, 'block')).toBe(true);
    expect(isOrgBillingBlocked(lapsed, new Date('2026-12-01T00:00:00Z'), 14, 'never')).toBe(false);
  });
  it('keeps a stored past_due with its audited start', () => {
    const org = { ...lapsed, billing_status: 'past_due', past_due_since: '2026-10-01T00:00:00Z' };
    expect(effectiveBilling(org, NOW).reason).toBe('payment');
    expect(isOrgBillingBlocked(org, NOW, 14)).toBe(true);
    expect(isOrgBillingBlocked(org, NOW, 30)).toBe(false);
  });
});

describe('isBillingBlocked', () => {
  it('canceled and paused at once; past_due after the grace days', () => {
    const now = new Date('2026-10-20T00:00:00Z');
    expect(isBillingBlocked({ billingStatus: 'active', pastDueSince: null }, now, 14)).toBe(false);
    expect(isBillingBlocked({ billingStatus: 'canceled', pastDueSince: null }, now, 14)).toBe(true);
    expect(isBillingBlocked({ billingStatus: 'paused', pastDueSince: null }, now, 14)).toBe(true);
    expect(
      isBillingBlocked(
        { billingStatus: 'past_due', pastDueSince: '2026-10-10T00:00:00Z' },
        now,
        14,
      ),
    ).toBe(false);
    expect(
      isBillingBlocked(
        { billingStatus: 'past_due', pastDueSince: '2026-10-05T00:00:00Z' },
        now,
        14,
      ),
    ).toBe(true);
    expect(isBillingBlocked({ billingStatus: 'past_due', pastDueSince: null }, now, 14)).toBe(
      false,
    );
  });
});

describe('billingAlert (the admin banner)', () => {
  it('a lapsed trial: trial_ended, blocking 14 days after the trial end', () => {
    expect(billingAlert(lapsed, NOW, 14)).toEqual({
      kind: 'trial_ended',
      provider: 'stripe',
      since: YESTERDAY,
      blocksAt: '2026-10-30T12:00:00.000Z',
      blocked: false,
    });
    expect(billingAlert(lapsed, new Date('2026-11-01T00:00:00Z'), 14)?.blocked).toBe(true);
  });
  it('a failed payment: past_due from the audited change; unknown start → no date', () => {
    const org = { ...lapsed, billing_status: 'past_due', past_due_since: '2026-10-10T00:00:00Z' };
    expect(billingAlert(org, NOW, 14)).toEqual({
      kind: 'past_due',
      provider: 'stripe',
      since: '2026-10-10T00:00:00.000Z',
      blocksAt: '2026-10-24T00:00:00.000Z',
      blocked: false,
    });
    expect(billingAlert({ ...org, past_due_since: null }, NOW, 14)).toEqual({
      kind: 'past_due',
      provider: 'stripe',
      since: null,
      blocksAt: null,
      blocked: false,
    });
  });
  it('canceled is blocked; active, a running trial and a demo trial show nothing', () => {
    expect(billingAlert({ ...lapsed, billing_status: 'canceled' }, NOW, 14)).toEqual({
      kind: 'canceled',
      provider: 'stripe',
      since: null,
      blocksAt: null,
      blocked: true,
    });
    expect(billingAlert({ ...lapsed, billing_status: 'active' }, NOW, 14)).toBeNull();
    expect(billingAlert({ ...lapsed, trial_ends_at: '2026-10-25T00:00:00Z' }, NOW, 14)).toBeNull();
    expect(billingAlert({ ...lapsed, is_demo: true }, NOW, 14)).toBeNull();
  });
});

describe('minorFromInput (/ops price entry)', () => {
  it('reads the main unit with up to the currency digits', () => {
    expect(minorFromInput('399', 'USD')).toBe(39900);
    expect(minorFromInput(' 399.00 ', 'USD')).toBe(39900);
    expect(minorFromInput('1500,5', 'TRY')).toBe(150050);
    expect(minorFromInput('5000', 'JPY')).toBe(5000);
  });
  it('refuses zero, negatives, three decimals and words', () => {
    for (const bad of ['0', '-1', '399.001', 'abc', '', '1.5'])
      expect(minorFromInput(bad, bad === '1.5' ? 'JPY' : 'USD'), bad).toBeNull();
  });
});
