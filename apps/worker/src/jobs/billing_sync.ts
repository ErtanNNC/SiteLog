import { billingProviderOf, syncDecision } from '@sitelog/shared';
import type { Config } from '../config';
import { PermanentJobError, type JobHandler } from './types';

/**
 * W4-10 (F23 steps 1–3; docs/AUDIT_BACKLOG.md "Adding a site never increments the Stripe
 * subscription quantity", its caveat): the subscription quantity of a real Stripe org equals its
 * active sites. The `sites_billing_sync` trigger (20261017000450) queues this job two minutes
 * after a site of such an org is added, paused, resumed or archived; the panel's own api-billing
 * `sync` usually did it already (then nothing changes here), and a sync that failed there is done
 * here, retried by the queue's backoff (D17) until Stripe answers.
 *
 * Stripe is called over its REST API with STRIPE_SECRET_KEY (no SDK in the worker). Without the
 * key the job ends with a warning: nothing in this environment bills through Stripe. A demo org, a
 * `manual` org and an org without a subscription are left alone (the trigger does not queue them;
 * the job checks again, since the org may have changed since).
 */

export interface StripeQuantityApi {
  /** The subscription's first item and its quantity, or null when it has none. */
  item(subscriptionId: string): Promise<{ id: string; quantity: number | null } | null>;
  setQuantity(
    itemId: string,
    quantity: number,
    proration: 'create_prorations' | 'none',
  ): Promise<void>;
}

const STRIPE_API = 'https://api.stripe.com/v1';

/** Stripe's REST API for the two calls the sync needs. */
export function stripeQuantityApi(
  secretKey: string,
  fetchImpl: typeof fetch = fetch,
): StripeQuantityApi {
  const headers = { Authorization: `Bearer ${secretKey}` };
  async function call(path: string, init: RequestInit = {}): Promise<unknown> {
    const res = await fetchImpl(`${STRIPE_API}${path}`, {
      ...init,
      headers: { ...headers, ...(init.headers ?? {}) },
    });
    const body = (await res.json().catch(() => null)) as {
      error?: { message?: string };
    } | null;
    if (!res.ok) {
      throw new Error(`stripe ${res.status}: ${body?.error?.message ?? 'request failed'}`);
    }
    return body;
  }
  return {
    async item(subscriptionId) {
      const sub = (await call(`/subscriptions/${encodeURIComponent(subscriptionId)}`)) as {
        items?: { data?: Array<{ id: string; quantity?: number | null }> };
      };
      const first = sub.items?.data?.[0];
      return first ? { id: first.id, quantity: first.quantity ?? null } : null;
    },
    async setQuantity(itemId, quantity, proration) {
      await call(`/subscription_items/${encodeURIComponent(itemId)}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          quantity: String(quantity),
          proration_behavior: proration,
        }).toString(),
      });
    },
  };
}

export function createBillingSyncJob(
  apiFor: (config: Config) => StripeQuantityApi | null,
): JobHandler<'billing_sync'> {
  return async (ctx, payload) => {
    const org = await ctx.db.getOrg(payload.orgId);
    if (!org) throw new PermanentJobError(`org ${payload.orgId} not found`);
    if (org.is_demo || billingProviderOf(org) !== 'stripe' || !org.billing_subscription_id) {
      ctx.log.info('billing_sync: nothing to sync', {
        org_id: org.id,
        provider: billingProviderOf(org),
        demo: org.is_demo,
      });
      return;
    }
    const api = apiFor(ctx.config);
    if (!api) {
      ctx.log.warn('billing_sync: no STRIPE_SECRET_KEY in the worker; quantity not synced', {
        org_id: org.id,
      });
      return;
    }
    const sites = await ctx.db.listSitesByOrg(org.id);
    const active = sites.filter((s) => s.status === 'active').length;
    const item = await api.item(org.billing_subscription_id);
    if (!item) {
      ctx.log.warn('billing_sync: subscription has no item', { org_id: org.id });
      return;
    }
    const decision = syncDecision(item.quantity, active);
    if (!decision.update) {
      ctx.log.info('billing_sync: quantity already right', {
        org_id: org.id,
        quantity: decision.quantity,
      });
      return;
    }
    await api.setQuantity(item.id, decision.quantity, decision.proration);
    await ctx.db.logAudit({
      org_id: org.id,
      actor_type: 'system',
      action: 'billing.quantity_synced',
      entity: 'org',
      entity_id: org.id,
      diff: {
        from: item.quantity,
        to: decision.quantity,
        proration: decision.proration,
        via: 'billing_sync',
      },
    });
    ctx.log.info('billing_sync: quantity synced', {
      org_id: org.id,
      from: item.quantity,
      to: decision.quantity,
    });
  };
}

export const billingSyncJob = createBillingSyncJob((config) =>
  config.STRIPE_SECRET_KEY ? stripeQuantityApi(config.STRIPE_SECRET_KEY) : null,
);
