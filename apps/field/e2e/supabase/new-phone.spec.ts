import { expect, test } from '@playwright/test';
import { UI_RESOURCES } from '@sitelog/shared/copy/ui/index.ts';
import { expectFieldScreen } from '../support/checks.ts';
import {
  codesSent,
  createFieldFixture,
  deviceCode,
  dropFieldFixture,
  inList,
  rest,
  verifiedDevice,
  type FieldFixture,
} from './stack.ts';

/**
 * W2-17 (M6 acceptance, F16 "new phone" and the lock, tagged `@m6 @F16`; the expired link is
 * `expired.spec.ts`) against the local Supabase stack (the `stack` project, no worker needed): an
 * active reporter whose old phone is verified and whose consents are given.
 * - A new phone (a browser with no device cookie) opens the personal link → the device check →
 *   the code from the console `verify_code` row → straight to Today (consents are the reporter's,
 *   not the phone's); the reporter now has two verified devices.
 * - Another new phone: five wrong codes ("Tries left: 4 … 0"), then the right code is refused too
 *   ("Too many tries"): field-api locks the check for the rest of the hour (F16, 5 an hour per
 *   phone, counted from the first try), audits `device.verify_locked` and posts the office's
 *   `device_verify_locked` notice once (§13 "Device check locked"); the phone stays unverified.
 */
test.describe.configure({ mode: 'serial' });

const copy = UI_RESOURCES.en.field;
let f: FieldFixture | undefined;

test.beforeAll(async () => {
  f = await createFieldFixture();
  // The old phone: verified, consents given; its cookie is never set in these browsers.
  await verifiedDevice(f);
});

test.afterAll(async () => {
  await dropFieldFixture(f);
});

async function toCodeStep(page: import('@playwright/test').Page, fx: FieldFixture) {
  await page.goto(`/r/${fx.code}`);
  await expect(
    page.getByRole('heading', {
      level: 1,
      name: copy.device.title.replace('{{name}}', fx.reporter.name),
    }),
  ).toBeVisible();
  const before = await codesSent(fx.reporter.id);
  await page.getByRole('button', { name: copy.device.send }).click();
  const input = page.getByLabel(copy.device.codeLabel);
  await expect(input).toBeVisible();
  return { input, code: await deviceCode(fx.reporter.id, before) };
}

test(
  'a new phone: the code, then Today with no consent asked again',
  { tag: ['@m6', '@F16'] },
  async ({ page }) => {
    const fx = f!;
    const { input, code } = await toCodeStep(page, fx);
    await input.fill(code);
    await expect(page).toHaveURL(/\/today$/);
    await expect(page.getByRole('heading', { name: copy.today.promptsTitle })).toBeVisible();
    await expect(page.getByRole('checkbox', { name: copy.welcome.consentRequired })).toHaveCount(0);
    await expectFieldScreen(page);
    const devices = await rest<{ verified_at: string | null; revoked_at: string | null }[]>(
      'GET',
      `field_devices?select=verified_at,revoked_at&reporter_id=eq.${fx.reporter.id}`,
    );
    expect(devices).toHaveLength(2);
    expect(devices.every((d) => d.verified_at !== null && d.revoked_at === null)).toBe(true);
  },
);

test(
  'five wrong codes lock the check: the right code is refused, the office is told',
  { tag: ['@m6', '@F16'] },
  async ({ page }) => {
    const fx = f!;
    // A fresh window of code checks (the first test used one).
    await rest('DELETE', `rate_limits?key=${inList([`code:${fx.reporter.phone}`])}`);
    const { input, code } = await toCodeStep(page, fx);
    for (let i = 1; i <= 5; i++) {
      // A different wrong code each time (the screen does not resend the same six digits).
      const wrong = String((Number(code) + i) % 1_000_000).padStart(6, '0');
      await input.fill(wrong);
      await expect(
        page.getByRole('alert').filter({
          hasText: copy.device.errors.code_invalid.replace('{{attemptsLeft}}', String(5 - i)),
        }),
      ).toBeVisible();
    }
    await input.fill(code);
    const [head, tail] = copy.device.errors.rate_limited.split('{{minutes}}');
    const escape = (t: string) => t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    await expect(
      page
        .getByRole('alert')
        .filter({ hasText: new RegExp(`${escape(head!)}\\d+${escape(tail!)}`) }),
    ).toBeVisible();
    await expect(page).not.toHaveURL(/\/today$/);
    await expectFieldScreen(page);

    const devices = await rest<{ verified_at: string | null }[]>(
      'GET',
      `field_devices?select=verified_at&reporter_id=eq.${fx.reporter.id}&order=id`,
    );
    expect(devices.filter((d) => d.verified_at === null)).toHaveLength(1);
    const audits = await rest<{ action: string }[]>(
      'GET',
      `audit_log?select=action&org_id=eq.${fx.orgId}&action=eq.device.verify_locked`,
    );
    expect(audits).toHaveLength(1);
    const notices = await rest<{ kind: string; title: string }[]>(
      'GET',
      `notifications?select=kind,title&org_id=eq.${fx.orgId}&kind=eq.device_verify_locked`,
    );
    expect(notices).toEqual([
      {
        kind: 'device_verify_locked',
        title: `${fx.reporter.name}'s phone check is locked for an hour`,
      },
    ]);
  },
);
