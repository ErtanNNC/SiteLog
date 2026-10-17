import { expect, test } from '@playwright/test';
import type { CountryRow } from '@sitelog/shared/db/types.ts';
import { formatPhone } from '@sitelog/shared/format.ts';
import { copy as en } from '../../src/copy/en';
import { admin, SEED, signInWithMagicLink } from './support';

/**
 * W4-16 · Settings' Field channels on the stack (spec F22, P12, §19 Q231, Q232; W4-05 Done when;
 * M10), Lena on Kestrel (a demo org), no worker:
 *
 * - the US pack card read-only, as the `countries` row of this database says (the sender and the
 *   voice number are per environment: CI's earlier steps set the voice number and, before the
 *   M10 step, the stand-in sender; a stack without them shows "Not set up in this environment"
 *   and "Talk now only");
 * - the daily link time, its expiry and the default preference saved through the audited
 *   `org_settings` path (`settings.updated`), then put back;
 * - _Send me a test message_ (`api-test-message`): a demo org's text goes to the console, the
 *   panel says so, the audit masks the number.
 *
 * Call me now on the console telephony is `worker/settings-test-call.spec.ts` (`@m10 @F22`).
 */
test.describe.configure({ mode: 'serial' });

type Saved = {
  daily_link_time: string | null;
  daily_link_ttl_hours: number | null;
  default_contact_pref: string;
};
let saved: Saved | null = null;

test.beforeAll(async () => {
  const { data } = await admin()
    .from('org_settings')
    .select('daily_link_time, daily_link_ttl_hours, default_contact_pref')
    .eq('org_id', SEED.orgId)
    .single()
    .throwOnError();
  saved = data as Saved;
});

test.afterAll(async () => {
  if (saved) await admin().from('org_settings').update(saved).eq('org_id', SEED.orgId);
});

test(
  'Field channels: the US pack as this database has it, read-only',
  { tag: ['@m10', '@F22'] },
  async ({ page }) => {
    const { data } = await admin()
      .from('countries')
      .select('*')
      .eq('code', 'US')
      .single()
      .throwOnError();
    const us = data as CountryRow;
    await signInWithMagicLink(page);
    await page.goto('/settings/channels');
    await expect(page.getByRole('heading', { level: 1, name: 'Settings' })).toBeVisible();
    const pack = page.getByTestId('pack-card');
    await expect(pack).toContainText('United States');
    if (us.sms_sender_id) await expect(pack).toContainText(formatPhone(us.sms_sender_id));
    else await expect(pack.getByTestId('sender-not-set')).toBeVisible();
    await expect(pack).toContainText(
      us.voice_number ? formatPhone(us.voice_number) : en.settings.channels.talkNowOnly,
    );
    await expect(page.getByTestId('channel-order')).toHaveText(
      us.message_channels.map((c) => en.team.channels[c]).join(' → '),
    );
    await expect(pack).toContainText(
      us.two_way_sms ? en.settings.channels.twoWayYes : en.settings.channels.twoWayNo,
    );
    // Read-only: no field of the card can be edited.
    await expect(pack.locator('input, select, textarea, [role="combobox"]')).toHaveCount(0);
    await expect(page.getByTestId('recording-notice')).toContainText('voice.recording_notice.v1');
  },
);

test(
  'the daily link time, its expiry and the default preference saved and audited',
  { tag: ['@m10', '@F22'] },
  async ({ page }) => {
    const since = new Date().toISOString();
    await signInWithMagicLink(page);
    await page.goto('/settings/channels');
    await page.getByLabel(en.settings.channels.dailyLinkTime).fill('16:30');
    await page.getByTestId('daily-link-ttl').fill('12');
    await page.getByRole('radio', { name: en.team.prefers.call }).click();
    await page.getByTestId('save-settings').click();

    await expect
      .poll(
        async () => {
          const { data } = await admin()
            .from('org_settings')
            .select('daily_link_time, daily_link_ttl_hours, default_contact_pref')
            .eq('org_id', SEED.orgId)
            .single();
          return data;
        },
        { timeout: 20_000 },
      )
      .toEqual({
        daily_link_time: '16:30:00',
        daily_link_ttl_hours: 12,
        default_contact_pref: 'call',
      });
    const { data: audits } = await admin()
      .from('audit_log')
      .select('actor_id')
      .eq('org_id', SEED.orgId)
      .eq('action', 'settings.updated')
      .gte('created_at', since)
      .throwOnError();
    expect(audits).toContainEqual({ actor_id: SEED.admin.id });

    // Invite preselects the org's default preference (§19 Q231).
    await page.goto('/team');
    await page.getByRole('button', { name: 'Invite reporter' }).first().click();
    await expect(page.getByRole('dialog').getByRole('radio', { name: 'Call' })).toBeChecked();
  },
);

test(
  'Send me a test message: a demo org’s text goes to the console, audited masked',
  { tag: ['@m10', '@F22'] },
  async ({ page }) => {
    const since = new Date().toISOString();
    await signInWithMagicLink(page);
    await page.goto('/settings/channels');
    await page.getByRole('button', { name: en.settings.channels.testMessage }).click();
    const dialog = page.getByRole('dialog', { name: en.settings.channels.testDialog.title });
    await dialog.getByTestId('test-phone').fill('(555) 014-2290');
    await dialog.getByRole('checkbox', { name: en.settings.channels.testDialog.attest }).check();
    await dialog.getByRole('button', { name: en.settings.channels.testDialog.send }).click();
    await expect(dialog.getByTestId('test-result')).toContainText(
      en.settings.channels.testResults.demo,
    );
    const { data: audits } = await admin()
      .from('audit_log')
      .select('diff')
      .eq('org_id', SEED.orgId)
      .eq('action', 'settings.test_message')
      .gte('created_at', since)
      .throwOnError();
    expect(audits).toHaveLength(1);
    const diff = JSON.stringify(audits![0]!.diff);
    expect(diff).toContain('***');
    expect(diff).not.toContain('5550142290');
  },
);
