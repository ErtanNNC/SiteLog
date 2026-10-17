import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import AxeBuilder from '@axe-core/playwright';
import { expect, test, type Locator, type Page } from '@playwright/test';
import { demoId } from '@sitelog/shared/demo/ids.ts';

const SITE_PHOTO = fileURLToPath(new URL('./fixtures/site-photo.png', import.meta.url));

/**
 * §15 / §16.2 M9 accessibility pass (demo mode): axe-core WCAG 2.2 AA scan of every route at
 * 1440 and 375 px, open dialogs/drawers included, plus keyboard checks of the shell.
 */

const WCAG_22_AA = ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22a', 'wcag22aa'];
const WIDTHS = [1440, 375] as const;

const RIVERSIDE_SITE = demoId('site:riverside');
const HERO_REPORT = demoId('report:riverside:2026-10-09');

/** Demo session without the login form (AuthProvider reads this key on boot). */
async function signInFast(page: Page, key: 'admin' | 'pm' | 'accounts' = 'admin') {
  await page.addInitScript((k) => {
    window.localStorage.setItem('sitelog.demo.session', JSON.stringify({ key: k }));
  }, key);
}

/** The viewer chose Turkish on this device (what the language switch saves). */
async function chooseTurkish(page: Page) {
  await page.addInitScript(() => {
    window.localStorage.setItem('sitelog.language', JSON.stringify('tr'));
  });
}

function describeViolations(violations: Awaited<ReturnType<AxeBuilder['analyze']>>['violations']) {
  return violations
    .map(
      (v) =>
        `${v.id} (${v.impact ?? 'n/a'}): ${v.help}\n` +
        v.nodes
          .slice(0, 8)
          .map((n) => `    ${n.target.join(' ')}\n      ${n.failureSummary?.replace(/\n/g, ' ')}`)
          .join('\n'),
    )
    .join('\n');
}

async function expectNoViolations(page: Page, opts: { include?: string } = {}) {
  // Fonts and lazy chunks settle before the scan so colour-contrast sees final styles.
  await page.evaluate(() => document.fonts.ready);
  let builder = new AxeBuilder({ page }).withTags(WCAG_22_AA);
  if (opts.include) builder = builder.include(opts.include);
  const { violations } = await builder.analyze();
  // Compared as text so a failure prints rule · impact · selector instead of a deep diff.
  expect(describeViolations(violations)).toBe('');
}

interface RouteCase {
  name: string;
  path: string;
  signedIn?: boolean;
  /** Something that proves the page finished loading. */
  ready: (page: Page) => Locator;
}

const h1 = (page: Page, name: string | RegExp) =>
  page.getByRole('heading', { level: 1, name: name instanceof RegExp ? name : name });

const ROUTES: RouteCase[] = [
  {
    name: 'login',
    path: '/login',
    signedIn: false,
    ready: (p) => p.getByRole('heading', { name: 'End-of-day reports, spoken in three minutes.' }),
  },
  { name: 'overview', path: '/', ready: (p) => h1(p, 'Today across 6 sites') },
  { name: 'sites', path: '/sites', ready: (p) => p.getByTestId('site-card').first() },
  {
    name: 'site',
    path: `/sites/${RIVERSIDE_SITE}`,
    ready: (p) => p.getByTestId('latest-card'),
  },
  { name: 'reports', path: '/reports', ready: (p) => p.getByRole('table', { name: 'Reports' }) },
  { name: 'new report', path: '/reports/new', ready: (p) => p.getByTestId('report-editor') },
  {
    name: 'report',
    path: `/reports/${HERO_REPORT}`,
    ready: (p) => p.getByTestId('media-player').first(),
  },
  { name: 'hours', path: '/hours', ready: (p) => p.getByTestId('hours-matrix') },
  { name: 'weather', path: '/weather', ready: (p) => p.getByTestId('delay-log') },
  { name: 'team', path: '/team', ready: (p) => p.getByTestId('unknown-sender') },
  { name: 'glossary', path: '/glossary', ready: (p) => p.getByTestId('review-queue') },
  { name: 'settings-reports', path: '/settings/reports', ready: (p) => p.getByTestId('ladder') },
  { name: 'settings-pdf', path: '/settings/pdf', ready: (p) => h1(p, 'Settings') },
  { name: 'settings-recipients', path: '/settings/recipients', ready: (p) => h1(p, 'Settings') },
  { name: 'settings-payroll', path: '/settings/payroll', ready: (p) => h1(p, 'Settings') },
  { name: 'billing', path: '/billing', ready: (p) => p.getByTestId('plan-card') },
  {
    name: 'settings-channels',
    path: '/settings/channels',
    ready: (p) => p.getByTestId('pack-card'),
  },
  { name: 'dev-phone', path: '/dev/phone', ready: (p) => h1(p, 'Demo phone') },
  { name: 'ops', path: '/ops', ready: (p) => p.getByTestId('ops-kpis') },
  { name: 'try', path: '/try', ready: (p) => p.getByTestId('try-log') },
  { name: 'setup-company', path: '/setup/company', ready: (p) => h1(p, /./) },
  { name: 'setup-site', path: '/setup/site', ready: (p) => p.getByLabel('Site name') },
  { name: 'setup-reports', path: '/setup/reports', ready: (p) => h1(p, /./) },
  {
    name: 'not-found',
    path: '/no-such-page',
    ready: (p) => p.getByRole('heading', { name: 'Page not found' }),
  },
];

for (const width of WIDTHS) {
  test.describe(`WCAG 2.2 AA at ${width}px`, () => {
    test.use({ viewport: { width, height: width === 375 ? 812 : 900 } });

    for (const route of ROUTES) {
      test(`${route.name}`, async ({ page }) => {
        if (route.signedIn !== false) await signInFast(page);
        await page.goto(route.path);
        await expect(route.ready(page).first()).toBeVisible();
        await expectNoViolations(page);
      });
    }

    test('login in Turkish', async ({ page }) => {
      await chooseTurkish(page);
      await page.goto('/login');
      await expect(
        page.getByRole('heading', { level: 1, name: 'Ofis paneline giriş yapın' }),
      ).toBeVisible();
      await expect(page.locator('html')).toHaveAttribute('lang', 'tr');
      await expectNoViolations(page);
    });

    test('the Turkish shell and Overview (W1-16), with its menus open', async ({ page }) => {
      await chooseTurkish(page);
      await signInFast(page);
      await page.goto('/');
      await expect(h1(page, 'Bugün 6 şantiyede')).toBeVisible();
      await expect(page.locator('main [lang="en"]')).toHaveCount(0);
      await expectNoViolations(page);
      if (width === 375) {
        await page.getByRole('button', { name: 'Menüyü aç' }).click();
        await expect(page.getByRole('dialog', { name: 'Ana gezinme' })).toBeVisible();
      }
      await page.getByRole('button', { name: 'Hesap menüsü' }).click();
      await expect(page.getByRole('menu')).toBeVisible();
      await expectNoViolations(page);
    });

    // WCAG 3.1.2: what an English-only page portals to <body> is English too, not the shell's TR.
    test('the Turkish shell: an English page’s select stays lang="en"', async ({ page }) => {
      await chooseTurkish(page);
      await signInFast(page);
      const langOf = (l: Locator) =>
        l.evaluate((el) => el.closest('[lang]')?.getAttribute('lang') ?? null);
      // New report is still English-only (Settings speaks Turkish since W4-05): its select's list.
      await page.goto('/reports/new');
      const siteSelect = page.getByRole('combobox', { name: 'Site' });
      await expect(siteSelect).toBeVisible();
      await siteSelect.click();
      const options = page.getByRole('listbox');
      await expect(options).toBeVisible();
      expect(await langOf(options)).toBe('en');
      // Axe runs once the list is closed: an open Radix select hides the rest of the page.
      await page.keyboard.press('Escape');
      await expect(options).toHaveCount(0);
      await expectNoViolations(page);
      // No English-only page has W4-01's country-code picker any more (Setup speaks Turkish since
      // W4-02, Team since W4-03): its Turkish case is the setup wizard's test below.
    });

    // W4-02: the setup wizard in Turkish, its site step with W4-01's picker open, the preference,
    // the language select and the welcome preview (the SMS in its own language, lang="tr" here).
    test('the setup wizard in Turkish (W4-02)', async ({ page }) => {
      await chooseTurkish(page);
      await signInFast(page);
      const langOf = (l: Locator) =>
        l.evaluate((el) => el.closest('[lang]')?.getAttribute('lang') ?? null);
      await page.goto('/setup/company');
      await expect(h1(page, 'Şirketinizi kurun')).toBeVisible();
      await expect(page.getByLabel('Şirket adı')).toHaveValue('Kestrel Build Group');
      await expectNoViolations(page);
      await page.goto('/setup/site');
      await expect(page.getByLabel('Şantiye adı')).toBeVisible();
      await page.getByLabel('Ad', { exact: true }).fill('Elena Vasquez');
      await page.getByRole('radio', { name: 'Arama' }).click();
      await expect(page.getByTestId('welcome-text')).toHaveAttribute('lang', 'en');
      await expectNoViolations(page);
      const country = page.getByRole('button', { name: /^Ülke kodu: / }).first();
      await country.click();
      const listbox = page.getByRole('listbox', { name: 'Ülke kodu' });
      await expect(listbox).toBeVisible();
      expect(await langOf(listbox)).toBe('tr');
      await expectNoViolations(page);
      await page.keyboard.press('Escape');
      // No horizontal scroll at either width.
      expect(
        await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
      ).toBe(true);
    });

    test('accounts user: crew hours', async ({ page }) => {
      await signInFast(page, 'accounts');
      await page.goto('/hours');
      await expect(page.getByTestId('hours-matrix')).toBeVisible();
      await expectNoViolations(page);
    });

    // W1-17: both pages speak Turkish; the report's sources, players and activity pass too.
    test('reports archive and report review in Turkish', async ({ page }) => {
      await chooseTurkish(page);
      await signInFast(page);
      await page.goto('/reports');
      await expect(page.getByRole('table', { name: 'Raporlar' })).toBeVisible();
      await expect(page.locator('html')).toHaveAttribute('lang', 'tr');
      await expectNoViolations(page);
      await page.goto(`/reports/${HERO_REPORT}`);
      await expect(page.getByTestId('media-player').first()).toBeVisible();
      await expect(page.getByTestId('provenance')).toContainText('Rapor veren: Marco Ruiz');
      await expectNoViolations(page);
    });

    test('report review after a source link played the rain stoppage', async ({ page }) => {
      await signInFast(page);
      await page.goto(`/reports/${HERO_REPORT}`);
      await expect(page.getByTestId('media-player').first()).toBeVisible();
      await page
        .getByTestId('weather-period')
        .first()
        .getByRole('button', { name: /^audio 0:41/ })
        .click();
      await expect(
        page.locator('[data-testid="transcript-excerpt"][data-active="true"]').first(),
      ).toBeVisible();
      await expectNoViolations(page);
    });

    test('report in edit mode and the save dialog', async ({ page }) => {
      await signInFast(page);
      await page.goto(`/reports/${HERO_REPORT}`);
      await expect(page.getByTestId('media-player').first()).toBeVisible();
      await page.getByRole('button', { name: 'Edit', exact: true }).click();
      await expect(page.getByTestId('save-version')).toBeVisible();
      await expectNoViolations(page);

      await page.getByLabel('Summary', { exact: true }).fill('Edited for the accessibility pass.');
      await page.getByTestId('save-version').click();
      await expect(page.getByRole('dialog')).toBeVisible();
      await expect(page.getByLabel('Change note')).toBeFocused();
      await expectNoViolations(page);
    });

    test('new report with a photo and a refused file in the picker', async ({ page }) => {
      await signInFast(page);
      await page.goto('/reports/new');
      const picker = page.getByTestId('photo-picker');
      await picker.getByTestId('photo-input').setInputFiles([
        { name: 'site-photo.png', mimeType: 'image/png', buffer: readFileSync(SITE_PHOTO) },
        { name: 'notes.txt', mimeType: 'text/plain', buffer: Buffer.from('not a photo') },
      ]);
      await expect(picker.getByRole('img', { name: 'Photo 1' })).toBeVisible();
      await expect(picker.getByRole('alert')).toContainText('notes.txt is not an image.');
      await expectNoViolations(page);
      // The thumbnails, captions and buttons fit a phone screen without sideways scrolling.
      expect(
        await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
      ).toBe(true);
    });

    test('crew hours with the invoice check open', async ({ page }) => {
      await signInFast(page);
      await page.goto('/hours');
      await page
        .getByRole('button', { name: 'Compare BrightLine Electric with its invoice' })
        .click();
      await expect(page.getByTestId('invoice-check')).toBeVisible();
      await expectNoViolations(page);
    });

    test('open dialogs', async ({ page }) => {
      await signInFast(page);

      await page.goto('/weather');
      await expect(page.getByTestId('delay-log')).toBeVisible();
      await page
        .getByRole('button', { name: /Build EOT evidence pack/i })
        .first()
        .click();
      await expect(page.getByRole('dialog')).toBeVisible();
      await expectNoViolations(page);
      await page.keyboard.press('Escape');
      await expect(page.getByRole('dialog')).toHaveCount(0);

      await page.goto('/team');
      await expect(page.getByTestId('unknown-sender')).toBeVisible();
      await page
        .getByRole('button', { name: /Invite reporter/i })
        .first()
        .click();
      await expect(page.getByRole('dialog')).toBeVisible();
      await expectNoViolations(page);
      await page.keyboard.press('Escape');

      await page.goto('/glossary');
      await expect(page.getByTestId('review-queue')).toBeVisible();
      await page
        .getByRole('button', { name: /Add term/i })
        .first()
        .click();
      await expect(page.getByRole('dialog')).toBeVisible();
      await expectNoViolations(page);
      await page.keyboard.press('Escape');

      await page.goto('/hours');
      await expect(page.getByTestId('hours-matrix')).toBeVisible();
      await page
        .getByRole('button', { name: /Add invoice/i })
        .first()
        .click();
      await expect(page.getByRole('dialog')).toBeVisible();
      await expectNoViolations(page);
    });

    test('try it on WhatsApp: voice-note sheet and a conversation with reply buttons', async ({
      page,
    }) => {
      await signInFast(page);
      await page.goto('/try');
      await expect(page.getByTestId('try-log')).toBeVisible();
      // No sideways scroll, and the first action is on screen without scrolling.
      expect(
        await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
      ).toBe(true);
      await expect(page.getByRole('button', { name: 'Send Marco’s voice note' })).toBeInViewport();
      await page.getByRole('button', { name: 'Send voice note' }).click();
      await expect(page.getByRole('dialog', { name: 'Send a voice note' })).toBeVisible();
      await expectNoViolations(page);
      await page.getByRole('button', { name: 'Send: Marco’s Friday report' }).click();
      const log = page.getByRole('log', { name: 'Conversation' });
      await expect(log.getByRole('button', { name: '5 · full day' })).toBeEnabled({
        timeout: 20_000,
      });
      await expectNoViolations(page);
      await log.getByRole('button', { name: '5 · full day' }).click();
      await expect(log.getByRole('button', { name: 'OK, file it' })).toBeEnabled({
        timeout: 20_000,
      });
      await expectNoViolations(page);
    });

    test('notifications and account menus', async ({ page }) => {
      await signInFast(page);
      await page.goto('/');
      await expect(h1(page, 'Today across 6 sites')).toBeVisible();
      await page.getByTestId('notifications-bell').click();
      await expect(page.getByRole('heading', { name: 'Notifications' })).toBeVisible();
      await expectNoViolations(page);
      await page.keyboard.press('Escape');
      if (width === 375) {
        await page.getByRole('button', { name: 'Open menu' }).click();
        await expect(page.getByRole('dialog')).toBeVisible();
      }
      await page.getByRole('button', { name: 'Account menu' }).click();
      await expect(page.getByRole('menu')).toBeVisible();
      await expectNoViolations(page);
    });
  });
}

test.describe('keyboard', () => {
  test('skip link moves focus to the main landmark', async ({ page }) => {
    await signInFast(page);
    await page.goto('/');
    await expect(h1(page, 'Today across 6 sites')).toBeVisible();
    await page.keyboard.press('Tab');
    const skip = page.getByRole('link', { name: 'Skip to content' });
    await expect(skip).toBeFocused();
    await expect(skip).toBeInViewport();
    await page.keyboard.press('Enter');
    await expect(page.locator('main#main')).toBeFocused();
  });

  test('tab order reaches the navigation, search and bell with a visible focus ring', async ({
    page,
  }) => {
    await signInFast(page);
    await page.goto('/');
    await expect(h1(page, 'Today across 6 sites')).toBeVisible();
    const nav = page.getByRole('navigation', { name: 'Main navigation' });
    const seen: string[] = [];
    for (let i = 0; i < 25; i++) {
      await page.keyboard.press('Tab');
      // §11.5 focus ring: 2 px outline (colour transitions with `transition-colors`, so only
      // style and width are checked here; contrast of Asphalt/Chalk rings is by design).
      const info = await page.evaluate(() => {
        const el = document.activeElement as HTMLElement | null;
        if (!el || el === document.body) return null;
        const cs = getComputedStyle(el);
        return {
          label:
            el.getAttribute('aria-label') ??
            (el as HTMLInputElement).labels?.[0]?.textContent ??
            el.textContent?.trim().slice(0, 40) ??
            '',
          tag: el.tagName,
          outline: cs.outlineStyle !== 'none' && parseFloat(cs.outlineWidth) >= 2,
          ring: cs.boxShadow !== 'none',
        };
      });
      expect(info, `focus lost after ${i + 1} tabs`).not.toBeNull();
      expect(info!.outline || info!.ring, `no visible focus on ${info!.tag} "${info!.label}"`).toBe(
        true,
      );
      seen.push(info!.label);
    }
    await expect(nav.getByRole('link', { name: /^Overview/ })).toBeVisible();
    expect(seen.some((l) => /^Sites/.test(l))).toBe(true);
    expect(seen).toContain('Search');
    expect(seen.some((l) => /^Notifications/.test(l))).toBe(true);
  });

  test('a nav link opens with Enter', async ({ page }) => {
    await signInFast(page);
    await page.goto('/');
    await expect(h1(page, 'Today across 6 sites')).toBeVisible();
    const sites = page
      .getByRole('navigation', { name: 'Main navigation' })
      .getByRole('link', { name: /^Sites/ });
    await sites.focus();
    await page.keyboard.press('Enter');
    await expect(h1(page, 'Sites')).toBeVisible();
  });

  test('dialogs open and close from the keyboard and return focus', async ({ page }) => {
    await signInFast(page);
    await page.goto('/weather');
    await expect(page.getByTestId('delay-log')).toBeVisible();
    const trigger = page.getByRole('button', { name: /Build EOT evidence pack/i }).first();
    await trigger.focus();
    await page.keyboard.press('Enter');
    const dialog = page.getByRole('dialog');
    await expect(dialog).toBeVisible();
    await expect(dialog).toHaveAccessibleName(/.+/);
    // Focus is trapped inside the dialog.
    for (let i = 0; i < 12; i++) {
      await page.keyboard.press('Tab');
      expect(await dialog.evaluate((d) => d.contains(document.activeElement))).toBe(true);
    }
    await page.keyboard.press('Escape');
    await expect(dialog).toHaveCount(0);
    await expect(trigger).toBeFocused();
  });

  test('mobile drawer opens with the keyboard and closes with Escape', async ({ page }) => {
    await page.setViewportSize({ width: 375, height: 812 });
    await signInFast(page);
    await page.goto('/');
    await expect(h1(page, 'Today across 6 sites')).toBeVisible();
    const menu = page.getByRole('button', { name: 'Open menu' });
    await menu.focus();
    await page.keyboard.press('Enter');
    const drawer = page.getByRole('dialog', { name: 'Main navigation' });
    await expect(drawer).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(drawer).toHaveCount(0);
    await expect(menu).toBeFocused();
  });

  test('account menu opens with the keyboard', async ({ page }) => {
    await signInFast(page);
    await page.goto('/');
    await expect(h1(page, 'Today across 6 sites')).toBeVisible();
    const account = page.getByRole('button', { name: 'Account menu' });
    await account.focus();
    await page.keyboard.press('Enter');
    await expect(page.getByRole('menu')).toBeVisible();
    await page.keyboard.press('ArrowDown');
    expect(await page.getByRole('menu').evaluate((m) => m.contains(document.activeElement))).toBe(
      true,
    );
    await page.keyboard.press('Escape');
    await expect(page.getByRole('menu')).toHaveCount(0);
    await expect(account).toBeFocused();
  });

  test('try it on WhatsApp: voice note, answer and OK with the keyboard only', async ({ page }) => {
    await signInFast(page);
    await page.goto('/try');
    const log = page.getByRole('log', { name: 'Conversation' });
    await log.getByRole('button', { name: 'Send Marco’s voice note' }).focus();
    await page.keyboard.press('Enter');
    // Focus moves to the question's buttons once the reply is in.
    await expect(log.getByRole('button', { name: '4 · full day' })).toBeFocused({
      timeout: 30_000,
    });
    await page.keyboard.press('Tab');
    await expect(log.getByRole('button', { name: '5 · full day' })).toBeFocused();
    await page.keyboard.press('Enter');
    await expect(log.getByRole('button', { name: 'OK, file it' })).toBeFocused({
      timeout: 30_000,
    });
    await page.keyboard.press('Enter');
    await expect(log.getByText(/^Filed\. Daily Report RL-2041-0187/)).toBeVisible({
      timeout: 30_000,
    });
  });
});

test.describe('no sideways scroll on narrow phones', () => {
  const overflow = (page: Page) =>
    page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);

  for (const width of [320, 360, 390]) {
    test(`/try and Overview at ${width}px`, async ({ page }) => {
      await page.setViewportSize({ width, height: 800 });
      await signInFast(page);
      await page.goto('/try');
      await expect(page.getByTestId('try-log')).toBeVisible();
      expect(await overflow(page)).toBeLessThanOrEqual(0);
      await page.goto('/');
      await expect(h1(page, 'Today across 6 sites')).toBeVisible();
      expect(await overflow(page)).toBeLessThanOrEqual(0);
    });
  }

  // /team: the Field reporters table scrolls inside its card; the page's grid track no longer
  // grows with the table (it scrolled the page ~198 px sideways at 390 px).
  test('Team & numbers at 390px: the reporters table scrolls inside its card', async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await signInFast(page);
    await page.goto('/team');
    const table = page.getByRole('table', { name: 'Field reporters' });
    await expect(table).toBeVisible();
    expect(await overflow(page)).toBeLessThanOrEqual(0);
    const region = page.getByTestId('data-table').filter({ has: table });
    expect(
      await region.evaluate((el) => el.scrollWidth > el.clientWidth),
      'the table is wider than its card and scrolls in it',
    ).toBe(true);
  });

  // W1-08: the Demo phone's tabs and reporter buttons are 44 px targets at phone width, the tab
  // list grows with its triggers instead of clipping them, and picking a reporter moves focus to
  // the thread (below 768 px the list and the thread take turns).
  test('the Demo phone keeps 44 px targets at 390px', async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await signInFast(page);
    await page.goto('/dev/phone');
    await expect(h1(page, 'Demo phone')).toBeVisible();
    expect(await overflow(page)).toBeLessThanOrEqual(0);
    const tab = page.getByRole('tab', { name: 'Texts' });
    const tabBox = (await tab.boundingBox())!;
    const listBox = (await page.getByRole('tablist').first().boundingBox())!;
    expect(tabBox.height).toBeGreaterThanOrEqual(44);
    expect(listBox.height).toBeGreaterThanOrEqual(tabBox.height);
    const marco = page
      .getByRole('navigation', { name: 'Reporters' })
      .getByRole('button', { name: /Marco Ruiz/ });
    expect((await marco.boundingBox())!.height).toBeGreaterThanOrEqual(44);
    await marco.click();
    await expect(page.getByRole('heading', { level: 2, name: 'Marco Ruiz' })).toBeFocused();
    expect(await overflow(page)).toBeLessThanOrEqual(0);
    await page.getByRole('button', { name: 'All reporters' }).click();
    await expect(marco).toBeFocused();
    // A two-way thread: Back, the reply box and Send are 44 px too.
    await page
      .getByRole('navigation', { name: 'Reporters' })
      .getByRole('button', { name: /Dana Whitfield/ })
      .click();
    await expect(page.getByRole('heading', { level: 2, name: 'Dana Whitfield' })).toBeFocused();
    for (const target of [
      page.getByRole('button', { name: 'All reporters' }),
      page.getByRole('textbox', { name: 'Reply as Dana Whitfield' }),
      page.getByRole('button', { name: 'Send' }),
    ]) {
      expect((await target.boundingBox())!.height).toBeGreaterThanOrEqual(44);
    }
    expect(await overflow(page)).toBeLessThanOrEqual(0);
  });

  // The shared Button, Input and Select are 44 px at every width: their heights are the
  // `--spacing-target` token in pixels, not `h-11` (41.25 px on the panel's 15 px root,
  // docs/AUDIT_BACKLOG.md). Dense variants (40 px, §14.3) are left out on purpose.
  for (const width of [390, 1440]) {
    test(`shared buttons and inputs are 44 px targets at ${width}px`, async ({ page }) => {
      await page.setViewportSize({ width, height: 900 });
      const expect44 = async (target: Locator, what: string) => {
        await expect(target, what).toBeVisible();
        const box = (await target.boundingBox())!;
        expect(box.height, `${what} at ${width}px`).toBeGreaterThanOrEqual(44);
      };

      await page.goto('/login');
      await expect(h1(page, 'Sign in to the office panel')).toBeVisible();
      await expect44(page.getByRole('textbox', { name: 'Work email' }), 'login: email');
      await expect44(
        page.getByRole('button', { name: 'Email me a sign-in link' }),
        'login: submit',
      );
      await expect44(page.getByRole('button', { name: 'Continue with company SSO' }), 'login: SSO');

      await page.evaluate(() =>
        window.localStorage.setItem('sitelog.demo.session', JSON.stringify({ key: 'admin' })),
      );
      await page.goto('/sites');
      await expect(h1(page, 'Sites')).toBeVisible();
      await expect44(page.getByRole('link', { name: 'Add site' }), 'sites: Add site');
      const search = page.getByRole('combobox', { name: 'Search' });
      if (await search.isVisible()) await expect44(search, 'top bar: search');

      await page.goto('/team');
      await expect(h1(page, 'Team & numbers')).toBeVisible();
      const invite = page.getByRole('button', { name: 'Invite reporter' }).first();
      await expect44(invite, 'team: Invite reporter');
      await invite.click();
      const dialog = page.getByRole('dialog', { name: 'Invite reporter' });
      await expect44(dialog.getByRole('textbox', { name: 'Name' }), 'invite: name');
      await expect44(dialog.getByRole('textbox', { name: 'Mobile number' }), 'invite: phone');
      await expect44(dialog.getByRole('button', { name: /^Country code: / }), 'invite: country');
      await expect44(dialog.getByRole('button', { name: 'Send welcome text' }), 'invite: send');
    });
  }

  // W1-03: the shell itself at 390 px, in both languages: sign-in, the shell's own pages, the top
  // bar with a page's controls, the drawer and the account menu inside it.
  for (const lang of ['en', 'tr'] as const) {
    test(`the shell at 390px (${lang})`, async ({ page }) => {
      const tr = lang === 'tr';
      await page.setViewportSize({ width: 390, height: 844 });
      if (tr) await chooseTurkish(page);
      await page.goto('/login');
      await expect(
        h1(page, tr ? 'Ofis paneline giriş yapın' : 'Sign in to the office panel'),
      ).toBeVisible();
      expect(await overflow(page), '/login').toBeLessThanOrEqual(0);

      await page.evaluate(() =>
        window.localStorage.setItem('sitelog.demo.session', JSON.stringify({ key: 'admin' })),
      );
      const pages: Array<[string, (p: Page) => Locator]> = [
        ['/', (p) => h1(p, tr ? 'Bugün 6 şantiyede' : 'Today across 6 sites')],
        ['/dev/phone', (p) => h1(p, tr ? 'Demo telefon' : 'Demo phone')],
        ['/settings/channels', (p) => p.getByTestId('pack-card')],
        // Pages with controls in the top bar: below 768 px they get a row of their own.
        ['/settings/reports', (p) => p.getByTestId('ladder')],
        ['/weather', (p) => p.getByTestId('delay-log')],
        [
          '/no-such-page',
          (p) => p.getByRole('heading', { name: tr ? 'Sayfa bulunamadı' : 'Page not found' }),
        ],
        [`/reports/${HERO_REPORT}`, (p) => p.getByTestId('media-player').first()],
        ['/reports', (p) => p.getByRole('table', { name: tr ? 'Raporlar' : 'Reports' })],
      ];
      for (const [path, ready] of pages) {
        await page.goto(path);
        await expect(ready(page)).toBeVisible();
        expect(await overflow(page), path).toBeLessThanOrEqual(0);
      }

      await page.getByRole('button', { name: tr ? 'Menüyü aç' : 'Open menu' }).click();
      const drawer = page.getByRole('dialog', { name: tr ? 'Ana gezinme' : 'Main navigation' });
      await expect(drawer).toBeVisible();
      await expect(drawer.getByTestId('sidebar-footer')).toBeInViewport();
      expect(await overflow(page), 'drawer').toBeLessThanOrEqual(0);
      await drawer.getByRole('button', { name: tr ? 'Hesap menüsü' : 'Account menu' }).click();
      await expect(page.getByRole('menu')).toBeVisible();
      expect(await overflow(page), 'account menu').toBeLessThanOrEqual(0);

      // WCAG 2.4.3: Tab follows the rows as seen: menu, bell (row 1), search (row 2), then the
      // page's controls (row 3).
      await page.goto('/weather');
      await expect(page.getByTestId('delay-log')).toBeVisible();
      const menuButton = page.getByRole('button', { name: tr ? 'Menüyü aç' : 'Open menu' });
      const bell = page.getByTestId('notifications-bell');
      const search = page.getByRole('combobox', { name: tr ? 'Arama' : 'Search', exact: true });
      const siteSelect = page.getByRole('combobox', {
        name: tr ? 'Şantiye' : 'Site',
        exact: true,
      });
      const top = async (l: Locator) => (await l.boundingBox())!.y;
      expect(await top(bell)).toBeLessThan(await top(search));
      expect(await top(search)).toBeLessThan(await top(siteSelect));
      await menuButton.focus();
      for (const next of [bell, search, siteSelect]) {
        await page.keyboard.press('Tab');
        await expect(next).toBeFocused();
      }
    });
  }
});
