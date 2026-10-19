import { expect, test } from '@playwright/test';
import { admin, SEED, signInWithMagicLink } from '../support';

/**
 * W4-05 · Settings' Call me now (spec P12 Field channels, §19 Q232, Q350; M10) against the local
 * stack with the worker running (the `worker` project), on the `console` telephony: Kestrel is a
 * demo org, so nothing reaches a real phone (§19 Q132).
 *
 * Lena (admin) types her number on Field channels, ticks "This is my own number." and asks for
 * the test call: settings_test_call_start() writes the call (outbound, `settings_test`, no
 * reporter) audited with the number masked; the worker's place_call {phase: settings_test} takes
 * it on the console, blanks the number, and, nobody answering, ends it `no_answer` /
 * `not_reached` with no text to anyone. Skips without the worker.
 */
test.describe.configure({ mode: 'serial' });

const WORKER_HEALTH_URL = process.env.WORKER_HEALTH_URL ?? 'http://127.0.0.1:8080/health';
const LENA_PHONE = '+15550143378';

test.beforeAll(async () => {
  const up = await fetch(WORKER_HEALTH_URL)
    .then((r) => r.ok)
    .catch(() => false);
  test.skip(!up && !process.env.CI, `no worker at ${WORKER_HEALTH_URL} (pnpm dev:worker)`);
  expect(up, `the worker answers at ${WORKER_HEALTH_URL}`).toBe(true);
  // No test call of the org still open from an earlier run (one at a time).
  await admin()
    .from('calls')
    .update({ ended_at: new Date().toISOString(), status: 'completed', to_e164: null })
    .eq('org_id', SEED.orgId)
    .eq('purpose', 'settings_test')
    .is('ended_at', null);
});

test(
  'Lena asks for a test call: placed on the console, audited masked, not kept, no text',
  { tag: ['@m10', '@F22'] },
  async ({ page }) => {
    await signInWithMagicLink(page);
    await page.goto('/settings/channels');
    await page.getByRole('button', { name: 'Call me now' }).click();
    const dialog = page.getByRole('dialog', { name: 'Call me now' });
    await dialog.getByTestId('call-phone').fill('(555) 014-3378');
    await dialog.getByRole('checkbox', { name: 'This is my own number.' }).click();
    await dialog.getByRole('button', { name: 'Call me now' }).click();
    await expect(dialog.getByTestId('call-result')).toContainText(
      'Demo company: the call was placed on TalkOlog’s console',
    );

    const { data: rows } = await admin()
      .from('calls')
      .select('id, direction, purpose, reporter_id, attempt, metrics')
      .eq('org_id', SEED.orgId)
      .eq('purpose', 'settings_test')
      .order('created_at', { ascending: false })
      .limit(1);
    const call = rows![0]!;
    expect(call).toMatchObject({
      direction: 'outbound',
      reporter_id: null,
      attempt: null,
      metrics: { telephony: 'console', stage: 'settings_test', requested_by: SEED.admin.id },
    });

    // The worker places it on the console: ringing (the number handed over and blanked), then,
    // nobody answering, not reached.
    await expect
      .poll(
        async () => {
          const { data } = await admin()
            .from('calls')
            .select('status, to_e164')
            .eq('id', call.id)
            .single();
          return data;
        },
        { timeout: 120_000 },
      )
      .toEqual({ status: 'no_answer', to_e164: null });

    // Audited with the number masked, never whole; nothing texted about it.
    const { data: audits } = await admin()
      .from('audit_log')
      .select('action, diff')
      .eq('org_id', SEED.orgId)
      .eq('action', 'settings.test_call')
      .eq('diff->>call_id', call.id);
    expect(audits).toEqual([
      {
        action: 'settings.test_call',
        diff: { to: '+1555***378', telephony: 'console', language: 'en', call_id: call.id },
      },
    ]);
    const { data: all } = await admin().from('audit_log').select('diff').eq('entity_id', call.id);
    expect(JSON.stringify(all)).not.toContain(LENA_PHONE);
    const { data: texts } = await admin()
      .from('jobs')
      .select('dedupe_key')
      .eq('type', 'notify')
      .like('dedupe_key', `%${call.id}%`);
    expect(texts).toEqual([]);
  },
);
