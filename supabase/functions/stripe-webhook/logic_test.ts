import { assertEquals } from '@std/assert';
import { checkoutOrgId, isHandledEvent, paymentFailedChange, subscriptionPatch } from './logic.ts';

Deno.test('invoice.payment_failed: past due with the payment_failed notice; canceled stays', () => {
  const change = paymentFailedChange({ billing_status: 'active' });
  assertEquals(change.patch, { billing_status: 'past_due' });
  assertEquals(change.notice.kind, 'billing');
  assertEquals(change.notice.targetPath, '/billing');
  assertEquals(change.notice.data, { key: 'payment_failed', params: {} });
  assertEquals(paymentFailedChange({ billing_status: 'canceled' }).patch, {});
  assertEquals(isHandledEvent('invoice.payment_failed'), true);
});

Deno.test('checkoutOrgId prefers metadata over client_reference_id', () => {
  assertEquals(checkoutOrgId({ metadata: { orgId: 'o1' }, client_reference_id: 'o2' }), 'o1');
  assertEquals(checkoutOrgId({ metadata: {}, client_reference_id: 'o2' }), 'o2');
  assertEquals(checkoutOrgId({ metadata: null, client_reference_id: null }), null);
});

Deno.test('subscriptionPatch mirrors Stripe status, ids and trial end', () => {
  assertEquals(
    subscriptionPatch({
      id: 'sub_1',
      status: 'trialing',
      customer: 'cus_1',
      trial_end: 1_792_000_000,
    }),
    {
      billing_subscription_id: 'sub_1',
      billing_status: 'trialing',
      billing_customer_id: 'cus_1',
      trial_ends_at: '2026-10-14T17:46:40.000Z',
    },
  );
  assertEquals(
    subscriptionPatch({
      id: 'sub_1',
      status: 'unpaid',
      customer: { id: 'cus_2' },
      trial_end: null,
    }),
    {
      billing_subscription_id: 'sub_1',
      billing_status: 'past_due',
      billing_customer_id: 'cus_2',
    },
  );
  assertEquals(
    subscriptionPatch({ id: 'sub_1', status: 'active', customer: null }, true).billing_status,
    'canceled',
  );
  // unknown status → leave billing_status untouched
  assertEquals(
    subscriptionPatch({ id: 'sub_1', status: 'something_new', customer: null }).billing_status,
    undefined,
  );
});

Deno.test('isHandledEvent', () => {
  assertEquals(isHandledEvent('invoice.paid'), true);
  assertEquals(isHandledEvent('charge.refunded'), false);
});
