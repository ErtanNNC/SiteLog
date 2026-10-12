import { expect, test, type Page } from '@playwright/test';

async function signIn(page: Page, as?: string) {
  await page.goto(as ? `/login?as=${as}` : '/login');
  await expect(
    page.getByRole('heading', { name: 'End-of-day reports, spoken in three minutes.' }),
  ).toBeVisible();
  await page.getByLabel('Work email').fill('lena@kestrelbuild.example');
  await page.getByRole('button', { name: 'Email me a sign-in link' }).click();
}

test.describe('SiteLog panel (demo mode)', () => {
  test('login → overview renders the KPIs → every nav item opens', async ({ page }) => {
    await signIn(page);
    await expect(page.getByRole('heading', { name: 'Today across 6 sites' })).toBeVisible();
    await expect(page.getByTestId('kpi-reports-in')).toHaveText(/4\s*\/\s*6/);
    await expect(page.getByText('FRI, OCT 9, 2026 · 19:05')).toBeVisible();
    await expect(page.getByTestId('demo-chip')).toBeVisible();
    await expect(
      page.getByTestId('needs-attention').locator('[data-kind]').first(),
    ).toHaveAttribute('data-kind', 'missing');
    await expect(
      page
        .getByRole('table', { name: 'Sites today' })
        .getByRole('link', { name: 'Elm St. Townhomes', exact: true }),
    ).toBeVisible();

    const nav = page.getByRole('navigation', { name: 'Main navigation' });
    const items: Array<[string, RegExp]> = [
      ['Sites', /Sites/],
      ['Reports', /Reports/],
      ['Crew hours', /Crew hours/],
      ['Weather & delays', /Weather & delays/],
      ['Team & numbers', /Team & numbers/],
      ['Site glossary', /Site glossary/],
      ['Settings', /Settings/],
      ['Billing', /Billing/],
      ['Overview', /Today across 6 sites/],
    ];
    for (const [label, heading] of items) {
      await nav.getByRole('link', { name: new RegExp(`^${label}`) }).click();
      await expect(page.getByRole('heading', { level: 1 })).toHaveText(heading);
    }
  });

  test('sites page shows six site cards with streaks and the connect-another card', async ({
    page,
  }) => {
    await signIn(page);
    await page.goto('/sites');
    await expect(page.getByRole('heading', { name: 'Sites', exact: true })).toBeVisible();
    await expect(page.getByTestId('site-card')).toHaveCount(6);
    await expect(page.getByTestId('streak-bar')).toHaveCount(6);
    await expect(
      page.getByTestId('site-card').filter({ hasText: 'Elm St. Townhomes' }),
    ).toHaveAttribute('data-attention', 'true');
    await expect(page.getByTestId('connect-site-card')).toContainText('$399 / month');
    await page.getByRole('tab', { name: /Attention/ }).click();
    await expect(page.getByTestId('site-card')).toHaveCount(2);
  });

  test('accounts users land on crew hours and cannot open the overview', async ({ page }) => {
    await signIn(page, 'accounts');
    await expect(page).toHaveURL(/\/hours$/);
    await expect(page.getByRole('heading', { level: 1 })).toHaveText(/Crew hours/);
    await page.goto('/sites');
    await expect(page.getByText('You don’t have access to Sites. Ask an admin.')).toBeVisible();
  });

  test('demo realtime: simulate report flips Elm St. to filed', async ({ page }) => {
    await signIn(page);
    await expect(page.getByRole('heading', { name: 'Today across 6 sites' })).toBeVisible();
    await page.getByRole('button', { name: 'Account menu' }).click();
    await page.getByTestId('demo-simulate').click();
    await expect(page.getByTestId('kpi-reports-in')).toHaveText(/5\s*\/\s*6/);
    await expect(page.getByText('Elm St. Townhomes — no report')).toHaveCount(0);
  });

  test('try it on WhatsApp: voice note → question → OK → Overview shows Riverside filed', async ({
    page,
  }) => {
    await signIn(page);
    await expect(page.getByTestId('try-card')).toBeVisible();
    await page
      .getByRole('navigation', { name: 'Main navigation' })
      .getByRole('link', { name: /^Try it on WhatsApp/ })
      .click();
    await expect(page.getByRole('heading', { level: 1 })).toHaveText('Try it on WhatsApp');
    const log = page.getByRole('log', { name: 'Conversation' });
    await page.getByRole('button', { name: 'Send Marco’s voice note' }).click();
    await expect(log.getByText('Got it, Marco — 2 min 48 s.')).toBeVisible();
    await log.getByRole('button', { name: '5 · full day' }).click({ timeout: 20_000 });
    await expect(log.getByText(/23 on site · 4 subs · 184 h/)).toBeVisible({ timeout: 20_000 });
    await log.getByRole('button', { name: 'OK, file it' }).click();
    await expect(log.getByText(/^Filed\. Daily Report RL-2041-0187/)).toBeVisible({
      timeout: 20_000,
    });
    await expect(page.getByTestId('try-report-no')).toHaveText('RL-2041-0187');
    await page.getByTestId('try-open-report').click();
    await expect(page.getByRole('navigation', { name: 'Breadcrumb' })).toContainText(
      'RL-2041-0187',
    );
    await page
      .getByRole('navigation', { name: 'Main navigation' })
      .getByRole('link', { name: /^Overview/ })
      .click();
    const row = page.getByRole('row').filter({ hasText: 'Riverside Lofts — Block B' });
    await expect(row.getByText('Filed', { exact: true })).toBeVisible();
  });

  test('mobile: the menu button opens the drawer navigation', async ({ page }) => {
    await page.setViewportSize({ width: 375, height: 812 });
    await signIn(page);
    await expect(page.getByRole('heading', { name: 'Today across 6 sites' })).toBeVisible();
    await page.getByRole('button', { name: 'Open menu' }).click();
    await page.getByRole('dialog').getByRole('link', { name: /Sites/ }).click();
    await expect(page.getByRole('heading', { name: 'Sites', exact: true })).toBeVisible();
  });
});
