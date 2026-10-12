import AxeBuilder from '@axe-core/playwright';
import { expect, test, type Locator, type Page } from '@playwright/test';
import { demoId } from '@sitelog/shared/demo/ids.ts';

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
  { name: 'report', path: `/reports/${HERO_REPORT}`, ready: (p) => p.getByTestId('voice-player') },
  { name: 'hours', path: '/hours', ready: (p) => p.getByTestId('hours-matrix') },
  { name: 'weather', path: '/weather', ready: (p) => p.getByTestId('delay-log') },
  { name: 'team', path: '/team', ready: (p) => p.getByTestId('unknown-sender') },
  { name: 'glossary', path: '/glossary', ready: (p) => p.getByTestId('review-queue') },
  { name: 'settings-reports', path: '/settings/reports', ready: (p) => p.getByTestId('ladder') },
  { name: 'settings-pdf', path: '/settings/pdf', ready: (p) => h1(p, 'Settings') },
  { name: 'settings-recipients', path: '/settings/recipients', ready: (p) => h1(p, 'Settings') },
  { name: 'settings-payroll', path: '/settings/payroll', ready: (p) => h1(p, 'Settings') },
  { name: 'billing', path: '/billing', ready: (p) => p.getByTestId('plan-card') },
  { name: 'ops', path: '/ops', ready: (p) => p.getByTestId('ops-kpis') },
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

    test('accounts user: crew hours', async ({ page }) => {
      await signInFast(page, 'accounts');
      await page.goto('/hours');
      await expect(page.getByTestId('hours-matrix')).toBeVisible();
      await expectNoViolations(page);
    });

    test('report in edit mode and the save dialog', async ({ page }) => {
      await signInFast(page);
      await page.goto(`/reports/${HERO_REPORT}`);
      await expect(page.getByTestId('voice-player')).toBeVisible();
      await page.getByRole('button', { name: 'Edit', exact: true }).click();
      await expect(page.getByTestId('save-version')).toBeVisible();
      await expectNoViolations(page);

      await page.getByLabel('Summary', { exact: true }).fill('Edited for the accessibility pass.');
      await page.getByTestId('save-version').click();
      await expect(page.getByRole('dialog')).toBeVisible();
      await expect(page.getByLabel('Change note')).toBeFocused();
      await expectNoViolations(page);
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
});
