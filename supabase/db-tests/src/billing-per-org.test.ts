import { beforeAll, describe, expect, it } from 'vitest';
import type { PGlite } from '@electric-sql/pglite';
import { billingProviderForCountry } from '@sitelog/shared';
import { applyMigration, asService, asUser, bootDatabase, probeAs } from './harness.ts';

/**
 * W4-10 (20261017000450_billing_per_org.sql; spec §19 Q234, Q236, F23, P13):
 * - create_org() presets the org's price from billing_default_prices for its pack's currency
 *   (US: USD 39900; TR: none until Q9) and its provider from the pack (TR `manual`, Q236);
 * - the backfill gives existing orgs their currency's price and a TR org without a subscription
 *   `manual`, audited;
 * - only SiteLog staff change an org's price (ops_set_org_price) or a manual org's status
 *   (ops_set_org_billing_status), audited; a Stripe org's status is Stripe's;
 * - a site added, paused or resumed in a real Stripe org with a subscription queues `billing_sync`.
 */

const MIGRATION = '20261017000450_billing_per_org.sql';
const ELIF = 'eeee0430-1111-4111-8111-111111111111'; // signs up, admin of what she creates
const STAFF = 'eeee0430-2222-4222-8222-222222222222'; // platform admin
const ID = (n: number) => `eeee0430-0000-4000-8000-${n.toString(16).padStart(12, '0')}`;

let db: PGlite;

async function svc<T = Record<string, unknown>>(sql: string, params: unknown[] = []) {
  return (await asService(db, (q) => q<T>(sql, params))).rows;
}

async function createOrg(name: string, country: 'US' | 'TR'): Promise<string> {
  return asUser(
    db,
    ELIF,
    async (q) =>
      (
        await q<{ r: { id: string } }>(`select create_org($1, null, null, null, $2) as r`, [
          name,
          country,
        ])
      ).rows[0]!.r.id,
    'elif@example.test',
  );
}

const staff = <T = Record<string, unknown>>(sql: string, params: unknown[] = []) =>
  asUser(db, STAFF, async (q) => (await q<T>(sql, params)).rows);

type OrgBilling = {
  billing_provider: string;
  billing_status: string;
  price_per_site_minor: number | null;
  price_currency: string | null;
};
const orgBilling = async (id: string) =>
  (
    await svc<OrgBilling>(
      `select billing_provider, billing_status, price_per_site_minor, price_currency
       from orgs where id = $1`,
      [id],
    )
  )[0]!;

describe('the backfill (orgs from before W4-10)', () => {
  it("gives each org its currency's price and a TR org without a subscription `manual`", async () => {
    const old = await bootDatabase({ until: MIGRATION });
    await old.exec(`
      insert into orgs (id, name, country, currency) values
        ('${ID(1)}', 'Old US', 'US', 'USD'),
        ('${ID(2)}', 'Old TR', 'TR', 'TRY');
      insert into orgs (id, name, country, currency, billing_subscription_id) values
        ('${ID(3)}', 'Old TR on Stripe', 'TR', 'TRY', 'sub_tr');
    `);
    await applyMigration(old, MIGRATION);
    const rows = await old.query<OrgBilling & { id: string }>(
      `select id, billing_provider, billing_status, price_per_site_minor, price_currency
       from orgs order by id`,
    );
    expect(
      rows.rows.map((r) => [r.billing_provider, r.price_per_site_minor, r.price_currency]),
    ).toEqual([
      ['stripe', 39900, 'USD'],
      ['manual', null, null],
      ['stripe', null, null],
    ]);
    const audit = await old.query<{ entity_id: string; action: string; diff: { via: string } }>(
      `select entity_id, action, diff from audit_log
       where action in ('billing.price_set', 'billing.provider_set') order by action, entity_id`,
    );
    expect(audit.rows.map((r) => [r.action, r.entity_id, r.diff.via])).toEqual([
      ['billing.price_set', ID(1), 'migration'],
      ['billing.provider_set', ID(2), 'migration'],
    ]);
    await old.close();
  });
});

describe('W4-10 on a fresh database', () => {
  beforeAll(async () => {
    db = await bootDatabase();
    await db.exec(`
      insert into auth.users (id, email) values
        ('${ELIF}', 'elif@example.test'), ('${STAFF}', 'staff@sitelog.test');
      insert into platform_admins (user_id) values ('${STAFF}');
    `);
  });

  it('create_org(): a US org gets $399 on Stripe; a TR org `manual` with no price (Q234, Q236)', async () => {
    const us = await createOrg('Prairie Build', 'US');
    const tr = await createOrg('Anadolu Yapı', 'TR');
    expect(await orgBilling(us)).toEqual({
      billing_provider: 'stripe',
      billing_status: 'trialing',
      price_per_site_minor: 39900,
      price_currency: 'USD',
    });
    expect(await orgBilling(tr)).toEqual({
      billing_provider: 'manual',
      billing_status: 'trialing',
      price_per_site_minor: null,
      price_currency: null,
    });
    const created = await svc<{ diff: Record<string, unknown> }>(
      `select diff from audit_log where action = 'org.created' and entity_id = $1`,
      [tr],
    );
    expect(created[0]!.diff).toEqual({ country: 'TR', billing_provider: 'manual', price: null });
  });

  it('the SQL pick equals billingProviderForCountry()', async () => {
    for (const code of ['US', 'TR', 'tr', 'DE']) {
      const [row] = await svc<{ p: string }>(`select billing_provider_for_country($1) as p`, [
        code,
      ]);
      expect(row!.p, code).toBe(billingProviderForCountry(code));
    }
  });

  it('a price comes in pairs, above zero, and the provider is stripe or manual', async () => {
    const id = await createOrg('Pair Check', 'US');
    for (const set of [
      'price_currency = null',
      'price_per_site_minor = 0',
      `price_currency = 'usd'`,
      `billing_provider = 'iyzico'`,
    ]) {
      await expect(svc(`update orgs set ${set} where id = $1`, [id]), set).rejects.toThrow(
        /check constraint/,
      );
    }
  });

  it('an admin changes neither the price nor the status; nobody but staff runs the ops RPCs', async () => {
    const id = await createOrg('Admin Probe', 'US');
    const admin = { role: 'authenticated' as const, userId: ELIF };
    for (const sql of [
      `update orgs set price_per_site_minor = 100 where id = '${id}'`,
      `select ops_set_org_price('${id}', 100, 'USD')`,
      `select ops_set_org_billing_status('${id}', 'active')`,
      `select * from ops_org_billing()`,
      `select * from billing_default_prices`,
    ]) {
      const res = await probeAs(db, admin, sql);
      expect(res.ok, sql).toBe(false);
      if (!res.ok) expect(res.code, sql).toBe('42501');
    }
  });

  it('ops_set_org_price(): sets, clears and audits the price; refuses half a price', async () => {
    const id = await createOrg('Pilot Build', 'US');
    expect(await staff(`select ops_set_org_price($1, 29900, 'usd') as r`, [id])).toEqual([
      { r: { id, changed: true } },
    ]);
    expect(await orgBilling(id)).toMatchObject({
      price_per_site_minor: 29900,
      price_currency: 'USD',
    });
    expect(await staff(`select ops_set_org_price($1, 29900, 'USD') as r`, [id])).toEqual([
      { r: { id, changed: false } },
    ]);
    await staff(`select ops_set_org_price($1, null, null)`, [id]);
    expect(await orgBilling(id)).toMatchObject({
      price_per_site_minor: null,
      price_currency: null,
    });
    await expect(staff(`select ops_set_org_price($1, 100, null)`, [id])).rejects.toThrow(
      /together/,
    );
    await expect(staff(`select ops_set_org_price($1, -5, 'USD')`, [id])).rejects.toThrow(
      /above zero/,
    );
    await expect(staff(`select ops_set_org_price($1, 5, 'US')`, [id])).rejects.toThrow(/ISO 4217/);
    const audit = await svc<{ actor_id: string; diff: Record<string, unknown> }>(
      `select actor_id, diff from audit_log where action = 'billing.price_set' and entity_id = $1
       order by id`,
      [id],
    );
    expect(audit).toEqual([
      {
        actor_id: STAFF,
        diff: {
          from: { minor: 39900, currency: 'USD' },
          to: { minor: 29900, currency: 'USD' },
          via: 'ops',
        },
      },
      { actor_id: STAFF, diff: { from: { minor: 29900, currency: 'USD' }, to: null, via: 'ops' } },
    ]);
  });

  it("ops_set_org_billing_status(): a manual org's status, audited as the scheduler reads it", async () => {
    const tr = await createOrg('Kuzey İnşaat', 'TR');
    const us = await createOrg('Stripe Only', 'US');
    await staff(`select ops_set_org_billing_status($1, 'past_due')`, [tr]);
    expect((await orgBilling(tr)).billing_status).toBe('past_due');
    const [row] = await svc<{ diff: Record<string, unknown> }>(
      `select diff from audit_log where action = 'billing.status_changed' and entity_id = $1
         and diff->>'to' = 'past_due'`,
      [tr],
    );
    expect(row!.diff).toEqual({ from: 'trialing', to: 'past_due', via: 'ops' });
    await expect(staff(`select ops_set_org_billing_status($1, 'active')`, [us])).rejects.toThrow(
      /follows Stripe/,
    );
    await expect(staff(`select ops_set_org_billing_status($1, 'free')`, [tr])).rejects.toThrow(
      /unknown billing status/,
    );
  });

  it('ops_org_billing(): every org with its provider, price and active sites', async () => {
    const id = await createOrg('Listed Org', 'US');
    await svc(
      `insert into sites (org_id, name, project_code, timezone, status) values
         ($1, 'A', 'A-1', 'America/Chicago', 'active'), ($1, 'B', 'B-1', 'America/Chicago', 'paused')`,
      [id],
    );
    const rows = await staff<{ id: string; active_sites: number; price_per_site_minor: number }>(
      `select * from ops_org_billing()`,
    );
    expect(rows.find((r) => r.id === id)).toMatchObject({
      name: 'Listed Org',
      country: 'US',
      is_demo: false,
      billing_provider: 'stripe',
      billing_status: 'trialing',
      has_subscription: false,
      price_per_site_minor: 39900,
      price_currency: 'USD',
      active_sites: 1,
    });
  });

  describe('billing_sync (the quantity sync retried by a job)', () => {
    const jobs = (orgId: string) =>
      svc<{ dedupe_key: string; run_after_s: number }>(
        `select dedupe_key, extract(epoch from run_after - now())::int as run_after_s
         from jobs where type = 'billing_sync' and payload->>'orgId' = $1 order by id`,
        [orgId],
      );

    it('queues a job two minutes out when a subscribed org adds, pauses or resumes a site', async () => {
      const id = await createOrg('Subscribed', 'US');
      await svc(
        `update orgs set billing_subscription_id = 'sub_q', billing_status = 'active' where id = $1`,
        [id],
      );
      const [site] = await svc<{ id: string }>(
        `insert into sites (org_id, name, project_code, timezone) values ($1, 'S', 'S-1', 'UTC')
         returning id`,
        [id],
      );
      await svc(`update sites set name = 'S renamed' where id = $1`, [site!.id]);
      await svc(`update sites set status = 'paused' where id = $1`, [site!.id]);
      await svc(`update sites set status = 'paused' where id = $1`, [site!.id]);
      await svc(`update sites set status = 'active' where id = $1`, [site!.id]);
      const queued = await jobs(id);
      expect(queued.map((j) => j.dedupe_key.split(':').slice(0, 3).join(':'))).toEqual([
        `billing_sync:${site!.id}:active`,
        `billing_sync:${site!.id}:paused`,
        `billing_sync:${site!.id}:active`,
      ]);
      for (const j of queued) expect(j.run_after_s).toBeGreaterThanOrEqual(110);
    });

    it('nothing for an org without a subscription, a manual org or a demo org', async () => {
      const trial = await createOrg('On Trial', 'US');
      const manual = await createOrg('Manuel', 'TR');
      await svc(`update orgs set billing_subscription_id = 'sub_m' where id = $1`, [manual]);
      const demo = await createOrg('Demo Co', 'US');
      await svc(`update orgs set billing_subscription_id = 'sub_d', is_demo = true where id = $1`, [
        demo,
      ]);
      for (const org of [trial, manual, demo]) {
        await svc(
          `insert into sites (org_id, name, project_code, timezone) values ($1, 'X', 'X-1', 'UTC')`,
          [org],
        );
        expect(await jobs(org), org).toEqual([]);
      }
    });
  });
});
