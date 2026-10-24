import AxeBuilder from '@axe-core/playwright';
import { expect, test, type Locator, type Page } from '@playwright/test';

/**
 * W3-07 · Weather & delays (spec F20, P9) in demo mode: content, the *Call ts* chip of Hillcrest's
 * call-back opening P7 at that second, the pack dialog, axe WCAG 2.2 AA and no sideways scroll at
 * 1440 and 390 px, in English and in Turkish.
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

/** §19 Q146: the chip keeps its 28 px look; its hit area (`::before`) is 44 px tall. */
async function expectHitArea(chip: Locator) {
  expect((await chip.boundingBox())!.height).toBeLessThanOrEqual(30);
  const hit = await chip.evaluate((el) => parseFloat(getComputedStyle(el, '::before').height));
  expect(hit).toBeGreaterThanOrEqual(44);
}

const COPY = {
  en: {
    title: 'Weather & delays',
    hours: '36.5',
    call: /^Open report HS-0418-\d+ at call 0:41$/,
    build: 'Build EOT evidence pack',
    summary: '3 site-days · 17 h lost',
  },
  tr: {
    title: 'Hava durumu ve gecikmeler',
    hours: '36,5',
    call: /^HS-0418-\d+ raporunu aramanın 0:41 anında aç$/,
    build: 'Süre uzatımı kanıt dosyası oluştur',
    summary: '3 şantiye günü · 17 sa kayıp',
  },
} as const;

for (const lang of ['en', 'tr'] as const) {
  for (const width of [1440, 390] as const) {
    test(`Weather & delays at ${width}px (${lang})`, async ({ page }) => {
      const c = COPY[lang];
      await page.setViewportSize({ width, height: width === 390 ? 844 : 900 });
      await signInFast(page, lang);

      await page.goto('/weather?month=2026-10');
      await expect(page.getByRole('heading', { name: c.title, level: 1 })).toBeVisible({
        timeout: 20_000,
      });
      await expect(page.getByTestId('kpi-hours')).toHaveText(c.hours);
      await expect(page.getByTestId('delay-log')).toBeVisible();
      expect(await overflow(page), '/weather').toBeLessThanOrEqual(0);
      await expectNoViolations(page);

      await page.getByRole('button', { name: c.build }).first().click();
      const dialog = page.getByRole('dialog');
      await expect(dialog.getByTestId('pack-summary')).toHaveText(c.summary);
      await expectNoViolations(page);
      await page.keyboard.press('Escape');
      await expect(dialog).toHaveCount(0);

      // Hillcrest's Oct 9 rain came in on a call: its chip opens P7 at the call second.
      const chip = page.getByRole('link', { name: c.call });
      await expect(chip).toHaveAttribute('href', /\?clip=[^&]+&at=41$/);
      await expectHitArea(chip);
      await chip.click();
      await expect(page).toHaveURL(/\/reports\/[^?]+\?clip=[^&]+&at=41$/);
      await expect(page.getByTestId('media-player').first()).toBeVisible({ timeout: 20_000 });
    });
  }
}
