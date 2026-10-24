import { assertEquals } from '@std/assert';
import {
  idOf,
  isBillingBlocked,
  mapStripeStatus,
  periodEndOf,
  prorationFor,
  checkoutTrial,
  MIN_CHECKOUT_TRIAL_MS,
  statusAfterInvoicePaid,
  unixToIso,
} from './billing.ts';

Deno.test('mapStripeStatus collapses Stripe statuses to the panel statuses', () => {
  assertEquals(mapStripeStatus('trialing'), 'trialing');
  assertEquals(mapStripeStatus('active'), 'active');
  assertEquals(mapStripeStatus('past_due'), 'past_due');
  assertEquals(mapStripeStatus('unpaid'), 'past_due');
  assertEquals(mapStripeStatus('incomplete'), 'past_due');
  assertEquals(mapStripeStatus('canceled'), 'canceled');
  assertEquals(mapStripeStatus('incomplete_expired'), 'canceled');
  assertEquals(mapStripeStatus('paused'), 'paused');
  assertEquals(mapStripeStatus('future_status'), null);
});

Deno.test('statusAfterInvoicePaid recovers past_due and converts trials, never canceled', () => {
  assertEquals(statusAfterInvoicePaid('past_due', 0), 'active');
  assertEquals(statusAfterInvoicePaid('trialing', 0), null); // $0 trial invoice
  assertEquals(statusAfterInvoicePaid('trialing', 39_900), 'active');
  assertEquals(statusAfterInvoicePaid('active', 39_900), null);
  assertEquals(statusAfterInvoicePaid('canceled', 39_900), null);
});

Deno.test('proration (from the shared rules)', () => {
  assertEquals(prorationFor(2, 3), 'create_prorations');
  assertEquals(prorationFor(3, 2), 'none');
  assertEquals(prorationFor(3, 3), 'none');
});

Deno.test('checkoutTrial keeps the trial create_org() started instead of charging at once', () => {
  const now = new Date('2026-10-12T12:00:00Z');
  // Org created on Oct 10: 12 days left, the subscription's trial ends with the org's.
  assertEquals(checkoutTrial({ trial_ends_at: '2026-10-24T12:00:00Z' }, now), {
    trial_end: Date.parse('2026-10-24T12:00:00Z') / 1000,
  });
  // Under 48 h left: Checkout's minimum (plus an hour), never an early charge.
  const soon = checkoutTrial({ trial_ends_at: '2026-10-13T12:00:00Z' }, now);
  assertEquals(soon, {
    trial_end: Math.ceil((now.getTime() + MIN_CHECKOUT_TRIAL_MS + 3_600_000) / 1000),
  });
  // Trial over, or a value Stripe could not use: no trial.
  assertEquals(checkoutTrial({ trial_ends_at: '2026-10-12T11:59:59Z' }, now), {});
  assertEquals(checkoutTrial({ trial_ends_at: 'garbage' }, now), {});
  // An org without a stored trial gets the full 14 days.
  assertEquals(checkoutTrial({ trial_ends_at: null }, now), { trial_period_days: 14 });
});

Deno.test('Stripe reference helpers', () => {
  assertEquals(idOf('cus_1'), 'cus_1');
  assertEquals(idOf({ id: 'cus_2' }), 'cus_2');
  assertEquals(idOf(null), null);
  assertEquals(unixToIso(1_791_000_000), '2026-10-03T04:00:00.000Z');
  assertEquals(unixToIso(null), null);
  assertEquals(
    periodEndOf({ items: { data: [{ current_period_end: 1_791_000_000 }] } }),
    1_791_000_000,
  );
  assertEquals(
    periodEndOf({ current_period_end: 1_791_000_001, items: { data: [{}] } }),
    1_791_000_001,
  );
  assertEquals(periodEndOf({}), null);
  assertEquals(periodEndOf(null), null);
});

Deno.test('isBillingBlocked', () => {
  const now = new Date('2026-10-20T00:00:00Z');
  assertEquals(isBillingBlocked({ billingStatus: 'active', pastDueSince: null }, now, 14), false);
  assertEquals(isBillingBlocked({ billingStatus: 'canceled', pastDueSince: null }, now, 14), true);
  assertEquals(
    isBillingBlocked({ billingStatus: 'past_due', pastDueSince: '2026-10-10T00:00:00Z' }, now, 14),
    false,
  );
  assertEquals(
    isBillingBlocked({ billingStatus: 'past_due', pastDueSince: '2026-10-05T00:00:00Z' }, now, 14),
    true,
  );
  assertEquals(
    isBillingBlocked({ billingStatus: 'past_due', pastDueSince: 'garbage' }, now, 14),
    false,
  );
});
