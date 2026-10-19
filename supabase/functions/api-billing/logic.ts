import { billingPrice, billingProviderOf, monthlyTotalMinor } from '../_shared/billing.ts';
import type { BillingOrg, BillingProvider, ProviderStatus } from '../_shared/billing_provider.ts';
import { HttpError } from '../_shared/http.ts';

export {
  checkoutQuantity,
  invoiceSummary,
  sitePriceId,
  type InvoiceLike,
  type InvoiceSummary,
} from '../_shared/billing_provider.ts';
export { syncDecision } from '../_shared/billing.ts';

/**
 * api-billing's actions on any provider (§F23, §P13, W4-10). index.ts authenticates the admin,
 * loads the org and picks its provider (`orgs.billing_provider`, `pickProvider`); this module
 * does the rest against a small store, so the Deno tests run it on fakes per provider.
 */

export const BILLING_ACTIONS = [
  'checkout',
  'portal',
  'sync',
  'pause_site',
  'resume_site',
  'invoices',
  'status',
] as const;
export type BillingAction = (typeof BILLING_ACTIONS)[number];

export interface BillingStore {
  activeSiteCount(orgId: string): Promise<number>;
  getSite(
    orgId: string,
    siteId: string,
  ): Promise<{ id: string; status: string; name: string } | null>;
  setSiteStatus(siteId: string, next: 'paused' | 'active', at: string): Promise<void>;
  audit(entry: {
    orgId: string;
    actorId: string;
    action: 'site.paused' | 'site.resumed';
    siteId: string;
    diff: { from: string; to: string };
  }): Promise<void>;
}

export interface BillingSummary extends ProviderStatus {
  provider: 'stripe' | 'manual';
  billingStatus: string | null;
  trialEndsAt: string | null;
  activeSites: number;
  /** The org's price (§19 Q234); null while TalkOlog has set none (a TR org until Q9). */
  pricePerSiteMinor: number | null;
  currency: string | null;
  monthlyTotalMinor: number | null;
  hasCustomer: boolean;
  hasSubscription: boolean;
}

export function baseSummary(org: BillingOrg, activeSites: number): BillingSummary {
  const price = billingPrice(org);
  return {
    provider: billingProviderOf(org),
    billingStatus: org.billing_status,
    trialEndsAt: org.trial_ends_at,
    activeSites,
    pricePerSiteMinor: price?.minor ?? null,
    currency: price?.currency ?? null,
    monthlyTotalMinor: price ? monthlyTotalMinor(price, activeSites) : null,
    hasCustomer: org.billing_customer_id !== null,
    hasSubscription: org.billing_subscription_id !== null,
    subscriptionStatus: null,
    subscriptionQuantity: null,
    nextInvoiceAt: null,
    paymentMethod: null,
  };
}

export interface BillingRequest {
  action: BillingAction;
  siteId?: string;
  userId: string;
  email: string | null;
}

export interface BillingDeps {
  store: BillingStore;
  provider: BillingProvider;
  now: () => Date;
}

export async function handleBillingAction(
  deps: BillingDeps,
  org: BillingOrg,
  req: BillingRequest,
): Promise<unknown> {
  const { store, provider } = deps;
  switch (req.action) {
    case 'checkout':
      return provider.checkout(org, await store.activeSiteCount(org.id), req.email);
    case 'portal':
      return provider.portal(org);
    case 'sync':
      return provider.syncQuantity(org, await store.activeSiteCount(org.id));
    case 'pause_site':
    case 'resume_site':
      return setSiteStatus(deps, org, req);
    case 'invoices':
      return { invoices: await provider.invoices(org) };
    case 'status': {
      const summary = baseSummary(org, await store.activeSiteCount(org.id));
      return { ...summary, ...(await provider.status(org)) };
    }
  }
}

/** Pause or resume a site (admin only, F23: billed from the next cycle), then the quantity sync. */
async function setSiteStatus(deps: BillingDeps, org: BillingOrg, req: BillingRequest) {
  if (!req.siteId) throw new HttpError(400, 'siteId is required');
  const site = await deps.store.getSite(org.id, req.siteId);
  if (!site) throw new HttpError(404, 'Site not found in this organisation');
  if (site.status === 'archived') {
    throw new HttpError(409, 'Archived sites cannot be paused or resumed');
  }
  const next = req.action === 'pause_site' ? 'paused' : 'active';
  if (site.status !== next) {
    await deps.store.setSiteStatus(site.id, next, deps.now().toISOString());
    await deps.store.audit({
      orgId: org.id,
      actorId: req.userId,
      action: next === 'paused' ? 'site.paused' : 'site.resumed',
      siteId: site.id,
      diff: { from: site.status, to: next },
    });
  }
  const sync = await deps.provider.syncQuantity(org, await deps.store.activeSiteCount(org.id));
  return { site: { id: site.id, name: site.name, status: next }, sync };
}
