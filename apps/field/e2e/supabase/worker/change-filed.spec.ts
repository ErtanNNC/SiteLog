import { expect, test } from '@playwright/test';
import { UI_RESOURCES } from '@sitelog/shared/copy/ui/index.ts';
import { expectFieldScreen } from '../../support/checks.ts';
import {
  createFieldFixture,
  dropFieldFixture,
  FIELD_E2E_URL,
  rest,
  seedDraft,
  verifiedDevice,
  type FieldFixture,
  type SeededDraft,
} from '../stack.ts';

/**
 * W2-11 (F10 *Change something*, Done when) against the local Supabase stack with the CI worker
 * (the `worker` project; skips without WORKER_HEALTH_URL): today's report with Apex Concrete at
 * 6 × 8 h, filed → Past reports → the report → *Change something* → Chromium's fake microphone →
 * the clip as a correction clip of the filed report (`fixTo`) → `correction {uploadId}` → the
 * worker's apply_correction (the fake transcriber's "Apex had seven, not six.", the fake Claude's
 * recorded output) → the preview "Apex Concrete 6 → 7 workers, 48 → 56 h" → Save change →
 * version 2 with Marco's change note → render_pdf (`_v2`), the "Updated" email once and the
 * `edit_applied` text once (this demo org's console driver: the Demo phone).
 */
test.describe.configure({ mode: 'serial' });

const copy = UI_RESOURCES.en.field;
let f: FieldFixture | undefined;
let d: SeededDraft | undefined;

test.beforeAll(async () => {
  test.skip(!process.env.WORKER_HEALTH_URL, 'needs the worker on the stack (WORKER_HEALTH_URL)');
  f = await createFieldFixture();
  // The site's report recipient (§13 "Recipients + signer"), as the photos and answer specs set
  // it: the fixture's site has none, and an email with no recipient is skipped.
  await rest('POST', 'site_recipients', { site_id: f.site.id, email: 'pm@e2e-field.example' });
  d = await seedDraft(f);
  // Filed as file_report leaves it.
  const now = new Date().toISOString();
  await rest('PATCH', `reports?id=eq.${d.reportId}`, {
    status: 'filed',
    confirmed_at: now,
    confirmed_via: 'web',
    filed_at: now,
  });
  await rest('PATCH', `site_days?report_id=eq.${d.reportId}`, { status: 'filed' });
});

test.afterAll(async () => {
  await dropFieldFixture(f);
});

test('Change something → apply_correction → preview → Save change → v2, _v2, Updated, edit_applied', async ({
  page,
  context,
}) => {
  const fx = f!;
  const report = d!;
  const cookie = await verifiedDevice(fx);
  await context.addCookies([
    { name: cookie.name, value: cookie.value, url: FIELD_E2E_URL, httpOnly: true, sameSite: 'Lax' },
  ]);
  await page.goto(`/r/${fx.code}`);
  await expect(page).toHaveURL(/\/today$/);
  await page.getByRole('link', { name: copy.today.pastReports }).click();
  await page.getByRole('link', { name: new RegExp(report.reportNo) }).click();
  await page.getByRole('button', { name: copy.history.change.button }).click();
  const sheet = page.getByRole('dialog', { name: copy.history.change.title });
  await sheet.getByRole('button', { name: copy.draft.fix.record }).click();
  await expect(sheet.getByRole('timer')).toHaveText(/^00:0[2-9] \/ 00:30$/, { timeout: 10_000 });
  await sheet.getByRole('button', { name: copy.draft.fix.stop }).click();

  const preview = page.getByRole('region', { name: copy.draft.fix.previewTitle });
  await expect(preview).toBeVisible({ timeout: 60_000 });
  await expect(preview.getByRole('listitem')).toHaveText('Apex Concrete 6 → 7 workers, 48 → 56 h');
  await expectFieldScreen(page);
  await preview.getByRole('button', { name: copy.draft.fix.save }).click();
  await expect(
    page
      .getByRole('status')
      .filter({ hasText: copy.history.change.saved.replace('{{version}}', '2') }),
  ).toBeVisible({ timeout: 30_000 });

  const [v2] = await rest<
    {
      author: string;
      via: string;
      change_note: string;
      author_reporter_id: string;
      data: { manpower: { workers: number; totalHours: number }[] };
    }[]
  >(
    'GET',
    `report_versions?select=author,via,change_note,author_reporter_id,data&report_id=eq.${report.reportId}&version=eq.2`,
  );
  expect(v2).toMatchObject({
    author: 'reporter',
    via: 'web',
    change_note: 'Apex Concrete 6 → 7 workers, 48 → 56 h',
    author_reporter_id: fx.reporter.id,
  });
  expect(v2!.data.manpower[0]).toMatchObject({ workers: 7, totalHours: 56 });

  // render_pdf: the PDF card names _v2.
  await expect(page.getByRole('link', { name: /_v2\.pdf/ })).toBeVisible({ timeout: 60_000 });

  // The "Updated" email and the edit_applied text, once each.
  const emails = () =>
    rest<{ subject: string; body_text: string; recipients: string[] }[]>(
      'GET',
      `console_emails?select=subject,body_text,recipients&org_id=eq.${fx.orgId}&kind=eq.report_updated`,
    );
  await expect.poll(async () => (await emails()).length, { timeout: 60_000 }).toBe(1);
  const [email] = await emails();
  expect(email!.recipients).toEqual(['pm@e2e-field.example']);
  expect(email!.subject).toMatch(new RegExp(`^Updated: ${report.reportNo} · `));
  expect(email!.body_text).toContain('Apex Concrete 6 → 7 workers, 48 → 56 h');
  const texts = () =>
    rest<{ body: string }[]>(
      'GET',
      `messages?select=body&reporter_id=eq.${fx.reporter.id}&copy_key=eq.edit_applied`,
    );
  await expect.poll(async () => (await texts()).length, { timeout: 60_000 }).toBe(1);
  expect((await texts())[0]!.body).toMatch(
    /^Updated \w+day: Apex Concrete 6 -> 7 workers, 48 -> 56 h\. Version 2 sent to the office\.$/,
  );
});
