import { randomBytes } from 'node:crypto';
import { expect, test } from '@playwright/test';
import { demoId, demoLinkCode } from '@sitelog/shared/demo/ids.ts';
import { deviceCookieName } from '@sitelog/shared/field-api.ts';
import { sha256Hex } from '@sitelog/shared/links.ts';
import { admin, SEED, signInWithMagicLink, SUPABASE_URL } from './support';

/**
 * W4-16 · Team on the stack (spec P10, F3, F15, F16, F17, F24; W4-03 Done when; M10), through
 * the real RPCs and functions under RLS, on the §18.1 seed (Kestrel, a demo org: every text is a
 * console text in the Demo phone). No worker is needed:
 *
 * - @F15: an ops user (made for the run) moves Marco to WhatsApp with the attestation;
 *   `update_reporter_contact()` writes it and audits `reporter.preferences_changed` `via office`;
 * - @F16: Lena revokes Marco's devices (`revoke_reporter_devices()`, §19 Q244): the phone that
 *   field-api knew as verified must verify again (`resolve` says `needsDeviceCheck`);
 * - @F17: Lena texts Priya today's link from her row (`api-text-daily-link` with `reporterId`):
 *   the console text, and the Demo phone shows it;
 * - @F24: Lena adds an office user with Turkish as the panel language (`api-invite-office-user`,
 *   `org_members.ui_locale`); signed in, their panel opens in Turkish.
 *
 * Everything changed is put back (Marco's channel, the ops and office users removed).
 */
test.describe.configure({ mode: 'serial' });

const MARCO = { id: demoId('reporter:marco'), name: 'Marco Ruiz' };
const PRIYA = { id: demoId('reporter:priya'), name: 'Priya Raman' };
const FIELD_API = `${SUPABASE_URL}/functions/v1/field-api`;
const stamp = Date.now().toString(36);
const OPS_EMAIL = `ops-${stamp}@kestrelbuild.example`;
const OFFICE_EMAIL = `dana-${stamp}@kestrelbuild.example`;

let marcoChannel: string | null = null;
const usersMade: string[] = [];

async function userIdOf(email: string): Promise<string | null> {
  const { data } = await admin().auth.admin.listUsers({ page: 1, perPage: 1000 });
  return data?.users.find((u) => u.email === email)?.id ?? null;
}

test.beforeAll(async () => {
  const { data } = await admin()
    .from('reporters')
    .select('message_channel')
    .eq('id', MARCO.id)
    .single()
    .throwOnError();
  marcoChannel = (data as { message_channel: string | null }).message_channel;
});

test.afterAll(async () => {
  await admin()
    .from('reporters')
    .update({ message_channel: marcoChannel })
    .eq('id', MARCO.id)
    .throwOnError();
  for (const email of [OPS_EMAIL, OFFICE_EMAIL]) {
    const id = (await userIdOf(email)) ?? null;
    if (id && !usersMade.includes(id)) usersMade.push(id);
  }
  for (const id of usersMade) {
    await admin().from('org_members').delete().eq('user_id', id);
    await admin().auth.admin.deleteUser(id);
  }
});

test(
  'an ops user moves Marco to WhatsApp with the attestation, audited via office',
  { tag: ['@m10', '@F15'] },
  async ({ page }) => {
    const created = await admin().auth.admin.createUser({ email: OPS_EMAIL, email_confirm: true });
    if (created.error) throw created.error;
    const opsId = created.data.user.id;
    usersMade.push(opsId);
    await admin()
      .from('org_members')
      .insert({ org_id: SEED.orgId, user_id: opsId, role: 'ops' })
      .throwOnError();
    // Marco on the pack's order first, so the change is a change.
    await admin()
      .from('reporters')
      .update({ message_channel: null })
      .eq('id', MARCO.id)
      .throwOnError();
    const since = new Date().toISOString();

    await signInWithMagicLink(page, OPS_EMAIL);
    await page.goto('/team');
    const table = page.getByRole('table', { name: 'Field reporters' });
    await table.getByRole('button', { name: `Menu for ${MARCO.name}` }).click();
    await page.getByRole('menuitem', { name: 'Edit' }).click();
    const dialog = page.getByRole('dialog', { name: `Edit ${MARCO.name}` });
    await dialog.getByRole('combobox', { name: 'Messages go by' }).click();
    await page.getByRole('option', { name: 'WhatsApp', exact: true }).click();
    // Without the attestation nothing is saved (§19 Q243).
    const attest = dialog.getByRole('checkbox', { name: 'Marco asked for this change' });
    await expect(attest).toBeVisible();
    await attest.click();
    await dialog.getByRole('button', { name: 'Save changes' }).click();
    await expect(dialog).toHaveCount(0);
    const row = table.getByRole('row').filter({ hasText: MARCO.name });
    await expect(row.getByTestId('contact-pref')).toHaveText('Text link · WhatsApp');

    const { data: reporter } = await admin()
      .from('reporters')
      .select('message_channel')
      .eq('id', MARCO.id)
      .single()
      .throwOnError();
    expect(reporter).toEqual({ message_channel: 'whatsapp' });
    const { data: audits } = await admin()
      .from('audit_log')
      .select('actor_id, diff')
      .eq('entity_id', MARCO.id)
      .eq('action', 'reporter.preferences_changed')
      .gte('created_at', since)
      .throwOnError();
    expect(audits).toEqual([
      {
        actor_id: opsId,
        diff: expect.objectContaining({
          via: 'office',
          attested: true,
          to: expect.objectContaining({ message_channel: 'whatsapp' }),
        }),
      },
    ]);
  },
);

test(
  'Lena revokes Marco’s devices: his next open asks for a code',
  { tag: ['@m10', '@F16'] },
  async ({ page }) => {
    // A phone of Marco's that field-api knows as verified (the cookie the recorder holds).
    const token = randomBytes(32).toString('hex');
    const { data: device } = await admin()
      .from('field_devices')
      .insert({
        reporter_id: MARCO.id,
        device_token_hash: sha256Hex(token),
        user_agent: 'e2e:w4-16 team',
        verified_at: new Date().toISOString(),
      })
      .select('id')
      .single()
      .throwOnError();
    const code = demoLinkCode(`personal:${MARCO.id}`);
    const resolve = async () => {
      const res = await fetch(`${FIELD_API}/resolve`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          cookie: `${deviceCookieName(MARCO.id)}=${token}`,
        },
        body: JSON.stringify({ code }),
      });
      expect(res.status).toBe(200);
      return ((await res.json()) as { needsDeviceCheck: boolean }).needsDeviceCheck;
    };
    expect(await resolve()).toBe(false);

    await signInWithMagicLink(page);
    await page.goto('/team');
    const table = page.getByRole('table', { name: 'Field reporters' });
    const marco = table.getByRole('row').filter({ hasText: MARCO.name });
    await expect(marco).toContainText(/\d+ phones? signed in/);
    await marco.getByRole('button', { name: `Menu for ${MARCO.name}` }).click();
    await page.getByRole('menuitem', { name: 'Revoke devices' }).click();
    const revoke = page.getByRole('dialog', { name: `Revoke devices for ${MARCO.name}?` });
    await revoke.getByRole('button', { name: 'Revoke devices' }).click();
    await expect(revoke).toHaveCount(0);
    await expect(marco).not.toContainText(/phones? signed in/);

    const { data: live } = await admin()
      .from('field_devices')
      .select('id')
      .eq('reporter_id', MARCO.id)
      .is('revoked_at', null)
      .throwOnError();
    expect(live).toEqual([]);
    const { data: audit } = await admin()
      .from('audit_log')
      .select('actor_id, diff')
      .eq('entity_id', MARCO.id)
      .eq('action', 'device.revoked')
      .contains('diff', { via: 'office' })
      .order('created_at', { ascending: false })
      .limit(1)
      .throwOnError();
    expect(audit![0]).toMatchObject({ actor_id: SEED.admin.id });
    expect(JSON.stringify(audit![0]!.diff)).toContain(device!.id as string);
    // F16: the same phone must verify again.
    expect(await resolve()).toBe(true);
  },
);

test(
  'Lena texts Priya today’s link from her row; the Demo phone shows it',
  { tag: ['@m10', '@F17'] },
  async ({ page }) => {
    const since = new Date().toISOString();
    await signInWithMagicLink(page);
    await page.goto('/team');
    const table = page.getByRole('table', { name: 'Field reporters' });
    await table.getByRole('button', { name: `Menu for ${PRIYA.name}` }).click();
    const answer = page.waitForResponse((r) =>
      r.url().endsWith('/functions/v1/api-text-daily-link'),
    );
    await page
      .getByRole('menuitem', { name: /^Text today’s link/ })
      .first()
      .click();
    const res = await answer;
    expect(res.status()).toBe(200);
    expect(await res.json()).toMatchObject({ sent: true, reporterId: PRIYA.id });
    await expect(page.getByText('Today’s link texted to Priya.')).toBeVisible();

    const { data: texts } = await admin()
      .from('messages')
      .select('provider, channel, body')
      .eq('reporter_id', PRIYA.id)
      .eq('copy_key', 'daily_link')
      .gte('created_at', since)
      .throwOnError();
    expect(texts).toEqual([expect.objectContaining({ provider: 'console', channel: 'sms' })]);
    expect(texts![0]!.body).toMatch(/^Today's report for Elm St\. Townhomes: \S+\/r\/[A-Z0-9]+/);

    await page.goto('/dev/phone');
    await page
      .getByRole('navigation', { name: 'Reporters' })
      .getByRole('button', { name: new RegExp(PRIYA.name) })
      .click();
    await expect(page.getByRole('list', { name: `Texts with ${PRIYA.name}` })).toContainText(
      "Today's report for Elm St. Townhomes",
    );
  },
);

test(
  'Lena adds an office user with Turkish: their panel opens in Turkish',
  { tag: ['@m10', '@F24'] },
  async ({ page, browser }) => {
    await signInWithMagicLink(page);
    await page.goto('/team');
    await page.getByRole('button', { name: 'Add office user' }).click();
    const add = page.getByRole('dialog', { name: 'Add office user' });
    await add.getByRole('textbox', { name: 'Email' }).fill(OFFICE_EMAIL);
    await add.getByRole('radio', { name: 'Turkish' }).click();
    await add.getByRole('button', { name: 'Send invite' }).click();
    await expect(add).toHaveCount(0);
    await expect(page.getByTestId('office-users')).toContainText('Panel in Turkish');

    const userId = await userIdOf(OFFICE_EMAIL);
    expect(userId, 'the invited user').not.toBeNull();
    usersMade.push(userId!);
    const { data: member } = await admin()
      .from('org_members')
      .select('role, ui_locale')
      .eq('org_id', SEED.orgId)
      .eq('user_id', userId!)
      .single()
      .throwOnError();
    expect(member).toEqual({ role: 'pm', ui_locale: 'tr-TR' });

    // Their first sign-in (the invite accepted): the panel in Turkish, no device choice made.
    await admin().auth.admin.updateUserById(userId!, { email_confirm: true });
    const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    try {
      const theirs = await context.newPage();
      await signInWithMagicLink(theirs, OFFICE_EMAIL);
      await expect(theirs.locator('html')).toHaveAttribute('lang', 'tr');
      await expect(
        theirs.getByRole('navigation', { name: 'Ana gezinme' }).getByRole('link', {
          name: 'Genel bakış',
        }),
      ).toBeVisible();
    } finally {
      await context.close();
    }
  },
);
