import { expect, test, type Page } from '@playwright/test';
import { demoId } from '@sitelog/shared/demo/ids.ts';
import { admin, pinSeedClock, SEED, signInWithMagicLink } from './support';
import { expectTurkishPage, tr } from './turkish';

/**
 * W4-16 · the panel in Turkish on the stack (spec §16.2 M11 "Panel TR strings", §17 "E2E panel …
 * TR locale", §11.2, §19 Q240; W4-09 Done when: "Elif Aydın sees every Demir Yapı page in
 * Turkish (no English page but `/ops` and `/try`)"). Elif, the §18.2 admin with no panel language
 * of her own (the org's tr-TR decides it), opens every page of the shell her role reaches, each
 * checked by `expectTurkishPage`: `<html lang="tr">`, no `<EnglishOnly>` wrapper and no text
 * block that is an English string of the panel's catalogue (`turkish.ts`). `/ops` (staff only)
 * and `/try` (v1.0's WhatsApp simulator) stay English by Q240 and are not visited.
 *
 * Report review needs a Demir Yapı report, and the §18.2 seed has none: Elif types one on New
 * report (P6's typed report, filed at once, its PDF rendered in the browser) for Ataşehir on Thu
 * Oct 8, the day before the pinned seed day, so the Overview's "today" is untouched; a re-run on
 * the same stack finds it and opens it from New report's notice. Field channels shows the TR pack
 * read-only in Turkish (W4-05 Done when: one-way SMS, "Talk now only"). No worker is needed.
 */
test.describe.configure({ mode: 'serial' });

const KARTAL = demoId('demir:site:kartal');
const ATASEHIR = demoId('demir:site:atasehir');
const DEMIR_ORG = demoId('org:demir');
const TYPED_DATE = '2026-10-08';

let reportId = '';

async function openTurkish(page: Page, path: string) {
  await page.goto(path);
  await expect(page.getByRole('heading', { level: 1 }).first(), path).toBeVisible({
    timeout: 30_000,
  });
  // "{thing} yüklenemedi." is the Turkish "Couldn't load {thing}."
  await expect(page.getByText(/yüklenemedi\.$/), path).toHaveCount(0);
  await expectTurkishPage(page, path);
}

test(
  'Elif files a typed report on New report in Turkish and reviews it',
  { tag: ['@m11', '@F18'] },
  async ({ page }) => {
    await pinSeedClock(page);
    await signInWithMagicLink(page, SEED.demirAdmin.email);
    await page.goto(`/reports/new?site=${ATASEHIR}&date=${TYPED_DATE}`);
    await expect(
      page.getByRole('heading', { level: 1, name: tr('newReport.title') }),
    ).toBeVisible();
    await expectTurkishPage(page, '/reports/new');
    const editor = page.getByTestId('report-editor');
    await editor
      .getByRole('textbox')
      .first()
      .fill('3. kat döşeme kalıbı tamamlandı; Volt Elektrik 2. katta kablo çekti.');
    await page.getByTestId('file-report').click();

    // Filed now, or (a re-run on this stack) already filed for that day: open it from the notice.
    const exists = page.getByTestId('day-has-report');
    await expect
      .poll(
        async () =>
          /\/reports\/[0-9a-f-]{36}$/.test(new URL(page.url()).pathname) ||
          (await exists.isVisible()),
        { timeout: 60_000 },
      )
      .toBe(true);
    if (await exists.isVisible()) await exists.getByRole('link').first().click();
    await page.waitForURL(/\/reports\/[0-9a-f-]{36}$/, { timeout: 30_000 });
    reportId = new URL(page.url()).pathname.split('/').at(-1)!;

    const { data: report } = await admin()
      .from('reports')
      .select('org_id, site_id, report_no, language, channel, status')
      .eq('id', reportId)
      .single()
      .throwOnError();
    expect(report).toMatchObject({
      org_id: DEMIR_ORG,
      site_id: ATASEHIR,
      language: 'tr',
      channel: 'office',
    });
    await expect(
      page.getByText(tr('report.eyebrow', { no: report!.report_no as string })),
    ).toBeVisible();
    await expectTurkishPage(page, `/reports/${reportId}`);
  },
);

test(
  'Elif sees every Demir Yapı page in Turkish (no English but /ops and /try)',
  { tag: ['@m11', '@F17'] },
  async ({ page }) => {
    test.setTimeout(240_000);
    await pinSeedClock(page);
    await signInWithMagicLink(page, SEED.demirAdmin.email);
    const pages = [
      '/',
      '/sites',
      `/sites/${KARTAL}`,
      '/reports',
      ...(reportId ? [`/reports/${reportId}`] : []),
      '/hours',
      '/weather',
      '/team',
      '/glossary',
      '/settings/reports',
      '/settings/channels',
      '/settings/pdf',
      '/settings/recipients',
      '/settings/payroll',
      '/billing',
      '/dev/phone',
    ];
    for (const path of pages) await openTurkish(page, path);

    // The not-found page of the shell.
    await page.goto('/no-such-page');
    await expect(page.getByText(tr('states.notFoundTitle'))).toBeVisible({ timeout: 30_000 });
    await expectTurkishPage(page, '/no-such-page');

    // Field channels: the TR pack, read-only, one-way, Talk now only (W4-05 Done when).
    await page.goto('/settings/channels');
    const pack = page.getByTestId('pack-card');
    await expect(pack).toContainText(tr('settings.channels.twoWayNo'));
    await expect(pack).toContainText(tr('settings.channels.talkNowOnly'));

    // The setup wizard of an org that exists: its company step, locked, in Turkish.
    await page.goto('/setup');
    await expect(page.getByRole('heading').first()).toBeVisible({ timeout: 30_000 });
    await expectTurkishPage(page, '/setup');
  },
);
