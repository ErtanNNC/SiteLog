import { expect, test, type Page } from '@playwright/test';
import { demoId } from '@sitelog/shared/demo/ids.ts';

const OUT = 'e2e/__screenshots__';
// W1-16: phone screenshots at 390 px (CLAUDE.md: every screen works at 390 and 1440 px).
const WIDTHS = [1440, 390] as const;

// §18 demo ids are deterministic (packages/shared/src/demo/ids.ts).
const RIVERSIDE_SITE = demoId('site:riverside');
const HERO_REPORT = demoId('report:riverside:2026-10-09');

async function shoot(page: Page, name: string, width: number) {
  await page.setViewportSize({ width, height: width === 390 ? 844 : 900 });
  await page.waitForTimeout(300);
  await page.screenshot({ path: `${OUT}/${name}-${width}.png`, fullPage: true });
}

async function signIn(page: Page) {
  await page.goto('/login');
  await page.getByLabel('Work email').fill('lena@kestrelbuild.example');
  await page.getByRole('button', { name: 'Email me a sign-in link' }).click();
  await expect(page.getByRole('heading', { name: 'Today across 6 sites' })).toBeVisible();
}

for (const width of WIDTHS) {
  test(`screenshots at ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height: width === 390 ? 844 : 900 });
    await page.goto('/login');
    await expect(
      page.getByRole('heading', { name: 'End-of-day reports, spoken in three minutes.' }),
    ).toBeVisible();
    await shoot(page, 'login', width);

    await signIn(page);
    await shoot(page, 'overview', width);

    await page.goto('/sites');
    await expect(page.getByTestId('site-card').first()).toBeVisible();
    await shoot(page, 'sites', width);

    await page.goto(`/sites/${RIVERSIDE_SITE}`);
    await expect(page.getByRole('heading', { name: 'Riverside Lofts — Block B' })).toBeVisible();
    await expect(page.getByTestId('latest-card')).toBeVisible();
    await shoot(page, 'site', width);

    await page.goto('/reports');
    await expect(page.getByRole('heading', { name: 'Reports', exact: true })).toBeVisible();
    await expect(page.getByRole('table', { name: 'Reports' })).toBeVisible();
    await shoot(page, 'reports', width);

    await page.goto(`/reports/${HERO_REPORT}`);
    await expect(page.getByRole('heading', { name: 'Friday, Oct 9 — Riverside B' })).toBeVisible();
    await expect(page.getByTestId('media-player').first()).toBeVisible();
    await shoot(page, 'report', width);
  });
}

// ── Hours · Weather · Team · Glossary · Settings · Billing · Setup (P2, P8–P13) ──
for (const width of WIDTHS) {
  test(`setup pages screenshots at ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height: width === 390 ? 844 : 900 });
    await signIn(page);

    await page.goto('/hours');
    await expect(page.getByRole('heading', { name: 'Crew hours' })).toBeVisible();
    await expect(page.getByTestId('hours-matrix')).toBeVisible();
    await page
      .getByRole('button', { name: 'Compare BrightLine Electric with its invoice' })
      .click();
    await expect(page.getByTestId('invoice-check')).toBeVisible();
    await shoot(page, 'hours', width);

    await page.goto('/weather');
    await expect(page.getByRole('heading', { name: 'Weather & delays' })).toBeVisible();
    await expect(page.getByTestId('delay-log')).toBeVisible();
    await shoot(page, 'weather', width);

    await page.goto('/team');
    await expect(page.getByRole('heading', { name: 'Team & numbers' })).toBeVisible();
    await expect(page.getByTestId('unknown-sender')).toBeVisible();
    await shoot(page, 'team', width);

    await page.goto('/glossary');
    await expect(page.getByRole('heading', { name: 'Site glossary' })).toBeVisible();
    await expect(page.getByTestId('review-queue')).toBeVisible();
    await shoot(page, 'glossary', width);

    await page.goto('/settings/reports');
    await expect(page.getByRole('heading', { name: 'Settings', exact: true })).toBeVisible();
    await expect(page.getByTestId('ladder')).toBeVisible();
    await shoot(page, 'settings-reports', width);

    await page.goto('/billing');
    await expect(page.getByRole('heading', { name: 'Billing' })).toBeVisible();
    await expect(page.getByTestId('plan-card')).toBeVisible();
    await shoot(page, 'billing', width);

    await page.goto('/ops');
    await expect(page.getByTestId('ops-kpis')).toBeVisible();
    await shoot(page, 'ops', width);

    await page.goto('/setup/site');
    await expect(page.getByRole('heading', { name: 'Site', exact: true })).toBeVisible();
    await page.getByLabel('Site name').fill('Harbor View Apartments');
    await page.getByLabel('Project number').fill('HV-5120');
    await page.getByLabel('Name', { exact: true }).fill('Elena Vasquez');
    await page.getByTestId('manager-phone').fill('555 014 8001');
    await expect(page.getByTestId('welcome-preview')).toContainText('Hi Elena');
    await shoot(page, 'setup-site', width);
  });
}

// W1-18: Sites and Site detail at 1440 and 390 px, in English and Turkish (spec P4, P5).
for (const lang of ['en', 'tr'] as const) {
  test(`sites screenshots (${lang})`, async ({ page }) => {
    await page.addInitScript((tr) => {
      window.localStorage.setItem('sitelog.demo.session', JSON.stringify({ key: 'admin' }));
      if (tr) window.localStorage.setItem('sitelog.language', JSON.stringify('tr'));
    }, lang === 'tr');
    const widths = [1440, 390] as const;
    for (const width of widths) {
      const suffix = lang === 'tr' ? `tr-${width}` : `${width}`;
      await page.setViewportSize({ width, height: width === 390 ? 844 : 900 });
      await page.goto('/sites');
      await expect(page.getByTestId('site-card').first()).toBeVisible({ timeout: 20_000 });
      await page.waitForTimeout(300);
      await page.screenshot({ path: `${OUT}/sites-${suffix}.png`, fullPage: true });
      await page.goto(`/sites/${RIVERSIDE_SITE}`);
      await expect(page.getByTestId('latest-card')).toBeVisible({ timeout: 20_000 });
      await page.waitForTimeout(300);
      await page.screenshot({ path: `${OUT}/site-${suffix}.png`, fullPage: true });
    }
  });
}
