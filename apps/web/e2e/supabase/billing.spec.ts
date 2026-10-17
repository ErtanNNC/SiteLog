import { randomUUID } from 'node:crypto';
import { expect, test } from '@playwright/test';
import { createClient } from '@supabase/supabase-js';
import { billingPrice, formatBillingMoney, monthlyTotalMinor } from '@sitelog/shared/billing.ts';
import { demoId } from '@sitelog/shared/demo/ids.ts';
import { admin, ANON_KEY, SEED, signInWithMagicLink, SUPABASE_URL } from './support';

/**
 * W4-16 · Billing on the stack (spec F23, P13, §19 Q234, Q235; W4-10 Done when; M10), no worker
 * and no Stripe call that matters (the functions hold a dummy key; a failed quantity sync is the
 * `billing_sync` job's, W4-10):
 *
 * - Kestrel's plan reads the org's own price ("{sites} × {price} = {total}" from
 *   `orgs.price_per_site_minor`, the active sites counted here), no banner (it pays);
 * - a pm (Sam) gets no Billing and no Site settings (Pause is admin only);
 * - a brand-new US customer (a real org, Stripe, trialing): one site at the default price, Pause
 *   and Resume on Billing, then its trial ends with no card (§19 Q235): the banner on every page
 *   says when reminders and calls stop, and after the grace days that they are paused.
 *
 * Demir Yapı's manual Billing in Turkish is `demir.spec.ts` (`@m11`).
 */
test.describe.configure({ mode: 'serial' });

const SAM = 'sam@kestrelbuild.example';
const RIVERSIDE = demoId('site:riverside');
const EMAIL = `billing-${Date.now().toString(36)}@sitelog.example`;
const SITE = 'Harbor Point Lofts';
let orgId = '';

test(
  'Kestrel’s plan from the org’s own price; no banner for a paying org',
  { tag: ['@m10', '@F23'] },
  async ({ page }) => {
    const { data: org } = await admin()
      .from('orgs')
      .select('price_per_site_minor, price_currency')
      .eq('id', SEED.orgId)
      .single()
      .throwOnError();
    const price = billingPrice(org!);
    expect(price, 'Kestrel has a price').not.toBeNull();
    const { count } = await admin()
      .from('sites')
      .select('id', { count: 'exact', head: true })
      .eq('org_id', SEED.orgId)
      .eq('status', 'active')
      .throwOnError();
    const money = (minor: number) => formatBillingMoney(minor, price!.currency, 'en-US');
    await signInWithMagicLink(page);
    await page.goto('/billing');
    await expect(page.getByRole('heading', { level: 1, name: 'Billing' })).toBeVisible();
    await expect(page.getByTestId('plan-equation')).toHaveText(
      `${count} × ${money(price!.minor)} = ${money(monthlyTotalMinor(price!, count ?? 0))}`,
    );
    await expect(page.getByTestId('billing-banner')).toHaveCount(0);
  },
);

test('a pm gets no Billing and no Site settings', { tag: ['@m10', '@F23'] }, async ({ page }) => {
  await signInWithMagicLink(page, SAM);
  await page.goto('/billing');
  // Billing is the admin's (§2.2): the shell's "No access" state, no plan.
  await expect(page.getByText('No access').first()).toBeVisible();
  await expect(page.getByTestId('plan-card')).toHaveCount(0);
  await page.goto(`/sites/${RIVERSIDE}`);
  await expect(
    page.getByRole('heading', { level: 1, name: 'Riverside Lofts — Block B' }),
  ).toBeVisible();
  await expect(page.getByRole('button', { name: 'Site settings' })).toHaveCount(0);
});

test(
  'a new US customer: one site at the default price, Pause and Resume',
  { tag: ['@m10', '@F23'] },
  async ({ page }) => {
    const user = createClient(SUPABASE_URL, ANON_KEY, { auth: { persistSession: false } });
    const signedUp = await user.auth.signUp({ email: EMAIL, password: `billing-${randomUUID()}` });
    if (signedUp.error) throw signedUp.error;
    const org = await user.rpc('create_org', {
      p_name: 'Harbor Point Builders',
      p_timezone: 'America/Chicago',
      p_address: null,
      p_license_no: null,
      p_country: 'US',
    });
    if (org.error) throw org.error;
    orgId = (org.data as { id: string }).id;
    const site = await user
      .from('sites')
      .insert({
        org_id: orgId,
        name: SITE,
        project_code: 'HP-0001',
        timezone: 'America/Chicago',
        status: 'active',
      })
      .select('id')
      .single();
    if (site.error) throw site.error;
    const siteId = (site.data as { id: string }).id;
    const { data: row } = await admin()
      .from('orgs')
      .select(
        'is_demo, billing_provider, billing_status, price_per_site_minor, price_currency, trial_ends_at',
      )
      .eq('id', orgId)
      .single()
      .throwOnError();
    expect(row).toMatchObject({
      is_demo: false,
      billing_provider: 'stripe',
      billing_status: 'trialing',
      price_currency: 'USD',
    });
    const price = billingPrice(row!)!;
    const one = formatBillingMoney(price.minor, price.currency, 'en-US');

    await signInWithMagicLink(page, EMAIL);
    await page.goto('/billing');
    await expect(page.getByTestId('plan-equation')).toHaveText(`1 × ${one} = ${one}`);
    // Trialing with time left: Checkout is offered, no banner.
    await expect(page.getByTestId('start-subscription')).toBeVisible();
    await expect(page.getByTestId('billing-banner')).toHaveCount(0);

    // Pause (from the next cycle, §19 Q10), then Resume: the site row as RLS lets the admin write.
    await page.getByRole('button', { name: `Pause ${SITE}` }).click();
    await page.getByRole('button', { name: 'Pause site', exact: true }).click();
    await expect(page.getByRole('button', { name: `Resume ${SITE}` })).toBeVisible();
    const status = async () =>
      (await admin().from('sites').select('status').eq('id', siteId).single()).data?.status;
    await expect.poll(status).toBe('paused');
    await page.getByRole('button', { name: `Resume ${SITE}` }).click();
    await page.getByRole('button', { name: 'Resume site', exact: true }).click();
    await expect(page.getByRole('button', { name: `Pause ${SITE}` })).toBeVisible();
    await expect.poll(status).toBe('active');
  },
);

test(
  'the trial ends with no card: the banner on every page, then reminders and calls paused',
  { tag: ['@m10', '@F23'] },
  async ({ page }) => {
    test.skip(!orgId && !process.env.CI, 'the new customer was not created');
    const day = 86_400_000;
    // Ended yesterday: past due from then, 14 grace days (the org's past_due_grace_days).
    await admin()
      .from('orgs')
      .update({ trial_ends_at: new Date(Date.now() - day).toISOString() })
      .eq('id', orgId)
      .throwOnError();
    await signInWithMagicLink(page, EMAIL);
    const banner = page.getByTestId('billing-banner');
    await expect(banner).toHaveAttribute('data-kind', 'trial_ended');
    await expect(banner).toContainText('Your free trial ended on');
    await expect(banner).toContainText('to keep reminders and calls on');
    for (const path of ['/sites', '/team']) {
      await page.goto(path);
      await expect(page.getByTestId('billing-banner'), path).toBeVisible();
    }

    // Twenty days ago: past the grace days, so blocked (isOrgBillingBlocked).
    await admin()
      .from('orgs')
      .update({ trial_ends_at: new Date(Date.now() - 20 * day).toISOString() })
      .eq('id', orgId)
      .throwOnError();
    await page.goto('/billing');
    await expect(page.getByTestId('billing-banner')).toContainText(
      'Reminders and calls are paused: billing is past due.',
    );
  },
);
