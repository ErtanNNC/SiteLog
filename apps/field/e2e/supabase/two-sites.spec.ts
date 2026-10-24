import { expect, test } from '@playwright/test';
import { UI_RESOURCES } from '@sitelog/shared/copy/ui/index.ts';
import { formatDateInTz, formatTimeInTz } from '@sitelog/shared/format.ts';
import { linkCodeHash, LINK_CODE_ALPHABET } from '@sitelog/shared/links.ts';
import { expectFieldScreen } from '../support/checks.ts';
import { pickSite, siteSwitcher } from './sites.ts';
import {
  addSite,
  createFieldFixture,
  dropFieldFixture,
  everyDayWorking,
  FIELD_E2E_URL,
  rest,
  verifiedDevice,
  type FieldFixture,
} from './stack.ts';

/**
 * W2-17 (M6 acceptance, F14, tagged `@m6 @F14`; W1-09 and W2-03 built it) against the local
 * Supabase stack (the `stack` project, no worker needed): a reporter of two sites on a verified
 * phone opens the personal link → Today shows the site whose deadline today is nearest now
 * (field-api's `nearestDeadlineSite`: the first site's deadline is set to the current minute in
 * Chicago, the second's six hours away) → the switcher → the second site → a clip recorded there
 * goes to that site's report (`FE-2-0001`) → that site's daily link opens it with no switcher (a
 * daily link names one site).
 */
test.describe.configure({ mode: 'serial' });

const copy = UI_RESOURCES.en.field;
const TZ = 'America/Chicago';
let f: FieldFixture | undefined;
let pier: { id: string; name: string; projectCode: string } | undefined;

test.beforeAll(async () => {
  f = await createFieldFixture();
  await everyDayWorking(f);
  const now = Date.now();
  await rest('PATCH', `sites?id=eq.${f.site.id}`, { deadline: formatTimeInTz(new Date(now), TZ) });
  pier = await addSite(f, {
    name: 'Pier 9 Warehouse Retrofit',
    projectCode: 'FE-2',
    deadline: formatTimeInTz(new Date(now + 6 * 3_600_000), TZ),
  });
});

test.afterAll(async () => {
  await dropFieldFixture(f);
});

test(
  'nearest deadline first, the switcher, a clip on the other site, its daily link',
  { tag: ['@m6', '@F14'] },
  async ({ page, context }) => {
    const fx = f!;
    const other = pier!;
    const cookie = await verifiedDevice(fx);
    await context.addCookies([
      {
        name: cookie.name,
        value: cookie.value,
        url: FIELD_E2E_URL,
        httpOnly: true,
        sameSite: 'Lax',
      },
    ]);
    await page.goto(`/r/${fx.code}`);
    await expect(page).toHaveURL(/\/today$/);
    await expect(page.getByRole('heading', { name: copy.today.promptsTitle })).toBeVisible();
    await expect(siteSwitcher(page, fx.site.name)).toBeVisible();
    await expectFieldScreen(page);

    // The switcher lists both; the other site's Today.
    await siteSwitcher(page).click();
    const sheet = page.getByRole('dialog', { name: copy.today.siteSheetTitle });
    await expect(sheet.getByRole('button', { name: fx.site.name, exact: true })).toBeVisible();
    await expect(sheet.getByRole('button', { name: other.name, exact: true })).toBeVisible();
    await expectFieldScreen(page);
    await sheet.getByRole('button', { name: other.name, exact: true }).click();
    await expect(siteSwitcher(page, other.name)).toBeVisible();
    await expect(page.getByRole('heading', { name: copy.today.promptsTitle })).toBeVisible();
    await expect(page.getByText(copy.today.status.notSent)).toBeVisible();

    // A clip recorded here is the other site's report.
    await page.getByRole('link', { name: copy.today.record }).click();
    await expect(page.getByRole('button', { name: copy.recording.pause })).toBeEnabled();
    await expect(page.getByRole('timer')).toHaveText(/^00:0[5-9]$/, { timeout: 15_000 });
    await page.getByRole('button', { name: copy.recording.stopSend }).click();
    await expect(page).toHaveURL(/\/report\/[0-9a-f-]{36}$/, { timeout: 30_000 });
    const reportId = /\/report\/([0-9a-f-]{36})$/.exec(page.url())![1]!;
    const [report] = await rest<{ site_id: string; report_no: string }[]>(
      'GET',
      `reports?select=site_id,report_no&id=eq.${reportId}`,
    );
    expect(report).toEqual({ site_id: other.id, report_no: `${other.projectCode}-0001` });
    expect(await rest('GET', `reports?select=id&site_id=eq.${fx.site.id}`)).toEqual([]);

    // Back on Today: the first site is still waiting, the other has its report.
    await page.goto('/today');
    await pickSite(page, fx.site.name);
    await expect(page.getByText(copy.today.status.notSent)).toBeVisible();
    await pickSite(page, other.name);
    await expect(
      page.getByRole('link', {
        name: copy.today.openReport.replace('{{no}}', `${other.projectCode}-0001`),
      }),
    ).toBeVisible();

    // The first site's daily link opens that site only: no switcher.
    const code = Array.from(crypto.getRandomValues(new Uint8Array(8)), (b) =>
      LINK_CODE_ALPHABET.charAt(b % LINK_CODE_ALPHABET.length),
    ).join('');
    await rest('POST', 'field_links', {
      code_hash: linkCodeHash(code),
      reporter_id: fx.reporter.id,
      site_id: fx.site.id,
      kind: 'daily',
      report_date: formatDateInTz(new Date(), TZ),
      expires_at: new Date(Date.now() + 24 * 3_600_000).toISOString(),
    });
    await page.goto(`/r/${code}`);
    await expect(page).toHaveURL(/\/today$/);
    await expect(page.getByRole('heading', { name: copy.today.promptsTitle })).toBeVisible();
    await expect(page.getByRole('banner')).toContainText(fx.site.name);
    await expect(siteSwitcher(page)).toHaveCount(0);
  },
);
