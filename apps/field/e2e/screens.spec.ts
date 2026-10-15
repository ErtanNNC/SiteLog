import { expect, test, type Page } from '@playwright/test';
import { UI_RESOURCES } from '@sitelog/shared/copy/ui/index.ts';
import { expectFieldScreen, expectNoAxeViolations } from './support/checks.ts';
import {
  demir,
  installFakeFieldApi,
  kestrel,
  OTP,
  QUESTION_ID,
  REPORT_ID,
  REPORT_NO,
  type Market,
} from './support/fakeFieldApi.ts';

/**
 * W1-09 and W1-13 screens on the production build at 390 px, against a fake field-api (Playwright
 * routes; `support/fakeFieldApi.ts`) and Chromium's fake microphone, with axe, the 56 px targets
 * and no sideways scroll (`expectFieldScreen`) on each screen:
 * - in EN, ES and TR: the first open (device check, welcome and consent) → Today → Recording →
 *   upload → Processing → the question → the draft → Confirm & send → filed (W1-13), focus on
 *   each new screen's heading; the microphone refused, no MediaRecorder, the microphone failing, a
 *   clip too short; a clip field-api refuses, Today's "Not sent" list; Today failing to load; the
 *   link errors (not found, expired, revoked, paused, failed); the site switcher;
 * - in EN: a question without answers to tap (D28) at 390 and 1440 px; the offline queue through
 *   a reload, sent in the background with Today updating by itself; the No work and Weather sheets.
 * The same flow against the real field-api is `e2e/supabase/`.
 */

const CODE = 'K7Q2MX';

const RUNS = [
  {
    lang: 'en',
    locale: 'en-US',
    market: () => kestrel('en-US'),
    date: 'FRI, OCT 9',
    due: 'DUE 17:30',
  },
  {
    lang: 'es',
    locale: 'es-US',
    market: () => kestrel('es-US'),
    date: 'VIE, 9 OCT',
    due: 'VENCE 17:30',
  },
  { lang: 'tr', locale: 'tr-TR', market: demir, date: 'CUMA, 9 EKİM', due: 'SON SAAT 17:30' },
] as const;

/** Records a little over 5 s (shorter clips are refused, F5) and sends it. */
async function recordAndSend(page: Page, lang: keyof typeof UI_RESOURCES) {
  const copy = UI_RESOURCES[lang].field.recording;
  const timer = page.getByRole('timer');
  await expect(page.getByRole('button', { name: copy.pause })).toBeEnabled();
  await expect(timer).toHaveText(/^00:0[5-9]$/, { timeout: 15_000 });
  return copy;
}

for (const run of RUNS) {
  test.describe(`first open → Today → Recording → Processing in ${run.lang}`, () => {
    test.use({ locale: run.locale });

    test('runs end to end', async ({ page }) => {
      const field = UI_RESOURCES[run.lang].field;
      const market: Market = run.market();
      const api = await installFakeFieldApi(page, market);

      // F4 step 2: the device check, in the reporter's language once the link is resolved.
      await page.goto(`/r/${CODE.toLowerCase()}`);
      await expect(
        page.getByRole('heading', {
          level: 1,
          name: field.device.title.replace('{{name}}', market.reporter.name),
        }),
      ).toBeVisible();
      await expect(page.locator('html')).toHaveAttribute('lang', run.lang);
      await expectFieldScreen(page);
      await page.getByRole('button', { name: field.device.send }).click();
      const input = page.getByLabel(field.device.codeLabel);
      await expect(input).toHaveAttribute('autocomplete', 'one-time-code');
      await expect(input).toHaveAttribute('inputmode', 'numeric');
      await expectFieldScreen(page);
      // Auto-fill (or the sixth digit) submits without another tap.
      await input.fill(OTP);

      // F4 step 3 (Field-02): the welcome and consent, first open only. The code field is gone:
      // focus is on the new screen's heading.
      const welcome = page.getByRole('heading', {
        level: 1,
        name: field.welcome.title.replace('{{name}}', market.reporter.firstName),
      });
      await expect(welcome).toBeVisible();
      await expect(welcome).toBeFocused();
      await expectFieldScreen(page);
      await page.getByRole('checkbox', { name: field.welcome.consentRequired }).check();
      await page.getByRole('button', { name: field.welcome.continue }).click();

      // Today (Field-03 / Field-10).
      await expect(page).toHaveURL(/\/today$/);
      await expect(page.getByRole('banner')).toContainText(market.site.name);
      await expect(page.locator('time')).toHaveText(run.date);
      await expect(page.getByText(run.due)).toBeVisible();
      await expect(page.getByText(field.today.status.notSent)).toBeVisible();
      await expect(
        page.getByRole('heading', { level: 2, name: field.today.promptsTitle }),
      ).toBeVisible();
      await expect(page.getByText(field.today.tapToRecord)).toBeVisible();
      // No voice number in week 1, and Talk now is off (VITE_FEATURE_TALK_NOW).
      await expect(page.locator('a[href^="tel:"]')).toHaveCount(0);
      await expect(page.getByText(field.today.talkNow)).toHaveCount(0);
      const record = page.getByRole('link', { name: field.today.record });
      const box = await record.boundingBox();
      expect(box!.height, 'Record ≥ 120 px (§14.6)').toBeGreaterThanOrEqual(120);
      await expectFieldScreen(page);

      // Recording (Field-04): the fake microphone, the timer, then Stop & send.
      await record.click();
      await expect(page).toHaveURL(/\/record$/);
      const copy = await recordAndSend(page, run.lang);
      await expectFieldScreen(page);
      await page.getByRole('button', { name: copy.stopSend }).click();

      // Processing (F5 step 4): polls the report (every 2 s at first) until the draft is there.
      await expect(page).toHaveURL(new RegExp(`/report/${REPORT_ID}$`));
      await expect(
        page.getByRole('heading', { level: 1, name: field.processing.title }),
      ).toBeVisible();
      await expect(page.getByRole('heading', { level: 1 })).toBeFocused();
      await expectFieldScreen(page);

      // The question (F7, Field-05; W1-13): one per screen, two answers, no Other… until M6.
      const question = page.getByRole('heading', { level: 1, name: market.question.prompt });
      await expect(question).toBeVisible({ timeout: 10_000 });
      await expect(question).toBeFocused();
      await expect(page.getByText(field.question.badge, { exact: true })).toBeVisible();
      const answers = page.getByRole('main').getByRole('button');
      await expect(answers).toHaveText([...market.question.options]);
      await expectFieldScreen(page);
      await page.getByRole('button', { name: market.question.options[1] }).click();

      // F7's confirmation line, then the draft (F8, Field-06) once decide_next has run.
      const asked = market.draft.manpower[market.askedCrew]!;
      await expect(page.getByRole('status').filter({ hasText: asked.companyName })).toBeVisible();
      await expect(page.getByRole('heading', { level: 1, name: field.draft.title })).toBeVisible({
        timeout: 10_000,
      });
      await expect(page.getByRole('heading', { level: 1 })).toBeFocused();
      await expect(
        page.getByText(`5 × ${run.lang === 'tr' ? '8 sa' : '8 h'}`).first(),
      ).toBeVisible();
      await expectFieldScreen(page);
      // The sticky bar keeps Confirm & send on screen at 390 px.
      const send = page.getByRole('button', { name: field.draft.confirm });
      await expect(send).toBeInViewport();
      await send.click();

      // Filing, then filed (the Filed screen is W1-15).
      await expect(
        page.getByRole('heading', { level: 1, name: field.processing.filedTitle }),
      ).toBeVisible({ timeout: 10_000 });
      expect(api.calls.find((c) => c.path === `reports/${REPORT_ID}/answer`)?.body).toEqual({
        questionId: QUESTION_ID,
        optionId: 'o2',
      });
      expect(api.calls.find((c) => c.path === `reports/${REPORT_ID}/confirm`)?.body).toEqual({
        version: 1,
      });

      // What the app sent: the consent with the wording's version, the clip by signed URL.
      expect(api.consent).toEqual({
        types: ['recording', 'data_processing', 'sms'],
        textVersion: 'field.consent.v1',
        contactPref: 'link',
        locale: market.reporter.locale,
      });
      const upload = api.calls.find((c) => c.method === 'POST' && c.path === 'uploads')!;
      expect(upload.headers['x-link-code']).toBe(CODE);
      expect(upload.body).toMatchObject({
        kind: 'audio',
        siteId: market.site.id,
        date: market.date,
      });
      expect((upload.body as { mime: string }).mime).toMatch(/^audio\/webm/);
      expect(api.stored).toHaveLength(1);
      expect(api.stored[0]!.contentType).toBe('audio/webm');
      expect(api.stored[0]!.bytes).toBeGreaterThan(0);
      expect(api.completed).toEqual([api.stored[0]!.uploadId]);
    });
  });
}

test.describe('question and draft (W1-13)', () => {
  test.use({ locale: 'en-US' });

  test('a question without answers to tap takes the number, full day by default (D28); 1440 px', async ({
    page,
  }) => {
    const field = UI_RESOURCES.en.field;
    const market = kestrel('en-US');
    const api = await installFakeFieldApi(page, market, {
      verified: true,
      consented: true,
      noOptions: true,
    });
    await page.goto(`/r/${CODE}`);
    await page.getByRole('link', { name: field.today.record }).click();
    await recordAndSend(page, 'en');
    await page.getByRole('button', { name: field.recording.stopSend }).click();
    await expect(page.getByRole('heading', { level: 1, name: market.question.prompt })).toBeVisible(
      { timeout: 15_000 },
    );
    await expect(page.getByRole('radio', { name: field.question.fullDay })).toBeChecked();
    await expectFieldScreen(page);
    await page.setViewportSize({ width: 1440, height: 900 });
    await expectFieldScreen(page);
    await page.getByLabel(field.question.workers).fill('5');
    await page.getByRole('button', { name: field.question.send }).click();
    await expect(
      page.getByText('Delta Mechanical: 5 workers, 8 hours each — 40 hours.').first(),
    ).toBeVisible();
    await expect(page.getByRole('heading', { level: 1, name: field.draft.title })).toBeVisible({
      timeout: 10_000,
    });
    await expect(page.getByRole('region', { name: 'CREW' })).toContainText('23 · 184 h');
    await expectFieldScreen(page);
    expect(api.calls.find((c) => c.path === `reports/${REPORT_ID}/answer`)?.body).toEqual({
      questionId: QUESTION_ID,
      value: 5,
      hours: 'full_day',
    });
  });
});

test.describe('offline (F5 step 3)', () => {
  test.use({ locale: 'en-US' });

  test('keeps a clip without signal, through a reload, and sends it when the signal is back', async ({
    page,
    context,
  }) => {
    const field = UI_RESOURCES.en.field;
    const api = await installFakeFieldApi(page, kestrel(), { verified: true, consented: true });
    await page.goto(`/r/${CODE}`);
    await expect(page).toHaveURL(/\/today$/);
    await page.getByRole('link', { name: field.today.record }).click();
    const copy = await recordAndSend(page, 'en');

    // Airplane mode, then Stop & send: the clip is saved on the phone.
    api.state.noSignal = true;
    await context.setOffline(true);
    await page.getByRole('button', { name: copy.stopSend }).click();
    await expect(page.getByRole('heading', { level: 1, name: field.sending.queued })).toBeVisible();
    await expect(page.getByText(field.offline.banner)).toBeVisible();
    await expect(page.getByText(field.offline.queued.replace('{{count}}', '1'))).toBeVisible();
    await expectNoAxeViolations(page);

    // The app is opened again later (the page reloads) while field-api is still unreachable: the
    // clip is still queued, from IndexedDB.
    await context.setOffline(false);
    await page.goto('/today');
    await expect(page.getByText(field.offline.queued.replace('{{count}}', '1'))).toBeVisible();
    expect(api.completed).toEqual([]);

    // Signal back: the queue sends at once, and Today shows the report by itself (no tap).
    api.state.noSignal = false;
    await page.evaluate(() => window.dispatchEvent(new Event('online')));
    await expect.poll(() => api.completed.length, { timeout: 15_000 }).toBe(1);
    await expect(page.getByText(field.offline.queued.replace('{{count}}', '1'))).toHaveCount(0);
    await expect(
      page.getByRole('link', { name: field.today.openReport.replace('{{no}}', REPORT_NO) }),
    ).toBeVisible();
    await expect(page.getByText(field.today.status.inProgress)).toBeVisible();
    // A day with a report on its way is not offered as a no-work or weather day.
    await expect(page.getByRole('button', { name: field.today.noWork })).toHaveCount(0);
  });
});

test.describe('No work / Weather (F12, spec §19 Q41)', () => {
  test.use({ locale: 'en-US' });

  test('confirms No work today in a sheet, and Today shows the day closed', async ({ page }) => {
    const field = UI_RESOURCES.en.field;
    const market = kestrel();
    const api = await installFakeFieldApi(page, market, { verified: true, consented: true });
    await page.goto(`/r/${CODE}`);
    await page.getByRole('button', { name: field.today.noWork }).click();
    const sheet = page.getByRole('dialog', { name: field.today.daySheet.noWorkTitle });
    await expect(sheet).toBeVisible();
    await expectFieldScreen(page);
    await sheet.getByRole('button', { name: field.today.daySheet.confirm }).click();
    await expect(sheet).toBeHidden();
    const call = api.calls.find((c) => c.path === 'day-status')!;
    expect(call.body).toEqual({ siteId: market.site.id, status: 'no_work', date: market.date });
    await expect(page.getByText(field.today.status.noWork)).toBeVisible();
    await expect(page.getByText(field.today.closed)).toBeVisible();
    await expect(page.getByRole('link', { name: field.today.record })).toHaveCount(0);
  });

  test('asks since when and how many for a weather day', async ({ page }) => {
    const field = UI_RESOURCES.en.field;
    const market = kestrel();
    const api = await installFakeFieldApi(page, market, { verified: true, consented: true });
    await page.goto(`/r/${CODE}`);
    await page.getByRole('button', { name: field.today.weather }).click();
    const sheet = page.getByRole('dialog', { name: field.today.daySheet.weatherTitle });
    await sheet.getByRole('radio', { name: '09:00' }).click();
    await sheet.getByLabel(field.today.daySheet.workersBefore).fill('12');
    await expectFieldScreen(page);
    await sheet.getByRole('button', { name: field.today.daySheet.confirm }).click();
    await expect(sheet).toBeHidden();
    const call = api.calls.find((c) => c.path === 'day-status')!;
    expect(call.body).toEqual({
      siteId: market.site.id,
      status: 'weather_day',
      date: market.date,
      details: { since: '09:00', workersBefore: 12 },
    });
    await expect(page.getByText(field.today.status.weatherDay)).toBeVisible();
  });
});

/** What the next `/record` gets from the browser: a refusal, no MediaRecorder, or the fake mic. */
async function microphone(
  page: Page,
  mode: 'NotAllowedError' | 'NotReadableError' | 'unsupported' | '',
) {
  await page.evaluate((m) => sessionStorage.setItem('test-microphone', m), mode);
}

async function installMicrophoneSwitch(page: Page) {
  await page.addInitScript(() => {
    const mode = sessionStorage.getItem('test-microphone');
    if (mode === 'unsupported') {
      Object.defineProperty(window, 'MediaRecorder', { value: undefined, configurable: true });
    } else if (mode) {
      navigator.mediaDevices.getUserMedia = () => Promise.reject(new DOMException('test', mode));
    }
  });
}

for (const run of RUNS) {
  test.describe(`off the happy path in ${run.lang}`, () => {
    test.use({ locale: run.locale });

    test('microphone refused, no MediaRecorder, a failing microphone, a clip too short', async ({
      page,
    }) => {
      const field = UI_RESOURCES[run.lang].field;
      const common = UI_RESOURCES[run.lang].common;
      await installFakeFieldApi(page, run.market(), { verified: true, consented: true });
      await installMicrophoneSwitch(page);
      await page.goto(`/r/${CODE}`);
      await expect(page).toHaveURL(/\/today$/);

      await microphone(page, 'NotAllowedError');
      await page.goto('/record');
      await expect(
        page.getByRole('heading', { level: 1, name: field.recording.permission.title }),
      ).toBeVisible();
      await expect(page.getByText(field.recording.permission.ios)).toBeVisible();
      await expectFieldScreen(page);

      await microphone(page, 'unsupported');
      await page.goto('/record');
      await expect(
        page.getByRole('heading', { level: 1, name: field.recording.unsupported.title }),
      ).toBeVisible();
      await expect(page.getByText(field.recording.permission.body)).toHaveCount(0);
      await expectFieldScreen(page);

      // A microphone another app holds: the light Try again on the dark screen (axe contrast).
      await microphone(page, 'NotReadableError');
      await page.goto('/record');
      await expect(
        page.getByRole('heading', { level: 1, name: field.recording.failed }),
      ).toBeVisible();
      await expect(page.getByRole('button', { name: common.retry })).toBeVisible();
      await expectFieldScreen(page);

      await microphone(page, '');
      await page.goto('/record');
      const stop = page.getByRole('button', { name: field.recording.stopSend });
      await expect(stop).toBeEnabled();
      await stop.click();
      const short = page.getByRole('heading', { level: 1, name: field.recording.tooShort });
      await expect(short).toBeVisible();
      await expect(short).toBeFocused();
      await expectFieldScreen(page);
    });

    test('a clip field-api refuses, the Not sent list, and Today failing to load', async ({
      page,
    }) => {
      const field = UI_RESOURCES[run.lang].field;
      const api = await installFakeFieldApi(page, run.market(), {
        verified: true,
        consented: true,
        completeError: { status: 409, error: 'day_closed' },
      });
      await page.goto(`/r/${CODE}`);
      await page.getByRole('link', { name: field.today.record }).click();
      const copy = await recordAndSend(page, run.lang);
      await page.getByRole('button', { name: copy.stopSend }).click();
      await expect(
        page.getByRole('heading', { level: 1, name: field.sending.failed }),
      ).toBeVisible();
      await expect(page.getByRole('alert')).toHaveText(field.sending.errors.day_closed);
      // Nothing can send it: no Try again, Remove or Back.
      await expect(page.getByRole('button', { name: field.sending.retry })).toHaveCount(0);
      await expect(page.getByRole('button', { name: field.sending.remove })).toBeVisible();
      await expectFieldScreen(page);

      await page.getByRole('link', { name: field.sending.backToToday }).click();
      await expect(page.getByText(field.offline.failed.replace('{{count}}', '1'))).toBeVisible();
      await page.getByRole('button', { name: field.offline.review }).click();
      const sheet = page.getByRole('dialog', { name: field.offline.sheetTitle });
      await expect(sheet).toContainText(field.sending.errors.day_closed);
      await expectFieldScreen(page);
      await sheet.getByRole('button', { name: new RegExp(field.offline.remove) }).click();
      await expect(sheet).toBeHidden();
      await expect(page.getByText(field.offline.failed.replace('{{count}}', '1'))).toHaveCount(0);

      api.options.todayError = { status: 500, error: 'internal' };
      await page.goto('/today');
      await expect(page.getByRole('alert')).toHaveText(field.today.failed);
      await expectFieldScreen(page);
    });

    test('the link errors, and the site switcher', async ({ page }) => {
      const field = UI_RESOURCES[run.lang].field;
      const common = UI_RESOURCES[run.lang].common;
      const market = run.market();
      const api = await installFakeFieldApi(page, market, { verified: true, consented: true });
      const cases = [
        { refusal: { status: 404, error: 'link_not_found' }, title: field.link.notFound.title },
        { refusal: { status: 410, error: 'link_revoked' }, title: field.link.revoked.title },
        { refusal: { status: 403, error: 'reporter_disabled' }, title: field.link.disabled.title },
        {
          refusal: {
            status: 410,
            error: 'link_expired',
            extra: { locale: market.reporter.locale, country: market.country },
          },
          title: field.link.expired.title,
        },
        { refusal: { status: 500, error: 'internal' }, title: common.errorTitle },
      ];
      for (const { refusal, title } of cases) {
        api.options.resolveError = refusal;
        await page.goto(`/r/${CODE}`);
        await expect(page.getByRole('heading', { level: 1, name: title })).toBeVisible();
        await expectFieldScreen(page);
      }

      // Two sites: the switcher's name holds the site shown (WCAG 2.5.3).
      api.options.resolveError = undefined;
      api.options.moreSites = [
        { ...market.site, id: '3c1d2e4f-5a6b-4c7d-8e9f-0a1b2c3d4e5f', name: 'Pier 9' },
      ];
      await page.goto(`/r/${CODE}`);
      const switcher = page.getByRole('button', {
        name: `${market.site.name}, ${field.today.changeSite}`,
      });
      await expect(switcher).toBeVisible();
      await switcher.click();
      const sheet = page.getByRole('dialog', { name: field.today.siteSheetTitle });
      await expect(sheet.getByRole('button', { name: 'Pier 9' })).toBeVisible();
      await expectFieldScreen(page);
    });
  });
}
