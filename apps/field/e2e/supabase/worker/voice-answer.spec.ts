import { expect, test } from '@playwright/test';
import { UI_RESOURCES } from '@sitelog/shared/copy/ui/index.ts';
import { expectFieldScreen } from '../../support/checks.ts';
import {
  createFieldFixture,
  dropFieldFixture,
  FIELD_E2E_URL,
  rest,
  seedOpenQuestion,
  verifiedDevice,
  type FieldFixture,
  type OpenQuestion,
} from '../stack.ts';

/**
 * W2-09 (F7 *Other…*, §10.7) against the local Supabase stack with the CI worker running (the
 * `worker` project; skips without WORKER_HEALTH_URL): the seeded Delta question → *Other — say
 * it* → Chromium's fake microphone records a short answer → the clip goes up as an answer clip of
 * the question (`answerTo`) → `answer {uploadId}` → the worker's parse_answer: the fake
 * transcriber's answer clip ("Five, all day.", fixtures/voice) and the fake Claude's recorded
 * output (fixtures/answers; CI's worker runs EXTRACT_PROVIDER=fake) → 5 × full day applied in
 * code, sourced to the answer and the clip → F7's line → decide_next → the draft. Independent of
 * the date: the question's day is the seed's, and nothing here reads the worker's clock.
 */
test.describe.configure({ mode: 'serial' });

const copy = UI_RESOURCES.en.field;
let f: FieldFixture | undefined;
let q: OpenQuestion | undefined;

test.beforeAll(async () => {
  test.skip(!process.env.WORKER_HEALTH_URL, 'needs the worker on the stack (WORKER_HEALTH_URL)');
  f = await createFieldFixture();
  q = await seedOpenQuestion(f);
});

test.afterAll(async () => {
  await dropFieldFixture(f);
});

test(
  'Other — say it → parse_answer → 5 × full day with the clip as a source → the draft',
  { tag: ['@m6', '@F7'] },
  async ({ page, context }) => {
    const fx = f!;
    const open = q!;
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
    await page
      .getByRole('link', { name: copy.today.openReport.replace('{{no}}', open.reportNo) })
      .click();
    await expect(page.getByRole('heading', { level: 1, name: open.prompt })).toBeVisible();

    await page.getByRole('button', { name: copy.question.other }).click();
    const sheet = page.getByRole('dialog', { name: copy.question.otherTitle });
    await sheet.getByRole('button', { name: copy.question.record }).click();
    await expect(sheet.getByRole('timer')).toHaveText(/^00:0[2-9] \/ 00:30$/, { timeout: 10_000 });
    await sheet.getByRole('button', { name: copy.question.stop }).click();

    // F7's line from code's numbers once the worker applied it, then the draft.
    await expect(
      page.getByText('Delta Mechanical: 5 workers, 8 hours each — 40 hours.').first(),
    ).toBeVisible({ timeout: 60_000 });
    await expect(page.getByRole('heading', { level: 1, name: copy.draft.title })).toBeVisible({
      timeout: 60_000,
    });
    await expectFieldScreen(page);

    const [question] = await rest<
      {
        answer: { text: string; parsed: unknown; voice: { uploadId: string } };
        voice_answers: { status: string }[];
      }[]
    >('GET', `questions?select=answer,voice_answers&id=eq.${open.questionId}`);
    expect(question!.answer).toMatchObject({
      text: 'Five, all day.',
      parsed: { workers: 5, fullDay: true },
    });
    expect(question!.voice_answers).toMatchObject([{ status: 'applied' }]);
    const clip = question!.answer.voice.uploadId;
    const [version] = await rest<
      { data: { manpower: { workers: number; totalHours: number; source: unknown[] }[] } }[]
    >('GET', `report_versions?select=data&report_id=eq.${open.reportId}&version=eq.1`);
    const delta = version!.data.manpower[1]!;
    expect(delta).toMatchObject({ workers: 5, totalHours: 40 });
    expect(delta.source).toEqual(
      expect.arrayContaining([
        { type: 'answer', questionId: open.questionId },
        expect.objectContaining({ type: 'voice_note', uploadId: clip, start: 0 }),
      ]),
    );
    // The clip is never report material.
    expect(await rest('GET', `report_sources?select=id&upload_id=eq.${clip}`)).toEqual([]);
    const [upload] = await rest<{ question_id: string; report_id: string }[]>(
      'GET',
      `uploads?select=question_id,report_id&id=eq.${clip}`,
    );
    expect(upload).toEqual({ question_id: open.questionId, report_id: open.reportId });
  },
);

/**
 * W2-17 (F7 *Other…* by number, D28, the M6 acceptance's third answer): a question of its own →
 * *Other — say it* → the sheet's number input → 6 → field-api maps it in code (full day by
 * default) → F7's line → the worker's decide_next → the draft at 6 × 8 = 48 h.
 */
test(
  'Other — a number typed in the sheet → 6 × full day in code → the draft',
  { tag: ['@m6', '@F7'] },
  async ({ page, context }) => {
    const fx = await createFieldFixture();
    try {
      const open = await seedOpenQuestion(fx);
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
      await page
        .getByRole('link', { name: copy.today.openReport.replace('{{no}}', open.reportNo) })
        .click();
      await expect(page.getByRole('heading', { level: 1, name: open.prompt })).toBeVisible();

      await page.getByRole('button', { name: copy.question.other }).click();
      const sheet = page.getByRole('dialog', { name: copy.question.otherTitle });
      await sheet.getByLabel(copy.question.workers).fill('6');
      await sheet.getByRole('button', { name: copy.question.send }).click();

      await expect(
        page.getByText('Delta Mechanical: 6 workers, 8 hours each — 48 hours.').first(),
      ).toBeVisible({ timeout: 30_000 });
      await expect(page.getByRole('heading', { level: 1, name: copy.draft.title })).toBeVisible({
        timeout: 60_000,
      });
      await expectFieldScreen(page);

      const [question] = await rest<{ answer: { parsed: unknown; via: string } }[]>(
        'GET',
        `questions?select=answer&id=eq.${open.questionId}`,
      );
      expect(question!.answer).toMatchObject({ parsed: { workers: 6, fullDay: true }, via: 'web' });
      const [version] = await rest<
        { data: { manpower: { workers: number; totalHours: number }[] } }[]
      >('GET', `report_versions?select=data&report_id=eq.${open.reportId}&version=eq.1`);
      expect(version!.data.manpower[1]).toMatchObject({ workers: 6, totalHours: 48 });
    } finally {
      await dropFieldFixture(fx);
    }
  },
);
