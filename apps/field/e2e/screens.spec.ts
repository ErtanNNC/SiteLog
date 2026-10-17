import { expect, test, type Page } from '@playwright/test';
import { UI_RESOURCES } from '@sitelog/shared/copy/ui/index.ts';
import { correctionNote } from '@sitelog/shared/report/correction-note.ts';
import { expectFieldScreen, expectNoAxeViolations } from './support/checks.ts';
import type { HistoryResponse, ReportView } from '@sitelog/shared/field-contract.ts';
import {
  DAY_OFF_REPORT_ID,
  demir,
  installFakeFieldApi,
  kestrel,
  OTP,
  QUESTION_ID,
  REPORT_ID,
  REPORT_NO,
  TEST_SNIPPETS,
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
 *   a reload, sent in the background with Today updating by itself;
 * - No work and Weather (F12, W2-08) in EN, ES and TR: the sheets, "Since when?" required, the
 *   day closed and the weather day's photo of the conditions;
 * - Settings (F15, W2-02) in EN, ES and TR: the preference, texts off, the recording sheet, sign
 *   out back to the device check; in EN the language switch and recording off back to the consent,
 *   and the screen at 1440 px.
 * - Past reports and the expired link (F10, F16; W2-03) in EN, ES and TR; the two-site reporter
 *   (F14: the nearest deadline first, the switcher, a daily link of the other site) in EN; Past
 *   reports at 1440 px.
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

      // F4's optional test recording (W2-13), now that the consent covers it: the fake
      // microphone, then the worker's words, shown once ("Heard you clearly: '…'").
      const testTitle = page.getByRole('heading', { level: 1, name: field.welcomeTest.title });
      await expect(testTitle).toBeVisible();
      await expect(testTitle).toBeFocused();
      await expect(page.getByText(field.welcomeTest.body)).toBeVisible();
      const start = page.getByRole('button', { name: field.welcomeTest.start });
      expect((await start.boundingBox())!.height, 'Record ≥ 120 px (§14.6)').toBeGreaterThanOrEqual(
        120,
      );
      await expectFieldScreen(page);
      await start.click();
      await expect(page.getByRole('timer')).toHaveText(/^00:0[1-9] \/ 00:20$/, { timeout: 10_000 });
      await page.getByRole('button', { name: field.welcomeTest.stop }).click();
      await expect(
        page.getByText(field.welcomeTest.heard.replace('{{text}}', TEST_SNIPPETS[run.lang]!)),
      ).toBeVisible({ timeout: 15_000 });
      await expectFieldScreen(page);
      expect(api.testClips).toHaveLength(1);
      expect(api.testClips[0]!).toMatchObject({ stored: true });
      expect((api.testClips[0]!.body as { mime: string }).mime).toMatch(/^audio\//);
      await page.getByRole('button', { name: field.welcomeTest.continue }).click();

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
      // No voice number in week 1, and Talk now is not offered (`talkNow` false).
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

      // The question (F7, Field-05; W1-13): one per screen, two answers and Other — say it (W2-09).
      const question = page.getByRole('heading', { level: 1, name: market.question.prompt });
      await expect(question).toBeVisible({ timeout: 10_000 });
      await expect(question).toBeFocused();
      await expect(page.getByText(field.question.badge, { exact: true })).toBeVisible();
      const answers = page.getByRole('main').getByRole('button');
      await expect(answers).toHaveText([...market.question.options, field.question.other]);
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

      // Filing, then the Filed screen (F8, Field-07; W1-15): the report number and the PDF.
      await expect(page.getByRole('heading', { level: 1, name: field.filed.title })).toBeVisible({
        timeout: 10_000,
      });
      await expect(page.getByRole('heading', { level: 1 })).toBeFocused();
      await expect(page.getByRole('main').getByText(REPORT_NO, { exact: true })).toBeVisible();
      await expect(
        page.getByRole('link', { name: new RegExp(`^${field.filed.pdf}`) }),
      ).toHaveAttribute('href', `/__storage/pdfs/${REPORT_NO}_v1.pdf?token=e2e`);
      await expectFieldScreen(page);
      expect(api.calls.find((c) => c.path === `reports/${REPORT_ID}/answer`)?.body).toEqual({
        questionId: QUESTION_ID,
        optionId: 'o2',
      });
      expect(api.calls.find((c) => c.path === `reports/${REPORT_ID}/confirm`)?.body).toEqual({
        version: 1,
        draftRev: 1,
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

/** Today → Recording → the question (an answered device and consent): the Question screen. */
async function toQuestion(page: Page, lang: keyof typeof UI_RESOURCES, market: Market) {
  const field = UI_RESOURCES[lang].field;
  await page.goto(`/r/${CODE}`);
  await page.getByRole('link', { name: field.today.record }).click();
  await recordAndSend(page, lang);
  await page.getByRole('button', { name: field.recording.stopSend }).click();
  await expect(page.getByRole('heading', { level: 1, name: market.question.prompt })).toBeVisible({
    timeout: 15_000,
  });
}

/** F7 Other… (W2-09): open the sheet, record a short answer with the fake microphone, send it. */
async function sayAnswer(page: Page, lang: keyof typeof UI_RESOURCES) {
  const q = UI_RESOURCES[lang].field.question;
  await page.getByRole('button', { name: q.other }).click();
  const sheet = page.getByRole('dialog', { name: q.otherTitle });
  await expect(sheet).toBeVisible();
  const record = sheet.getByRole('button', { name: q.record });
  const box = await record.boundingBox();
  expect(box!.height, 'Record ≥ 120 px (§14.6)').toBeGreaterThanOrEqual(120);
  await record.click();
  await expect(sheet.getByRole('timer')).toHaveText(/^00:0[1-9] \/ 00:30$/, { timeout: 10_000 });
  await sheet.getByRole('button', { name: q.stop }).click();
  await expect(sheet).toHaveCount(0);
}

for (const run of RUNS) {
  test.describe(`Other… said (F7, W2-09) in ${run.lang}`, () => {
    test.use({ locale: run.locale });

    test('the answer said is listened to, applied in code with F7’s line, then the draft', async ({
      page,
    }) => {
      const field = UI_RESOURCES[run.lang].field;
      const market = run.market();
      const api = await installFakeFieldApi(page, market, { verified: true, consented: true });
      await toQuestion(page, run.lang, market);
      await sayAnswer(page, run.lang);
      await expect(
        page.getByRole('status').filter({ hasText: field.question.listening }),
      ).toBeVisible();
      await expectFieldScreen(page);
      // The worker's numbers (code's), then the draft.
      const asked = market.draft.manpower[market.askedCrew]!;
      await expect(page.getByRole('status').filter({ hasText: asked.companyName })).toBeVisible({
        timeout: 15_000,
      });
      await expect(page.getByRole('heading', { level: 1, name: field.draft.title })).toBeVisible({
        timeout: 15_000,
      });
      await expect(
        page.getByText(`5 × ${run.lang === 'tr' ? '8 sa' : '8 h'}`).first(),
      ).toBeVisible();
      // The clip went as an answer clip of the question, then `answer {uploadId}`.
      const upload = api.calls.filter((c) => c.method === 'POST' && c.path === 'uploads').at(-1)!;
      expect(upload.body).toMatchObject({
        kind: 'audio',
        answerTo: { reportId: REPORT_ID, questionId: QUESTION_ID },
      });
      expect(upload.body).not.toHaveProperty('siteId');
      const answer = api.calls.find((c) => c.path === `reports/${REPORT_ID}/answer`)!;
      expect(answer.body).toEqual({
        questionId: QUESTION_ID,
        uploadId: api.stored.at(-1)!.uploadId,
      });
      // Not a voice note of the report.
      expect(api.completed).toHaveLength(1);
    });
  });
}

test.describe('Other… (F7, W2-09) off the happy path', () => {
  test.use({ locale: 'en-US' });

  test('unclear: asked once more, then left for the office; the sheet types a number; 1440 px', async ({
    page,
  }) => {
    const field = UI_RESOURCES.en.field;
    const market = kestrel('en-US');
    await installFakeFieldApi(page, market, {
      verified: true,
      consented: true,
      voiceAnswer: 'unclear',
    });
    await toQuestion(page, 'en', market);
    // The sheet: Say it, and for a number field the number input.
    await page.getByRole('button', { name: field.question.other }).click();
    const sheet = page.getByRole('dialog', { name: field.question.otherTitle });
    await expect(sheet.getByRole('heading', { name: field.question.typeIt })).toBeVisible();
    await expect(sheet.getByLabel(field.question.workers)).toBeVisible();
    await expectFieldScreen(page);
    await sheet.getByRole('button', { name: field.question.cancel }).click();
    await expect(sheet).toHaveCount(0);

    await sayAnswer(page, 'en');
    await expect(page.getByRole('status').filter({ hasText: field.question.retry })).toBeVisible({
      timeout: 15_000,
    });
    // Asked once more, with the same answers to tap.
    await expect(page.getByRole('button', { name: market.question.options[0] })).toBeEnabled();
    await page.setViewportSize({ width: 1440, height: 900 });
    await expectFieldScreen(page);
    await sayAnswer(page, 'en');
    await expect(page.getByRole('status').filter({ hasText: field.question.unclear })).toBeVisible({
      timeout: 15_000,
    });
    await expect(page.getByRole('heading', { level: 1, name: field.draft.title })).toBeVisible({
      timeout: 15_000,
    });
    await expectFieldScreen(page);
  });

  test('a number typed in the sheet answers like the card’s input', async ({ page }) => {
    const field = UI_RESOURCES.en.field;
    const market = kestrel('en-US');
    const api = await installFakeFieldApi(page, market, { verified: true, consented: true });
    await toQuestion(page, 'en', market);
    await page.getByRole('button', { name: field.question.other }).click();
    const sheet = page.getByRole('dialog', { name: field.question.otherTitle });
    await sheet.getByLabel(field.question.workers).fill('6');
    await sheet.getByRole('button', { name: field.question.send }).click();
    await expect(page.getByRole('heading', { level: 1, name: field.draft.title })).toBeVisible({
      timeout: 15_000,
    });
    expect(api.calls.find((c) => c.path === `reports/${REPORT_ID}/answer`)?.body).toEqual({
      questionId: QUESTION_ID,
      value: 6,
      hours: 'full_day',
    });
  });
});

test.describe('Message me on WhatsApp (W2-15, spec §19 Q25, Q40)', () => {
  test.use({ locale: 'tr-TR' });

  test('the opt-in on Welcome, unticked by default, then Turn off and on in Settings', async ({
    page,
  }) => {
    const field = UI_RESOURCES.tr.field;
    const market = demir();
    const api = await installFakeFieldApi(page, market, { verified: true, whatsapp: true });
    await page.goto(`/r/${CODE}`);
    const wa = page.getByRole('checkbox', { name: field.welcome.consentWhatsapp });
    await expect(wa).not.toBeChecked();
    await page.getByRole('checkbox', { name: field.welcome.consentRequired }).check();
    await wa.check();
    await page.getByRole('button', { name: field.welcome.continue }).click();
    await expect(
      page.getByRole('heading', { level: 1, name: field.welcomeTest.title }),
    ).toBeVisible();
    expect((api.consent as { types: string[] }).types).toContain('whatsapp');

    await page.goto('/settings');
    const s = field.settings;
    const off = page.getByRole('button', { name: `${s.turnOff}: ${s.consents.whatsapp}` });
    await off.click();
    expect(api.calls.find((c) => c.path === 'consent/revoke')!.body).toEqual({ type: 'whatsapp' });
    await page.getByRole('button', { name: `${s.turnOn}: ${s.consents.whatsapp}` }).click();
    const sheet = page.getByRole('dialog', { name: s.turnOnSheet.titleWhatsapp });
    await expect(sheet).toContainText(field.welcome.consentWhatsapp);
    await sheet.getByRole('button', { name: s.turnOnSheet.confirm }).click();
    expect(api.calls.find((c) => c.path === 'consent/grant')!.body).toEqual({
      type: 'whatsapp',
      textVersion: market.country.legalKeys.consent ?? 'field.consent.v1',
    });
    await expect(
      page.getByRole('button', { name: `${s.turnOff}: ${s.consents.whatsapp}` }),
    ).toBeVisible();
  });
});

test.describe('the test recording off the happy path (F4, W2-13)', () => {
  test.use({ locale: 'en-US' });

  async function toTest(page: Page, opts: Parameters<typeof installFakeFieldApi>[2] = {}) {
    const field = UI_RESOURCES.en.field;
    const market = kestrel('en-US');
    const api = await installFakeFieldApi(page, market, { verified: true, ...opts });
    await page.goto(`/r/${CODE}`);
    await page.getByRole('checkbox', { name: field.welcome.consentRequired }).check();
    await page.getByRole('button', { name: field.welcome.continue }).click();
    await expect(
      page.getByRole('heading', { level: 1, name: field.welcomeTest.title }),
    ).toBeVisible();
    return { api, field };
  }

  test('nothing heard: says so and offers another try; skip goes to Today; 1440 px', async ({
    page,
  }) => {
    const { api, field } = await toTest(page, { testClip: 'silent' });
    await page.setViewportSize({ width: 1440, height: 900 });
    await expectFieldScreen(page);
    await page.getByRole('button', { name: field.welcomeTest.start }).click();
    await expect(page.getByRole('timer')).toHaveText(/^00:0[1-9] \/ 00:20$/, { timeout: 10_000 });
    await page.getByRole('button', { name: field.welcomeTest.stop }).click();
    await expect(page.getByText(field.welcomeTest.silent)).toBeVisible({ timeout: 15_000 });
    await expectFieldScreen(page);
    await page.getByRole('button', { name: field.welcomeTest.again }).click();
    await expect(page.getByRole('button', { name: field.welcomeTest.start })).toBeVisible();
    await page.getByRole('button', { name: field.welcomeTest.skip }).click();
    await expect(page).toHaveURL(/\/today$/);
    expect(api.testClips).toHaveLength(1);
  });

  test('too many tests this hour: says so; the reporter goes on', async ({ page }) => {
    const { field } = await toTest(page, { testClip: 'rate_limited' });
    await page.getByRole('button', { name: field.welcomeTest.start }).click();
    await expect(page.getByRole('timer')).toHaveText(/^00:0[1-9] \/ 00:20$/, { timeout: 10_000 });
    await page.getByRole('button', { name: field.welcomeTest.stop }).click();
    await expect(page.getByText(field.welcomeTest.tooMany)).toBeVisible({ timeout: 15_000 });
    await page.getByRole('button', { name: field.welcomeTest.continue }).click();
    await expect(page).toHaveURL(/\/today$/);
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

for (const run of RUNS) {
  test.describe(`No work / Weather (F12, spec §19 Q41; W2-08) in ${run.lang}`, () => {
    test.use({ locale: run.locale });

    test('confirms No work today in a sheet, and Today shows the day closed', async ({ page }) => {
      const field = UI_RESOURCES[run.lang].field;
      const market = run.market();
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
      await expectFieldScreen(page);
    });

    test('asks since when (required) and how many, then offers the photo of the conditions', async ({
      page,
    }) => {
      const field = UI_RESOURCES[run.lang].field;
      const market = run.market();
      const api = await installFakeFieldApi(page, market, { verified: true, consented: true });
      await page.goto(`/r/${CODE}`);
      await page.getByRole('button', { name: field.today.weather }).click();
      const sheet = page.getByRole('dialog', { name: field.today.daySheet.weatherTitle });
      const confirm = sheet.getByRole('button', { name: field.today.daySheet.confirm });
      // No lost hours are guessed: Confirm waits for "Since when?".
      await expect(confirm).toBeDisabled();
      await expect(sheet.getByText(field.today.daySheet.sinceHint)).toBeVisible();
      await sheet.getByRole('radio', { name: '09:00' }).click();
      await sheet.getByLabel(field.today.daySheet.workersBefore).fill('12');
      await expectFieldScreen(page);
      await confirm.click();
      await expect(sheet).toBeHidden();
      const call = api.calls.find((c) => c.path === 'day-status')!;
      expect(call.body).toEqual({
        siteId: market.site.id,
        status: 'weather_day',
        date: market.date,
        details: { since: '09:00', workersBefore: 12 },
      });
      await expect(page.getByText(field.today.status.weatherDay)).toBeVisible();
      await expect(page.getByText(field.today.weatherPhotoHint)).toBeVisible();
      await expect(page.getByRole('link', { name: field.today.weatherPhoto })).toHaveAttribute(
        'href',
        `/report/${DAY_OFF_REPORT_ID}`,
      );
      await expectFieldScreen(page);
      await page.setViewportSize({ width: 1440, height: 900 });
      await expectFieldScreen(page);
    });
  });
}

for (const run of RUNS) {
  test.describe(`Settings (F15, W2-02) in ${run.lang}`, () => {
    test.use({ locale: run.locale });

    test('preference, language, texts off, recording off, sign out', async ({ page }) => {
      const field = UI_RESOURCES[run.lang].field;
      const s = field.settings;
      const market: Market = run.market();
      const api = await installFakeFieldApi(page, market, { verified: true, consented: true });
      await page.goto(`/r/${CODE}`);
      await page.getByRole('link', { name: field.routes.settings }).click();
      await expect(page).toHaveURL(/\/settings$/);
      const heading = page.getByRole('heading', { level: 1, name: field.routes.settings });
      await expect(heading).toBeFocused();
      await expect(page.getByText(s.consents.sms)).toBeVisible();
      // One built channel: no channel choice; no "Don't call me today" before M8.
      await expect(page.getByText(s.channelTitle)).toHaveCount(0);
      await expectFieldScreen(page);

      const call = page.getByRole('radio', { name: new RegExp(field.welcome.prefCall) });
      await call.click();
      await expect(page.getByRole('status').filter({ hasText: s.saved })).toBeVisible();
      await expect(call).toBeChecked();
      expect(api.calls.find((c) => c.method === 'PATCH')!.body).toEqual({ contactPref: 'call' });

      // Texts off at once; the state reads Off as text.
      await page.getByRole('button', { name: `${s.turnOff}: ${s.consents.sms}` }).click();
      await expect(page.getByText(s.off, { exact: true })).toBeVisible();
      expect(api.calls.find((c) => c.path === 'consent/revoke')!.body).toEqual({ type: 'sms' });

      // ... and back on (§19 Q86): the sheet shows the Welcome wording again.
      await page.getByRole('button', { name: `${s.turnOn}: ${s.consents.sms}` }).click();
      const on = page.getByRole('dialog', { name: s.turnOnSheet.title });
      await expect(on).toContainText(field.welcome.consentSms);
      await expectFieldScreen(page);
      await on.getByRole('button', { name: s.turnOnSheet.confirm }).click();
      await expect(on).toBeHidden();
      await expect(page.getByText(s.off, { exact: true })).toHaveCount(0);
      expect(api.calls.find((c) => c.path === 'consent/grant')!.body).toEqual({
        type: 'sms',
        textVersion: market.country.legalKeys.consent ?? 'field.consent.v1',
      });

      // Recording off behind the sheet; Keep it on changes nothing.
      const recording = page.getByRole('button', { name: `${s.turnOff}: ${s.consents.recording}` });
      await recording.click();
      const sheet = page.getByRole('dialog', { name: s.stopSheet.title });
      await expect(sheet).toBeVisible();
      await expectFieldScreen(page);
      await sheet.getByRole('button', { name: s.stopSheet.cancel }).click();
      await expect(sheet).toBeHidden();

      // Sign out: back through the device check (F4 step 2).
      await page.getByRole('button', { name: s.signOut }).click();
      const out = page.getByRole('dialog', { name: s.signOutSheet.title });
      await out.getByRole('button', { name: s.signOutSheet.confirm }).click();
      await expect(
        page.getByRole('heading', {
          level: 1,
          name: field.device.title.replace('{{name}}', market.reporter.name),
        }),
      ).toBeVisible();
      expect(api.calls.some((c) => c.path === 'device/sign-out')).toBe(true);
    });
  });
}

/**
 * W2-14: the installed app (`display-mode: standalone`) with a fake Push API: permission granted
 * or denied when asked, and a subscription the fake `PushManager` hands out.
 */
async function installedWithPush(page: Page, permission: 'granted' | 'denied' | 'default') {
  await page.addInitScript((answer) => {
    const real = window.matchMedia.bind(window);
    window.matchMedia = (query: string) =>
      query === '(display-mode: standalone)'
        ? ({ matches: true, media: query } as MediaQueryList)
        : real(query);
    const asked: string[] = [];
    (window as unknown as { __pushAsked: string[] }).__pushAsked = asked;
    let current: unknown = null;
    const subscription = {
      toJSON: () => ({
        endpoint: 'https://fcm.googleapis.com/fcm/send/e2e',
        expirationTime: null,
        keys: { p256dh: 'BPe2eKey', auth: 'e2eAuth' },
      }),
      unsubscribe: async () => {
        current = null;
        return true;
      },
    };
    const pushManager = {
      getSubscription: async () => current,
      subscribe: async () => (current = subscription),
    };
    Object.defineProperty(window, 'PushManager', {
      value: function PushManager() {},
      configurable: true,
    });
    Object.defineProperty(window, 'Notification', {
      configurable: true,
      value: {
        permission: answer === 'denied' ? 'denied' : 'default',
        requestPermission: async () => {
          asked.push('permission');
          return answer;
        },
      },
    });
    Object.defineProperty(navigator, 'serviceWorker', {
      configurable: true,
      value: { ready: Promise.resolve({ pushManager }), register: async () => ({}) },
    });
  }, permission);
}

for (const run of RUNS) {
  test.describe(`Settings: Notifications in the installed app (W2-14) in ${run.lang}`, () => {
    test.use({ locale: run.locale });

    test('asks for permission only on the toggle; on and off are saved', async ({ page }) => {
      const field = UI_RESOURCES[run.lang].field;
      const s = field.settings;
      await installedWithPush(page, 'granted');
      const api = await installFakeFieldApi(page, run.market(), {
        verified: true,
        consented: true,
        push: true,
      });
      await page.goto(`/r/${CODE}`);
      await page.getByRole('link', { name: field.routes.settings }).click();
      await expect(page.getByRole('heading', { level: 2, name: s.push.title })).toBeVisible();
      await expect(page.getByText(s.push.hint)).toBeVisible();
      // Nothing asked before the toggle.
      expect(
        await page.evaluate(() => (window as unknown as { __pushAsked: string[] }).__pushAsked),
      ).toEqual([]);
      await expectFieldScreen(page);

      await page.getByRole('button', { name: `${s.turnOn}: ${s.push.label}` }).click();
      await expect(
        page.getByRole('button', { name: `${s.turnOff}: ${s.push.label}` }),
      ).toBeVisible();
      expect(
        await page.evaluate(() => (window as unknown as { __pushAsked: string[] }).__pushAsked),
      ).toEqual(['permission']);
      expect(api.calls.find((c) => c.path === 'push/subscribe')!.body).toEqual({
        subscription: {
          endpoint: 'https://fcm.googleapis.com/fcm/send/e2e',
          expirationTime: null,
          keys: { p256dh: 'BPe2eKey', auth: 'e2eAuth' },
        },
        textVersion: run.market().country.legalKeys.consent ?? 'field.consent.v1',
      });
      // The push consent is the toggle's, not a row of the consents (one label on the screen).
      await expect(page.getByText(s.push.label, { exact: true })).toHaveCount(1);
      await expectFieldScreen(page);

      await page.getByRole('button', { name: `${s.turnOff}: ${s.push.label}` }).click();
      await expect(
        page.getByRole('button', { name: `${s.turnOn}: ${s.push.label}` }),
      ).toBeVisible();
      expect(api.calls.some((c) => c.path === 'push/unsubscribe')).toBe(true);
      expect(api.pushSubscription).toBeNull();
    });
  });
}

test.describe('Settings: Notifications hidden or blocked (W2-14)', () => {
  test('hidden in a browser tab, and where field-api offers no push', async ({ page }) => {
    const s = UI_RESOURCES.en.field.settings;
    await installFakeFieldApi(page, kestrel(), { verified: true, consented: true, push: true });
    await page.goto(`/r/${CODE}`);
    await page.getByRole('link', { name: UI_RESOURCES.en.field.routes.settings }).click();
    await expect(page.getByText(s.consents.sms)).toBeVisible();
    await expect(page.getByRole('heading', { name: s.push.title })).toHaveCount(0);
  });

  test('hidden in the installed app without push here', async ({ page }) => {
    const s = UI_RESOURCES.en.field.settings;
    await installedWithPush(page, 'granted');
    await installFakeFieldApi(page, kestrel(), { verified: true, consented: true });
    await page.goto(`/r/${CODE}`);
    await page.getByRole('link', { name: UI_RESOURCES.en.field.routes.settings }).click();
    await expect(page.getByText(s.consents.sms)).toBeVisible();
    await expect(page.getByRole('heading', { name: s.push.title })).toHaveCount(0);
  });

  test('a refused permission says how to allow it, and nothing is stored', async ({ page }) => {
    const s = UI_RESOURCES.en.field.settings;
    await installedWithPush(page, 'denied');
    const api = await installFakeFieldApi(page, kestrel(), {
      verified: true,
      consented: true,
      push: true,
    });
    await page.goto(`/r/${CODE}`);
    await page.getByRole('link', { name: UI_RESOURCES.en.field.routes.settings }).click();
    await page.getByRole('button', { name: `${s.turnOn}: ${s.push.label}` }).click();
    await expect(page.getByRole('alert').filter({ hasText: s.push.blocked })).toBeVisible();
    expect(api.calls.some((c) => c.path === 'push/subscribe')).toBe(false);
    await page.setViewportSize({ width: 1440, height: 900 });
    await expectFieldScreen(page);
  });
});

test.describe('Settings: language and stopping reports (F15, W2-02)', () => {
  test.use({ locale: 'en-US' });

  test('switches the language at once, and recording off leads back to the consent', async ({
    page,
  }) => {
    const en = UI_RESOURCES.en.field;
    const es = UI_RESOURCES.es.field;
    const api = await installFakeFieldApi(page, kestrel(), { verified: true, consented: true });
    await page.goto('/r/K7Q2MX');
    await page.getByRole('link', { name: en.routes.settings }).click();
    await page.getByRole('radio', { name: 'Español' }).click();
    await expect(page.getByRole('heading', { level: 1, name: es.routes.settings })).toBeVisible();
    await expect(page.locator('html')).toHaveAttribute('lang', 'es');
    expect(api.calls.find((c) => c.method === 'PATCH')!.body).toEqual({ locale: 'es-US' });

    await page
      .getByRole('button', { name: `${es.settings.turnOff}: ${es.settings.consents.recording}` })
      .click();
    await page
      .getByRole('dialog', { name: es.settings.stopSheet.title })
      .getByRole('button', { name: es.settings.stopSheet.confirm })
      .click();
    // The Welcome & consent again: reports stop until the reporter agrees again.
    await expect(page.getByRole('checkbox', { name: es.welcome.consentRequired })).toBeVisible();
    await expectFieldScreen(page);
  });

  test('a phone opted out by STOP gets START on a two-way pack, no Turn on (Q86)', async ({
    page,
  }) => {
    const s = UI_RESOURCES.en.field.settings;
    await installFakeFieldApi(page, kestrel(), {
      verified: true,
      consented: true,
      textsOptedOut: true,
    });
    await page.goto('/r/K7Q2MX');
    await page.getByRole('link', { name: UI_RESOURCES.en.field.routes.settings }).click();
    await page.getByRole('button', { name: `${s.turnOff}: ${s.consents.sms}` }).click();
    await expect(page.getByText(s.textsStopped.start)).toBeVisible();
    await expect(page.getByRole('button', { name: `${s.turnOn}: ${s.consents.sms}` })).toHaveCount(
      0,
    );
    await expectFieldScreen(page);
  });

  test('works at 1440 px too', async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await installFakeFieldApi(page, kestrel(), { verified: true, consented: true });
    await page.goto('/r/K7Q2MX');
    await page.getByRole('link', { name: UI_RESOURCES.en.field.routes.settings }).click();
    await expect(page.getByText(UI_RESOURCES.en.field.settings.consents.sms)).toBeVisible();
    await expectFieldScreen(page);
  });
});

test.describe('Settings: an opted-out phone on a one-way pack (Q86, Q94)', () => {
  test.use({ locale: 'tr-TR' });

  test('says to ask the office, never START, and offers no Turn on', async ({ page }) => {
    const s = UI_RESOURCES.tr.field.settings;
    await installFakeFieldApi(page, demir(), {
      verified: true,
      consented: true,
      textsOptedOut: true,
    });
    await page.goto(`/r/${CODE}`);
    await page.getByRole('link', { name: UI_RESOURCES.tr.field.routes.settings }).click();
    await expect(page.getByText(s.textsStopped.office)).toBeVisible();
    await expect(page.getByText(s.textsStopped.start)).toHaveCount(0);
    await expect(page.getByRole('button', { name: new RegExp(`^${s.turnOn}: `) })).toHaveCount(0);
    await expectFieldScreen(page);
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
          title: field.expired.title,
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

const PIER_9 = '3c1d2e4f-5a6b-4c7d-8e9f-0a1b2c3d4e5f';
const PAST_ID = '7d2f4c1e-0000-4000-8000-000000000187';

/** Two past reports: one filed late at the market's site, one awaiting confirmation at Pier 9. */
function pastReports(market: Market): {
  history: HistoryResponse['reports'];
  reports: Record<string, ReportView>;
} {
  const filed: ReportView = {
    id: PAST_ID,
    reportNo: 'RL-2041-0187',
    status: 'filed',
    kind: 'daily',
    siteId: market.site.id,
    siteName: market.site.name,
    date: '2026-10-08',
    channel: 'web',
    currentVersion: 2,
    needsReview: false,
    filedAt: '2026-10-08T22:44:00.000Z',
    confirmedAt: '2026-10-08T22:43:00.000Z',
    question: null,
    data: { ...market.draft, reportDate: '2026-10-08' },
    draftRev: 1,
    progress: { voiceNotes: 1, transcribed: 1, photos: 0 },
    pdfUrl: '/__storage/pdfs/RL-2041-0187_v2.pdf?token=e2e',
    addPhotos: null,
    changeNote: null,
    lastVoiceAnswer: null,
    correction: null,
    change: { canChange: true, locked: false },
  };
  return {
    history: [
      {
        id: 'b3a1c2d4-0000-4000-8000-000000000012',
        reportNo: 'P9-3007-0012',
        status: 'awaiting_confirmation',
        siteId: PIER_9,
        siteName: 'Pier 9',
        date: '2026-10-09',
        filedAt: null,
        currentVersion: 1,
        isLate: false,
      },
      {
        id: PAST_ID,
        reportNo: 'RL-2041-0187',
        status: 'filed',
        siteId: market.site.id,
        siteName: market.site.name,
        date: '2026-10-08',
        filedAt: '2026-10-08T22:44:00.000Z',
        currentVersion: 2,
        isLate: true,
      },
    ],
    reports: { [PAST_ID]: filed },
  };
}

for (const run of RUNS) {
  test.describe(`Past reports and the expired link (W2-03) in ${run.lang}`, () => {
    test.use({ locale: run.locale });

    test('Today → Past reports → one report, read-only with its PDF', async ({ page }) => {
      const field = UI_RESOURCES[run.lang].field;
      const market = run.market();
      const past = pastReports(market);
      await installFakeFieldApi(page, market, {
        verified: true,
        consented: true,
        moreSites: [{ ...market.site, id: PIER_9, name: 'Pier 9' }],
        ...past,
      });
      await page.goto(`/r/${CODE}`);
      await page.getByRole('link', { name: field.today.pastReports }).click();
      await expect(page).toHaveURL(/\/history$/);
      await expect(
        page.getByRole('heading', { level: 1, name: field.routes.history }),
      ).toBeFocused();
      await expect(page.getByText(field.history.status.awaiting_confirmation)).toBeVisible();
      await expect(page.getByText(field.history.late, { exact: true })).toBeVisible();
      await expectFieldScreen(page);

      await page.getByRole('link', { name: /RL-2041-0187/ }).click();
      await expect(page).toHaveURL(new RegExp(`/history/${PAST_ID}$`));
      await expect(page.getByRole('heading', { level: 1, name: 'RL-2041-0187' })).toBeVisible();
      await expect(page.getByText(field.history.status.filed)).toBeVisible();
      await expect(page.getByRole('link', { name: new RegExp(field.filed.pdf) })).toBeVisible();
      await expect(page.getByText(market.draft.manpower[0]!.companyName)).toBeVisible();
      // Change something (W2-11), and no Confirm & send on a filed report.
      await expect(page.getByRole('button', { name: field.history.change.button })).toBeVisible();
      await expect(page.getByRole('button', { name: field.draft.confirm })).toHaveCount(0);
      await expectFieldScreen(page);
      await page.getByRole('link', { name: field.history.back }).click();
      await expect(page).toHaveURL(/\/history$/);
    });

    test('an expired daily link sends today’s link to the phone on file', async ({ page }) => {
      const field = UI_RESOURCES[run.lang].field;
      const market = run.market();
      const api = await installFakeFieldApi(page, market, {
        resolveError: {
          status: 410,
          error: 'link_expired',
          extra: { locale: market.reporter.locale, country: market.country },
        },
      });
      await page.goto(`/r/${CODE}`);
      await expect(page).toHaveURL(/\/expired$/);
      await expect(
        page.getByRole('heading', { level: 1, name: field.expired.title }),
      ).toBeVisible();
      await expect(page.locator('html')).toHaveAttribute('lang', run.lang);
      await expectFieldScreen(page);
      await page.getByRole('button', { name: field.expired.send }).click();
      await expect(page.getByRole('status').filter({ hasText: field.expired.sent })).toBeVisible();
      expect(api.calls.find((c) => c.path === 'expired/daily-link')!.body).toEqual({ code: CODE });
      await expectFieldScreen(page);

      // A paused site says so instead (the reason, never a link).
      api.options.expiredAnswer = { sent: false, reason: 'site_paused' };
      await page.goto(`/r/${CODE}`);
      await page.getByRole('button', { name: field.expired.send }).click();
      await expect(page.getByText(field.expired.reasons.site_paused)).toBeVisible();
    });
  });
}

for (const run of RUNS) {
  test.describe(`Change something on a past report (F10, W2-11) in ${run.lang}`, () => {
    test.use({ locale: run.locale });

    test('Past reports → said change → preview from code’s numbers → Save change → version 3', async ({
      page,
    }) => {
      const field = UI_RESOURCES[run.lang].field;
      const change = field.history.change;
      const market = run.market();
      const past = pastReports(market);
      const api = await installFakeFieldApi(page, market, {
        verified: true,
        consented: true,
        ...past,
      });
      await page.goto(`/r/${CODE}`);
      await page.getByRole('link', { name: field.today.pastReports }).click();
      await page.getByRole('link', { name: /RL-2041-0187/ }).click();
      await page.getByRole('button', { name: change.button }).click();
      const sheet = page.getByRole('dialog', { name: change.title });
      await expect(sheet).toBeVisible();
      await expect(sheet.getByText(change.hint)).toBeVisible();
      await expectFieldScreen(page);
      await sheet.getByRole('button', { name: field.draft.fix.record }).click();
      await expect(sheet.getByRole('timer')).toHaveText(/^00:0[1-9] \/ 00:30$/, {
        timeout: 10_000,
      });
      await sheet.getByRole('button', { name: field.draft.fix.stop }).click();
      await expect(sheet).toHaveCount(0);

      // The preview: the crew line from code's numbers, as the worker sends it.
      const crew = market.draft.manpower[0]!;
      const to = (crew.workers ?? 0) + 1;
      const line = correctionNote(
        [
          {
            kind: 'crew',
            company: crew.companyName,
            change: 'changed',
            workers: [crew.workers, to],
            hoursPerWorker: [crew.hoursPerWorker, crew.hoursPerWorker],
            totalHours: [crew.totalHours, to * (crew.hoursPerWorker ?? 0)],
          },
        ],
        run.lang,
      );
      const preview = page.getByRole('region', { name: field.draft.fix.previewTitle });
      await expect(preview).toBeVisible({ timeout: 15_000 });
      await expect(preview.getByRole('listitem')).toHaveText(line!);
      await expectFieldScreen(page);
      await preview.getByRole('button', { name: field.draft.fix.save }).click();

      await expect(
        page.getByRole('status').filter({ hasText: change.saved.replace('{{version}}', '3') }),
      ).toBeVisible({ timeout: 15_000 });
      await expect(
        page.getByText(field.history.version.replace('{{version}}', '3'), { exact: true }),
      ).toBeVisible();
      await expect(page.getByRole('link', { name: /_v3\.pdf/ })).toBeVisible();
      const upload = api.calls.find((c) => c.path === 'uploads')!;
      expect((upload.body as { fixTo: unknown }).fixTo).toEqual({ reportId: PAST_ID });
      expect(Object.values(api.changes).map((c) => c.version)).toEqual([3]);
      await expectFieldScreen(page);
    });

    test('a report older than 14 days is locked', async ({ page }) => {
      const field = UI_RESOURCES[run.lang].field;
      const market = run.market();
      const past = pastReports(market);
      past.reports[PAST_ID]!.change = { canChange: false, locked: true };
      await installFakeFieldApi(page, market, { verified: true, consented: true, ...past });
      await page.goto(`/r/${CODE}`);
      await page.getByRole('link', { name: field.today.pastReports }).click();
      await page.getByRole('link', { name: /RL-2041-0187/ }).click();
      await expect(page.getByText(field.history.change.locked)).toBeVisible();
      await expect(page.getByRole('button', { name: field.history.change.button })).toHaveCount(0);
      await expectFieldScreen(page);
    });
  });
}

test.describe('a two-site reporter (F14, W2-03)', () => {
  test.use({ locale: 'en-US' });

  test('nearest deadline first, the switcher, and a daily link opening its own site', async ({
    page,
  }) => {
    const field = UI_RESOURCES.en.field;
    const market = kestrel();
    const pier: Market['site'] = { ...market.site, id: PIER_9, name: 'Pier 9' };
    // Pier 9's deadline is the nearer one from now.
    const deadlines = {
      [market.site.id]: new Date(Date.now() + 5 * 3_600_000).toISOString(),
      [PIER_9]: new Date(Date.now() + 1 * 3_600_000).toISOString(),
    };
    const api = await installFakeFieldApi(page, market, {
      verified: true,
      consented: true,
      moreSites: [pier],
      deadlines,
    });
    await page.goto(`/r/${CODE}`);
    const pierSwitcher = page.getByRole('button', { name: `Pier 9, ${field.today.changeSite}` });
    await expect(pierSwitcher).toBeVisible();
    await expectFieldScreen(page);

    await pierSwitcher.click();
    await page
      .getByRole('dialog', { name: field.today.siteSheetTitle })
      .getByRole('button', { name: market.site.name })
      .click();
    await expect(
      page.getByRole('button', { name: `${market.site.name}, ${field.today.changeSite}` }),
    ).toBeVisible();
    expect(api.calls.some((c) => c.path === 'today' && c.headers['x-link-code'] === CODE)).toBe(
      true,
    );

    // The other site's daily link opens that site, with no switcher (a daily link names one site).
    api.options.dailyLinkSite = market.site.id;
    await page.goto('/r/D4ILY2');
    await expect(page.getByText(market.site.name)).toBeVisible();
    await expect(
      page.getByRole('button', { name: new RegExp(field.today.changeSite) }),
    ).toHaveCount(0);
  });
});

test.describe('Past reports at 1440 px (W2-03)', () => {
  test('works at 1440 px too', async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    const market = kestrel();
    await installFakeFieldApi(page, market, {
      verified: true,
      consented: true,
      ...pastReports(market),
    });
    await page.goto('/r/K7Q2MX');
    await page.getByRole('link', { name: UI_RESOURCES.en.field.today.pastReports }).click();
    await expect(page.getByText('RL-2041-0187')).toBeVisible();
    await expectFieldScreen(page);
    // W2-11: the report view with Change something and its sheet.
    await page.getByRole('link', { name: /RL-2041-0187/ }).click();
    await page.getByRole('button', { name: UI_RESOURCES.en.field.history.change.button }).click();
    await expect(page.getByRole('dialog')).toBeVisible();
    await expectFieldScreen(page);
  });
});

/** A 1×1 PNG: what the photo picker hands the page in the Filed tests (F9). */
const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==',
  'base64',
);

for (const run of RUNS) {
  test.describe(`Filed: Add more photos (F9, W2-04) in ${run.lang}`, () => {
    test.use({ locale: run.locale });

    test('two photos from the Filed screen make version 2', async ({ page }) => {
      const field = UI_RESOURCES[run.lang].field;
      const market = run.market();
      const filed: ReportView = {
        ...pastReports(market).reports[PAST_ID]!,
        date: market.date,
        currentVersion: 1,
        pdfUrl: '/__storage/pdfs/RL-2041-0187_v1.pdf?token=e2e',
        addPhotos: { canAdd: true, remaining: 4, until: '2026-10-11T04:59:00.000Z', pending: 0 },
      };
      const api = await installFakeFieldApi(page, market, {
        verified: true,
        consented: true,
        reports: { [PAST_ID]: filed },
      });
      await page.goto(`/r/${CODE}/report/${PAST_ID}`);
      await expect(page.getByRole('heading', { level: 1, name: field.filed.title })).toBeVisible();
      await expect(page.getByRole('link', { name: field.filed.pastReports })).toHaveAttribute(
        'href',
        '/history',
      );
      await expectFieldScreen(page);

      await page.locator('input[type="file"]').setInputFiles([
        { name: 'level4-a.png', mimeType: 'image/png', buffer: PNG },
        { name: 'level4-b.png', mimeType: 'image/png', buffer: PNG },
      ]);
      const dialog = page.getByRole('dialog');
      await expect(dialog).toContainText(field.filed.photos.chosen.replace('{{count}}', '2'));
      await expect(dialog.getByRole('img')).toHaveCount(2);
      await expectFieldScreen(page);
      await dialog.getByRole('button', { name: field.filed.photos.send }).click();

      await expect(
        page.getByRole('status').filter({
          hasText: field.filed.photos.added.replace('{{version}}', '2'),
        }),
      ).toBeVisible();
      await expect(page.getByRole('link', { name: /_v2\.pdf/ })).toBeVisible();
      const sent = api.calls
        .filter((c) => c.path === 'uploads')
        .map((c) => (c.body as { addTo: { batchId: string; photos: number } }).addTo);
      expect(sent).toHaveLength(2);
      expect(new Set(sent.map((a) => a.batchId)).size).toBe(1);
      expect(sent[0]!.photos).toBe(2);
      expect(Object.values(api.batches)[0]!.version).toBe(2);
      await expectFieldScreen(page);
    });
  });
}

test.describe('Filed with Add more photos at 1440 px', () => {
  test.use({ viewport: { width: 1440, height: 900 } });

  test('lays out the actions side by side', async ({ page }) => {
    const field = UI_RESOURCES.en.field;
    const market = kestrel('en-US');
    await installFakeFieldApi(page, market, {
      verified: true,
      consented: true,
      reports: {
        [PAST_ID]: {
          ...pastReports(market).reports[PAST_ID]!,
          addPhotos: { canAdd: true, remaining: 4, until: '2026-10-11T04:59:00.000Z', pending: 0 },
        },
      },
    });
    await page.goto(`/r/${CODE}/report/${PAST_ID}`);
    await expect(page.getByRole('button', { name: field.filed.addPhotos })).toBeVisible();
    await expectFieldScreen(page);
  });
});

// ── W2-10: Fix by voice and the steppers on the draft (F8, §10.6, Q80) ─────────────────────────

/** The question answered with its second option: the draft (Field-06). */
async function toDraft(page: Page, lang: keyof typeof UI_RESOURCES, market: Market) {
  const field = UI_RESOURCES[lang].field;
  await toQuestion(page, lang, market);
  await page.getByRole('button', { name: market.question.options[1] }).click();
  await expect(page.getByRole('heading', { level: 1, name: field.draft.title })).toBeVisible({
    timeout: 10_000,
  });
}

/** The preview line of "one more worker" on the fixed crew (code's numbers, as the worker sends). */
const FIX_LINE: Record<'en' | 'es' | 'tr', string> = {
  en: 'Apex Concrete 6 → 7 workers, 48 → 56 h',
  es: 'Apex Concrete 6 → 7 trabajadores, 48 → 56 h',
  tr: 'Demir Yapı ekibi 6 → 7 çalışan, 48 → 56 saat',
};

for (const run of RUNS) {
  test.describe(`Fix by voice on the draft (F8, W2-10) in ${run.lang}`, () => {
    test.use({ locale: run.locale });

    test('said on the draft: listening, the preview, Save change, the new revision filed', async ({
      page,
    }) => {
      const field = UI_RESOURCES[run.lang].field;
      const fix = field.draft.fix;
      const market = run.market();
      const api = await installFakeFieldApi(page, market, { verified: true, consented: true });
      await toDraft(page, run.lang, market);
      await page.getByRole('button', { name: fix.button }).click();
      const sheet = page.getByRole('dialog', { name: fix.title });
      await expect(sheet).toBeVisible();
      await expectFieldScreen(page);
      const record = sheet.getByRole('button', { name: fix.record });
      expect((await record.boundingBox())!.height, 'Record ≥ 120 px').toBeGreaterThanOrEqual(120);
      await record.click();
      await expect(sheet.getByRole('timer')).toHaveText(/^00:0[1-9] \/ 00:30$/, {
        timeout: 10_000,
      });
      await sheet.getByRole('button', { name: fix.stop }).click();
      await expect(sheet).toHaveCount(0);

      // The worker listens, then the preview from code's numbers; nothing is sent meanwhile.
      const preview = page.getByRole('region', { name: fix.previewTitle });
      await expect(preview).toBeVisible({ timeout: 15_000 });
      await expect(preview.getByRole('listitem')).toHaveText(FIX_LINE[run.lang]);
      await expect(page.getByRole('button', { name: field.draft.confirm })).toBeDisabled();
      await expectFieldScreen(page);
      await preview.getByRole('button', { name: fix.save }).click();

      // The draft again, at its new revision, with the change; then Confirm & send files it.
      await expect(page.getByRole('status').filter({ hasText: fix.saved }).first()).toBeVisible({
        timeout: 15_000,
      });
      await expect(page.getByRole('heading', { level: 1, name: field.draft.title })).toBeVisible({
        timeout: 15_000,
      });
      await expect(
        page.getByText(`7 × ${run.lang === 'tr' ? '8 sa' : '8 h'}`).first(),
      ).toBeVisible();
      await expectFieldScreen(page);
      await page.getByRole('button', { name: field.draft.confirm }).click();
      await expect(page.getByRole('heading', { level: 1, name: field.filed.title })).toBeVisible({
        timeout: 15_000,
      });

      // What the app sent: the clip as a correction clip of the draft, then the fix and the save.
      const upload = api.calls.filter((c) => c.method === 'POST' && c.path === 'uploads').at(-1)!;
      expect(upload.body).toMatchObject({ kind: 'audio', fixTo: { reportId: REPORT_ID } });
      expect(upload.body).not.toHaveProperty('siteId');
      expect(api.calls.find((c) => c.path === `reports/${REPORT_ID}/correction`)!.body).toEqual({
        uploadId: api.stored.at(-1)!.uploadId,
      });
      expect(api.calls.some((c) => /^reports\/[^/]+\/correction\/[^/]+\/apply$/.test(c.path))).toBe(
        true,
      );
      expect(api.calls.find((c) => c.path === `reports/${REPORT_ID}/confirm`)?.body).toEqual({
        version: 1,
        draftRev: 2,
      });
      // Not a voice note of the report.
      expect(api.completed).toHaveLength(1);
    });
  });
}

test.describe('the steppers and a fix it cannot make (F8, W2-10)', () => {
  test.use({ locale: 'en-US' });

  test('a crew line’s stepper saves the numbers on the draft shown; 390 and 1440 px', async ({
    page,
  }) => {
    const field = UI_RESOURCES.en.field;
    const market = kestrel('en-US');
    const api = await installFakeFieldApi(page, market, { verified: true, consented: true });
    await toDraft(page, 'en', market);
    await page
      .getByRole('button', { name: 'Ironclad Steel, 3 workers, 8 hours each — change' })
      .click();
    const sheet = page.getByRole('dialog', { name: 'Ironclad Steel' });
    await expect(sheet).toBeVisible();
    await expectFieldScreen(page);
    await sheet.getByRole('button', { name: field.draft.stepper.moreWorkers }).click();
    await expect(sheet.getByRole('textbox', { name: field.draft.stepper.workers })).toHaveValue(
      '4',
    );
    await expect(sheet.getByText('Total: 32 h')).toBeVisible();
    await sheet.getByRole('button', { name: field.draft.stepper.save }).click();
    await expect(
      page.getByRole('button', { name: 'Ironclad Steel, 4 workers, 8 hours each — change' }),
    ).toBeVisible({ timeout: 15_000 });
    expect(api.calls.find((c) => c.path === `reports/${REPORT_ID}/edit`)!.body).toEqual({
      version: 1,
      draftRev: 1,
      index: 3,
      workers: 4,
      hoursPerWorker: 8,
    });
    await page.setViewportSize({ width: 1440, height: 900 });
    await expectFieldScreen(page);
  });

  test('a typed fix that names no crew: the model’s question and Try again', async ({ page }) => {
    const fix = UI_RESOURCES.en.field.draft.fix;
    const market = kestrel('en-US');
    const api = await installFakeFieldApi(page, market, {
      verified: true,
      consented: true,
      fixAnswer: 'unclear',
    });
    await toDraft(page, 'en', market);
    await page.getByRole('button', { name: fix.button }).click();
    const sheet = page.getByRole('dialog', { name: fix.title });
    await sheet.getByRole('textbox', { name: fix.typeLabel }).fill('change it to three');
    await sheet.getByRole('button', { name: fix.send }).click();
    await expect(page.getByText(fix.unclear)).toBeVisible({ timeout: 15_000 });
    await expect(page.getByText(market.fixClarification)).toBeVisible();
    await expect(
      page.getByRole('button', { name: UI_RESOURCES.en.field.draft.confirm }),
    ).toBeEnabled();
    await expectFieldScreen(page);
    expect(api.calls.find((c) => c.path === `reports/${REPORT_ID}/correction`)!.body).toEqual({
      text: 'change it to three',
    });
    await page.getByRole('button', { name: fix.tryAgain }).click();
    await expect(page.getByRole('dialog', { name: fix.title })).toBeVisible();
  });
});
