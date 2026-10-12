import { assertEquals } from '@std/assert';
import { baseSummary, checkoutQuantity, invoiceSummary, syncDecision } from './logic.ts';

Deno.test('invoiceSummary maps a Stripe invoice to the panel row', () => {
  assertEquals(
    invoiceSummary({
      id: 'in_1',
      created: 1_791_000_000,
      total: 119_700,
      currency: 'usd',
      status: 'paid',
      hosted_invoice_url: 'https://invoice.stripe.com/i/x',
      lines: { data: [{ quantity: 2 }, { quantity: 1 }, { quantity: null }] },
    }),
    {
      id: 'in_1',
      date: '2026-10-03T04:00:00.000Z',
      amount_cents: 119_700,
      currency: 'usd',
      status: 'paid',
      hosted_invoice_url: 'https://invoice.stripe.com/i/x',
      sites: 3,
    },
  );
});

Deno.test('checkoutQuantity bills the active sites and refuses an org with none', () => {
  assertEquals(checkoutQuantity(0), null);
  assertEquals(checkoutQuantity(-1), null);
  assertEquals(checkoutQuantity(1), 1);
  assertEquals(checkoutQuantity(6), 6);
});

Deno.test('syncDecision updates only when the quantity differs; decreases are not prorated', () => {
  assertEquals(syncDecision(3, 3), { update: false, quantity: 3, proration: 'none' });
  assertEquals(syncDecision(3, 4), { update: true, quantity: 4, proration: 'create_prorations' });
  assertEquals(syncDecision(3, 2), { update: true, quantity: 2, proration: 'none' });
  assertEquals(syncDecision(null, 1), {
    update: true,
    quantity: 1,
    proration: 'create_prorations',
  });
});

Deno.test('baseSummary prices $399 per active site', () => {
  const s = baseSummary(
    {
      billing_status: 'active',
      trial_ends_at: null,
      stripe_customer_id: 'cus_1',
      stripe_subscription_id: null,
    },
    6,
  );
  assertEquals(s.monthlyTotalCents, 239_400);
  assertEquals(s.pricePerSiteCents, 39_900);
  assertEquals(s.hasCustomer, true);
  assertEquals(s.hasSubscription, false);
});
