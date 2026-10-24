import AxeBuilder from '@axe-core/playwright';
import { expect, test, type Page } from '@playwright/test';

/**
 * W4-03 · Team on v1.2 (spec P10, F3, F15, F16, F24) in demo mode (Kestrel): the P10 columns and
 * statuses in English and Turkish at 1440 and 390 px with axe WCAG 2.2 AA and no sideways scroll;
 * an ops user moves Marco to WhatsApp with the attestation; Revoke devices; Text today's link to
 * Priya lands in the Demo phone; an office user invited with Turkish as their panel language.
 * W4-04: Call now at 1440 and 390 px (the attestation sheet with axe, the row's progress, the call
 * in Priya's Demo phone thread).
 * Demir Yapı in Turkish is the page test's (src/app/team/Page.test.tsx); the demo signs in to
 * Kestrel only.
 */

const WCAG_22_AA = ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22a', 'wcag22aa'];

async function signInFast(page: Page, lang: 'en' | 'tr', key: 'admin' | 'ops' = 'admin') {
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
    title: 'Team & numbers',
    table: 'Field reporters',
    active: 'Active',
    invite: 'Invite reporter',
    menu: 'Menu for Marco Ruiz',
    edit: 'Edit',
    invited: 'Invite sent',
  },
  tr: {
    title: 'Ekip ve numaralar',
    table: 'Saha raporcuları',
    active: 'Aktif',
    invite: 'Raporcu davet et',
    menu: 'Marco Ruiz için menü',
    edit: 'Düzenle',
    invited: 'Davet gönderildi',
  },
} as const;

for (const lang of ['en', 'tr'] as const) {
  for (const width of [1440, 390] as const) {
    test(`Team & numbers at ${width}px (${lang})`, async ({ page }) => {
      const c = COPY[lang];
      await page.setViewportSize({ width, height: width === 390 ? 844 : 900 });
      await signInFast(page, lang);
      await page.goto('/team');
      await expect(page.getByRole('heading', { name: c.title, level: 1 })).toBeVisible({
        timeout: 20_000,
      });
      const table = page.getByRole('table', { name: c.table });
      await expect(table.getByText(c.active).first()).toBeVisible();
      await expect(table.getByText(c.invited).first()).toBeVisible();
      await expect(page.locator('html')).toHaveAttribute('lang', lang);
      expect(await overflow(page), '/team').toBeLessThanOrEqual(0);
      await expectNoViolations(page);

      await page.getByRole('button', { name: c.invite }).first().click();
      await expect(page.getByRole('dialog')).toBeVisible();
      await expectNoViolations(page);
      await page.keyboard.press('Escape');

      await table.getByRole('button', { name: c.menu }).click();
      await page.getByRole('menuitem', { name: c.edit }).click();
      await expect(page.getByRole('dialog')).toBeVisible();
      expect(await overflow(page), '/team edit').toBeLessThanOrEqual(0);
      await expectNoViolations(page);
    });
  }
}

test('an ops user moves Marco to WhatsApp with the attestation', async ({ page }) => {
  await signInFast(page, 'en', 'ops');
  await page.goto('/team');
  const table = page.getByRole('table', { name: 'Field reporters' });
  await table.getByRole('button', { name: 'Menu for Marco Ruiz' }).click();
  await page.getByRole('menuitem', { name: 'Edit' }).click();
  const dialog = page.getByRole('dialog', { name: 'Edit Marco Ruiz' });
  await dialog.getByRole('combobox', { name: 'Messages go by' }).click();
  await page.getByRole('option', { name: 'WhatsApp', exact: true }).click();
  await dialog.getByRole('checkbox', { name: 'Marco asked for this change' }).click();
  await expectNoViolations(page);
  await dialog.getByRole('button', { name: 'Save changes' }).click();
  await expect(dialog).toHaveCount(0);
  const marco = table.getByRole('row').filter({ hasText: 'Marco Ruiz' });
  await expect(marco.getByTestId('contact-pref')).toHaveText('Text link · WhatsApp');
  await expect(marco).toContainText('WhatsApp not agreed yet');
});

test('revoke devices, text Priya today’s link (the Demo phone shows it), add an office user in Turkish', async ({
  page,
}) => {
  await signInFast(page, 'en');
  await page.goto('/team');
  const table = page.getByRole('table', { name: 'Field reporters' });
  const marco = table.getByRole('row').filter({ hasText: 'Marco Ruiz' });
  await expect(marco).toContainText('1 phone signed in');
  await marco.getByRole('button', { name: 'Menu for Marco Ruiz' }).click();
  await page.getByRole('menuitem', { name: 'Revoke devices' }).click();
  const revoke = page.getByRole('dialog', { name: 'Revoke devices for Marco Ruiz?' });
  await expect(revoke).toContainText('Signed in now: 1 phone.');
  await revoke.getByRole('button', { name: 'Revoke devices' }).click();
  await expect(revoke).toHaveCount(0);
  await expect(marco).not.toContainText('phone signed in');

  await table.getByRole('button', { name: 'Menu for Priya Raman' }).click();
  await page
    .getByRole('menuitem', { name: /^Text today’s link/ })
    .first()
    .click();
  await expect(page.getByText('Today’s link texted to Priya.')).toBeVisible();

  await page.getByRole('button', { name: 'Add office user' }).click();
  const add = page.getByRole('dialog', { name: 'Add office user' });
  await add.getByRole('textbox', { name: 'Email' }).fill('dana@kestrelbuild.example');
  await add.getByRole('radio', { name: 'Turkish' }).click();
  await add.getByRole('button', { name: 'Send invite' }).click();
  await expect(add).toHaveCount(0);
  await expect(page.getByTestId('office-users')).toContainText('Panel in Turkish');

  // In-app navigation keeps the demo's memory: the Demo phone has Priya's text.
  await page
    .getByRole('link', { name: /Demo phone/ })
    .first()
    .click();
  // Her newest text (the list's last line) is the daily link the office just sent.
  await expect(page.getByRole('button', { name: /Priya Raman/ })).toContainText(
    "Today's report for Elm St. Townhomes",
  );
});

for (const width of [1440, 390] as const) {
  test(`Call now (W4-04, F3): Lena attests and calls Priya at ${width}px; the Demo phone rings`, async ({
    page,
  }) => {
    await page.setViewportSize({ width, height: width === 390 ? 844 : 900 });
    await signInFast(page, 'en');
    await page.goto('/team');
    const table = page.getByRole('table', { name: 'Field reporters' });
    await table.getByRole('button', { name: 'Menu for Priya Raman' }).click();
    await page.getByRole('menuitem', { name: 'Call now' }).click();
    const dialog = page.getByRole('dialog', { name: 'Call Priya Raman now?' });
    await expect(dialog).toContainText('If Priya doesn’t answer, TalkOlog sends no text.');
    const confirm = dialog.getByRole('button', { name: 'Call now' });
    await expect(confirm).toBeDisabled();
    expect(await overflow(page), '/team call now').toBeLessThanOrEqual(0);
    await expectNoViolations(page);
    // The attestation (§19 Q230) is the only way to the button; 44 px targets.
    await dialog
      .getByRole('checkbox', {
        name: 'Priya agreed to get calls from TalkOlog for the daily report',
      })
      .click();
    const size = await confirm.boundingBox();
    expect(size!.height).toBeGreaterThanOrEqual(44);
    await confirm.click();
    await expect(dialog).toHaveCount(0);
    const priya = table.getByRole('row').filter({ hasText: 'Priya Raman' });
    await expect(priya.getByTestId('call-today')).toHaveText('Office call · Ringing · 19:05');
    await expectNoViolations(page);

    // In-app navigation keeps the demo's memory (at 390 px the sidebar is a menu, so the router
    // is moved directly): the call rings in Priya's Demo phone thread.
    await page.evaluate(() => {
      window.history.pushState({}, '', '/dev/phone');
      window.dispatchEvent(new PopStateEvent('popstate'));
    });
    await expect(page.getByRole('heading', { name: 'Demo phone', level: 1 })).toBeVisible();
    const priyaPhone = page.getByRole('button', { name: /Priya Raman/ });
    await expect(priyaPhone).toBeVisible();
    // The page settles its queries first; select her thread once it holds.
    await expect(async () => {
      await priyaPhone.click();
      await expect(page.getByTestId('demo-phone-call').last()).toContainText(
        'Call from the office',
        { timeout: 2_000 },
      );
    }).toPass({ timeout: 20_000 });
  });
}
