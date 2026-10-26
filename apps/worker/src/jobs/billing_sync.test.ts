import { describe, expect, it, vi } from 'vitest';
import { V12_ROW_DEFAULTS, type JobRow, type OrgRow, type SiteRow } from '@sitelog/shared';
import { testConfig } from '../config';
import type { Ctx } from '../context';
import { silentLogger } from '../log';
import { createBillingSyncJob, stripeQuantityApi, type StripeQuantityApi } from './billing_sync';

const ORG = '0430aaaa-1111-4111-8111-111111111111';

function org(patch: Partial<OrgRow> = {}): OrgRow {
  return {
    id: ORG,
    name: 'Prairie Build',
    address: null,
    license_no: null,
    logo_path: null,
    timezone: 'America/Chicago',
    stripe_customer_id: 'cus_1',
    stripe_subscription_id: 'sub_1',
    billing_status: 'active',
    trial_ends_at: null,
    created_at: '2026-10-01T00:00:00Z',
    ...V12_ROW_DEFAULTS.orgs,
    billing_customer_id: 'cus_1',
    billing_subscription_id: 'sub_1',
    price_per_site_minor: 39900,
    price_currency: 'USD',
    ...patch,
  };
}

const site = (status: SiteRow['status']) => ({ status }) as SiteRow;

function harness(o: OrgRow | null, statuses: Array<SiteRow['status']>) {
  const audit: unknown[] = [];
  const ctx = {
    config: testConfig(),
    log: silentLogger,
    db: {
      getOrg: vi.fn(async () => o),
      listSitesByOrg: vi.fn(async () => statuses.map(site)),
      logAudit: vi.fn(async (a: unknown) => {
        audit.push(a);
      }),
    },
  } as unknown as Ctx;
  return { ctx, audit };
}

function fakeApi(quantity: number | null): StripeQuantityApi & { set: unknown[] } {
  const set: unknown[] = [];
  return {
    set,
    item: async () => ({ id: 'si_1', quantity }),
    setQuantity: async (id, q, p) => {
      set.push([id, q, p]);
    },
  };
}

const run = (job: ReturnType<typeof createBillingSyncJob>, ctx: Ctx) =>
  job(ctx, { orgId: ORG }, {} as JobRow);

describe('billing_sync (W4-10, the quantity sync retried by a job)', () => {
  it('sets the quantity to the active sites, prorating an increase, and audits it', async () => {
    const api = fakeApi(3);
    const { ctx, audit } = harness(org(), ['active', 'active', 'active', 'active', 'paused']);
    await run(
      createBillingSyncJob(() => api),
      ctx,
    );
    expect(api.set).toEqual([['si_1', 4, 'create_prorations']]);
    expect(audit).toEqual([
      {
        org_id: ORG,
        actor_type: 'system',
        action: 'billing.quantity_synced',
        entity: 'org',
        entity_id: ORG,
        diff: { from: 3, to: 4, proration: 'create_prorations', via: 'billing_sync' },
      },
    ]);
  });

  it('a decrease is not prorated; the right quantity changes nothing', async () => {
    const down = fakeApi(3);
    await run(
      createBillingSyncJob(() => down),
      harness(org(), ['active', 'active']).ctx,
    );
    expect(down.set).toEqual([['si_1', 2, 'none']]);
    const same = fakeApi(2);
    const h = harness(org(), ['active', 'active']);
    await run(
      createBillingSyncJob(() => same),
      h.ctx,
    );
    expect(same.set).toEqual([]);
    expect(h.audit).toEqual([]);
  });

  it('leaves a demo org, a manual org and an org without a subscription alone', async () => {
    for (const o of [
      org({ is_demo: true }),
      org({ billing_provider: 'manual' }),
      org({ billing_subscription_id: null }),
    ]) {
      const api = fakeApi(1);
      const apiFor = vi.fn(() => api);
      await run(createBillingSyncJob(apiFor), harness(o, ['active', 'active']).ctx);
      expect(apiFor).not.toHaveBeenCalled();
      expect(api.set).toEqual([]);
    }
  });

  it('without STRIPE_SECRET_KEY it ends with a warning; a missing org is permanent', async () => {
    const h = harness(org(), ['active']);
    await expect(
      run(
        createBillingSyncJob(() => null),
        h.ctx,
      ),
    ).resolves.toBeUndefined();
    await expect(
      run(
        createBillingSyncJob(() => fakeApi(1)),
        harness(null, []).ctx,
      ),
    ).rejects.toThrow(/not found/);
  });

  it("a Stripe error fails the job, so the queue's backoff retries it", async () => {
    const api: StripeQuantityApi = {
      item: async () => {
        throw new Error('stripe 500: down');
      },
      setQuantity: async () => undefined,
    };
    await expect(
      run(
        createBillingSyncJob(() => api),
        harness(org(), ['active']).ctx,
      ),
    ).rejects.toThrow('stripe 500');
  });
});

describe('stripeQuantityApi (Stripe REST, no SDK)', () => {
  it('reads the first item and posts the quantity form-encoded with the key', async () => {
    const calls: Array<[string, RequestInit | undefined]> = [];
    const fetchImpl = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      calls.push([String(url), init]);
      if (String(url).includes('/subscriptions/'))
        return new Response(JSON.stringify({ items: { data: [{ id: 'si_9', quantity: 2 }] } }));
      return new Response('{}');
    }) as unknown as typeof fetch;
    const api = stripeQuantityApi('sk_test_x', fetchImpl);
    expect(await api.item('sub_1')).toEqual({ id: 'si_9', quantity: 2 });
    await api.setQuantity('si_9', 3, 'create_prorations');
    expect(calls[0]![0]).toBe('https://api.stripe.com/v1/subscriptions/sub_1');
    expect((calls[0]![1]!.headers as Record<string, string>).Authorization).toBe(
      'Bearer sk_test_x',
    );
    expect(calls[1]![0]).toBe('https://api.stripe.com/v1/subscription_items/si_9');
    expect(calls[1]![1]!.method).toBe('POST');
    expect(calls[1]![1]!.body).toBe('quantity=3&proration_behavior=create_prorations');
  });

  it('throws on a Stripe error with its message', async () => {
    const fetchImpl = (async () =>
      new Response(JSON.stringify({ error: { message: 'No such subscription' } }), {
        status: 404,
      })) as unknown as typeof fetch;
    await expect(stripeQuantityApi('sk', fetchImpl).item('sub_x')).rejects.toThrow(
      'stripe 404: No such subscription',
    );
  });
});
