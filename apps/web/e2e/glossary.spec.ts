import AxeBuilder from '@axe-core/playwright';
import { expect, test, type Page } from '@playwright/test';

/**
 * W3-08 · Site glossary (spec F21, P11) in demo mode: the review queue and the terms table with
 * the tabs All · Companies · Spanish · Turkish, axe WCAG 2.2 AA and no sideways scroll at 1440 and
 * 390 px, in English and in Turkish.
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
    title: 'Site glossary',
    review: 'New this week · review 3',
    table: 'All terms',
    spanish: 'Spanish',
    turkish: 'Turkish',
    empty: 'No terms yet. The agent learns them from voice notes.',
  },
  tr: {
    title: 'Şantiye sözlüğü',
    review: 'Bu hafta yeni · 3 inceleme',
    table: 'Tüm terimler',
    spanish: 'İspanyolca',
    turkish: 'Türkçe',
    empty: 'Henüz terim yok. Asistan terimleri sesli notlardan öğrenir.',
  },
} as const;

for (const lang of ['en', 'tr'] as const) {
  for (const width of [1440, 390] as const) {
    test(`Site glossary at ${width}px (${lang})`, async ({ page }) => {
      const c = COPY[lang];
      await page.setViewportSize({ width, height: width === 390 ? 844 : 900 });
      await signInFast(page, lang);

      await page.goto('/glossary');
      await expect(page.getByRole('heading', { name: c.title, level: 1 })).toBeVisible({
        timeout: 20_000,
      });
      await expect(page.getByRole('heading', { name: c.review })).toBeVisible();
      expect(await overflow(page), '/glossary').toBeLessThanOrEqual(0);
      await expectNoViolations(page);

      const table = page.getByRole('table', { name: c.table });
      await page.getByRole('tab', { name: c.spanish }).click();
      await expect(table.getByText('“llovió”')).toBeVisible();
      // Kestrel's terms are English and Spanish: the Turkish tab is empty for this org.
      await page.getByRole('tab', { name: c.turkish }).click();
      await expect(page.getByText(c.empty)).toBeVisible();
      expect(await overflow(page), '/glossary (Turkish tab)').toBeLessThanOrEqual(0);
    });
  }
}
