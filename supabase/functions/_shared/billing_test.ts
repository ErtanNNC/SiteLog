import { assertEquals } from '@std/assert';
import {
  idOf,
  isBillingBlocked,
  mapStripeStatus,
  monthlyTotalCents,
  periodEndOf,
  prorationFor,
  statusAfterInvoicePaid,
  trialDaysFor,
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

Deno.test('money and trial helpers', () => {
  assertEquals(monthlyTotalCents(0), 0);
  assertEquals(monthlyTotalCents(6), 239_400);
  assertEquals(trialDaysFor({ trial_ends_at: null }), 14);
  assertEquals(trialDaysFor({ trial_ends_at: '2026-10-25T00:00:00Z' }), undefined);
  assertEquals(prorationFor(2, 3), 'create_prorations');
  assertEquals(prorationFor(3, 2), 'none');
  assertEquals(prorationFor(3, 3), 'none');
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
