import { expect, test } from '@playwright/test';
import { UI_RESOURCES } from '@sitelog/shared/copy/ui/index.ts';
import { expectFieldScreen } from '../../support/checks.ts';
import {
  createFieldFixture,
  dropFieldFixture,
  FIELD_E2E_URL,
  rest,
  seedFiledReport,
  verifiedDevice,
  type FieldFixture,
  type FiledReport,
} from '../stack.ts';

/**
 * W2-04 (F9) against the local Supabase stack with the CI worker running (the `worker` project;
 * skips without WORKER_HEALTH_URL): a reporter opens today's filed report on a verified phone →
 * *Add more photos* → two photos → *Send photos*: the queue PUTs both to Storage and completes
 * them through the real field-api as one batch; the second completion makes version 2 "2 photos
 * added" (`field_attach_photos()`), the worker renders the `_v2` PDF and sends the "Updated"
 * email (the console provider: the Demo phone's Email tab); the Filed screen names `_v2`, and
 * the day stays filed (the Overview row says Filed).
 */
test.describe.configure({ mode: 'serial' });

const copy = UI_RESOURCES.en.field;
const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==',
  'base64',
);
let f: FieldFixture | undefined;
let filed: FiledReport | undefined;

test.beforeAll(async () => {
  test.skip(!process.env.WORKER_HEALTH_URL, 'needs the worker on the stack (WORKER_HEALTH_URL)');
  f = await createFieldFixture();
  filed = await seedFiledReport(f);
  await rest('POST', 'site_recipients', { site_id: f.site.id, email: 'pm@e2e-field.example' });
});

test.afterAll(async () => {
  await dropFieldFixture(f);
});

test('two photos from the Filed screen make version 2, its _v2 PDF and the Updated email', async ({
  page,
  context,
}) => {
  const fx = f!;
  const report = filed!;
  const cookie = await verifiedDevice(fx);
  await context.addCookies([
    { name: cookie.name, value: cookie.value, url: FIELD_E2E_URL, httpOnly: true, sameSite: 'Lax' },
  ]);

  await page.goto(`/r/${fx.code}/report/${report.reportId}`);
  await expect(page.getByRole('heading', { level: 1, name: copy.filed.title })).toBeVisible();
  await expect(page.getByRole('button', { name: copy.filed.addPhotos })).toBeVisible();
  await expectFieldScreen(page);

  await page.locator('input[type="file"]').setInputFiles([
    { name: 'level4-a.png', mimeType: 'image/png', buffer: PNG },
    { name: 'level4-b.png', mimeType: 'image/png', buffer: PNG },
  ]);
  await page.getByRole('dialog').getByRole('button', { name: copy.filed.photos.send }).click();

  await expect(
    page
      .getByRole('status')
      .filter({ hasText: copy.filed.photos.added.replace('{{version}}', '2') }),
  ).toBeVisible({ timeout: 60_000 });
  const [v2] = await rest<
    { author: string; via: string; change_note: string; data: { photos: unknown[] } }[]
  >(
    'GET',
    `report_versions?select=author,via,change_note,data&report_id=eq.${report.reportId}&version=eq.2`,
  );
  expect(v2).toMatchObject({ author: 'reporter', via: 'web', change_note: '2 photos added' });
  expect(v2!.data.photos).toHaveLength(2);

  // The worker's render_pdf: the PDF card names _v2.
  await expect(page.getByRole('link', { name: /_v2\.pdf/ })).toBeVisible({ timeout: 60_000 });
  await expectFieldScreen(page);

  // The "Updated" email, once, with the change note.
  const emails = () =>
    rest<{ kind: string; subject: string; body_text: string }[]>(
      'GET',
      `console_emails?select=kind,subject,body_text&org_id=eq.${fx.orgId}&kind=eq.report_updated`,
    );
  await expect.poll(async () => (await emails()).length, { timeout: 60_000 }).toBe(1);
  const [email] = await emails();
  expect(email!.subject).toMatch(new RegExp(`^Updated: ${report.reportNo} · `));
  expect(email!.body_text).toContain('2 photos added');

  // The day stays filed (the Overview row), and the report is filed at version 2.
  const [r] = await rest<{ status: string; current_version: number }[]>(
    'GET',
    `reports?select=status,current_version&id=eq.${report.reportId}`,
  );
  expect(r).toEqual({ status: 'filed', current_version: 2 });
  const [day] = await rest<{ status: string }[]>(
    'GET',
    `site_days?select=status&report_id=eq.${report.reportId}`,
  );
  expect(day!.status).toBe('filed');
});
