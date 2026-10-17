import { expect, test } from '@playwright/test';
import { demoId } from '@sitelog/shared/demo/ids.ts';
import { admin, SEED, signInWithMagicLink, SUPABASE_URL } from '../support';

/**
 * W3-17 (M8, spec §7.4, F6 step 1, F11, §19 Q129–Q132) against the local stack with the worker
 * running (the `worker` project), on the `console` telephony: Kestrel is a demo org, so its calls
 * ring the panel's Demo phone and never a real phone (§19 Q132). Fresh Northgate (Kevin O'Brien:
 * prefers calls, his own `auto_call` consent) and Hillcrest (Aisha Bello, the same, with "Don't
 * call me today") site-days on Tue Oct 13 2026; scheduler-tick on the test clock
 * (`SCHEDULER_CLOCK_OVERRIDE`, `?now=`):
 *
 * - 17:46: Kevin gets `call_coming` (§19 Q130) and the R1 call: `place_call` rings the Demo phone,
 *   nobody answers it, so after CONSOLE_CALL_RING_S (30 s) it ends `no_answer` / `not_reached` and
 *   `missed_call` arrives in his thread; the Demo phone shows both.
 * - 18:31: R2, the second call (`second_call_enabled`) plus the `reminder_2` text.
 * - Aisha (§19 Q129): the daily link, R1 and R2 as texts, never a call.
 *
 * Skips without the worker or without the scheduler's clock override, as the ladder spec does.
 */
test.describe.configure({ mode: 'serial' });

const WORKER_HEALTH_URL = process.env.WORKER_HEALTH_URL ?? 'http://127.0.0.1:8080/health';
const SCHEDULER_SECRET = process.env.SCHEDULER_SECRET ?? 'e2e-scheduler-secret';
const DATE = '2026-10-13';
const AT_1740 = '2026-10-13T22:40:00.000Z';
const AT_1746 = '2026-10-13T22:46:00.000Z';
const AT_1831 = '2026-10-13T23:31:00.000Z';
const KEVIN = { id: demoId('reporter:kevin'), name: "Kevin O'Brien" };
const AISHA = { id: demoId('reporter:aisha'), name: 'Aisha Bello' };
const NORTHGATE = demoId('site:northgate');
const HILLCREST = demoId('site:hillcrest');

async function tick(now: string): Promise<{ errors: number }> {
  const res = await fetch(`${SUPABASE_URL}/functions/v1/scheduler-tick?now=${now}`, {
    method: 'POST',
    headers: { authorization: `Bearer ${SCHEDULER_SECRET}` },
  });
  expect(res.status, await res.clone().text()).toBe(200);
  return (await res.json()) as { errors: number };
}

/** The jobs of one reporter's site-day: its texts (`notify:…`) and calls (`call:…`). */
async function jobKeys(siteDayId: string, reporterId: string): Promise<string[]> {
  const { data } = await admin()
    .from('jobs')
    .select('dedupe_key')
    .in('type', ['notify', 'place_call'])
    .like('dedupe_key', `%:${siteDayId}:${reporterId}%`)
    .order('id');
  return (data ?? []).map((j) => j.dedupe_key as string);
}

async function calls(siteDayId: string) {
  const { data } = await admin()
    .from('calls')
    .select('id, status, outcome, attempt, purpose, direction')
    .eq('site_day_id', siteDayId)
    .eq('direction', 'outbound')
    .order('attempt');
  return data ?? [];
}

async function freshDay(siteId: string): Promise<string> {
  const db = admin();
  await db.from('site_days').delete().eq('site_id', siteId).eq('date', DATE);
  const { data, error } = await db
    .from('site_days')
    .insert({ site_id: siteId, date: DATE, deadline_at: '2026-10-13T22:30:00.000Z' })
    .select('id')
    .single();
  if (error) throw error;
  return data.id as string;
}

let northgateDay = '';
let hillcrestDay = '';
/** The arrangement ran (a worker and a stack): the clean-up undoes it. */
let arranged = false;

test.beforeAll(async () => {
  const up = await fetch(WORKER_HEALTH_URL)
    .then((r) => r.ok)
    .catch(() => false);
  test.skip(!up && !process.env.CI, `no worker at ${WORKER_HEALTH_URL} (pnpm dev:worker)`);
  expect(up, `the worker answers at ${WORKER_HEALTH_URL}`).toBe(true);

  const db = admin();
  // Only the ladder: no weather slot (the last tick at 17:40), the digest and retention done.
  await db.from('scheduler_state').upsert(
    [
      { key: 'last_tick', value: { at: AT_1740 } },
      { key: 'retention_cleanup', value: { lastRunDate: DATE } },
      {
        key: 'weekly_digest_runs',
        value: { [SEED.orgId]: DATE, '6068578e-a1cb-4424-8ef6-9852a765d8de': DATE },
      },
    ],
    { onConflict: 'key' },
  );
  northgateDay = await freshDay(NORTHGATE);
  hillcrestDay = await freshDay(HILLCREST);
  // Kevin may be called (his own auto_call, no "not today"); Aisha said "not today" (§19 Q129).
  await db.from('reporters').update({ no_calls_until: null }).eq('id', KEVIN.id);
  await db
    .from('reporters')
    .update({ no_calls_until: '2026-10-14T05:00:00.000Z' })
    .eq('id', AISHA.id);
  arranged = true;
});

test.afterAll(async () => {
  if (!arranged) return;
  await admin().from('reporters').update({ no_calls_until: null }).eq('id', AISHA.id);
});

test(
  '17:46: Kevin’s R1 call rings the Demo phone; unanswered, it leaves missed_call',
  { tag: ['@m8', '@F11'] },
  async ({ page }) => {
    const first = await tick(AT_1746);
    const { data: state } = await admin()
      .from('scheduler_state')
      .select('value')
      .eq('key', 'last_tick')
      .single();
    const at = (state?.value as { at?: string } | null)?.at;
    test.skip(at !== AT_1746 && !process.env.CI, 'SCHEDULER_CLOCK_OVERRIDE=true is not set');
    expect(at).toBe(AT_1746);
    expect(first.errors).toBe(0);
    // §19 Q130: "I'll call you at 17:45", then the call itself (no reminder_1 text).
    expect(await jobKeys(northgateDay, KEVIN.id)).toEqual([
      `notify:call_coming:${northgateDay}:${KEVIN.id}`,
      `call:${northgateDay}:${KEVIN.id}:reminder_1`,
    ]);

    // The worker places it on the console telephony: ringing, then (30 s on) not answered.
    await expect
      .poll(async () => (await calls(northgateDay)).map((c) => [c.attempt, c.status]), {
        timeout: 120_000,
      })
      .toEqual([[1, 'no_answer']]);
    const [r1] = await calls(northgateDay);
    expect(r1).toMatchObject({ purpose: 'reminder', outcome: 'not_reached' });
    await expect
      .poll(
        async () => {
          const { data } = await admin()
            .from('messages')
            .select('copy_key, status, body')
            .eq('reporter_id', KEVIN.id)
            .eq('payload->>dedupe_key', `notify:missed_call:${r1!.id}`);
          return (data ?? []).map((m) => [m.copy_key, m.status]);
        },
        { timeout: 60_000 },
      )
      .toEqual([['missed_call', 'delivered']]);

    await signInWithMagicLink(page);
    await page.goto('/dev/phone');
    await page
      .getByRole('navigation', { name: 'Reporters' })
      .getByRole('button', { name: new RegExp(KEVIN.name) })
      .click();
    const thread = page.getByRole('list', { name: `Texts with ${KEVIN.name}` });
    await expect(
      thread.getByTestId('demo-phone-call').filter({ hasText: 'Missed call from SiteLog' }).last(),
    ).toBeVisible();
    await expect(
      thread.getByRole('listitem').filter({ hasText: "Missed you for today's report." }).last(),
    ).toBeVisible();
  },
);

test(
  '18:31: R2 is the second call plus the reminder_2 text',
  { tag: ['@m8', '@F11'] },
  async () => {
    test.skip(
      (await calls(northgateDay)).length === 0 && !process.env.CI,
      'SCHEDULER_CLOCK_OVERRIDE=true is not set',
    );
    const second = await tick(AT_1831);
    expect(second.errors).toBe(0);
    expect(await jobKeys(northgateDay, KEVIN.id)).toEqual([
      `notify:call_coming:${northgateDay}:${KEVIN.id}`,
      `call:${northgateDay}:${KEVIN.id}:reminder_1`,
      `notify:reminder_2:${northgateDay}:${KEVIN.id}`,
      `call:${northgateDay}:${KEVIN.id}:reminder_2`,
    ]);
    await expect
      .poll(async () => (await calls(northgateDay)).map((c) => c.attempt), { timeout: 60_000 })
      .toEqual([1, 2]);
  },
);

test(
  '"Don’t call me today": Aisha gets the texts a link reporter gets, never a call',
  { tag: ['@m8', '@F15'] },
  async () => {
    const keys = await jobKeys(hillcrestDay, AISHA.id);
    test.skip(keys.length === 0 && !process.env.CI, 'SCHEDULER_CLOCK_OVERRIDE=true is not set');
    expect(keys).toEqual([
      `notify:daily_link:${hillcrestDay}:${AISHA.id}`,
      `notify:reminder_1:${hillcrestDay}:${AISHA.id}`,
      `notify:reminder_2:${hillcrestDay}:${AISHA.id}`,
    ]);
    expect(await calls(hillcrestDay)).toEqual([]);
  },
);
