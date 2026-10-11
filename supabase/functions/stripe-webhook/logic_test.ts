import { assertEquals } from '@std/assert';
import { checkoutOrgId, isHandledEvent, subscriptionPatch } from './logic.ts';

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
      stripe_subscription_id: 'sub_1',
      billing_status: 'trialing',
      stripe_customer_id: 'cus_1',
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
      stripe_subscription_id: 'sub_1',
      billing_status: 'past_due',
      stripe_customer_id: 'cus_2',
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
