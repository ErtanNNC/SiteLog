import { expect, test } from '@playwright/test';
import { UI_RESOURCES } from '@sitelog/shared/copy/ui/index.ts';
import { expectFieldScreen } from '../../support/checks.ts';
import {
  createFieldFixture,
  deviceCode,
  dropFieldFixture,
  rest,
  type FieldFixture,
} from '../stack.ts';

/**
 * F4 end to end, the M6 acceptance spec of the flow (W2-17, tagged `@m6 @F4`; W2-13 built the
 * test, F4 step 3, spec §19 Q52) against the local Supabase stack with the CI worker running (the
 * `worker` project; skips without WORKER_HEALTH_URL): a new phone opens the personal link → *Is
 * this Marco Ruiz's phone?* → the code from the console `verify_code` row (the Demo phone's) →
 * the consent with the preference *Phone call* (stored on the reporter) → *Try a 20-second
 * test* → Chromium's fake microphone → `test-clip` (outside any report) → the worker's
 * transcribe_test_clip with the fake transcriber (fixtures/voice, kind `test`) → "Heard
 * you clearly: '…'" → Today. Nothing is left behind: the clip's row has no words and no file, and
 * the reporter has no upload, transcript or report. Independent of the date.
 */
test.describe.configure({ mode: 'serial' });

const copy = UI_RESOURCES.en.field;
let f: FieldFixture | undefined;

test.beforeAll(async () => {
  test.skip(!process.env.WORKER_HEALTH_URL, 'needs the worker on the stack (WORKER_HEALTH_URL)');
  f = await createFieldFixture();
});

test.afterAll(async () => {
  await dropFieldFixture(f);
});

test(
  'new phone → code → consent and preference → the 20-second test → the fake transcript → nothing left behind',
  { tag: ['@m6', '@F4'] },
  async ({ page }) => {
    const fx = f!;
    await page.goto(`/r/${fx.code}`);
    await expect(
      page.getByRole('heading', {
        level: 1,
        name: copy.device.title.replace('{{name}}', fx.reporter.name),
      }),
    ).toBeVisible();
    await page.getByRole('button', { name: copy.device.send }).click();
    await page.getByLabel(copy.device.codeLabel).fill(await deviceCode(fx.reporter.id));

    await expect(
      page.getByRole('heading', {
        level: 1,
        name: copy.welcome.title.replace('{{name}}', fx.reporter.firstName),
      }),
    ).toBeVisible();
    await page.getByRole('checkbox', { name: copy.welcome.consentRequired }).check();
    await page.getByRole('radio', { name: new RegExp(copy.welcome.prefCall) }).check();
    await page.getByRole('button', { name: copy.welcome.continue }).click();

    await expect(
      page.getByRole('heading', { level: 1, name: copy.welcomeTest.title }),
    ).toBeVisible();
    await page.getByRole('button', { name: copy.welcomeTest.start }).click();
    await expect(page.getByRole('timer')).toHaveText(/^00:0[2-9] \/ 00:20$/, { timeout: 10_000 });
    await page.getByRole('button', { name: copy.welcomeTest.stop }).click();
    // The reporter speaks English and nothing else: Deepgram's `multi`, the ES + EN test clip.
    await expect(
      page.getByText(
        copy.welcomeTest.heard.replace('{{text}}', 'Testing, uno, dos, tres. ¿Me oyes bien?'),
      ),
    ).toBeVisible({ timeout: 60_000 });
    await expectFieldScreen(page);

    const clips = await rest<
      { snippet: string | null; transcribed_at: string | null; deleted_at: string | null }[]
    >(
      'GET',
      `test_clips?select=snippet,transcribed_at,deleted_at&reporter_id=eq.${fx.reporter.id}`,
    );
    expect(clips).toHaveLength(1);
    expect(clips[0]).toMatchObject({ snippet: null });
    expect(clips[0]!.transcribed_at).not.toBeNull();
    expect(clips[0]!.deleted_at).not.toBeNull();
    expect(await rest('GET', `uploads?select=id&reporter_id=eq.${fx.reporter.id}`)).toEqual([]);
    expect(await rest('GET', `reports?select=id&site_id=eq.${fx.site.id}`)).toEqual([]);

    await page.getByRole('button', { name: copy.welcomeTest.continue }).click();
    await expect(page).toHaveURL(/\/today$/);
    const [reporter] = await rest<{ status: string; contact_pref: string }[]>(
      'GET',
      `reporters?select=status,contact_pref&id=eq.${fx.reporter.id}`,
    );
    expect(reporter).toEqual({ status: 'active', contact_pref: 'call' });
    const devices = await rest<{ verified_at: string | null }[]>(
      'GET',
      `field_devices?select=verified_at&reporter_id=eq.${fx.reporter.id}`,
    );
    expect(devices).toHaveLength(1);
    expect(devices[0]!.verified_at).not.toBeNull();
  },
);
