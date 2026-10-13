import { fileURLToPath } from 'node:url';
import { expect, test, type Page } from '@playwright/test';
import { demoId } from '@sitelog/shared/demo/ids.ts';

/** A 48 × 36 PNG: the panel turns it into a JPEG before it is "uploaded". */
const SITE_PHOTO = fileURLToPath(new URL('./fixtures/site-photo.png', import.meta.url));

async function signIn(page: Page, as?: string) {
  await page.goto(as ? `/login?as=${as}` : '/login');
  await expect(
    page.getByRole('heading', { name: 'End-of-day reports, spoken in three minutes.' }),
  ).toBeVisible();
  await page.getByLabel('Work email').fill('lena@kestrelbuild.example');
  await page.getByRole('button', { name: 'Email me a sign-in link' }).click();
}

test.describe('SiteLog panel (demo mode)', () => {
  test('login → overview renders the KPIs → every nav item opens', async ({ page }) => {
    await signIn(page);
    await expect(page.getByRole('heading', { name: 'Today across 6 sites' })).toBeVisible();
    await expect(page.getByTestId('kpi-reports-in')).toHaveText(/4\s*\/\s*6/);
    await expect(page.getByText('FRI, OCT 9, 2026 · 19:05')).toBeVisible();
    await expect(page.getByTestId('demo-chip')).toBeVisible();
    await expect(
      page.getByTestId('needs-attention').locator('[data-kind]').first(),
    ).toHaveAttribute('data-kind', 'missing');
    await expect(
      page
        .getByRole('table', { name: 'Sites today' })
        .getByRole('link', { name: 'Elm St. Townhomes', exact: true }),
    ).toBeVisible();

    const nav = page.getByRole('navigation', { name: 'Main navigation' });
    const items: Array<[string, RegExp]> = [
      ['Sites', /Sites/],
      ['Reports', /Reports/],
      ['Crew hours', /Crew hours/],
      ['Weather & delays', /Weather & delays/],
      ['Team & numbers', /Team & numbers/],
      ['Site glossary', /Site glossary/],
      ['Settings', /Settings/],
      ['Billing', /Billing/],
      ['Demo phone', /Demo phone/],
      ['Overview', /Today across 6 sites/],
    ];
    for (const [label, heading] of items) {
      await nav.getByRole('link', { name: new RegExp(`^${label}`) }).click();
      await expect(page.getByRole('heading', { level: 1 })).toHaveText(heading);
    }
  });

  test('sites page shows six site cards with streaks and the connect-another card', async ({
    page,
  }) => {
    await signIn(page);
    await page.goto('/sites');
    await expect(page.getByRole('heading', { name: 'Sites', exact: true })).toBeVisible();
    await expect(page.getByTestId('site-card')).toHaveCount(6);
    await expect(page.getByTestId('streak-bar')).toHaveCount(6);
    await expect(
      page.getByTestId('site-card').filter({ hasText: 'Elm St. Townhomes' }),
    ).toHaveAttribute('data-attention', 'true');
    await expect(page.getByTestId('connect-site-card')).toContainText('$399 / month');
    await page.getByRole('tab', { name: /Attention/ }).click();
    await expect(page.getByTestId('site-card')).toHaveCount(2);
  });

  test('accounts users land on crew hours and cannot open the overview', async ({ page }) => {
    await signIn(page, 'accounts');
    await expect(page).toHaveURL(/\/hours$/);
    await expect(page.getByRole('heading', { level: 1 })).toHaveText(/Crew hours/);
    await page.goto('/sites');
    await expect(page.getByText('You don’t have access to Sites. Ask an admin.')).toBeVisible();
  });

  test('demo realtime: simulate report flips Elm St. to filed', async ({ page }) => {
    await signIn(page);
    await expect(page.getByRole('heading', { name: 'Today across 6 sites' })).toBeVisible();
    await page.getByRole('button', { name: 'Account menu' }).click();
    await page.getByTestId('demo-simulate').click();
    await expect(page.getByTestId('kpi-reports-in')).toHaveText(/5\s*\/\s*6/);
    await expect(page.getByText('Elm St. Townhomes — no report')).toHaveCount(0);
  });

  test('try it on WhatsApp: voice note → question → OK → Overview shows Riverside filed', async ({
    page,
  }) => {
    await signIn(page);
    await expect(page.getByTestId('try-card')).toBeVisible();
    await page
      .getByRole('navigation', { name: 'Main navigation' })
      .getByRole('link', { name: /^Try it on WhatsApp/ })
      .click();
    await expect(page.getByRole('heading', { level: 1 })).toHaveText('Try it on WhatsApp');
    const log = page.getByRole('log', { name: 'Conversation' });
    await page.getByRole('button', { name: 'Send Marco’s voice note' }).click();
    await expect(log.getByText('Got it, Marco — 2 min 48 s.')).toBeVisible();
    await log.getByRole('button', { name: '5 · full day' }).click({ timeout: 20_000 });
    await expect(log.getByText(/23 on site · 4 subs · 184 h/)).toBeVisible({ timeout: 20_000 });
    await log.getByRole('button', { name: 'OK, file it' }).click();
    await expect(log.getByText(/^Filed\. Daily Report RL-2041-0187/)).toBeVisible({
      timeout: 20_000,
    });
    await expect(page.getByTestId('try-report-no')).toHaveText('RL-2041-0187');
    await page.getByTestId('try-open-report').click();
    await expect(page.getByRole('navigation', { name: 'Breadcrumb' })).toContainText(
      'RL-2041-0187',
    );
    await page
      .getByRole('navigation', { name: 'Main navigation' })
      .getByRole('link', { name: /^Overview/ })
      .click();
    const row = page.getByRole('row').filter({ hasText: 'Riverside Lofts — Block B' });
    await expect(row.getByText('Filed', { exact: true })).toBeVisible();
  });

  test('new report: type Elm St.’s missing report with a photo, file it and open its PDF', async ({
    page,
  }) => {
    await signIn(page);
    await expect(page.getByRole('heading', { name: 'Today across 6 sites' })).toBeVisible();
    await page
      .getByRole('navigation', { name: 'Main navigation' })
      .getByRole('link', { name: /^Reports/ })
      .click();
    await page.getByTestId('new-report').click();
    await expect(page.getByRole('heading', { level: 1 })).toHaveText('New report');

    await page.getByTestId('new-report-site').click();
    await page.getByRole('option', { name: /Elm St\. Townhomes/ }).click();
    await expect(page.getByTestId('new-report-date')).toHaveValue('2026-10-09');
    const editor = page.getByTestId('report-editor');
    await editor.getByRole('textbox').first().fill('Framing continued on units 3 and 4.');
    await editor.getByRole('button', { name: 'Add work item' }).click();
    await editor.getByLabel('Activity').first().fill('Wall framing');
    // A photo: prepared in the browser (decoded, JPEG), previewed, captioned.
    const picker = editor.getByTestId('photo-picker');
    await picker.getByTestId('photo-input').setInputFiles(SITE_PHOTO);
    const thumb = picker.getByRole('img', { name: 'Photo 1' });
    await expect(thumb).toBeVisible();
    await expect(thumb).toHaveJSProperty('complete', true);
    expect(await thumb.evaluate((img: HTMLImageElement) => img.naturalWidth)).toBe(48);
    await picker.getByLabel('Caption for photo 1').fill('Units 3 and 4 framed');
    await expect(picker.getByTestId('photo-count')).toContainText('1 photo of 20');
    await page.getByTestId('file-report').click();

    await expect(page).toHaveURL(/\/reports\/(?!new)[^/?]+$/);
    await expect(page.getByText(/Entered by .+ in SiteLog at/)).toBeVisible();
    await expect(page.getByText('Wall framing')).toBeVisible();
    // The filed report shows the photo with its caption.
    const photos = page.getByTestId('section-photos');
    const photo = photos.getByRole('img', { name: 'Units 3 and 4 framed' });
    await expect(photo).toBeVisible();
    expect(await photo.evaluate((img: HTMLImageElement) => img.naturalWidth)).toBe(48);
    await expect(photos.getByText('Units 3 and 4 framed')).toBeVisible();

    // Capture the URL the PDF button opens (headless Chromium has no PDF viewer, so a PDF tab
    // stays blank there) and check that it really is a PDF.
    await page.evaluate(() => {
      const w = window as unknown as { __opened: string[] };
      w.__opened = [];
      window.open = (url?: string | URL) => {
        if (url) w.__opened.push(String(url));
        return null;
      };
    });
    await page.getByRole('button', { name: 'PDF', exact: true }).click();
    const opened = await page.waitForFunction(() => {
      const urls = (window as unknown as { __opened: string[] }).__opened;
      return urls.find((u) => u.startsWith('blob:')) ?? null;
    });
    const pdf = await page.evaluate(
      async (url) => {
        const text = new TextDecoder('latin1').decode(await (await fetch(url)).arrayBuffer());
        return { head: text.slice(0, 5), hasImage: /\/Subtype\s*\/Image/.test(text) };
      },
      (await opened.jsonValue()) as string,
    );
    expect(pdf.head).toBe('%PDF-');
    // "08 Site photos" embeds the uploaded photo.
    expect(pdf.hasImage).toBe(true);

    await page
      .getByRole('navigation', { name: 'Main navigation' })
      .getByRole('link', { name: /^Overview/ })
      .click();
    await expect(page.getByTestId('kpi-reports-in')).toHaveText(/5\s*\/\s*6/);
  });

  test('mobile: the menu button opens the drawer navigation', async ({ page }) => {
    await page.setViewportSize({ width: 375, height: 812 });
    await signIn(page);
    await expect(page.getByRole('heading', { name: 'Today across 6 sites' })).toBeVisible();
    await page.getByRole('button', { name: 'Open menu' }).click();
    await page.getByRole('dialog').getByRole('link', { name: /Sites/ }).click();
    await expect(page.getByRole('heading', { name: 'Sites', exact: true })).toBeVisible();
  });
});

// §11.2 / F1 / §11.5: EN ⇄ TR from /login and from the account menu, keeping the route.
test.describe('language switch', () => {
  const HERO_REPORT = demoId('report:riverside:2026-10-09');

  test('on /login: Turkish and back keep the page, survive a reload and carry into the shell', async ({
    page,
  }) => {
    await page.goto('/login?as=pm');
    const english = page.getByRole('heading', { level: 1, name: 'Sign in to the office panel' });
    const turkish = page.getByRole('heading', { level: 1, name: 'Ofis paneline giriş yapın' });
    await expect(english).toBeVisible();
    await expect(page.locator('html')).toHaveAttribute('lang', 'en');

    await page
      .getByRole('group', { name: 'Language' })
      .getByRole('button', { name: 'Türkçe' })
      .click();
    await expect(turkish).toBeVisible();
    await expect(page.getByTestId('managers-note')).toHaveText(
      'Şantiye şefleri giriş yapmaz. Mesajdaki link ya da telefon aramasıyla rapor verirler.',
    );
    await expect(page).toHaveURL(/\/login\?as=pm$/);
    await expect(page.locator('html')).toHaveAttribute('lang', 'tr');

    await page.reload();
    await expect(turkish).toBeVisible();
    await page.getByRole('group', { name: 'Dil' }).getByRole('button', { name: 'English' }).click();
    await expect(english).toBeVisible();
    await expect(page).toHaveURL(/\/login\?as=pm$/);

    // Turkish again, then sign in: the shell speaks Turkish around the (English) page.
    await page
      .getByRole('group', { name: 'Language' })
      .getByRole('button', { name: 'Türkçe' })
      .click();
    await page.getByLabel('İş e-postası').fill('sam@kestrelbuild.example');
    await page.getByRole('button', { name: 'Bana giriş linki gönder' }).click();
    await expect(
      page.getByRole('heading', { level: 1, name: 'Today across 6 sites' }),
    ).toBeVisible();
    const nav = page.getByRole('navigation', { name: 'Ana gezinme' });
    await expect(nav.getByRole('link', { name: /^Genel bakış/ })).toBeVisible();
    await expect(page.getByText('Asistan hazır · mesaj ve arama')).toBeVisible();
    await expect(page.locator('main#main [lang="en"]').first()).toBeAttached();
  });

  test('from the account menu on a deep page: EN → TR → EN keeps the route', async ({ page }) => {
    await page.addInitScript(() => {
      window.localStorage.setItem('sitelog.demo.session', JSON.stringify({ key: 'admin' }));
    });
    const path = `/reports/${HERO_REPORT}`;
    await page.goto(path);
    const reportHeading = page.getByRole('heading', { name: 'Friday, Oct 9 — Riverside B' });
    await expect(reportHeading).toBeVisible();

    await page.getByRole('button', { name: 'Account menu' }).click();
    await page
      .getByRole('group', { name: 'Language' })
      .getByRole('menuitemradio', { name: 'Türkçe' })
      .click();
    await expect(page.getByRole('navigation', { name: 'Ana gezinme' })).toBeVisible();
    await expect(page).toHaveURL(new RegExp(`${path}$`));
    await expect(reportHeading).toBeVisible();
    await expect(page.locator('html')).toHaveAttribute('lang', 'tr');
    await expect(page.getByRole('combobox', { name: 'Arama' })).toBeVisible();

    await page.reload();
    await expect(page.getByRole('navigation', { name: 'Ana gezinme' })).toBeVisible();
    await page.getByRole('button', { name: 'Hesap menüsü' }).click();
    await page
      .getByRole('group', { name: 'Dil' })
      .getByRole('menuitemradio', { name: 'English' })
      .click();
    await expect(page.getByRole('navigation', { name: 'Main navigation' })).toBeVisible();
    await expect(page).toHaveURL(new RegExp(`${path}$`));
    await expect(reportHeading).toBeVisible();
    await expect(page.locator('html')).toHaveAttribute('lang', 'en');
  });
});
