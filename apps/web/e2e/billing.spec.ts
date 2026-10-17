import AxeBuilder from '@axe-core/playwright';
import { expect, test, type Page } from '@playwright/test';
import { demoId } from '@sitelog/shared/demo/ids.ts';

/**
 * W4-10 · Billing on v1.2 (spec P13, F23, §19 Q234–Q236) in demo mode: Kestrel's plan from the
 * org's own price ("6 × $399.00 = $2,394.00"), in English and in Turkish, axe WCAG 2.2 AA and no
 * sideways scroll at 1440 and 390 px; Pause offered to admins only (the Billing route and the
 * Site settings drawer). Demir Yapı's manual Billing (no Checkout, "SiteLog invoices you
 * directly") is `supabase/demir.spec.ts`, on the seeded stack.
 */

const WCAG_22_AA = ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22a', 'wcag22aa'];
const RIVERSIDE_SITE = demoId('site:riverside');

async function signInFast(page: Page, key: 'admin' | 'pm', lang: 'en' | 'tr' = 'en') {
  await page.addInitScript(
    ([k, tr]) => {
      window.localStorage.setItem('sitelog.demo.session', JSON.stringify({ key: k }));
      if (tr) window.localStorage.setItem('sitelog.language', JSON.stringify('tr'));
    },
    [key, lang === 'tr'] as const,
  );
}

async function expectNoViolations(page: Page) {
  await page.evaluate(() => document.fonts.ready);
  const { violations } = await new AxeBuilder({ page }).withTags(WCAG_22_AA).analyze();
  expect(
    violations
      .map((v) => `${v.id}: ${v.help} ${v.nodes.map((n) => n.target.join(' ')).join(', ')}`)
      .join('\n'),
  ).toBe('');
}

const overflow = (page: Page) =>
  page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);

const COPY = {
  en: {
    title: 'Billing',
    subtitle: '$399.00 per active site, per month. No setup fee.',
    equation: '6 × $399.00 = $2,394.00',
    sites: 'Sites on this plan',
    pause: 'Pause Riverside Lofts — Block B',
  },
  tr: {
    title: 'Faturalandırma',
    subtitle: 'Aktif şantiye başına aylık $399,00. Kurulum ücreti yoktur.',
    equation: '6 × $399,00 = $2.394,00',
    sites: 'Bu plandaki şantiyeler',
    pause: 'Riverside Lofts — Block B şantiyesini duraklat',
  },
} as const;

for (const width of [1440, 390] as const) {
  for (const lang of ['en', 'tr'] as const) {
    test(`Kestrel's Billing from the org's price, ${lang} at ${width} px`, async ({ page }) => {
      const c = COPY[lang];
      await page.setViewportSize({ width, height: 900 });
      await signInFast(page, 'admin', lang);
      await page.goto('/billing');
      await expect(page.getByRole('heading', { level: 1, name: c.title })).toBeVisible();
      await expect(page.getByText(c.subtitle)).toBeVisible();
      await expect(page.getByTestId('plan-equation')).toHaveText(c.equation);
      const sites = page.getByRole('table', { name: c.sites });
      await expect(sites.getByRole('button', { name: c.pause })).toBeVisible();
      // The demo org pays: no banner.
      await expect(page.getByTestId('billing-banner')).toHaveCount(0);
      expect(await overflow(page)).toBeLessThanOrEqual(0);
      await expectNoViolations(page);
    });
  }
}

test('a pm gets no Billing and no Pause in Site settings (W4-10)', async ({ page }) => {
  await signInFast(page, 'pm');
  await page.goto('/billing');
  await expect(page.getByTestId('plan-card')).toHaveCount(0);
  await page.goto(`/sites/${RIVERSIDE_SITE}`);
  await expect(
    page.getByRole('heading', { level: 1, name: 'Riverside Lofts — Block B' }),
  ).toBeVisible();
  await expect(page.getByRole('button', { name: 'Site settings' })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Pause site' })).toHaveCount(0);
});
