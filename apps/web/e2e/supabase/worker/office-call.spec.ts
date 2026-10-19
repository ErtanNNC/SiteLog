import { expect, test } from '@playwright/test';
import { demoId } from '@sitelog/shared/demo/ids.ts';
import { admin, SEED, signInWithMagicLink } from '../support';

/**
 * W4-04 · Team's Call now with the office's attestation (spec F3 edge cases, P10, §19 Q131,
 * Q230; M10) against the local stack with the worker running (the `worker` project), on the
 * `console` telephony: Kestrel is a demo org, so the call rings the panel's Demo phone and never a
 * real phone (§19 Q132).
 *
 * Lena (admin) attests that Aisha Bello agreed to get calls and calls her now from Team: the row
 * shows the call's progress, the worker's place_call rings the Demo phone and, nobody answering,
 * ends it `no_answer` / `not_reached` with no text to Aisha; the consent row is an `auto_call`
 * `office_attested` with Lena as the attester; and that night's R1 for Aisha is still refused
 * without her own `auto_call` (§19 Q131: the ladder never uses the attestation).
 *
 * office_call_start() reads the database clock (the real time), so the org's call window is
 * opened to the whole day for this spec and put back after. Skips without the worker.
 */
test.describe.configure({ mode: 'serial' });

const WORKER_HEALTH_URL = process.env.WORKER_HEALTH_URL ?? 'http://127.0.0.1:8080/health';
const AISHA = { id: demoId('reporter:aisha'), name: 'Aisha Bello' };
const HILLCREST = demoId('site:hillcrest');
/** A night far from the seed and today, for the ladder's R1 (§19 Q131). */
const NIGHT = '2031-08-04';

let window: { call_window_start: string | null; call_window_end: string | null } | null = null;
let callId = '';

test.beforeAll(async () => {
  const up = await fetch(WORKER_HEALTH_URL)
    .then((r) => r.ok)
    .catch(() => false);
  test.skip(!up && !process.env.CI, `no worker at ${WORKER_HEALTH_URL} (pnpm dev:worker)`);
  expect(up, `the worker answers at ${WORKER_HEALTH_URL}`).toBe(true);

  const db = admin();
  const { data } = await db
    .from('org_settings')
    .select('call_window_start, call_window_end')
    .eq('org_id', SEED.orgId)
    .single();
  window = data;
  await db
    .from('org_settings')
    .update({ call_window_start: '00:00', call_window_end: '23:59' })
    .eq('org_id', SEED.orgId);
  await db.from('reporters').update({ status: 'active', no_calls_until: null }).eq('id', AISHA.id);
  // No call of hers still open from an earlier spec.
  await db
    .from('calls')
    .update({ ended_at: new Date().toISOString(), status: 'completed' })
    .eq('reporter_id', AISHA.id)
    .is('ended_at', null);
});

test.afterAll(async () => {
  if (!window) return;
  const db = admin();
  await db.from('org_settings').update(window).eq('org_id', SEED.orgId);
  // Her own automated-call consent back as the seed has it.
  await db
    .from('consents')
    .update({ revoked_at: null })
    .eq('reporter_id', AISHA.id)
    .eq('type', 'auto_call')
    .neq('method', 'office_attested');
});

test(
  'Lena attests and calls Aisha now: the Demo phone rings, unanswered, no text',
  { tag: ['@m10', '@F3'] },
  async ({ page }) => {
    await signInWithMagicLink(page);
    await page.goto('/team');
    const table = page.getByRole('table', { name: 'Field reporters' });
    await table.getByRole('button', { name: `Menu for ${AISHA.name}` }).click();
    await page.getByRole('menuitem', { name: 'Call now' }).click();
    const dialog = page.getByRole('dialog', { name: `Call ${AISHA.name} now?` });
    await dialog
      .getByRole('checkbox', {
        name: 'Aisha agreed to get calls from TalkOlog for the daily report',
      })
      .click();
    await dialog.getByRole('button', { name: 'Call now' }).click();
    await expect(dialog).toHaveCount(0);
    const row = table.getByRole('row').filter({ hasText: AISHA.name });
    await expect(row.getByTestId('call-today')).toContainText('Office call');

    const { data: rows } = await admin()
      .from('calls')
      .select('id, purpose, attempt, metrics')
      .eq('reporter_id', AISHA.id)
      .eq('direction', 'outbound')
      .eq('purpose', 'daily_report')
      .order('created_at', { ascending: false })
      .limit(1);
    callId = rows![0]!.id as string;
    expect(rows![0]).toMatchObject({ attempt: null, metrics: { telephony: 'console' } });

    // The consent row: auto_call office_attested, Lena the attester.
    const { data: consent } = await admin()
      .from('consents')
      .select('type, method, text_version, evidence')
      .eq('reporter_id', AISHA.id)
      .eq('evidence->>call_id', callId)
      .single();
    expect(consent).toMatchObject({
      type: 'auto_call',
      method: 'office_attested',
      text_version: 'team.call_now.v1',
      evidence: { user_id: SEED.admin.id, via: 'office' },
    });

    // The worker places it on the console telephony: ringing, then (30 s on) not answered.
    await expect
      .poll(
        async () => {
          const { data } = await admin().from('calls').select('status').eq('id', callId).single();
          return data?.status;
        },
        { timeout: 120_000 },
      )
      .toBe('no_answer');
    // §19 Q230: no missed_call text (nor any text about this call).
    const { data: texts } = await admin()
      .from('jobs')
      .select('dedupe_key')
      .eq('type', 'notify')
      .like('dedupe_key', `%${callId}%`);
    expect(texts).toEqual([]);

    // Team shows how it went; the Demo phone has the call in her thread.
    await page.reload();
    await expect(
      page
        .getByRole('table', { name: 'Field reporters' })
        .getByRole('row')
        .filter({ hasText: AISHA.name })
        .getByTestId('call-today'),
    ).toContainText('Office call · Not reached');
    await page.goto('/dev/phone');
    await page
      .getByRole('navigation', { name: 'Reporters' })
      .getByRole('button', { name: new RegExp(AISHA.name) })
      .click();
    const thread = page.getByRole('list', { name: `Texts with ${AISHA.name}` });
    await expect(
      thread.getByTestId('demo-phone-call').filter({ hasText: 'Call from the office' }).last(),
    ).toBeVisible();
  },
);

test(
  'that night’s R1 for Aisha is still refused without her own auto_call (§19 Q131)',
  { tag: ['@m10', '@F3'] },
  async () => {
    test.skip(!callId && !process.env.CI, 'the office call did not run');
    const db = admin();
    await db
      .from('consents')
      .update({ revoked_at: new Date().toISOString() })
      .eq('reporter_id', AISHA.id)
      .eq('type', 'auto_call')
      .neq('method', 'office_attested')
      .is('revoked_at', null);
    await db.from('site_days').delete().eq('site_id', HILLCREST).eq('date', NIGHT);
    const { data: day, error } = await db
      .from('site_days')
      .insert({ site_id: HILLCREST, date: NIGHT, deadline_at: `${NIGHT}T22:30:00.000Z` })
      .select('id')
      .single();
    if (error) throw error;
    const { data: r1 } = await db.rpc('outbound_call_start', {
      p_reporter_id: AISHA.id,
      p_site_day_id: day.id,
      p_stage: 'reminder_1',
      p_now: `${NIGHT}T22:46:00.000Z`,
      p_telephony: 'console',
    });
    expect(r1).toEqual({ status: 'skipped', reason: 'no_consent' });
    await db.from('site_days').delete().eq('id', day.id);
  },
);
