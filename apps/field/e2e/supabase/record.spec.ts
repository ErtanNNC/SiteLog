import { expect, test } from '@playwright/test';
import { UI_RESOURCES } from '@sitelog/shared/copy/ui/index.ts';
import { expectFieldScreen } from '../support/checks.ts';
import { createFieldFixture, dropFieldFixture, rest, type FieldFixture } from './stack.ts';

/**
 * W1-09 against the local Supabase stack (`playwright.supabase.config.ts`; CI's e2e-supabase job
 * runs it after the field-api warm-up, before the worker starts): a reporter opens their personal
 * link in Chromium with a fake microphone, at 390 px, through the field preview server's `/api`
 * proxy to the real field-api → resolve → device check (the code read from the console `messages`
 * row, as the Demo phone shows it) → welcome and consent → Today → record → Stop & send: the clip
 * goes to Storage by signed URL, `complete` creates the report (`processing`, channel `web`) and
 * the `transcribe_upload` job, and the Processing screen polls it. axe on every screen.
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

/** The device code texted to the reporter: the newest console `verify_code` row's six digits. */
async function deviceCode(reporterId: string): Promise<string> {
  let otp = '';
  await expect
    .poll(
      async () => {
        const rows = await rest<{ body: string; provider: string }[]>(
          'GET',
          `messages?select=body,provider&reporter_id=eq.${reporterId}&copy_key=eq.verify_code&order=created_at.desc&limit=1`,
        );
        const m = /(\d{3})\s?(\d{3})/.exec(rows[0]?.body ?? '');
        if (m && rows[0]!.provider === 'console') otp = `${m[1]}${m[2]}`;
        return otp;
      },
      { timeout: 15_000 },
    )
    .toMatch(/^\d{6}$/);
  return otp;
}

test('first open → record → upload creates the report and the transcription job', async ({
  page,
}) => {
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
  await page.getByRole('checkbox', { name: copy.welcome.consentRequired }).check();
  await page.getByRole('button', { name: copy.welcome.continue }).click();

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
  await expect(page.getByRole('heading', { level: 1, name: copy.processing.title })).toBeVisible();
  await expect(page.getByText(`${fx.site.projectCode}-0001`, { exact: false })).toBeVisible();
  await expectFieldScreen(page);

  // The rows field-api wrote.
  const [report] = await rest<
    { channel: string; status: string; report_no: string; reporter_id: string }[]
  >('GET', `reports?select=channel,status,report_no,reporter_id&id=eq.${reportId}`);
  expect(report).toMatchObject({ channel: 'web', report_no: `${fx.site.projectCode}-0001` });
  // No worker runs in this step of CI; locally one may have picked the job up already.
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
  expect(consents).toEqual([
    { type: 'data_processing', method: 'web_checkbox', text_version: 'field.consent.v1' },
    { type: 'recording', method: 'web_checkbox', text_version: 'field.consent.v1' },
    { type: 'sms', method: 'web_checkbox', text_version: 'field.consent.v1' },
  ]);
  const [reporter] = await rest<{ status: string }[]>(
    'GET',
    `reporters?select=status&id=eq.${fx.reporter.id}`,
  );
  expect(reporter!.status).toBe('active');

  // Today again: the day is in progress and the report opens from there.
  await page.getByRole('link', { name: copy.sending.backToToday }).click();
  await expect(page.getByText(copy.today.status.inProgress)).toBeVisible();
  await expect(
    page.getByRole('link', {
      name: copy.today.openReport.replace('{{no}}', `${fx.site.projectCode}-0001`),
    }),
  ).toBeVisible();
});
