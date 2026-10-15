import { expect, test, type Page } from '@playwright/test';
import { pinSeedClock, SEED, signInWithMagicLink } from './support';

/**
 * §18.2 TR demo org Demir Yapı A.Ş. in the panel (W1-06 Done when): its sites with the shell in
 * Turkish, from the org's tr-TR locale. Its seeded office user is the TR admin Elif Aydın (spec §19
 * question 18, GAP D46), a member of Demir Yapı only, with no panel language of her own
 * (`ui_locale` null), so the org decides it. Its pages get Turkish copy in W1-16 … W1-18 (the
 * Overview in W1-16, Sites and Site detail in W1-18). Nothing here writes to the database.
 */
test.describe.configure({ mode: 'serial' });

/**
 * The org switcher's names: the visible text (org, active-site count), then its purpose. Chromium
 * puts a space before the comma, since the purpose is an `sr-only` span (absolutely positioned,
 * so a block in the name computation); jsdom has no CSS and none (`Sidebar.test.tsx`).
 */
const DEMIR_SWITCHER = /^Demir Yapı A\.Ş\. 2 aktif şantiye ?, Şirket değiştir$/;
const KESTREL_SWITCHER = /^Kestrel Build Group 6 active sites ?, Switch company$/;

/** The org switcher's companies (Radix radio items), by their names. */
async function switcherOrgs(page: Page, trigger: RegExp): Promise<string[]> {
  await page.getByRole('button', { name: trigger }).click();
  const menu = page.getByRole('menu');
  await expect(menu).toBeVisible();
  const items = menu.getByRole('menuitemradio');
  // Each item is the org's name, then its active-site count; the current org is checked.
  const names = (await items.allInnerTexts()).map((t) => t.replace(/\s*\d+\s*$/, '').trim());
  await expect(menu.getByRole('menuitemradio', { checked: true })).toHaveCount(1);
  await page.keyboard.press('Escape');
  await expect(menu).toHaveCount(0);
  return names;
}

test('Demir Yapı A.Ş.: the org’s sites with the shell in Turkish', async ({ page }) => {
  await pinSeedClock(page);
  await signInWithMagicLink(page, SEED.demirAdmin.email);
  await expect(page.locator('html')).toHaveAttribute('lang', 'tr');
  await expect(page.getByRole('button', { name: DEMIR_SWITCHER })).toBeVisible();
  const nav = page.getByRole('navigation', { name: 'Ana gezinme' });
  for (const name of ['Genel bakış', 'Şantiyeler', 'Raporlar', 'Puantaj'])
    await expect(nav.getByRole('link', { name })).toBeVisible();
  await expect(page.getByRole('heading', { level: 1, name: 'Bugün 2 şantiyede' })).toBeVisible();
  const table = page.getByRole('table', { name: 'Bugün şantiyeler' });
  for (const name of ['Kartal Konutları — B Blok', 'Ataşehir Ofis Binası'])
    await expect(table.getByRole('link', { name, exact: true })).toBeVisible();
  await expect(table.getByText('Emre Yıldız')).toBeVisible();
  // Only its own org: nothing of Kestrel's.
  await expect(page.getByText('Riverside Lofts — Block B')).toHaveCount(0);
  // Her name as seeded, dotless ı included (the account menu shows it).
  await expect(page.getByTestId('sidebar').getByText('Elif Aydın', { exact: true })).toBeVisible();
  // The org switcher lists Demir Yapı A.Ş. only.
  expect(await switcherOrgs(page, DEMIR_SWITCHER)).toEqual(['Demir Yapı A.Ş.']);
});

// W1-18: Sites and Site detail speak Turkish for the TR org (spec P4, P5). The TR price of the
// "Connect another site" card is open (spec §19 Q9), so the card shows no price line.
test('Demir Yapı A.Ş.: Sites and Site detail in Turkish', async ({ page }) => {
  await pinSeedClock(page);
  await signInWithMagicLink(page, SEED.demirAdmin.email);
  await page
    .getByRole('navigation', { name: 'Ana gezinme' })
    .getByRole('link', { name: 'Şantiyeler' })
    .click();
  await expect(page.getByRole('heading', { level: 1, name: 'Şantiyeler' })).toBeVisible();
  await expect(
    page.getByText('2 aktif · her biri her gün mesajdaki linkle ya da telefonla rapor verir'),
  ).toBeVisible();
  await expect(page.getByTestId('site-card')).toHaveCount(2);
  const kartal = page.getByTestId('site-card').filter({ hasText: 'Kartal Konutları — B Blok' });
  await expect(kartal.getByText('Emre Yıldız')).toBeVisible();
  // §18.2: Emre prefers a call (Q33), Selin a text link.
  await expect(kartal.getByTestId('contact-pref')).toHaveAttribute('data-pref', 'call');
  const ataşehir = page.getByTestId('site-card').filter({ hasText: 'Ataşehir Ofis Binası' });
  await expect(ataşehir.getByTestId('contact-pref')).toHaveAttribute('data-pref', 'link');
  const connect = page.getByTestId('connect-site-card');
  await expect(connect).toContainText('Başka bir şantiye bağlayın');
  await expect(connect).not.toContainText('Aylık');

  await kartal.getByRole('link', { name: 'Kartal Konutları — B Blok şantiyesini aç' }).click();
  await expect(
    page.getByRole('heading', { level: 1, name: 'Kartal Konutları — B Blok' }),
  ).toBeVisible();
  await expect(page.getByRole('link', { name: 'Ara: Emre' })).toHaveAttribute(
    'href',
    'tel:+905320001203',
  );
  await expect(page.getByRole('button', { name: 'Şantiye ayarları' })).toBeVisible();
  await expect(page.getByRole('tab', { name: 'Günlük raporlar' })).toBeVisible();
  await expect(page.getByRole('grid', { name: 'Ekim 2026' })).toBeVisible();
  await expect(page.getByText('Tercih: telefon araması · TR konuşur')).toBeVisible();
});

test('Lena still sees Kestrel Build Group only', async ({ page }) => {
  await pinSeedClock(page);
  await signInWithMagicLink(page);
  await expect(page.locator('html')).toHaveAttribute('lang', 'en');
  expect(await switcherOrgs(page, KESTREL_SWITCHER)).toEqual(['Kestrel Build Group']);
  await expect(page.getByText('Kartal Konutları — B Blok')).toHaveCount(0);
});
