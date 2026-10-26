import Stripe from 'stripe';
import { z } from 'zod';
import { logAudit } from '../_shared/audit.ts';
import { requireOrgRole, requireUser } from '../_shared/auth.ts';
import {
  pickProvider,
  stripeProvider,
  type BillingOrg,
  type StripeLike,
} from '../_shared/billing_provider.ts';
import { optionalEnv, requireEnv } from '../_shared/env.ts';
import {
  HttpError,
  json,
  parseWith,
  readJson,
  requireMethod,
  withHandler,
} from '../_shared/http.ts';
import { logInfo } from '../_shared/log.ts';
import { adminClient, type AppClient } from '../_shared/supabase.ts';
import { BILLING_ACTIONS, handleBillingAction, type BillingStore } from './logic.ts';

/**
 * api-billing (§F23, §P13, §19 Q10, Q234–Q236) — admin only. Reads and writes the §6.3 billing
 * columns (billing_customer_id, billing_subscription_id); the legacy stripe_* columns follow them
 * by trigger until step 23 (20261014000003_renames_billing.sql). The org's provider
 * (`orgs.billing_provider`: `stripe`, or `manual` for a TR org until §19 Q8) does the work
 * (`_shared/billing_provider.ts`); a manual org never needs a Stripe key.
 * POST { orgId, action, siteId? } with action:
 *   checkout     → Stripe Checkout Session (the org's price per currency, quantity = active sites
 *                  ≥ 1, keeps the rest of the 14-day trial); manual: 409 manual_billing
 *   portal       → customer portal session (payment method, invoices); manual: 409
 *   sync         → subscription item quantity = count of active sites
 *   pause_site   → sites.status 'paused' (+ paused_at), audited, then sync
 *   resume_site  → sites.status 'active', audited, then sync
 *   invoices     → last 12 invoices (none for manual)
 *   status       → billing summary for the Billing page (provider, price, totals)
 */

const BodySchema = z.object({
  orgId: z.uuid(),
  action: z.enum(BILLING_ACTIONS),
  siteId: z.uuid().optional(),
});

const ORG_COLUMNS =
  'id, name, billing_provider, billing_status, billing_customer_id, billing_subscription_id, trial_ends_at, price_per_site_minor, price_currency, is_demo';

Deno.serve(
  withHandler('api-billing', async (req) => {
    requireMethod(req, 'POST');
    const user = await requireUser(req);
    const body = parseWith(BodySchema, await readJson(req));
    const admin = adminClient();
    await requireOrgRole(admin, user.userId, body.orgId, ['admin']);
    const org = await loadOrg(admin, body.orgId);
    const provider = pickProvider(org, () =>
      stripeProvider({
        stripe: stripeClient(),
        env: optionalEnv,
        appUrl,
        saveCustomer: (orgId, customerId) => saveCustomer(admin, orgId, customerId),
        now: () => new Date(),
        log: logInfo,
      }),
    );
    const result = await handleBillingAction(
      { store: supabaseStore(admin), provider, now: () => new Date() },
      org,
      { action: body.action, siteId: body.siteId, userId: user.userId, email: user.email ?? null },
    );
    return json(req, result);
  }),
);

function stripeClient(): StripeLike {
  const stripe = new Stripe(requireEnv('STRIPE_SECRET_KEY'), {
    httpClient: Stripe.createFetchHttpClient(),
    maxNetworkRetries: 2,
  });
  // The SDK's overloads are wider than the structural interface the provider calls.
  return stripe as unknown as StripeLike;
}

function appUrl(): string {
  return requireEnv('APP_URL').replace(/\/+$/, '');
}

async function loadOrg(admin: AppClient, orgId: string): Promise<BillingOrg> {
  const { data } = await admin
    .from('orgs')
    .select(ORG_COLUMNS)
    .eq('id', orgId)
    .maybeSingle()
    .throwOnError();
  if (!data) throw new HttpError(404, 'Organisation not found');
  return data as BillingOrg;
}

async function saveCustomer(admin: AppClient, orgId: string, customerId: string): Promise<void> {
  await admin
    .from('orgs')
    .update({ billing_customer_id: customerId })
    .eq('id', orgId)
    .throwOnError();
}

function supabaseStore(admin: AppClient): BillingStore {
  return {
    async activeSiteCount(orgId) {
      const { count } = await admin
        .from('sites')
        .select('id', { count: 'exact', head: true })
        .eq('org_id', orgId)
        .eq('status', 'active')
        .throwOnError();
      return count ?? 0;
    },
    async getSite(orgId, siteId) {
      const { data } = await admin
        .from('sites')
        .select('id, status, name')
        .eq('id', siteId)
        .eq('org_id', orgId)
        .maybeSingle()
        .throwOnError();
      return data;
    },
    async setSiteStatus(siteId, next, at) {
      await admin
        .from('sites')
        .update(
          next === 'paused'
            ? { status: 'paused', paused_at: at }
            : { status: 'active', paused_at: null },
        )
        .eq('id', siteId)
        .throwOnError();
    },
    async audit(entry) {
      await logAudit(admin, {
        orgId: entry.orgId,
        actorType: 'user',
        actorId: entry.actorId,
        action: entry.action,
        entity: 'site',
        entityId: entry.siteId,
        diff: entry.diff,
      });
    },
  };
}
