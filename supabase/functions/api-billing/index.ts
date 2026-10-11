import Stripe from 'stripe';
import { z } from 'zod';
import { logAudit } from '../_shared/audit.ts';
import { requireOrgRole, requireUser, type AuthedUser } from '../_shared/auth.ts';
import { periodEndOf, trialDaysFor, unixToIso } from '../_shared/billing.ts';
import { requireEnv } from '../_shared/env.ts';
import {
  HttpError,
  json,
  parseWith,
  readJson,
  requireMethod,
  withHandler,
} from '../_shared/http.ts';
import { logInfo } from '../_shared/log.ts';
import { adminClient, type AppClient, type TableRow } from '../_shared/supabase.ts';
import { baseSummary, invoiceSummary, syncDecision, type BillingSummary } from './logic.ts';

/**
 * api-billing (§F19, §P13, §19 #4/#5) — admin only.
 * POST { orgId, action, siteId? } with action:
 *   checkout     → Stripe Checkout Session (subscription, quantity = active sites, 14-day trial once)
 *   portal       → customer portal session (payment method, invoices)
 *   sync         → subscription item quantity = count of active sites
 *   pause_site   → sites.status 'paused' (+ paused_at), then sync
 *   resume_site  → sites.status 'active', then sync
 *   invoices     → last 12 Stripe invoices
 *   status       → billing summary for the Billing page
 */

const BodySchema = z.object({
  orgId: z.uuid(),
  action: z.enum(['checkout', 'portal', 'sync', 'pause_site', 'resume_site', 'invoices', 'status']),
  siteId: z.uuid().optional(),
});

type Org = TableRow<'orgs'>;

Deno.serve(
  withHandler('api-billing', async (req) => {
    requireMethod(req, 'POST');
    const user = await requireUser(req);
    const body = parseWith(BodySchema, await readJson(req));
    const admin = adminClient();
    await requireOrgRole(admin, user.userId, body.orgId, ['admin']);
    const org = await loadOrg(admin, body.orgId);
    const stripe = stripeClient();

    switch (body.action) {
      case 'checkout':
        return json(req, await checkout(stripe, admin, org, user));
      case 'portal':
        return json(req, await portal(stripe, org));
      case 'sync':
        return json(req, await syncQuantity(stripe, admin, org));
      case 'pause_site':
      case 'resume_site':
        return json(req, await setSiteStatus(stripe, admin, org, user, body.siteId, body.action));
      case 'invoices':
        return json(req, await invoices(stripe, org));
      case 'status':
        return json(req, await status(stripe, admin, org));
    }
  }),
);

function stripeClient(): Stripe {
  return new Stripe(requireEnv('STRIPE_SECRET_KEY'), {
    httpClient: Stripe.createFetchHttpClient(),
    maxNetworkRetries: 2,
  });
}

function appUrl(): string {
  return requireEnv('APP_URL').replace(/\/+$/, '');
}

async function loadOrg(admin: AppClient, orgId: string): Promise<Org> {
  const { data } = await admin
    .from('orgs')
    .select('*')
    .eq('id', orgId)
    .maybeSingle()
    .throwOnError();
  if (!data) throw new HttpError(404, 'Organisation not found');
  return data;
}

async function activeSiteCount(admin: AppClient, orgId: string): Promise<number> {
  const { count } = await admin
    .from('sites')
    .select('id', { count: 'exact', head: true })
    .eq('org_id', orgId)
    .eq('status', 'active')
    .throwOnError();
  return count ?? 0;
}

async function ensureCustomer(
  stripe: Stripe,
  admin: AppClient,
  org: Org,
  user: AuthedUser,
): Promise<string> {
  if (org.stripe_customer_id) return org.stripe_customer_id;
  const customer = await stripe.customers.create({
    name: org.name,
    email: user.email ?? undefined,
    metadata: { orgId: org.id },
  });
  await admin
    .from('orgs')
    .update({ stripe_customer_id: customer.id })
    .eq('id', org.id)
    .throwOnError();
  org.stripe_customer_id = customer.id;
  logInfo('billing.customer_created', { orgId: org.id, customerId: customer.id });
  return customer.id;
}

async function checkout(stripe: Stripe, admin: AppClient, org: Org, user: AuthedUser) {
  if (org.stripe_subscription_id && org.billing_status !== 'canceled') {
    throw new HttpError(
      409,
      'This organisation already has a subscription; use the billing portal to manage it',
    );
  }
  const customer = await ensureCustomer(stripe, admin, org, user);
  const quantity = Math.max(1, await activeSiteCount(admin, org.id));
  const trialDays = trialDaysFor(org);
  const base = appUrl();
  const session = await stripe.checkout.sessions.create({
    mode: 'subscription',
    customer,
    client_reference_id: org.id,
    line_items: [{ price: requireEnv('STRIPE_PRICE_ID_SITE'), quantity }],
    subscription_data: {
      metadata: { orgId: org.id },
      ...(trialDays ? { trial_period_days: trialDays } : {}),
    },
    success_url: `${base}/billing?checkout=success&session_id={CHECKOUT_SESSION_ID}`,
    cancel_url: `${base}/billing?checkout=canceled`,
    metadata: { orgId: org.id },
  });
  logInfo('billing.checkout_created', {
    orgId: org.id,
    sessionId: session.id,
    quantity,
    trialDays: trialDays ?? 0,
  });
  return { url: session.url, sessionId: session.id, quantity, trialDays: trialDays ?? 0 };
}

async function portal(stripe: Stripe, org: Org) {
  if (!org.stripe_customer_id)
    throw new HttpError(409, 'No Stripe customer yet; start a subscription first');
  const session = await stripe.billingPortal.sessions.create({
    customer: org.stripe_customer_id,
    return_url: `${appUrl()}/billing`,
  });
  return { url: session.url };
}

async function syncQuantity(stripe: Stripe, admin: AppClient, org: Org) {
  const activeSites = await activeSiteCount(admin, org.id);
  if (!org.stripe_subscription_id) {
    return { synced: false, reason: 'no_subscription', activeSites };
  }
  const subscription = await stripe.subscriptions.retrieve(org.stripe_subscription_id);
  const item = subscription.items.data[0];
  if (!item) return { synced: false, reason: 'no_subscription_item', activeSites };
  const decision = syncDecision(item.quantity ?? null, activeSites);
  if (!decision.update)
    return { synced: true, changed: false, quantity: decision.quantity, activeSites };
  await stripe.subscriptionItems.update(item.id, {
    quantity: decision.quantity,
    proration_behavior: decision.proration,
  });
  logInfo('billing.quantity_synced', {
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

async function setSiteStatus(
  stripe: Stripe,
  admin: AppClient,
  org: Org,
  user: AuthedUser,
  siteId: string | undefined,
  action: 'pause_site' | 'resume_site',
) {
  if (!siteId) throw new HttpError(400, 'siteId is required');
  const { data: site } = await admin
    .from('sites')
    .select('id, status, name')
    .eq('id', siteId)
    .eq('org_id', org.id)
    .maybeSingle()
    .throwOnError();
  if (!site) throw new HttpError(404, 'Site not found in this organisation');
  if (site.status === 'archived')
    throw new HttpError(409, 'Archived sites cannot be paused or resumed');

  const next = action === 'pause_site' ? 'paused' : 'active';
  if (site.status !== next) {
    const now = new Date().toISOString();
    await admin
      .from('sites')
      .update(
        next === 'paused'
          ? { status: 'paused', paused_at: now }
          : { status: 'active', paused_at: null },
      )
      .eq('id', site.id)
      .throwOnError();
    await logAudit(admin, {
      orgId: org.id,
      actorType: 'user',
      actorId: user.userId,
      action: next === 'paused' ? 'site.paused' : 'site.resumed',
      entity: 'site',
      entityId: site.id,
      diff: { from: site.status, to: next },
    });
  }
  const sync = await syncQuantity(stripe, admin, org);
  return { site: { id: site.id, name: site.name, status: next }, sync };
}

async function invoices(stripe: Stripe, org: Org) {
  if (!org.stripe_customer_id) return { invoices: [] };
  const list = await stripe.invoices.list({ customer: org.stripe_customer_id, limit: 12 });
  return { invoices: list.data.map(invoiceSummary) };
}

async function status(stripe: Stripe, admin: AppClient, org: Org): Promise<BillingSummary> {
  const summary = baseSummary(org, await activeSiteCount(admin, org.id));
  if (org.stripe_subscription_id) {
    const subscription = await stripe.subscriptions.retrieve(org.stripe_subscription_id);
    summary.subscriptionStatus = subscription.status;
    summary.subscriptionQuantity = subscription.items.data[0]?.quantity ?? null;
    summary.nextInvoiceAt = unixToIso(periodEndOf(subscription));
  }
  if (org.stripe_customer_id)
    summary.paymentMethod = await defaultPaymentMethod(stripe, org.stripe_customer_id);
  return summary;
}

function isDeletedCustomer(
  c: Stripe.Customer | Stripe.DeletedCustomer,
): c is Stripe.DeletedCustomer {
  return 'deleted' in c && c.deleted === true;
}

async function defaultPaymentMethod(
  stripe: Stripe,
  customerId: string,
): Promise<{ brand: string; last4: string } | null> {
  const customer = await stripe.customers.retrieve(customerId, {
    expand: ['invoice_settings.default_payment_method'],
  });
  if (isDeletedCustomer(customer)) return null;
  const preferred = customer.invoice_settings.default_payment_method;
  let method: Stripe.PaymentMethod | null = null;
  if (preferred && typeof preferred !== 'string') method = preferred;
  else if (typeof preferred === 'string') method = await stripe.paymentMethods.retrieve(preferred);
  if (!method) {
    const list = await stripe.paymentMethods.list({ customer: customerId, type: 'card', limit: 1 });
    method = list.data[0] ?? null;
  }
  const card = method?.card;
  return card ? { brand: card.brand, last4: card.last4 } : null;
}
