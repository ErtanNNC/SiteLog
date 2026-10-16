import AxeBuilder from '@axe-core/playwright';
import { expect, test, type Page } from '@playwright/test';

/**
 * W3-06 · Crew hours (spec F19, P8) in demo mode: content, the invoice check with its voice-note
 * evidence opening P7 at the second, axe WCAG 2.2 AA and no sideways scroll at 1440 and 390 px,
 * in English and in Turkish. The committed screenshots come from `screenshots.spec.ts`.
 */

const WCAG_22_AA = ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22a', 'wcag22aa'];

async function signInFast(page: Page, lang: 'en' | 'tr') {
  await page.addInitScript((tr) => {
    window.localStorage.setItem('sitelog.demo.session', JSON.stringify({ key: 'admin' }));
    if (tr) window.localStorage.setItem('sitelog.language', JSON.stringify('tr'));
  }, lang === 'tr');
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
    title: 'Crew hours',
    week: 'OCT 5 – OCT 9, 2026',
    gaps: '+24 h · 2 subs',
    compare: 'Compare BrightLine Electric with its invoice',
    gap: '+16 h',
    evidence: 'Open report RL-2041-0187 at audio 0:19',
  },
  tr: {
    title: 'Ekip saatleri',
    week: '5 EKİ – 9 EKİ, 2026',
    gaps: '+24 sa · 2 taşeron',
    compare: 'BrightLine Electric firmasını faturasıyla karşılaştır',
    gap: '+16 sa',
    evidence: 'RL-2041-0187 raporunu ses 0:19 noktasında aç',
  },
} as const;

for (const lang of ['en', 'tr'] as const) {
  for (const width of [1440, 390] as const) {
    test(`Crew hours at ${width}px (${lang})`, async ({ page }) => {
      const c = COPY[lang];
      await page.setViewportSize({ width, height: width === 390 ? 844 : 900 });
      await signInFast(page, lang);

      await page.goto('/hours?week=2026-W41');
      await expect(page.getByRole('heading', { name: c.title, level: 1 })).toBeVisible({
        timeout: 20_000,
      });
      await expect(page.getByTestId('week-label')).toHaveText(c.week);
      await expect(page.getByText(c.gaps)).toBeVisible();
      await page.getByRole('button', { name: c.compare }).click();
      const aside = page.getByTestId('invoice-check');
      await expect(aside).toBeVisible();
      await expect(
        page.locator('[data-company="BrightLine Electric"] [data-testid="gap-cell"]'),
      ).toHaveText(c.gap);
      expect(await overflow(page), '/hours').toBeLessThanOrEqual(0);
      await expectNoViolations(page);

      // The voice-note second opens P7 there.
      const evidence = aside.getByRole('link', { name: c.evidence });
      await expect(evidence).toHaveAttribute('href', /\?clip=[^&]+&at=19$/);
      await evidence.click();
      await expect(page).toHaveURL(/\/reports\/[^?]+\?clip=[^&]+&at=19$/);
      await expect(page.getByTestId('media-player').first()).toBeVisible({ timeout: 20_000 });
    });
  }
}
