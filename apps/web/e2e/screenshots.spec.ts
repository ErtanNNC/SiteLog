import { expect, test, type Page } from '@playwright/test';
import { demoId } from '@sitelog/shared/demo/ids.ts';

const OUT = 'e2e/__screenshots__';
const WIDTHS = [1440, 375] as const;

// §18 demo ids are deterministic (packages/shared/src/demo/ids.ts).
const RIVERSIDE_SITE = demoId('site:riverside');
const HERO_REPORT = demoId('report:riverside:2026-10-09');

async function shoot(page: Page, name: string, width: number) {
  await page.setViewportSize({ width, height: width === 375 ? 812 : 900 });
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
    await page.setViewportSize({ width, height: width === 375 ? 812 : 900 });
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
    await expect(page.getByTestId('voice-player')).toBeVisible();
    await shoot(page, 'report', width);
  });
}
