import AxeBuilder from '@axe-core/playwright';
import { expect, test, type Page } from '@playwright/test';
import { UI_RESOURCES } from '@sitelog/shared/copy/ui/index.ts';
import { FIELD_ROUTES } from '../src/routes/paths.ts';

/**
 * W1-04 smoke test of the field app shell (production build, 390 px phone): every §9.3 route renders
 * its placeholder in EN, ES and TR with the Field-03 header, `<html lang>` follows the phone's
 * language, axe finds no WCAG 2.2 AA violation and nothing scrolls sideways. Then the PWA basics:
 * manifest, icons and the service worker.
 */

const WCAG_22_AA = ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22a', 'wcag22aa'];

/** Friday 9 October 2026, mid-afternoon in both markets (the artboards' day). */
const NOW = new Date('2026-10-09T15:00:00Z');

const LANGUAGES = [
  { lang: 'en', locale: 'en-US', timezoneId: 'America/Chicago', date: 'FRI, OCT 9' },
  { lang: 'es', locale: 'es-US', timezoneId: 'America/Chicago', date: 'VIE, 9 OCT' },
  { lang: 'tr', locale: 'tr-TR', timezoneId: 'Europe/Istanbul', date: 'CUMA, 9 EKİM' },
] as const;

async function expectNoAxeViolations(page: Page) {
  await page.evaluate(() => document.fonts.ready);
  const { violations } = await new AxeBuilder({ page }).withTags(WCAG_22_AA).analyze();
  const report = violations
    .map(
      (v) =>
        `${v.id} (${v.impact ?? 'n/a'}): ${v.help} → ${v.nodes.map((n) => n.target.join(' ')).join(', ')}`,
    )
    .join('\n');
  expect(report).toBe('');
}

async function expectNoSidewaysScroll(page: Page) {
  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
  );
  expect(overflow, 'horizontal overflow in px').toBeLessThanOrEqual(0);
}

/** §14.6: field targets are at least 56 px both ways. */
async function expectFieldTargets(page: Page) {
  for (const target of await page.locator('a[href], button').all()) {
    const box = await target.boundingBox();
    expect(box, await target.evaluate((el) => el.outerHTML)).not.toBeNull();
    expect(Math.round(box!.height)).toBeGreaterThanOrEqual(56);
    expect(Math.round(box!.width)).toBeGreaterThanOrEqual(56);
  }
}

for (const { lang, locale, timezoneId, date } of LANGUAGES) {
  test.describe(`placeholders in ${lang} (${locale})`, () => {
    test.use({ locale, timezoneId });

    for (const route of FIELD_ROUTES) {
      test(`${route.path} renders at 390 px`, async ({ page }) => {
        const copy = UI_RESOURCES[lang];
        const title = copy.field.routes[route.screen];
        await page.clock.setFixedTime(NOW);
        await page.goto(route.example);

        await expect(page.getByRole('heading', { level: 1, name: title })).toBeVisible();
        await expect(page.getByText(copy.field.placeholderBody)).toBeVisible();
        await expect(page.locator('html')).toHaveAttribute('lang', lang);
        await expect(page).toHaveTitle(`${title} · SiteLog`);

        // Field-03 / Field-10 header: the mark and the name, on Asphalt; the date line under it.
        const header = page.getByRole('banner');
        await expect(header).toContainText('SiteLog');
        await expect(header.locator('img[src="/brand/logo-mark.svg"]')).toBeVisible();
        await expect(page.locator('time')).toHaveText(date);
        await expect(page.locator('time')).toHaveAttribute('datetime', '2026-10-09');
        const gear = page.getByRole('link', { name: copy.field.routes.settings });
        await expect(gear).toHaveCount(route.screen === 'today' ? 1 : 0);

        await expectNoSidewaysScroll(page);
        await expectFieldTargets(page);
        await expectNoAxeViolations(page);
      });
    }

    test('an unknown path shows the not-found screen, with a way to Today', async ({ page }) => {
      const copy = UI_RESOURCES[lang].field;
      await page.goto('/no-such-screen');
      await expect(
        page.getByRole('heading', { level: 1, name: copy.notFound.title }),
      ).toBeVisible();
      await expect(page.locator('html')).toHaveAttribute('lang', lang);
      // The installed app (display: standalone) has no URL bar or back button.
      const action = page.getByRole('link', { name: copy.notFound.action });
      await expect(action).toBeVisible();
      await expectNoSidewaysScroll(page);
      await expectFieldTargets(page);
      await expectNoAxeViolations(page);
      await action.click();
      await expect(page).toHaveURL(/\/today$/);
      await expect(page.getByRole('heading', { level: 1, name: copy.routes.today })).toBeVisible();
    });
  });
}

test.describe('language fallback', () => {
  test.use({ locale: 'de-DE' });

  test('a phone in a language the app does not speak gets English', async ({ page }) => {
    await page.goto('/today');
    await expect(page.locator('html')).toHaveAttribute('lang', 'en');
    await expect(page.getByRole('heading', { level: 1, name: 'Today' })).toBeVisible();
  });
});

test.describe('PWA', () => {
  test('/ opens Today, and the gear opens Settings', async ({ page }) => {
    await page.goto('/');
    await expect(page).toHaveURL(/\/today$/);
    await page.getByRole('link', { name: 'Settings' }).click();
    await expect(page).toHaveURL(/\/settings$/);
    await expect(page.getByRole('heading', { level: 1, name: 'Settings' })).toBeVisible();
  });

  test('the installed shell paints at once on a stalled connection, with its own fonts', async ({
    page,
    context,
  }) => {
    // A congested site connection: every request that leaves the app's host hangs. The shell, its
    // stylesheet and its fonts come from the app itself (no Google Fonts), so nothing waits on them.
    const appHost = new URL(test.info().project.use.baseURL!).hostname;
    const thirdParty: string[] = [];
    await context.route(
      (url) => url.hostname !== appHost,
      (route) => {
        // Never answered.
        thirdParty.push(route.request().url());
      },
    );
    await page.goto('/today', { waitUntil: 'commit' });
    await expect(page.getByRole('heading', { level: 1, name: 'Today' })).toBeVisible();
    await page.waitForFunction(async () => {
      await navigator.serviceWorker.ready;
      return !!navigator.serviceWorker.controller;
    });

    // Installed and in control: a link opened from an SMS paints from the precache.
    await page.goto('/r/K7Q2MX', { waitUntil: 'commit' });
    await expect(page.getByRole('heading', { level: 1 })).toBeVisible({ timeout: 1500 });

    // Offline too, fonts included (Turkish letters are in the latin-ext files).
    await context.setOffline(true);
    await page.reload({ waitUntil: 'commit' });
    await expect(page.getByRole('heading', { level: 1 })).toBeVisible({ timeout: 1500 });
    const faces = await page.evaluate(async () => {
      const loaded = await Promise.all([
        document.fonts.load('800 30px Archivo', 'Bugün ŞĞİ'),
        document.fonts.load('500 13px "IBM Plex Mono"', 'CUMA, 9 EKİM'),
      ]);
      return loaded.flat().map((f) => `${f.family} ${f.weight} ${f.status}`);
    });
    expect(faces).toEqual(
      expect.arrayContaining([
        expect.stringMatching(/^"?Archivo"? 100 900 loaded$/),
        expect.stringMatching(/^"?IBM Plex Mono"? 500 loaded$/),
      ]),
    );
    expect(
      faces.every((f) => f.endsWith(' loaded')),
      faces.join(', '),
    ).toBe(true);
    await context.setOffline(false);
    expect(thirdParty).toEqual([]);
  });

  test('serves the manifest and its icons, and registers the service worker', async ({
    page,
    request,
  }) => {
    await page.goto('/today');
    const href = await page.locator('link[rel="manifest"]').getAttribute('href');
    expect(href).toBe('/manifest.webmanifest');
    const manifest = await (await request.get(href!)).json();
    expect(manifest).toMatchObject({
      name: 'SiteLog',
      short_name: 'SiteLog',
      display: 'standalone',
      theme_color: '#16181B',
      start_url: '/',
    });
    for (const icon of manifest.icons as { src: string }[]) {
      const res = await request.get(icon.src);
      expect(res.status(), icon.src).toBe(200);
      expect(res.headers()['content-type'], icon.src).toContain('image/png');
    }
    await expect(page.locator('meta[name="theme-color"]')).toHaveAttribute('content', '#16181B');

    const scope = await page.evaluate(async () => {
      const reg = await navigator.serviceWorker.ready;
      return reg.scope;
    });
    expect(new URL(scope).pathname).toBe('/');
  });
});
