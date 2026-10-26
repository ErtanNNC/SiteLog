import { expect, test } from '@playwright/test';
import { UI_RESOURCES } from '@sitelog/shared/copy/ui/index.ts';
import { expectFieldScreen } from '../support/checks.ts';
import {
  createFieldFixture,
  demoReply,
  dropFieldFixture,
  FIELD_E2E_URL,
  officeSession,
  rest,
  verifiedDevice,
  type FieldFixture,
} from './stack.ts';

/**
 * W2-17 (M6 acceptance, F15, tagged `@m6 @F15`; W2-02 built Settings, W1-08 the keywords)
 * against the local Supabase stack (the `stack` project, no worker needed): a reporter on a
 * verified phone opens Settings from Today →
 * - the preference *Phone call* (`PATCH preferences`: `reporters.contact_pref`),
 * - texts off (`consent/revoke`: the `sms` consent revoked) and on again through the sheet with
 *   the Welcome wording (`consent/grant`, spec §19 Q86),
 * - STOP typed as the reporter in the Demo phone (sms-webhook's `/demo-reply` as an admin of the
 *   demo org; handled inline, console only): the reporter is `opted_out`, the `stop_confirm`
 *   reply is written, and Settings shows "reply START" with no *Turn on* (a consent never undoes
 *   an opt-out, §19 Q94); START gives the texts back,
 * - recording off behind its sheet: the Welcome & consent again, then reporting again,
 * - *Sign out this phone*: the device revoked, the link asks for a code again (F4 step 2).
 */
test.describe.configure({ mode: 'serial' });

const copy = UI_RESOURCES.en.field;
const s = copy.settings;
let f: FieldFixture | undefined;

test.beforeAll(async () => {
  f = await createFieldFixture();
});

test.afterAll(async () => {
  await dropFieldFixture(f);
});

async function heldConsents(reporterId: string): Promise<string[]> {
  const rows = await rest<{ type: string }[]>(
    'GET',
    `consents?select=type&reporter_id=eq.${reporterId}&revoked_at=is.null`,
  );
  return rows.map((r) => r.type).sort();
}

test(
  'preference, texts off and on, STOP and START, recording off, sign out',
  { tag: ['@m6', '@F15'] },
  async ({ page, context }) => {
    const fx = f!;
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
    await page.getByRole('link', { name: copy.routes.settings }).click();
    await expect(page).toHaveURL(/\/settings$/);
    await expect(page.getByRole('heading', { level: 1, name: copy.routes.settings })).toBeVisible();
    await expectFieldScreen(page);

    // The preference.
    const call = page.getByRole('radio', { name: new RegExp(copy.welcome.prefCall) });
    await call.check();
    await expect(page.getByRole('status').filter({ hasText: s.saved })).toBeVisible();
    await expect(call).toBeChecked();
    const reporter = () =>
      rest<{ contact_pref: string; status: string; opted_out_at: string | null }[]>(
        'GET',
        `reporters?select=contact_pref,status,opted_out_at&id=eq.${fx.reporter.id}`,
      ).then((r) => r[0]!);
    expect((await reporter()).contact_pref).toBe('call');

    // Texts off, then on again (the Welcome wording in the sheet).
    const smsOff = page.getByRole('button', { name: `${s.turnOff}: ${s.consents.sms}` });
    const smsOn = page.getByRole('button', { name: `${s.turnOn}: ${s.consents.sms}` });
    await smsOff.click();
    await expect(smsOn).toBeVisible();
    expect(await heldConsents(fx.reporter.id)).toEqual(['data_processing', 'recording']);
    await smsOn.click();
    const on = page.getByRole('dialog', { name: s.turnOnSheet.title });
    await expect(on).toContainText(copy.welcome.consentSms);
    await expectFieldScreen(page);
    await on.getByRole('button', { name: s.turnOnSheet.confirm }).click();
    await expect(on).toBeHidden();
    await expect(smsOff).toBeVisible();
    expect(await heldConsents(fx.reporter.id)).toEqual(['data_processing', 'recording', 'sms']);

    // STOP from the phone (the Demo phone types it as the reporter): opted out, confirmed.
    const jwt = await officeSession(fx);
    const stop = await demoReply(jwt, fx.reporter.id, 'STOP');
    expect(stop.keyword).toBe('stop');
    expect(stop.replyId).not.toBeNull();
    const stopped = await reporter();
    expect(stopped.status).toBe('opted_out');
    expect(stopped.opted_out_at).not.toBeNull();
    const replies = await rest<{ copy_key: string; provider: string; direction: string }[]>(
      'GET',
      `messages?select=copy_key,provider,direction&reporter_id=eq.${fx.reporter.id}&copy_key=eq.stop_confirm`,
    );
    expect(replies).toEqual([{ copy_key: 'stop_confirm', provider: 'console', direction: 'out' }]);
    await page.reload();
    await expect(page.getByText(s.textsStopped.start)).toBeVisible();
    await expect(smsOn).toHaveCount(0);
    await expectFieldScreen(page);

    // START gives them back.
    const start = await demoReply(jwt, fx.reporter.id, 'START');
    expect(start.keyword).toBe('start');
    expect((await reporter()).status).toBe('active');
    await page.reload();
    await expect(page.getByRole('heading', { level: 1, name: copy.routes.settings })).toBeVisible();
    await expect(page.getByText(s.textsStopped.start)).toHaveCount(0);

    // Recording off: the sheet, then the Welcome & consent again.
    await page.getByRole('button', { name: `${s.turnOff}: ${s.consents.recording}` }).click();
    const stopSheet = page.getByRole('dialog', { name: s.stopSheet.title });
    await stopSheet.getByRole('button', { name: s.stopSheet.confirm }).click();
    const required = page.getByRole('checkbox', { name: copy.welcome.consentRequired });
    await expect(required).toBeVisible();
    expect(await heldConsents(fx.reporter.id)).not.toContain('recording');
    await required.check();
    await page.getByRole('button', { name: copy.welcome.continue }).click();
    // The 20-second test is for the first open only; skip it if offered.
    const skipTest = page.getByRole('button', { name: copy.welcomeTest.skip });
    const todayHeading = page.getByRole('heading', { name: copy.today.promptsTitle });
    await expect(skipTest.or(todayHeading)).toBeVisible();
    if (await skipTest.isVisible()) await skipTest.click();
    await expect(todayHeading).toBeVisible();
    expect(await heldConsents(fx.reporter.id)).toContain('recording');

    // Sign out this phone: the device is revoked and the link asks for a code again.
    await page.getByRole('link', { name: copy.routes.settings }).click();
    await page.getByRole('button', { name: s.signOut }).click();
    const out = page.getByRole('dialog', { name: s.signOutSheet.title });
    await out.getByRole('button', { name: s.signOutSheet.confirm }).click();
    await expect(
      page.getByRole('heading', {
        level: 1,
        name: copy.device.title.replace('{{name}}', fx.reporter.name),
      }),
    ).toBeVisible();
    const [device] = await rest<{ revoked_at: string | null }[]>(
      'GET',
      `field_devices?select=revoked_at&id=eq.${cookie.deviceId}`,
    );
    expect(device!.revoked_at).not.toBeNull();
    await page.goto(`/r/${fx.code}`);
    await expect(page.getByRole('button', { name: copy.device.send })).toBeVisible();
  },
);
