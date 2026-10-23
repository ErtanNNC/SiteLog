import { expect, test } from '@playwright/test';
import { UI_RESOURCES } from '@sitelog/shared/copy/ui/index.ts';
import { expectFieldScreen } from '../support/checks.ts';
import {
  createFieldFixture,
  deviceCode,
  dropFieldFixture,
  FIELD_E2E_URL,
  rest,
  verifiedDevice,
  type FieldFixture,
} from './stack.ts';

/**
 * W1-09 against the local Supabase stack (`playwright.supabase.config.ts`; CI's e2e-supabase job
 * runs it after the field-api warm-up, before the worker starts): a reporter opens their personal
 * link in Chromium with a fake microphone, at 390 px, through the field preview server's `/api`
 * proxy to the real field-api → resolve → device check (the code read from the console `messages`
 * row, as the Demo phone shows it) → welcome and consent → Today → record → Stop & send: the clip
 * goes to Storage by signed URL, `complete` creates the report (`processing`, channel `web`) and
 * the `transcribe_upload` job, and the Processing screen polls it. axe on every screen. Since
 * W2-17 the spec runs in CI's M6 step with the worker up (fake transcriber and Claude): the worker
 * may take the report past Processing (a question, the draft) within a poll or two, so the screen
 * after Stop & send is checked for whichever of the two it shows, and Today is opened by URL.
 *
 * W2-17 (M6 acceptance, F5 step 3): the same recorder without signal. Stop & send in airplane
 * mode keeps the clip on the phone ("Saved on your phone"), and the signal coming back sends it
 * through the real field-api with no tap: the upload, its report and the transcription job.
 * Both tests are tagged `@m6 @F5` (`pnpm e2e:m6`).
 */
test.describe.configure({ mode: 'serial' });

const copy = UI_RESOURCES.en.field;
let f: FieldFixture | undefined;

test.beforeAll(async () => {
  f = await createFieldFixture();
});

test.afterAll(async () => {
  await dropFieldFixture(f);
});

test(
  'first open → record → upload creates the report and the transcription job',
  { tag: ['@m6', '@F5'] },
  async ({ page }) => {
    const fx = f!;
    await page.goto(`/r/${fx.code}`);

    // Device check (F4 step 2).
    await expect(
      page.getByRole('heading', {
        level: 1,
        name: copy.device.title.replace('{{name}}', fx.reporter.name),
      }),
    ).toBeVisible();
    await expectFieldScreen(page);
    await page.getByRole('button', { name: copy.device.send }).click();
    const input = page.getByLabel(copy.device.codeLabel);
    await expect(input).toBeVisible();
    await expectFieldScreen(page);
    await input.fill(await deviceCode(fx.reporter.id));

    // Welcome and consent (F4 step 3).
    await expect(
      page.getByRole('heading', {
        level: 1,
        name: copy.welcome.title.replace('{{name}}', fx.reporter.firstName),
      }),
    ).toBeVisible();
    await expectFieldScreen(page);
    // §19 Q376: no WhatsApp box; the sentence above Continue says what Continue gives.
    await expect(page.getByText(copy.welcome.whatsappNotice, { exact: true })).toBeVisible();
    await page.getByRole('checkbox', { name: copy.welcome.consentRequired }).check();
    await page.getByRole('button', { name: copy.welcome.continue }).click();

    // F4's optional test recording (W2-13), skipped.
    await expect(
      page.getByRole('heading', { level: 1, name: copy.welcomeTest.title }),
    ).toBeVisible();
    await page.getByRole('button', { name: copy.welcomeTest.skip }).click();

    // Today.
    await expect(page).toHaveURL(/\/today$/);
    await expect(page.getByRole('banner')).toContainText(fx.site.name);
    await expect(page.getByText(copy.today.status.notSent)).toBeVisible();
    await expectFieldScreen(page);

    // Recording with the fake microphone, a little over the 5 s minimum.
    await page.getByRole('link', { name: copy.today.record }).click();
    await expect(page.getByRole('button', { name: copy.recording.pause })).toBeEnabled();
    await expect(page.getByRole('timer')).toHaveText(/^00:0[5-9]$/, { timeout: 15_000 });
    await expectFieldScreen(page);
    await page.getByRole('button', { name: copy.recording.stopSend }).click();

    // Processing: the report exists once `complete` answered.
    await expect(page).toHaveURL(/\/report\/[0-9a-f-]{36}$/, { timeout: 30_000 });
    const reportId = /\/report\/([0-9a-f-]{36})$/.exec(page.url())![1]!;
    const reportNo = `${fx.site.projectCode}-0001`;
    const processing = page.getByRole('heading', { level: 1, name: copy.processing.title });
    // The report screen is up: Processing, or already a question or the draft when the worker
    // (CI's M6 step) got there first.
    await expect(page.getByRole('heading', { level: 1 }).first()).toBeVisible();
    // Processing names the report once its first poll answered, unless the worker (up in CI's M6
    // step) has already moved it on to a question or the draft, which do not name it; the number
    // is checked in the row and on Today below either way.
    const label = page.getByText(copy.processing.report.replace('{{no}}', reportNo));
    await expect
      .poll(async () => (await label.isVisible()) || !(await processing.isVisible()))
      .toBe(true);
    await expectFieldScreen(page);

    // The rows field-api wrote.
    const [report] = await rest<
      { channel: string; status: string; report_no: string; reporter_id: string }[]
    >('GET', `reports?select=channel,status,report_no,reporter_id&id=eq.${reportId}`);
    expect(report).toMatchObject({ channel: 'web', report_no: reportNo });
    // The worker may have picked the job up already (CI's M6 step runs it).
    expect(['processing', 'awaiting_answer', 'awaiting_confirmation']).toContain(report!.status);
    const uploads = await rest<
      { id: string; kind: string; mime: string; bytes: number; reporter_id: string }[]
    >('GET', `uploads?select=id,kind,mime,bytes,reporter_id&report_id=eq.${reportId}`);
    expect(uploads).toHaveLength(1);
    expect(uploads[0]).toMatchObject({
      kind: 'audio',
      mime: 'audio/webm',
      reporter_id: fx.reporter.id,
    });
    expect(uploads[0]!.bytes).toBeGreaterThan(0);
    const jobs = await rest<{ type: string }[]>(
      'GET',
      `jobs?select=type&payload->>uploadId=eq.${uploads[0]!.id}`,
    );
    expect(jobs).toEqual([{ type: 'transcribe_upload' }]);
    const consents = await rest<{ type: string; method: string; text_version: string }[]>(
      'GET',
      `consents?select=type,method,text_version&reporter_id=eq.${fx.reporter.id}&revoked_at=is.null`,
    );
    // `order=type` would sort by the consent_type enum's declared order, not by name: sort here.
    consents.sort((a, b) => a.type.localeCompare(b.type));
    // The run's packs list WhatsApp (`E2E_SMS_ORDER`): Continue gives it under the sentence above
    // the button (§19 Q376), with the wording's version `field.consent.v2`.
    expect(consents).toEqual([
      { type: 'data_processing', method: 'web_checkbox', text_version: 'field.consent.v2' },
      { type: 'recording', method: 'web_checkbox', text_version: 'field.consent.v2' },
      { type: 'sms', method: 'web_checkbox', text_version: 'field.consent.v2' },
      { type: 'whatsapp', method: 'web_checkbox', text_version: 'field.consent.v2' },
    ]);
    const [reporter] = await rest<{ status: string }[]>(
      'GET',
      `reporters?select=status&id=eq.${fx.reporter.id}`,
    );
    expect(reporter!.status).toBe('active');

    // Today again (by URL: a question or the draft has no Back to Today): the day is in progress
    // and the report opens from there.
    await page.goto('/today');
    await expect(page.getByText(copy.today.status.inProgress)).toBeVisible();
    await expect(
      page.getByRole('link', { name: copy.today.openReport.replace('{{no}}', reportNo) }),
    ).toBeVisible();
  },
);

test(
  'offline: the clip waits on the phone and goes when the signal is back',
  { tag: ['@m6', '@F5'] },
  async ({ page, context }) => {
    // A fixture of its own: the first test's phone and report are not this one's.
    const fx = await createFieldFixture();
    try {
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
      await page.getByRole('link', { name: copy.today.record }).click();
      await expect(page.getByRole('button', { name: copy.recording.pause })).toBeEnabled();
      await expect(page.getByRole('timer')).toHaveText(/^00:0[5-9]$/, { timeout: 15_000 });

      // Airplane mode, then Stop & send: saved on the phone (IndexedDB), nothing reached the stack.
      await context.setOffline(true);
      await page.getByRole('button', { name: copy.recording.stopSend }).click();
      await expect(
        page.getByRole('heading', { level: 1, name: copy.sending.queued }),
      ).toBeVisible();
      await expect(page.getByText(copy.offline.banner)).toBeVisible();
      await expect(page.getByText(copy.offline.queued.replace('{{count}}', '1'))).toBeVisible();
      expect(await rest('GET', `uploads?select=id&site_id=eq.${fx.site.id}`)).toEqual([]);

      // The signal is back: the queue sends by itself.
      await context.setOffline(false);
      await page.evaluate(() => window.dispatchEvent(new Event('online')));
      await expect
        .poll(
          async () =>
            (
              await rest<{ report_id: string | null }[]>(
                'GET',
                `uploads?select=report_id&site_id=eq.${fx.site.id}&kind=eq.audio`,
              )
            ).filter((u) => u.report_id !== null).length,
          { timeout: 30_000 },
        )
        .toBe(1);
      const [upload] = await rest<{ id: string; report_id: string }[]>(
        'GET',
        `uploads?select=id,report_id&site_id=eq.${fx.site.id}&kind=eq.audio`,
      );
      const jobs = await rest<{ type: string }[]>(
        'GET',
        `jobs?select=type&payload->>uploadId=eq.${upload!.id}`,
      );
      expect(jobs).toEqual([{ type: 'transcribe_upload' }]);
      await expect(page.getByText(copy.offline.queued.replace('{{count}}', '1'))).toHaveCount(0);

      // Today shows the report on its way.
      await page.goto('/today');
      await expect(
        page.getByRole('link', {
          name: copy.today.openReport.replace('{{no}}', `${fx.site.projectCode}-0001`),
        }),
      ).toBeVisible();
    } finally {
      await dropFieldFixture(fx);
    }
  },
);
