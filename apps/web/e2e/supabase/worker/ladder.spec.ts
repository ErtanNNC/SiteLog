import { expect, test } from '@playwright/test';
import { demoId } from '@sitelog/shared/demo/ids.ts';
import { admin, SEED, signInWithMagicLink, SUPABASE_URL } from '../support';

/**
 * W2-06 against the local stack with the worker running (the `worker` project): the reminder
 * ladder through the Notifier. A fresh Elm St. site-day on Monday Oct 12 2026; scheduler-tick
 * with the clock at 17:46 Chicago (`?now=`, SCHEDULER_CLOCK_OVERRIDE in CI's functions env)
 * claims the daily link and R1 for Priya, the worker texts both on the console driver (Kestrel is
 * a demo org), and the Demo phone shows them. The worker runs on CI's test clock too
 * (WORKER_CLOCK_OVERRIDE from 2026-10-12T22:46:30Z), or the jobs' quiet-hours guard (20:00 Chicago
 * that day) would already be past on the real clock and nothing would be sent. The day is then filed; the 18:31 tick sends no R2.
 * The tick's other periodic work is arranged away first (weather slots, digest, retention), so it
 * only creates the day's site-days and runs the ladder.
 *
 * W2-17 (M6 acceptance, F11, tagged `@m6 @F11`): the rest of the ladder on a second fresh day,
 * Oakmont's (Dana): the same 17:46 tick gives her the daily link and R1, the 18:31 tick R2 (the
 * worker texts it before the day leaves the ladder), and the 19:01 tick (the deadline plus the
 * 90 minutes of `missing_offset_min`) makes the day `missing` with the office's `missing_report`
 * notice ("Dana didn't answer 2 reminders.") and the `report_missing` email, which the worker sends.
 * The worker's clock (WORKER_CLOCK_START, then real time) stays before 20:00 Chicago, so the
 * quiet-hours guard passes R2.
 */
test.describe.configure({ mode: 'serial' });

const WORKER_HEALTH_URL = process.env.WORKER_HEALTH_URL ?? 'http://127.0.0.1:8080/health';
const SCHEDULER_SECRET = process.env.SCHEDULER_SECRET ?? 'e2e-scheduler-secret';
const PRIYA = { id: '5592b895-f086-47ab-88ee-10092a7b51c5', name: 'Priya Raman' };
const DATE = '2026-10-12';
const AT_1746 = '2026-10-12T22:46:00.000Z';
const AT_1831 = '2026-10-12T23:31:00.000Z';
const AT_1901 = '2026-10-13T00:01:00.000Z';
const OAKMONT = { siteId: demoId('site:oakmont'), name: 'Oakmont Medical Center' };
const DANA = { id: demoId('reporter:dana'), name: 'Dana Whitfield' };

async function tick(now: string): Promise<{ ladderStages: number; errors: number }> {
  const res = await fetch(`${SUPABASE_URL}/functions/v1/scheduler-tick?now=${now}`, {
    method: 'POST',
    headers: { authorization: `Bearer ${SCHEDULER_SECRET}` },
  });
  expect(res.status, await res.clone().text()).toBe(200);
  return (await res.json()) as { ladderStages: number; errors: number };
}

async function jobKeys(siteDayId: string, reporterId: string = PRIYA.id): Promise<string[]> {
  const { data } = await admin()
    .from('jobs')
    .select('dedupe_key')
    .eq('type', 'notify')
    .like('dedupe_key', `notify:%:${siteDayId}:${reporterId}`)
    .order('id');
  return (data ?? []).map((j) => j.dedupe_key as string);
}

let siteDayId = '';
let oakmontDayId = '';

test.beforeAll(async () => {
  const up = await fetch(WORKER_HEALTH_URL)
    .then((r) => r.ok)
    .catch(() => false);
  test.skip(!up && !process.env.CI, `no worker at ${WORKER_HEALTH_URL} (pnpm dev:worker)`);
  expect(up, `the worker answers at ${WORKER_HEALTH_URL}`).toBe(true);

  // Only the ladder: no weather slot (the last tick at 17:40), the digest and retention done.
  const db = admin();
  await db.from('scheduler_state').upsert(
    [
      { key: 'last_tick', value: { at: '2026-10-12T22:40:00.000Z' } },
      { key: 'retention_cleanup', value: { lastRunDate: DATE } },
      {
        key: 'weekly_digest_runs',
        value: { [SEED.orgId]: DATE, '6068578e-a1cb-4424-8ef6-9852a765d8de': DATE },
      },
    ],
    { onConflict: 'key' },
  );
  // A fresh Elm St. day, still waiting for a report.
  await db.from('site_days').delete().eq('site_id', SEED.sites.elm).eq('date', DATE);
  const { data, error } = await db
    .from('site_days')
    .insert({ site_id: SEED.sites.elm, date: DATE, deadline_at: '2026-10-12T22:30:00.000Z' })
    .select('id')
    .single();
  if (error) throw error;
  siteDayId = data.id as string;
  // W2-17: Oakmont's day too, which nobody files (F11 to the end).
  await db.from('site_days').delete().eq('site_id', OAKMONT.siteId).eq('date', DATE);
  const oak = await db
    .from('site_days')
    .insert({ site_id: OAKMONT.siteId, date: DATE, deadline_at: '2026-10-12T22:30:00.000Z' })
    .select('id')
    .single();
  if (oak.error) throw oak.error;
  oakmontDayId = oak.data.id as string;
});

test(
  '17:46: the daily link and R1 reach Priya’s Demo phone; filing stops R2',
  { tag: ['@m6', '@F11'] },
  async ({ page }) => {
    const first = await tick(AT_1746);
    // The override must be on: without it the tick ran on the real clock and claimed nothing here.
    const { data: state } = await admin()
      .from('scheduler_state')
      .select('value')
      .eq('key', 'last_tick')
      .single();
    const at = (state?.value as { at?: string } | null)?.at;
    test.skip(at !== AT_1746 && !process.env.CI, 'SCHEDULER_CLOCK_OVERRIDE=true is not set');
    expect(at).toBe(AT_1746);
    expect(first.errors).toBe(0);
    expect(await jobKeys(siteDayId)).toEqual([
      `notify:daily_link:${siteDayId}:${PRIYA.id}`,
      `notify:reminder_1:${siteDayId}:${PRIYA.id}`,
    ]);
    const { data: day } = await admin()
      .from('site_days')
      .select('status, reminder_stage')
      .eq('id', siteDayId)
      .single();
    expect(day).toEqual({ status: 'reminded', reminder_stage: 2 });

    // The worker sends both through the Notifier (console, a demo org: the full text is kept).
    await expect
      .poll(
        async () => {
          const { data } = await admin()
            .from('messages')
            .select('copy_key, status')
            .eq('reporter_id', PRIYA.id)
            .in('payload->>dedupe_key', [
              `notify:daily_link:${siteDayId}:${PRIYA.id}`,
              `notify:reminder_1:${siteDayId}:${PRIYA.id}`,
            ])
            .order('created_at');
          return data;
        },
        { timeout: 60_000 },
      )
      .toEqual([
        { copy_key: 'daily_link', status: 'delivered' },
        { copy_key: 'reminder_1', status: 'delivered' },
      ]);

    await signInWithMagicLink(page);
    await page.goto('/dev/phone');
    await page
      .getByRole('navigation', { name: 'Reporters' })
      .getByRole('button', { name: new RegExp(PRIYA.name) })
      .click();
    const thread = page.getByRole('list', { name: `Texts with ${PRIYA.name}` });
    await expect(
      thread
        .getByRole('listitem')
        .filter({ hasText: "Today's report for Elm St. Townhomes:" })
        .last(),
    ).toBeVisible();
    await expect(
      thread
        .getByRole('listitem')
        .filter({ hasText: 'No report yet for Elm St. Townhomes today.' })
        .last(),
    ).toBeVisible();

    // Filed at 17:50 (the day leaves the ladder); the 18:31 tick sends no R2.
    await admin().from('site_days').update({ status: 'filed' }).eq('id', siteDayId);
    const second = await tick(AT_1831);
    expect(second.errors).toBe(0);
    expect(await jobKeys(siteDayId)).toEqual([
      `notify:daily_link:${siteDayId}:${PRIYA.id}`,
      `notify:reminder_1:${siteDayId}:${PRIYA.id}`,
    ]);
  },
);

test(
  'Oakmont, never filed: R2 at 18:31, then 19:01 makes the day missing and tells the office',
  { tag: ['@m6', '@F11'] },
  async () => {
    const db = admin();
    const keys = await jobKeys(oakmontDayId, DANA.id);
    // As the first test: locally without SCHEDULER_CLOCK_OVERRIDE nothing was claimed.
    test.skip(keys.length === 0 && !process.env.CI, 'SCHEDULER_CLOCK_OVERRIDE=true is not set');
    // The first test's ticks (17:46, 18:31) walked Dana's day too: daily link, R1, R2.
    expect(keys).toEqual([
      `notify:daily_link:${oakmontDayId}:${DANA.id}`,
      `notify:reminder_1:${oakmontDayId}:${DANA.id}`,
      `notify:reminder_2:${oakmontDayId}:${DANA.id}`,
    ]);
    const { data: day } = await db
      .from('site_days')
      .select('status, reminder_stage')
      .eq('id', oakmontDayId)
      .single();
    expect(day).toEqual({ status: 'reminded', reminder_stage: 3 });

    // The worker texts R2 while the day is still on the ladder (its guard re-reads the status).
    await expect
      .poll(
        async () => {
          const { data } = await db
            .from('messages')
            .select('copy_key, status, body')
            .eq('reporter_id', DANA.id)
            .eq('payload->>dedupe_key', `notify:reminder_2:${oakmontDayId}:${DANA.id}`);
          return (data ?? []).map((m) => ({ copy_key: m.copy_key, status: m.status }));
        },
        { timeout: 60_000 },
      )
      .toEqual([{ copy_key: 'reminder_2', status: 'delivered' }]);
    const { data: r2 } = await db
      .from('messages')
      .select('body')
      .eq('reporter_id', DANA.id)
      .eq('payload->>dedupe_key', `notify:reminder_2:${oakmontDayId}:${DANA.id}`)
      .single();
    expect(r2!.body).toContain("Still nothing for today. I'll let the office know at 19:00.");

    // 19:01: past the deadline plus 90 minutes, the day is the office's.
    const since = new Date().toISOString();
    const third = await tick(AT_1901);
    expect(third.errors).toBe(0);
    const { data: missing } = await db
      .from('site_days')
      .select('status, reminder_stage')
      .eq('id', oakmontDayId)
      .single();
    expect(missing).toEqual({ status: 'missing', reminder_stage: 4 });
    // No message after R2: the missing step texts nobody.
    expect(await jobKeys(oakmontDayId, DANA.id)).toHaveLength(3);
    const { data: notices } = await db
      .from('notifications')
      .select('title, body')
      .eq('org_id', SEED.orgId)
      .eq('kind', 'missing_report')
      .eq('title', `${OAKMONT.name} — no report`)
      .gte('created_at', since);
    expect(notices).toEqual([
      { title: `${OAKMONT.name} — no report`, body: 'Dana didn’t answer 2 reminders.' },
    ]);
    await expect
      .poll(
        async () => {
          const { data } = await db
            .from('jobs')
            .select('status')
            .eq('dedupe_key', `email:report_missing:${oakmontDayId}`);
          return (data ?? []).map((j) => j.status);
        },
        { timeout: 60_000 },
      )
      .toEqual(['done']);
  },
);
