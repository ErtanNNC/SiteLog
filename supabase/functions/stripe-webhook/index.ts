import Stripe from 'stripe';
import { logAudit } from '../_shared/audit.ts';
import { idOf, statusAfterInvoicePaid } from '../_shared/billing.ts';
import { requireEnv } from '../_shared/env.ts';
import { error, json, requireMethod, withHandler } from '../_shared/http.ts';
import { errorMessage, logInfo, logWarn } from '../_shared/log.ts';
import { notifyOrg } from '../_shared/notify.ts';
import { adminClient, type AppClient, type TableRow } from '../_shared/supabase.ts';
import { checkoutOrgId, isHandledEvent, subscriptionPatch, type OrgBillingPatch } from './logic.ts';

/**
 * stripe-webhook (§F19 step 5, §13 billing) — public endpoint verified with Stripe-Signature.
 * Mirrors Stripe into orgs.billing_status and billing_customer_id / billing_subscription_id (the
 * legacy stripe_* columns follow by trigger until step 23), alerts the org on payment failures and is
 * idempotent per event id (stripe_events table, migration 0007). Non-2xx responses make Stripe
 * retry, and an event whose processing failed is retried because processed_at stays null.
 */

type Org = TableRow<'orgs'>;

Deno.serve(
  withHandler('stripe-webhook', async (req) => {
    requireMethod(req, 'POST');
    const signature = req.headers.get('stripe-signature');
    if (!signature) return error(req, 400, 'Missing Stripe-Signature header');
    const body = await req.text();
    const stripe = new Stripe(requireEnv('STRIPE_SECRET_KEY'), {
      httpClient: Stripe.createFetchHttpClient(),
    });

    let event: Stripe.Event;
    try {
      event = await stripe.webhooks.constructEventAsync(
        body,
        signature,
        requireEnv('STRIPE_WEBHOOK_SECRET'),
        undefined,
        Stripe.createSubtleCryptoProvider(),
      );
    } catch (err) {
      logWarn('stripe.webhook.bad_signature', { error: errorMessage(err) });
      return error(req, 400, 'Invalid signature');
    }

    const admin = adminClient();
    const claim = await claimEvent(admin, event);
    if (claim === 'processed') {
      logInfo('stripe.webhook.duplicate', { eventId: event.id, type: event.type });
      return json(req, { received: true, duplicate: true });
    }
    if (isHandledEvent(event.type)) await handleEvent(stripe, admin, event);
    else logInfo('stripe.webhook.ignored', { eventId: event.id, type: event.type });
    await admin
      .from('stripe_events')
      .update({ processed_at: new Date().toISOString() })
      .eq('id', event.id)
      .throwOnError();
    return json(req, { received: true });
  }),
);

async function claimEvent(
  admin: AppClient,
  event: Stripe.Event,
): Promise<'new' | 'retry' | 'processed'> {
  const { data: existing } = await admin
    .from('stripe_events')
    .select('processed_at')
    .eq('id', event.id)
    .maybeSingle()
    .throwOnError();
  if (existing?.processed_at) return 'processed';
  if (existing) return 'retry';
  await admin
    .from('stripe_events')
    .upsert({ id: event.id, type: event.type }, { onConflict: 'id', ignoreDuplicates: true })
    .throwOnError();
  return 'new';
}

async function handleEvent(stripe: Stripe, admin: AppClient, event: Stripe.Event): Promise<void> {
  switch (event.type) {
    case 'checkout.session.completed': {
      const session = event.data.object;
      const customerId = idOf(session.customer);
      const subscriptionId = idOf(session.subscription);
      const org = await findOrg(admin, { orgId: checkoutOrgId(session), customerId });
      if (!org) return orgNotFound(event, { customerId, subscriptionId });
      const patch: OrgBillingPatch = {};
      if (customerId) patch.billing_customer_id = customerId;
      if (subscriptionId) {
        patch.billing_subscription_id = subscriptionId;
        Object.assign(
          patch,
          subscriptionPatch(await stripe.subscriptions.retrieve(subscriptionId)),
        );
      }
      await applyBillingChange(admin, org, patch, event);
      return;
    }
    case 'customer.subscription.created':
    case 'customer.subscription.updated':
    case 'customer.subscription.deleted': {
      const subscription = event.data.object;
      const customerId = idOf(subscription.customer);
      const org = await findOrg(admin, { subscriptionId: subscription.id, customerId });
      if (!org) return orgNotFound(event, { customerId, subscriptionId: subscription.id });
      const patch = subscriptionPatch(subscription, event.type === 'customer.subscription.deleted');
      await applyBillingChange(admin, org, patch, event);
      return;
    }
    case 'invoice.payment_failed': {
      const invoice = event.data.object;
      const customerId = idOf(invoice.customer);
      const org = await findOrg(admin, { customerId });
      if (!org) return orgNotFound(event, { customerId });
      await applyBillingChange(admin, org, { billing_status: 'past_due' }, event);
      await notifyOrg(admin, {
        orgId: org.id,
        kind: 'billing',
        title: 'Payment failed',
        body: 'Stripe could not charge your card. Update the payment method in Billing to keep reports and reminders flowing.',
        targetPath: '/billing',
      });
      return;
    }
    case 'invoice.paid': {
      const invoice = event.data.object;
      const customerId = idOf(invoice.customer);
      const org = await findOrg(admin, { customerId });
      if (!org) return orgNotFound(event, { customerId });
      const next = statusAfterInvoicePaid(org.billing_status, invoice.amount_paid);
      if (next) await applyBillingChange(admin, org, { billing_status: next }, event);
      return;
    }
    default:
      return;
  }
}

async function findOrg(
  admin: AppClient,
  keys: { orgId?: string | null; subscriptionId?: string | null; customerId?: string | null },
): Promise<Org | null> {
  const lookups: Array<['id' | 'billing_subscription_id' | 'billing_customer_id', string]> = [];
  if (keys.orgId) lookups.push(['id', keys.orgId]);
  if (keys.subscriptionId) lookups.push(['billing_subscription_id', keys.subscriptionId]);
  if (keys.customerId) lookups.push(['billing_customer_id', keys.customerId]);
  for (const [column, value] of lookups) {
    const { data } = await admin
      .from('orgs')
      .select('*')
      .eq(column, value)
      .limit(1)
      .maybeSingle()
      .throwOnError();
    if (data) return data;
  }
  return null;
}

function orgNotFound(event: Stripe.Event, keys: Record<string, string | null>): void {
  logWarn('stripe.webhook.org_not_found', { eventId: event.id, type: event.type, ...keys });
}

/** Writes the patch and, on a status transition, records it (audit + panel notice). */
async function applyBillingChange(
  admin: AppClient,
  org: Org,
  patch: OrgBillingPatch,
  event: Stripe.Event,
): Promise<void> {
  const from = org.billing_status;
  const to = patch.billing_status ?? from;
  if (Object.keys(patch).length > 0) {
    await admin.from('orgs').update(patch).eq('id', org.id).throwOnError();
  }
  logInfo('stripe.webhook.applied', {
    eventId: event.id,
    type: event.type,
    orgId: org.id,
    from,
    to,
  });
  if (to === from) return;
  // The scheduler reads this row (diff->>to = past_due) to start the past_due grace period.
  await logAudit(admin, {
    orgId: org.id,
    actorType: 'system',
    action: 'billing.status_changed',
    entity: 'org',
    entityId: org.id,
    diff: { from, to, eventId: event.id, eventType: event.type },
  });
  if (to === 'canceled') {
    await notifyOrg(admin, {
      orgId: org.id,
      kind: 'billing',
      title: 'Subscription canceled',
      body: 'Reminders and new site-days stop until the subscription is restarted from Billing.',
      targetPath: '/billing',
    });
  }
  org.billing_status = to;
}
