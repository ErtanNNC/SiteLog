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
 * W1-13 against the local Supabase stack with the CI worker running (the `worker` project of
 * `playwright.supabase.config.ts`; CI's e2e-supabase job runs it after "Start the worker", with
 * WORKER_HEALTH_URL set; without it the spec skips, since no worker would run decide_next): a
 * reporter on a verified phone opens today's report from Today, whose open question (seeded as
 * the worker leaves it after extraction) shows with its two answers → "5 · full day" → field-api
 * maps it in code and queues decide_next → F7's confirmation line → the worker's decide_next
 * moves the report to awaiting_confirmation → the draft with Delta at 5 × 8 h → Confirm & send →
 * field-api queues file_report for the version shown. axe on every screen.
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

test('open question → answer → draft (worker decide_next) → Confirm & send queues file_report', async ({
  page,
  context,
}) => {
  const fx = f!;
  const open = q!;
  const health = await fetch(process.env.WORKER_HEALTH_URL!).then((r) => r.json());
  expect(health).toMatchObject({ listening: true });

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

  // The link resolves without a device check or consent, then Today offers the open report.
  await page.goto(`/r/${fx.code}`);
  await expect(page).toHaveURL(/\/today$/);
  await page
    .getByRole('link', { name: copy.today.openReport.replace('{{no}}', open.reportNo) })
    .click();

  // The question (Field-05).
  await expect(page).toHaveURL(new RegExp(`/report/${open.reportId}$`));
  await expect(page.getByRole('heading', { level: 1, name: open.prompt })).toBeVisible();
  await expect(page.getByText(copy.question.heardAt.replace('{{time}}', '1:20'))).toBeVisible();
  await expectFieldScreen(page);
  await page.getByRole('button', { name: '5 · full day' }).click();

  // F7's line from field-api's numbers, then the draft once the worker's decide_next has run.
  await expect(
    page.getByText('Delta Mechanical: 5 workers, 8 hours each — 40 hours.').first(),
  ).toBeVisible();
  await expect(page.getByRole('heading', { level: 1, name: copy.draft.title })).toBeVisible({
    timeout: 60_000,
  });
  const crew = page.getByRole('region', { name: 'CREW' });
  await expect(crew).toContainText('11 · 88 h');
  await expect(crew.getByRole('listitem').filter({ hasText: 'Delta Mechanical' })).toContainText(
    '5 × 8 h',
  );
  await expectFieldScreen(page);

  // What the answer wrote: the question, the draft (code's total) and decide_next, done.
  const [question] = await rest<
    { answer: { optionId: string; parsed: unknown; via: string }; answer_source: unknown }[]
  >('GET', `questions?select=answer,answer_source&id=eq.${open.questionId}`);
  expect(question!.answer).toMatchObject({
    optionId: 'o2',
    parsed: { workers: 5, fullDay: true },
    via: 'web',
  });
  expect(question!.answer_source).toEqual({ type: 'answer', questionId: open.questionId });
  const [version] = await rest<{ data: { manpower: { workers: number; totalHours: number }[] } }[]>(
    'GET',
    `report_versions?select=data&report_id=eq.${open.reportId}&version=eq.1`,
  );
  expect(version!.data.manpower[1]).toMatchObject({ workers: 5, totalHours: 40 });
  const decide = await rest<{ status: string }[]>(
    'GET',
    `jobs?select=status&dedupe_key=eq.${encodeURIComponent(`decide:${open.reportId}:answer:${open.questionId}`)}`,
  );
  expect(decide).toEqual([{ status: 'done' }]);

  // Confirm & send (F8): file_report for the version shown; the screen waits for the filing.
  await page.getByRole('button', { name: copy.draft.confirm }).click();
  await expect(
    page.getByRole('heading', {
      level: 1,
      name: new RegExp(`^(${copy.filing.title}|${copy.processing.filedTitle})$`),
    }),
  ).toBeVisible();
  await expectFieldScreen(page);
  const jobs = await rest<{ type: string; payload: { trigger: string; version: number } }[]>(
    'GET',
    `jobs?select=type,payload&type=eq.file_report&payload->>reportId=eq.${open.reportId}`,
  );
  expect(jobs).toHaveLength(1);
  expect(jobs[0]!.payload).toMatchObject({ trigger: 'confirm', version: 1 });
  const audits = await rest<{ action: string }[]>(
    'GET',
    `audit_log?select=action&entity_id=eq.${open.reportId}&action=in.(report.question_answered,report.confirm_requested)&order=id`,
  );
  expect(audits.map((a) => a.action)).toEqual([
    'report.question_answered',
    'report.confirm_requested',
  ]);
});
