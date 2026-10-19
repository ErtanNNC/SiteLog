import { expect, test } from '@playwright/test';
import { LEGAL_DOCS, recordingNoticeFor } from '@sitelog/shared/copy/legal/index.ts';
import { UI_RESOURCES } from '@sitelog/shared/copy/ui/index.ts';
import { VOICE_CATALOGS } from '@sitelog/shared/copy/voice.ts';
import { expectFieldScreen, expectNoSidewaysScroll } from './support/checks.ts';
import { demir, installFakeFieldApi, kestrel, type Market } from './support/fakeFieldApi.ts';

/**
 * W4-06 (spec §9.1, §15.2, §19 Q28, Q50) on the production build at 390 px, against the fake
 * field-api, with axe, the 56 px targets and no sideways scroll on each screen:
 * - a TR test pack naming the three test-only keys (`ZZ.*`): the Welcome screen links the privacy
 *   notice to `/legal/<key>`, the page shows it in Turkish with its version, Back returns to the
 *   Welcome, and the consent stores the pack's consent key; Talk now shows the keyed recording
 *   notice; the launch pack (`legal_keys {}`) shows no link and the voice copy's own notice;
 * - `/legal/<key>` opened on its own in EN, ES and TR (and at 1440 px), an unknown key;
 * - offline after the first load: the page comes from the precached shell.
 */

const CODE = 'K7Q2MX';
const PRIVACY = LEGAL_DOCS['ZZ.privacy_notice.v1']!;

/** Demir Yapı with a test pack that names every legal key (no real pack can: placeholders). */
function keyedDemir(): Market {
  const market = demir();
  market.country = {
    ...market.country,
    legalKeys: {
      privacyNotice: 'ZZ.privacy_notice.v1',
      recordingNotice: 'ZZ.recording_notice.v1',
      consent: 'ZZ.consent.v1',
    },
  };
  return market;
}

test.describe('the pack’s legal texts in TR (a keyed test pack)', () => {
  test.use({ locale: 'tr-TR' });

  test('Welcome links the notice; the page; Back; the consent stores its key', async ({ page }) => {
    const field = UI_RESOURCES.tr.field;
    const api = await installFakeFieldApi(page, keyedDemir(), { verified: true });
    await page.goto(`/r/${CODE}`);
    const link = page.getByRole('link', { name: field.welcome.privacy });
    await expect(link).toHaveAttribute('href', '/legal/ZZ.privacy_notice.v1');
    await expectFieldScreen(page);
    await link.click();

    const tr = PRIVACY.texts.tr!;
    const title = page.getByRole('heading', { level: 1, name: tr.title });
    await expect(title).toBeVisible();
    await expect(title).toBeFocused();
    await expect(page).toHaveURL(/\/legal\/ZZ\.privacy_notice\.v1$/);
    await expect(page.getByText(tr.body[0]!)).toBeVisible();
    await expect(page.getByText(/^Sürüm 1 · /)).toBeVisible();
    await expect(page.locator('html')).toHaveAttribute('lang', 'tr');
    await expectFieldScreen(page);

    await page.getByRole('button', { name: field.legal.back }).click();
    await page.getByRole('checkbox', { name: field.welcome.consentRequired }).check();
    await page.getByRole('button', { name: field.welcome.continue }).click();
    await expect(
      page.getByRole('heading', { level: 1, name: field.welcomeTest.title }),
    ).toBeVisible();
    expect(api.consent).toMatchObject({ textVersion: 'ZZ.consent.v1', locale: 'tr-TR' });
  });

  test('Talk now shows the pack’s recording notice', async ({ page }) => {
    await installFakeFieldApi(page, keyedDemir(), {
      verified: true,
      consented: true,
      talkNow: 'fake:scripted?turns=2&turnMs=500&end=none',
    });
    await page.goto(`/r/${CODE}`);
    await page.getByRole('button', { name: UI_RESOURCES.tr.field.today.talkNow }).click();
    const keyed = recordingNoticeFor('ZZ.recording_notice.v1', 'tr');
    await expect(page.getByText(keyed.text)).toBeVisible();
    await expect(page.getByText(VOICE_CATALOGS.tr.recording_notice)).toHaveCount(0);
    await expectFieldScreen(page);
  });

  test('the launch pack names no key: no link, the voice copy’s notice', async ({ page }) => {
    await installFakeFieldApi(page, demir(), { verified: true });
    await page.goto(`/r/${CODE}`);
    await expect(
      page.getByRole('checkbox', { name: UI_RESOURCES.tr.field.welcome.consentRequired }),
    ).toBeVisible();
    await expect(
      page.getByRole('link', { name: UI_RESOURCES.tr.field.welcome.privacy }),
    ).toHaveCount(0);
  });
});

const RUNS = [
  { lang: 'en', locale: 'en-US', market: () => kestrel('en-US') },
  { lang: 'es', locale: 'es-US', market: () => kestrel('es-US') },
  { lang: 'tr', locale: 'tr-TR', market: demir },
] as const;

for (const run of RUNS) {
  test.describe(`/legal/:key on its own in ${run.lang}`, () => {
    test.use({ locale: run.locale });

    test('renders at 390 and 1440 px; Back goes to Today', async ({ page }) => {
      const field = UI_RESOURCES[run.lang].field;
      await page.goto('/legal/ZZ.privacy_notice.v1');
      const text = PRIVACY.texts[run.lang]!;
      await expect(page.getByRole('heading', { level: 1, name: text.title })).toBeVisible();
      await expect(page).toHaveTitle(`${text.title} · TalkOlog`);
      await expectFieldScreen(page);
      await page.setViewportSize({ width: 1440, height: 900 });
      await expectNoSidewaysScroll(page);
      await page.getByRole('button', { name: field.legal.back }).click();
      await expect(page).toHaveURL(/\/today$/);
    });

    test('an unknown key says so', async ({ page }) => {
      const field = UI_RESOURCES[run.lang].field;
      await page.goto('/legal/US.privacy_notice.v9');
      await expect(
        page.getByRole('heading', { level: 1, name: field.legal.unknown.title }),
      ).toBeVisible();
      await expectFieldScreen(page);
    });
  });
}

test.describe('offline', () => {
  test.use({ locale: 'en-US' });

  test('the page is readable offline after the first load (precached shell)', async ({
    page,
    context,
  }) => {
    await page.goto('/today');
    await page.waitForFunction(async () => {
      await navigator.serviceWorker.ready;
      return !!navigator.serviceWorker.controller;
    });
    await context.setOffline(true);
    await page.goto('/legal/ZZ.privacy_notice.v1');
    await expect(
      page.getByRole('heading', { level: 1, name: PRIVACY.texts.en!.title }),
    ).toBeVisible();
    await expect(page.getByText(PRIVACY.texts.en!.body[0]!)).toBeVisible();
    await context.setOffline(false);
  });
});
