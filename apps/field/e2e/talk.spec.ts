import { readdirSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { expect, test, type Page } from '@playwright/test';
import { UI_RESOURCES } from '@sitelog/shared/copy/ui/index.ts';
import { VOICE_CATALOGS } from '@sitelog/shared/copy/voice.ts';
import type { ReportView } from '@sitelog/shared/field-contract.ts';
import { expectFieldScreen } from './support/checks.ts';
import { demir, installFakeFieldApi, kestrel, type Market } from './support/fakeFieldApi.ts';

/**
 * W3-13 on the production build at 390 px, against the fake field-api and the app's scripted fake
 * VoiceClient (`src/voice/fake.ts`, chosen by the `fake:` URL the fake `voice/token` answers):
 * - in EN, ES and TR: Today offers Talk now (`talkNow`), the call screen asks for the microphone
 *   (Chromium's fake one), shows "Speaking with the SiteLog assistant", the recording notice as text,
 *   the timer, Mute and End call; the scripted call ends from the assistant's side and the Filed
 *   screen of the report it filed opens; axe, the 56 px targets and no sideways scroll on each;
 * - a hang-up (End call) opens the day's draft; three calls an hour, then the refusal;
 * - a photos link opens the photo-only screen (F9) and adds 2 photos as version 2;
 * - the bundle: `livekit-client` is in its own lazy chunk, never the main one (§16.2 M12).
 */

const CODE = 'K7Q2MX';
const CALL_REPORT = '6f1c2b9e-0d4a-4c1e-9b7a-3e2f1d0c9b8a';
const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==',
  'base64',
);

const RUNS = [
  { lang: 'en', locale: 'en-US', market: () => kestrel('en-US') },
  { lang: 'es', locale: 'es-US', market: () => kestrel('es-US') },
  { lang: 'tr', locale: 'tr-TR', market: demir },
] as const;

/** The report a call leaves, as `reports/:id` shows it. */
function callReport(market: Market, patch: Partial<ReportView> = {}): ReportView {
  return {
    id: CALL_REPORT,
    reportNo: 'RL-2041-0188',
    status: 'filed',
    kind: 'daily',
    siteId: market.site.id,
    siteName: market.site.name,
    date: market.date,
    channel: 'voice',
    currentVersion: 1,
    needsReview: false,
    filedAt: '2026-10-09T22:41:00.000Z',
    confirmedAt: '2026-10-09T22:40:00.000Z',
    question: null,
    data: {
      ...market.draft,
      manpower: market.draft.manpower.map((m) => ({ ...m, workers: m.workers ?? 4 })),
    },
    draftRev: 1,
    progress: { voiceNotes: 0, transcribed: 0, photos: 0 },
    pdfUrl: '/__storage/pdfs/RL-2041-0188_v1.pdf?token=e2e',
    addPhotos: { canAdd: true, remaining: 4, until: '2026-10-11T04:59:00.000Z', pending: 0 },
    changeNote: null,
    lastVoiceAnswer: null,
    correction: null,
    change: { canChange: true, locked: false },
    ...patch,
  };
}

async function openTalk(page: Page, lang: keyof typeof UI_RESOURCES) {
  const field = UI_RESOURCES[lang].field;
  await page.goto(`/r/${CODE}`);
  const talk = page.getByRole('button', { name: field.today.talkNow });
  await expect(talk).toBeVisible();
  await expectFieldScreen(page);
  await talk.click();
  return field;
}

for (const run of RUNS) {
  test.describe(`Talk now (W3-13) in ${run.lang}`, () => {
    test.use({ locale: run.locale });

    test('a scripted call to the Filed screen', async ({ page }) => {
      const market = run.market();
      const api = await installFakeFieldApi(page, market, {
        verified: true,
        consented: true,
        talkNow: 'fake:scripted?turns=8&turnMs=700&end=remote',
        talkReport: { id: CALL_REPORT, reportNo: 'RL-2041-0188', status: 'filed', kind: 'daily' },
        reports: { [CALL_REPORT]: callReport(market) },
      });
      const field = await openTalk(page, run.lang);

      // The call screen (its own lazy chunk): the assistant, the notice as text, a timer.
      await expect(
        page.getByRole('heading', { level: 1, name: field.talk.assistant }),
      ).toBeVisible();
      await expect(page.getByText(VOICE_CATALOGS[run.lang].recording_notice)).toBeVisible();
      await expect(page.getByRole('status').first()).toHaveText(
        new RegExp(`${field.talk.status.speaking}|${field.talk.status.listening}`),
      );
      await expect(page.getByRole('timer')).toHaveText(/^00:0[1-9]$/, { timeout: 10_000 });
      const end = page.getByRole('button', { name: field.talk.endCall });
      expect((await end.boundingBox())!.height, 'End call ≥ 56 px').toBeGreaterThanOrEqual(56);
      await expectFieldScreen(page);
      expect(api.talkCalls).toEqual([{ siteId: market.site.id, callId: expect.any(String) }]);

      // Mute says what it does next.
      await page.getByRole('button', { name: field.talk.mute }).click();
      await expect(page.getByRole('button', { name: field.talk.unmute })).toBeVisible();
      await expect(page.getByText(field.talk.status.muted)).toBeVisible();

      // The assistant ends the call after filing: the Filed screen of that report.
      await expect(page.getByRole('heading', { level: 1, name: field.filed.title })).toBeVisible({
        timeout: 15_000,
      });
      await expect(page).toHaveURL(new RegExp(`/report/${CALL_REPORT}$`));
      await expectFieldScreen(page);
    });
  });
}

test.describe('Talk now off the happy path (W3-13)', () => {
  test.use({ locale: 'en-US' });

  test('End call (a hang-up) opens the day’s draft', async ({ page }) => {
    const market = kestrel('en-US');
    const draft = callReport(market, {
      status: 'awaiting_confirmation',
      filedAt: null,
      confirmedAt: null,
      pdfUrl: null,
      addPhotos: null,
      change: null,
    });
    await installFakeFieldApi(page, market, {
      verified: true,
      consented: true,
      talkNow: 'fake:scripted?turns=2&turnMs=500&end=none',
      talkReport: {
        id: CALL_REPORT,
        reportNo: 'RL-2041-0188',
        status: 'awaiting_confirmation',
        kind: 'daily',
      },
      reports: { [CALL_REPORT]: draft },
    });
    const field = await openTalk(page, 'en');
    await expect(page.getByRole('timer')).toHaveText(/^00:0[1-9]$/, { timeout: 10_000 });
    await page.getByRole('button', { name: field.talk.endCall }).click();
    await expect(page).toHaveURL(new RegExp(`/report/${CALL_REPORT}$`));
    await expect(page.getByRole('heading', { level: 1, name: field.draft.title })).toBeVisible();
    await expect(page.getByRole('button', { name: field.draft.confirm })).toBeVisible();
  });

  test('a fourth call this hour is refused, with Record instead; 1440 px', async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    const market = kestrel('en-US');
    await installFakeFieldApi(page, market, {
      verified: true,
      consented: true,
      talkNow: 'fake:scripted',
      talkNowError: { status: 429, error: 'rate_limited', extra: { retryAfter: 1800 } },
    });
    const field = UI_RESOURCES.en.field;
    await page.goto(`/r/${CODE}`);
    await page.getByRole('button', { name: field.today.talkNow }).click();
    // §19 Q171: when the next call is possible (`retryAfter` 1800 s → 30 min).
    await expect(page.getByRole('alert')).toHaveText(
      field.talk.errors.rate_limited.replace('{{minutes}}', '30'),
    );
    await expect(page.getByRole('link', { name: field.talk.recordInstead })).toHaveAttribute(
      'href',
      '/record',
    );
    await expectFieldScreen(page);
  });

  test('a call-preferring reporter gets the large Talk now under Record (§9.3)', async ({
    page,
  }) => {
    const market = kestrel('en-US');
    market.reporter = { ...market.reporter, contactPref: 'call' };
    await installFakeFieldApi(page, market, {
      verified: true,
      consented: true,
      talkNow: 'fake:scripted',
    });
    const field = UI_RESOURCES.en.field;
    await page.goto(`/r/${CODE}`);
    const talk = page.getByRole('button', { name: field.today.talkNow });
    const add = page.getByRole('button', { name: field.today.addPhotos });
    const [t, a] = [(await talk.boundingBox())!, (await add.boundingBox())!];
    expect(t.height).toBeGreaterThan(a.height);
    expect(t.y).toBeLessThan(a.y);
    await expectFieldScreen(page);
  });
});

for (const run of RUNS) {
  test.describe(`a photos link (F9, W3-13) in ${run.lang}`, () => {
    test.use({ locale: run.locale });

    test('opens the photo-only screen and adds 2 photos as version 2', async ({ page }) => {
      const field = UI_RESOURCES[run.lang].field;
      const market = run.market();
      const api = await installFakeFieldApi(page, market, {
        verified: true,
        consented: true,
        dailyLinkSite: market.site.id,
        photosLink: true,
        talkNow: 'fake:scripted',
        reports: { [CALL_REPORT]: callReport(market) },
      });
      api.state.report = {
        id: CALL_REPORT,
        reportNo: 'RL-2041-0188',
        status: 'filed',
        kind: 'daily',
      };
      api.state.dayStatus = 'filed';
      await page.goto(`/r/${CODE}`);
      await expect(page).toHaveURL(/\/photos$/);
      await expect(
        page.getByRole('heading', { level: 1, name: field.photosLink.title }),
      ).toBeVisible();
      const pick = page.getByRole('button', { name: field.photosLink.pick });
      await expect(pick).toBeVisible();
      // Photos only: no Record, no Talk now.
      await expect(page.getByRole('link', { name: field.today.record })).toHaveCount(0);
      await expect(page.getByRole('button', { name: field.today.talkNow })).toHaveCount(0);
      await expectFieldScreen(page);

      await page.locator('input[type="file"]').setInputFiles([
        { name: 'conditions-a.png', mimeType: 'image/png', buffer: PNG },
        { name: 'conditions-b.png', mimeType: 'image/png', buffer: PNG },
      ]);
      const dialog = page.getByRole('dialog');
      await expect(dialog).toContainText(field.filed.photos.chosen.replace('{{count}}', '2'));
      await expectFieldScreen(page);
      await dialog.getByRole('button', { name: field.filed.photos.send }).click();
      await expect(
        page.getByRole('status').filter({
          hasText: field.filed.photos.added.replace('{{version}}', '2'),
        }),
      ).toBeVisible();
      const sent = api.calls
        .filter((c) => c.path === 'uploads')
        .map(
          (c) => (c.body as { addTo: { batchId: string; photos: number; reportId: string } }).addTo,
        );
      expect(sent).toHaveLength(2);
      expect(new Set(sent.map((a) => a.batchId)).size).toBe(1);
      expect(sent[0]).toMatchObject({ reportId: CALL_REPORT, photos: 2 });
      expect(Object.values(api.batches)[0]!.version).toBe(2);
      expect(api.talkCalls).toHaveLength(0);
      await expectFieldScreen(page);
    });
  });
}

test('the bundle: livekit-client is a lazy chunk, never in the main one (§16.2 M12)', async ({
  page,
}) => {
  await page.goto('/expired');
  const html = await (await page.request.get('/')).text();
  const entry = /<script[^>]+type="module"[^>]+src="\/assets\/([^"]+\.js)"/.exec(html)?.[1];
  expect(entry, 'the entry chunk in index.html').toBeTruthy();
  // The build `playwright.config.ts` serves (E2E_DIST).
  const assets = resolve(import.meta.dirname, '../node_modules/.e2e/field/assets');
  const js = readdirSync(assets).filter((f) => f.endsWith('.js'));
  // A string only livekit-client's code holds (RoomEvent.ActiveSpeakersChanged).
  const marker = 'activeSpeakersChanged';
  const holders = js.filter((f) => readFileSync(resolve(assets, f), 'utf8').includes(marker));
  expect(holders.length, 'livekit-client is built').toBe(1);
  expect(holders[0]).not.toBe(entry);
  expect(readFileSync(resolve(assets, entry!), 'utf8')).not.toContain(marker);
  // The call screen is its own chunk too, so Today loads neither.
  expect(js.some((f) => /^Talk-/.test(f))).toBe(true);
});
