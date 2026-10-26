import { expect, test } from '@playwright/test';
import { UI_RESOURCES } from '@sitelog/shared/copy/ui/index.ts';
import { expectFieldScreen } from '../../support/checks.ts';
import { pickSite } from '../sites.ts';
import {
  addSite,
  createFieldFixture,
  dropFieldFixture,
  everyDayWorking,
  FIELD_E2E_URL,
  rest,
  verifiedDevice,
  type FieldFixture,
} from '../stack.ts';

/**
 * W2-17 (M6 acceptance, F12, tagged `@m6 @F12`; W2-08 built it, spec §19 Q41) against the local
 * Supabase stack with the CI worker running (the `worker` project; skips without
 * WORKER_HEALTH_URL): a reporter of two sites on a verified phone.
 * - *Site closed: weather* on the first: "Since when?" 09:00 and 12 on site before → field-api's
 *   `day-status` makes the site-day `weather_day` and a numbered weather-day report with its
 *   answers, queues `file_report`; the worker files it and writes the delay record
 *   (`weather_events`, from 09:00, not a full day, hours lost); Today shows the day closed with
 *   *Add a photo of the conditions*.
 * - *No work today* on the second: the site-day `no_work`, no report (the org's `no_work_pdf` is
 *   off by default), Today closed.
 * Every day is a working day for the org, so the run never meets `not_working_day`.
 */
test.describe.configure({ mode: 'serial' });

const copy = UI_RESOURCES.en.field;
let f: FieldFixture | undefined;
let second: { id: string; name: string; projectCode: string } | undefined;

test.beforeAll(async () => {
  test.skip(!process.env.WORKER_HEALTH_URL, 'needs the worker on the stack (WORKER_HEALTH_URL)');
  f = await createFieldFixture();
  await everyDayWorking(f);
  second = await addSite(f, { name: 'Pier 9 Warehouse Retrofit', projectCode: 'FE-2' });
});

test.afterAll(async () => {
  await dropFieldFixture(f);
});

test(
  'Weather day on one site (filed, delay record), No work on the other',
  { tag: ['@m6', '@F12'] },
  async ({ page, context }) => {
    const fx = f!;
    const pier = second!;
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

    // Weather day on the first site.
    await pickSite(page, fx.site.name);
    await page.getByRole('button', { name: copy.today.weather }).click();
    const weather = page.getByRole('dialog', { name: copy.today.daySheet.weatherTitle });
    const confirm = weather.getByRole('button', { name: copy.today.daySheet.confirm });
    await expect(confirm).toBeDisabled();
    await weather.getByRole('radio', { name: '09:00' }).click();
    await weather.getByLabel(copy.today.daySheet.workersBefore).fill('12');
    await expectFieldScreen(page);
    await confirm.click();
    await expect(weather).toBeHidden();
    await expect(page.getByText(copy.today.status.weatherDay, { exact: true })).toBeVisible();
    await expect(page.getByText(copy.today.closed)).toBeVisible();
    await expect(page.getByRole('link', { name: copy.today.weatherPhoto })).toBeVisible();
    await expect(page.getByRole('link', { name: copy.today.record })).toHaveCount(0);
    await expectFieldScreen(page);

    const [day] = await rest<{ status: string; report_id: string | null }[]>(
      'GET',
      `site_days?select=status,report_id&site_id=eq.${fx.site.id}`,
    );
    expect(day!.status).toBe('weather_day');
    expect(day!.report_id).not.toBeNull();
    const reportId = day!.report_id!;
    await expect(page.getByRole('link', { name: copy.today.weatherPhoto })).toHaveAttribute(
      'href',
      `/report/${reportId}`,
    );

    // The worker files it (trigger weather_day) and writes the delay record.
    await expect
      .poll(
        async () => {
          const [r] = await rest<{ status: string; kind: string; channel: string }[]>(
            'GET',
            `reports?select=status,kind,channel&id=eq.${reportId}`,
          );
          return r;
        },
        { timeout: 60_000 },
      )
      .toEqual({ status: 'filed', kind: 'weather_day', channel: 'web' });
    const events = await rest<{ start_local: string; full_day: boolean; lost_hours: number }[]>(
      'GET',
      `weather_events?select=start_local,full_day,lost_hours&report_id=eq.${reportId}`,
    );
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ start_local: '09:00:00', full_day: false });
    expect(Number(events[0]!.lost_hours)).toBeGreaterThan(0);
    const questions = await rest<{ field: string; answered_at: string | null }[]>(
      'GET',
      `questions?select=field,answered_at&report_id=eq.${reportId}`,
    );
    expect(questions.map((q) => q.field).sort()).toEqual(['manpower.workers', 'weather.impact']);
    expect(questions.every((q) => q.answered_at !== null)).toBe(true);

    // No work on the second site.
    await pickSite(page, pier.name);
    await page.getByRole('button', { name: copy.today.noWork }).click();
    const noWork = page.getByRole('dialog', { name: copy.today.daySheet.noWorkTitle });
    await noWork.getByRole('button', { name: copy.today.daySheet.confirm }).click();
    await expect(noWork).toBeHidden();
    await expect(page.getByText(copy.today.status.noWork, { exact: true })).toBeVisible();
    await expect(page.getByText(copy.today.closed)).toBeVisible();
    await expectFieldScreen(page);
    const [pierDay] = await rest<{ status: string; report_id: string | null }[]>(
      'GET',
      `site_days?select=status,report_id&site_id=eq.${pier.id}`,
    );
    expect(pierDay).toEqual({ status: 'no_work', report_id: null });
    expect(await rest('GET', `reports?select=id&site_id=eq.${pier.id}`)).toEqual([]);
  },
);
