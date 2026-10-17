import AxeBuilder from '@axe-core/playwright';
import { expect, test, type Page } from '@playwright/test';
import { demoId } from '@sitelog/shared/demo/ids.ts';

/**
 * W1-18 · Sites and Site detail (spec P4, P5; Web-Sites, Web-Site) in demo mode: content, axe
 * WCAG 2.2 AA and no sideways scroll at 1440 and 390 px, in English and in Turkish. The committed
 * screenshots come from `screenshots.spec.ts`.
 */

const WCAG_22_AA = ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22a', 'wcag22aa'];
const RIVERSIDE_SITE = demoId('site:riverside');

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
    sitesSubtitle: '6 active · each reports daily by text link or call',
    prefersLink: 'Prefers text link',
    connect: 'Connect another site',
    call: 'Call Marco',
    textLink: 'Text today’s link',
    texted: 'Today’s link texted to Marco.',
    settings: 'Site settings',
    calendar: 'October 2026',
    confirmed: 'Confirmed by answer',
  },
  tr: {
    sitesSubtitle: '6 aktif · her biri her gün mesajdaki linkle ya da telefonla rapor verir',
    prefersLink: 'Tercih: mesajla link',
    connect: 'Başka bir şantiye bağlayın',
    call: 'Ara: Marco',
    textLink: 'Günün linkini gönder',
    texted: 'Günün linki gönderildi: Marco.',
    settings: 'Şantiye ayarları',
    calendar: 'Ekim 2026',
    confirmed: 'Yanıtla onaylandı',
  },
} as const;

for (const lang of ['en', 'tr'] as const) {
  for (const width of [1440, 390] as const) {
    test(`Sites and Site detail at ${width}px (${lang})`, async ({ page }) => {
      const c = COPY[lang];
      await page.setViewportSize({ width, height: width === 390 ? 844 : 900 });
      await signInFast(page, lang);

      await page.goto('/sites');
      await expect(page.getByText(c.sitesSubtitle)).toBeVisible({ timeout: 20_000 });
      await expect(page.getByTestId('site-card')).toHaveCount(6);
      const riverside = page.getByTestId('site-card').filter({ hasText: 'Riverside Lofts' });
      await expect(riverside.getByTestId('contact-pref')).toHaveAttribute('data-pref', 'link');
      await expect(riverside.getByTestId('contact-pref')).toHaveAttribute('title', c.prefersLink);
      await expect(page.getByTestId('connect-site-card')).toContainText(c.connect);
      expect(await overflow(page), '/sites').toBeLessThanOrEqual(0);
      await expectNoViolations(page);

      await page.goto(`/sites/${RIVERSIDE_SITE}`);
      await expect(page.getByTestId('latest-card')).toBeVisible({ timeout: 20_000 });
      await expect(page.getByRole('link', { name: c.call })).toHaveAttribute(
        'href',
        'tel:+15550143378',
      );
      await expect(page.getByRole('button', { name: c.settings })).toBeVisible();
      // P5: Text today's link (W1-16's action) texts Marco; the toast says so.
      const textLink = page.getByRole('button', { name: c.textLink });
      expect((await textLink.boundingBox())!.height).toBeGreaterThanOrEqual(40);
      await textLink.click();
      await expect(page.getByText(c.texted)).toBeVisible();
      await expect(page.locator('a[href*="wa.me"]')).toHaveCount(0);
      await expect(page.getByRole('grid', { name: c.calendar })).toBeVisible();
      await expect(page.locator('[data-date="2026-10-09"] [data-channel="link"]')).toHaveCount(1);
      await expect(page.getByText(c.confirmed)).toBeVisible();
      expect(await overflow(page), '/sites/:id').toBeLessThanOrEqual(0);
      await expectNoViolations(page);
    });
  }
}
