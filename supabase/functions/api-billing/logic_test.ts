import { assertEquals, assertRejects } from '@std/assert';
import {
  manualProvider,
  pickProvider,
  stripeProvider,
  type BillingOrg,
  type StripeLike,
} from '../_shared/billing_provider.ts';
import { EnvError } from '../_shared/env.ts';
import { HttpError } from '../_shared/http.ts';
import {
  baseSummary,
  checkoutQuantity,
  handleBillingAction,
  invoiceSummary,
  sitePriceId,
  syncDecision,
  type BillingStore,
} from './logic.ts';

const NOW = new Date('2026-10-17T12:00:00Z');

const kestrel = (patch: Partial<BillingOrg> = {}): BillingOrg => ({
  id: 'org-us',
  name: 'Kestrel Build Group',
  billing_provider: 'stripe',
  billing_status: 'trialing',
  billing_customer_id: null,
  billing_subscription_id: null,
  trial_ends_at: '2026-10-25T12:00:00.000Z',
  price_per_site_minor: 39900,
  price_currency: 'USD',
  is_demo: false,
  ...patch,
});

const demir = (patch: Partial<BillingOrg> = {}): BillingOrg => ({
  ...kestrel(),
  id: 'org-tr',
  name: 'Demir Yapı',
  billing_provider: 'manual',
  price_per_site_minor: null,
  price_currency: null,
  ...patch,
});

/** A structural Stripe that records its calls. */
function fakeStripe(opts: { price?: { unit_amount: number; currency: string } } = {}) {
  const calls: Array<[string, unknown]> = [];
  let quantity = 3;
  const stripe: StripeLike = {
    customers: {
      create: (p) => {
        calls.push(['customers.create', p]);
        return Promise.resolve({ id: 'cus_new' });
      },
      retrieve: () =>
        Promise.resolve({
          invoice_settings: { default_payment_method: { card: { brand: 'visa', last4: '4242' } } },
        }),
    },
    checkout: {
      sessions: {
        create: (p) => {
          calls.push(['checkout.sessions.create', p]);
          return Promise.resolve({ id: 'cs_1', url: 'https://checkout.stripe.test/cs_1' });
        },
      },
    },
    billingPortal: {
      sessions: {
        create: (p) => {
          calls.push(['billingPortal.sessions.create', p]);
          return Promise.resolve({ url: 'https://billing.stripe.test/p' });
        },
      },
    },
    prices: {
      retrieve: (id) => {
        calls.push(['prices.retrieve', id]);
        const p = opts.price ?? { unit_amount: 39900, currency: 'usd' };
        return Promise.resolve({ id, ...p });
      },
    },
    subscriptions: {
      retrieve: (id) =>
        Promise.resolve({
          id,
          status: 'active',
          current_period_end: 1_793_491_200,
          items: { data: [{ id: 'si_1', quantity }] },
        }),
    },
    subscriptionItems: {
      update: (id, p) => {
        calls.push(['subscriptionItems.update', { id, ...p }]);
        quantity = p.quantity;
        return Promise.resolve({});
      },
    },
    invoices: {
      list: () =>
        Promise.resolve({
          data: [
            {
              id: 'in_1',
              created: 1_791_000_000,
              total: 239_400,
              currency: 'usd',
              status: 'paid',
              lines: { data: [{ quantity: 6 }] },
            },
          ],
        }),
    },
    paymentMethods: {
      retrieve: () => Promise.resolve({ card: null }),
      list: () => Promise.resolve({ data: [] }),
    },
  };
  return { stripe, calls };
}

function fakeStore(active = 6) {
  const sites = new Map([
    ['site-1', { id: 'site-1', status: 'active', name: 'Riverside Lofts' }],
    ['site-9', { id: 'site-9', status: 'archived', name: 'Old Yard' }],
  ]);
  const audit: unknown[] = [];
  let count = active;
  const store: BillingStore = {
    activeSiteCount: () => Promise.resolve(count),
    getSite: (_org, id) => Promise.resolve(sites.has(id) ? { ...sites.get(id)! } : null),
    setSiteStatus: (id, next) => {
      sites.get(id)!.status = next;
      count += next === 'paused' ? -1 : 1;
      return Promise.resolve();
    },
    audit: (e) => {
      audit.push(e);
      return Promise.resolve();
    },
  };
  return { store, audit, sites };
}

function stripeFor(
  stripe: StripeLike,
  env: Record<string, string> = { STRIPE_PRICE_ID_SITE_US: 'price_us' },
) {
  const saved: Array<[string, string]> = [];
  const provider = stripeProvider({
    stripe,
    env: (n) => env[n],
    appUrl: () => 'https://app.sitelog.test',
    saveCustomer: (o, c) => {
      saved.push([o, c]);
      return Promise.resolve();
    },
    now: () => NOW,
  });
  return { provider, saved };
}

const req = (action: Parameters<typeof handleBillingAction>[2]['action'], siteId?: string) => ({
  action,
  siteId,
  userId: 'user-admin',
  email: 'admin@kestrel.test',
});

Deno.test(
  'the provider pick reads orgs.billing_provider; manual never builds a Stripe client',
  () => {
    let built = 0;
    const stripe = () => {
      built += 1;
      return manualProvider;
    };
    assertEquals(pickProvider({ billing_provider: 'manual' }, stripe).name, 'manual');
    assertEquals(built, 0);
    pickProvider({ billing_provider: 'stripe' }, stripe);
    pickProvider({ billing_provider: null }, stripe);
    assertEquals(built, 2);
  },
);

Deno.test('stripe: Checkout bills the org price per currency and keeps the trial', async () => {
  const { stripe, calls } = fakeStripe();
  const { provider, saved } = stripeFor(stripe);
  const { store } = fakeStore(6);
  const out = await handleBillingAction(
    { store, provider, now: () => NOW },
    kestrel(),
    req('checkout'),
  );
  assertEquals(out, {
    url: 'https://checkout.stripe.test/cs_1',
    sessionId: 'cs_1',
    quantity: 6,
    trialDays: 0,
    trialEnd: '2026-10-25T12:00:00.000Z',
  });
  assertEquals(saved, [['org-us', 'cus_new']]);
  assertEquals(calls[0], ['prices.retrieve', 'price_us']);
  const session = calls.find((c) => c[0] === 'checkout.sessions.create')![1] as {
    line_items: unknown;
    customer: string;
  };
  assertEquals(session.line_items, [{ price: 'price_us', quantity: 6 }]);
  assertEquals(session.customer, 'cus_new');
});

Deno.test('stripe: another currency reads its own price id, and needs one', async () => {
  const { stripe, calls } = fakeStripe({ price: { unit_amount: 150_000, currency: 'try' } });
  const org = kestrel({ price_per_site_minor: 150_000, price_currency: 'TRY' });
  const { store } = fakeStore(2);
  const { provider } = stripeFor(stripe, { STRIPE_PRICE_ID_SITE_TRY: 'price_try' });
  await handleBillingAction({ store, provider, now: () => NOW }, org, req('checkout'));
  assertEquals(calls[0], ['prices.retrieve', 'price_try']);

  const bare = stripeFor(fakeStripe().stripe, { STRIPE_PRICE_ID_SITE_US: 'price_us' }).provider;
  const err = await assertRejects(
    () => handleBillingAction({ store, provider: bare, now: () => NOW }, org, req('checkout')),
    EnvError,
  );
  assertEquals(err.variable, 'STRIPE_PRICE_ID_SITE_TRY');
});

Deno.test(
  'stripe: Checkout refuses no sites, no price, a price Stripe bills differently, a live subscription',
  async () => {
    const { stripe, calls } = fakeStripe({ price: { unit_amount: 39900, currency: 'usd' } });
    const { provider } = stripeFor(stripe);
    const deps = (active: number) => ({ store: fakeStore(active).store, provider, now: () => NOW });
    const refused = async (org: BillingOrg, active: number, code?: string) => {
      const err = await assertRejects(
        () => handleBillingAction(deps(active), org, req('checkout')),
        HttpError,
      );
      assertEquals(err.status, 409);
      if (code) assertEquals((err.details as { code: string }).code, code);
    };
    await refused(kestrel(), 0);
    await refused(kestrel({ price_per_site_minor: null, price_currency: null }), 3, 'no_price');
    await refused(kestrel({ price_per_site_minor: 29900 }), 3, 'price_mismatch');
    await refused(kestrel({ billing_subscription_id: 'sub_1', billing_status: 'active' }), 3);
    assertEquals(
      calls.filter((c) => c[0] === 'customers.create'),
      [],
    );
  },
);

Deno.test(
  'manual: no Checkout or portal (409 manual_billing), nothing to sync, no invoices',
  async () => {
    const { store } = fakeStore(2);
    const deps = { store, provider: manualProvider, now: () => NOW };
    for (const action of ['checkout', 'portal'] as const) {
      const err = await assertRejects(
        () => handleBillingAction(deps, demir(), req(action)),
        HttpError,
      );
      assertEquals(err.status, 409);
      assertEquals((err.details as { code: string }).code, 'manual_billing');
    }
    assertEquals(await handleBillingAction(deps, demir(), req('sync')), {
      synced: false,
      reason: 'manual',
      activeSites: 2,
    });
    assertEquals(await handleBillingAction(deps, demir(), req('invoices')), { invoices: [] });
    const status = (await handleBillingAction(deps, demir(), req('status'))) as Record<
      string,
      unknown
    >;
    assertEquals(status.provider, 'manual');
    assertEquals(status.pricePerSiteMinor, null);
    assertEquals(status.monthlyTotalMinor, null);
    assertEquals(status.paymentMethod, null);
  },
);

Deno.test('manual: pause and resume work, audited, with no Stripe call', async () => {
  const { store, audit, sites } = fakeStore(2);
  const deps = { store, provider: manualProvider, now: () => NOW };
  const out = await handleBillingAction(deps, demir(), req('pause_site', 'site-1'));
  assertEquals(out, {
    site: { id: 'site-1', name: 'Riverside Lofts', status: 'paused' },
    sync: { synced: false, reason: 'manual', activeSites: 1 },
  });
  assertEquals(sites.get('site-1')!.status, 'paused');
  assertEquals(audit, [
    {
      orgId: 'org-tr',
      actorId: 'user-admin',
      action: 'site.paused',
      siteId: 'site-1',
      diff: { from: 'active', to: 'paused' },
    },
  ]);
  await assertRejects(
    () => handleBillingAction(deps, demir(), req('pause_site', 'site-9')),
    HttpError,
    'Archived',
  );
  await assertRejects(() => handleBillingAction(deps, demir(), req('pause_site')), HttpError);
});

Deno.test(
  'stripe: pause syncs the quantity down without proration; status reads Stripe',
  async () => {
    const { stripe, calls } = fakeStripe();
    const { provider } = stripeFor(stripe);
    const { store } = fakeStore(3);
    const org = kestrel({
      billing_subscription_id: 'sub_1',
      billing_customer_id: 'cus_1',
      billing_status: 'active',
    });
    const deps = { store, provider, now: () => NOW };
    await handleBillingAction(deps, org, req('pause_site', 'site-1'));
    assertEquals(calls.at(-1), [
      'subscriptionItems.update',
      { id: 'si_1', quantity: 2, proration_behavior: 'none' },
    ]);
    const status = (await handleBillingAction(deps, org, req('status'))) as Record<string, unknown>;
    assertEquals(status.provider, 'stripe');
    assertEquals(status.pricePerSiteMinor, 39900);
    assertEquals(status.currency, 'USD');
    assertEquals(status.monthlyTotalMinor, 79800);
    assertEquals(status.subscriptionQuantity, 2);
    assertEquals(status.nextInvoiceAt, '2026-11-01T00:00:00.000Z');
    assertEquals(status.paymentMethod, { brand: 'visa', last4: '4242' });
    assertEquals(await handleBillingAction(deps, org, req('invoices')), {
      invoices: [
        {
          id: 'in_1',
          date: '2026-10-03T04:00:00.000Z',
          amount_cents: 239_400,
          currency: 'usd',
          status: 'paid',
          hosted_invoice_url: null,
          sites: 6,
        },
      ],
    });
  },
);

Deno.test('baseSummary prices from the org: 6 × $399.00 = $2,394.00', () => {
  const s = baseSummary(kestrel({ billing_customer_id: 'cus_1' }), 6);
  assertEquals(s.monthlyTotalMinor, 239_400);
  assertEquals(s.pricePerSiteMinor, 39_900);
  assertEquals(s.currency, 'USD');
  assertEquals(s.hasCustomer, true);
  assertEquals(s.hasSubscription, false);
});

Deno.test('invoiceSummary, checkoutQuantity and syncDecision', () => {
  assertEquals(
    invoiceSummary({
      id: 'in_1',
      created: 1_791_000_000,
      total: 119_700,
      currency: 'usd',
      status: 'paid',
      hosted_invoice_url: 'https://invoice.stripe.com/i/x',
      lines: { data: [{ quantity: 2 }, { quantity: 1 }, { quantity: null }] },
    }).sites,
    3,
  );
  assertEquals(checkoutQuantity(0), null);
  assertEquals(checkoutQuantity(6), 6);
  assertEquals(syncDecision(3, 4), { update: true, quantity: 4, proration: 'create_prorations' });
  assertEquals(syncDecision(3, 2), { update: true, quantity: 2, proration: 'none' });
  assertEquals(syncDecision(3, 3), { update: false, quantity: 3, proration: 'none' });
});

Deno.test('sitePriceId: per currency; USD reads STRIPE_PRICE_ID_SITE_US, then the old name', () => {
  const env = (values: Record<string, string>) => (name: string) => values[name];
  assertEquals(
    sitePriceId(env({ STRIPE_PRICE_ID_SITE_US: 'price_us', STRIPE_PRICE_ID_SITE: 'price_old' })),
    'price_us',
  );
  assertEquals(sitePriceId(env({ STRIPE_PRICE_ID_SITE: 'price_old' })), 'price_old');
  assertEquals(sitePriceId(env({ STRIPE_PRICE_ID_SITE: 'price_old' }), 'TRY'), null);
  assertEquals(sitePriceId(env({ STRIPE_PRICE_ID_SITE_TRY: 'price_try' }), 'try'), 'price_try');
  assertEquals(sitePriceId(env({})), null);
});
