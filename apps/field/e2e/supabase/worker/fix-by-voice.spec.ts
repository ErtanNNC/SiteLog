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
 * W2-10 (F8 *Fix by voice*, §10.6) against the local Supabase stack with the CI worker running
 * (the `worker` project; skips without WORKER_HEALTH_URL): the seeded draft (Apex Concrete 6 ×
 * 8 h) → *Fix by voice* → Chromium's fake microphone records a short fix → the clip goes up as a
 * correction clip of the draft (`fixTo`) → `correction {uploadId}` → the worker's
 * apply_correction: the fake transcriber's correction clip ("Apex had seven, not six.",
 * fixtures/voice) and the fake Claude's recorded output (fixtures/corrections; CI's worker runs
 * EXTRACT_PROVIDER=fake) → the preview "Apex Concrete 6 → 7 workers, 48 → 56 h" → Save change →
 * decide_next → the draft again, 7 × 8 = 56 h with the clip as the source → Confirm & send files
 * that revision. Independent of the date: the draft's day is the seed's.
 */
test.describe.configure({ mode: 'serial' });

const copy = UI_RESOURCES.en.field;
let f: FieldFixture | undefined;
let d: SeededDraft | undefined;

test.beforeAll(async () => {
  test.skip(!process.env.WORKER_HEALTH_URL, 'needs the worker on the stack (WORKER_HEALTH_URL)');
  f = await createFieldFixture();
  d = await seedDraft(f);
});

test.afterAll(async () => {
  await dropFieldFixture(f);
});

test('Fix by voice → apply_correction → preview → Save change → 7 × 8 = 56 h → filed', async ({
  page,
  context,
}) => {
  const fx = f!;
  const draft = d!;
  const cookie = await verifiedDevice(fx);
  await context.addCookies([
    { name: cookie.name, value: cookie.value, url: FIELD_E2E_URL, httpOnly: true, sameSite: 'Lax' },
  ]);
  await page.goto(`/r/${fx.code}`);
  await expect(page).toHaveURL(/\/today$/);
  await page
    .getByRole('link', { name: copy.today.openReport.replace('{{no}}', draft.reportNo) })
    .click();
  await expect(page.getByRole('heading', { level: 1, name: copy.draft.title })).toBeVisible();

  await page.getByRole('button', { name: copy.draft.fix.button }).click();
  const sheet = page.getByRole('dialog', { name: copy.draft.fix.title });
  await sheet.getByRole('button', { name: copy.draft.fix.record }).click();
  await expect(sheet.getByRole('timer')).toHaveText(/^00:0[2-9] \/ 00:30$/, { timeout: 10_000 });
  await sheet.getByRole('button', { name: copy.draft.fix.stop }).click();

  const preview = page.getByRole('region', { name: copy.draft.fix.previewTitle });
  await expect(preview).toBeVisible({ timeout: 60_000 });
  await expect(preview.getByRole('listitem')).toHaveText('Apex Concrete 6 → 7 workers, 48 → 56 h');
  await expectFieldScreen(page);
  await preview.getByRole('button', { name: copy.draft.fix.save }).click();

  await expect(
    page.getByRole('button', { name: 'Apex Concrete, 7 workers, 8 hours each — change' }),
  ).toBeVisible({ timeout: 60_000 });
  const [fix] = await rest<{ upload_id: string; status: string }[]>(
    'GET',
    `draft_corrections?select=upload_id,status&report_id=eq.${draft.reportId}`,
  );
  expect(fix!.status).toBe('applied');
  const [version] = await rest<
    {
      data: { manpower: { workers: number; totalHours: number; source: unknown[] }[] };
      draft_rev: number;
    }[]
  >('GET', `report_versions?select=data,draft_rev&report_id=eq.${draft.reportId}&version=eq.1`);
  expect(version!.data.manpower[0]).toMatchObject({ workers: 7, totalHours: 56 });
  expect(version!.data.manpower[0]!.source).toEqual(
    expect.arrayContaining([
      expect.objectContaining({ type: 'voice_note', uploadId: fix!.upload_id, start: 0 }),
    ]),
  );
  // The clip is never report material.
  expect(await rest('GET', `report_sources?select=id&upload_id=eq.${fix!.upload_id}`)).toEqual([]);

  await page.getByRole('button', { name: copy.draft.confirm }).click();
  await expect(page.getByRole('heading', { level: 1, name: copy.filed.title })).toBeVisible({
    timeout: 60_000,
  });
  const [report] = await rest<{ status: string }[]>(
    'GET',
    `reports?select=status&id=eq.${draft.reportId}`,
  );
  expect(report!.status).toBe('filed');
});
