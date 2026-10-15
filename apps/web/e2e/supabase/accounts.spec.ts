import { readFile } from 'node:fs/promises';
import { expect, test } from '@playwright/test';
import { pinSeedClock, SEED, signInWithMagicLink } from './support';

/**
 * The accounts role against the real policies (§2.2 "hours and invoices"; GAP D22;
 * 20261014000001_queue_rls_fixes.sql): RLS hides sites, reports, the audit log and every
 * notification §13 does not address to accounts, so Crew hours takes its site names from the
 * site_options view. Reads only: the other specs share this database.
 */
test.describe.configure({ mode: 'serial' });

test.beforeEach(async ({ page }) => {
  await pinSeedClock(page);
  await signInWithMagicLink(page, SEED.accounts.email, '/hours');
});

test('accounts: Crew hours names every site and exports the payroll CSV', async ({ page }) => {
  await page.goto('/hours?week=2026-W41');
  await expect(page.getByRole('heading', { level: 1 })).toHaveText(/Crew hours/);
  const matrix = page.getByTestId('hours-matrix');
  await expect(matrix).toBeVisible();
  await expect(matrix).toContainText('Riverside B');
  await expect(page.getByText(/^Couldn’t load|^Couldn't load/)).toHaveCount(0);

  await page.getByRole('combobox', { name: 'Site' }).click();
  for (const name of ['Riverside Lofts — Block B', 'Elm St. Townhomes', 'Oakmont Medical Center'])
    await expect(page.getByRole('option', { name, exact: true })).toBeVisible();
  await page.keyboard.press('Escape');

  const exported = page.waitForResponse(
    (r) => r.url().includes('/functions/v1/api-export-payroll') && r.request().method() === 'GET',
  );
  const download = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Payroll CSV' }).click();
  expect((await exported).status()).toBe(200);
  const csv = await readFile((await (await download).path())!, 'utf8');
  expect(csv).toContain('RL-2041-0187');
  expect(csv).toContain('Riverside Lofts — Block B');
});

test('accounts: the bell shows invoice gaps, not the office alerts', async ({ page }) => {
  await page.getByTestId('notifications-bell').click();
  const list = page.getByRole('list', { name: 'Notifications' });
  await expect(list).toContainText('Invoice gap: BrightLine Electric +16 h');
  for (const title of [
    'Elm St. Townhomes — no report',
    'needs review',
    'Unknown number tried to report',
  ])
    await expect(list).not.toContainText(title);
  await page.keyboard.press('Escape');
});

test('accounts: no overview or sites', async ({ page }) => {
  await page.goto('/');
  await expect(page).toHaveURL(/\/hours$/);
  await page.goto('/sites');
  await expect(page.getByText('You don’t have access to Sites. Ask an admin.')).toBeVisible();
});
