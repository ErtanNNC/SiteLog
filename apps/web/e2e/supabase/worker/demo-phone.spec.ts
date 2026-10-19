import { expect, test, type Page } from '@playwright/test';
import { admin, SEED, signInWithMagicLink, SUPABASE_URL } from '../support';

/**
 * W1-08 Done when, against the local stack with the worker running (the `worker` project of
 * playwright.supabase.config.ts; CI starts the worker after the panel specs): inviting Marco shows
 * the welcome text in the Demo phone with a working personal link. The invite goes through
 * api-invite-reporter (the personal `field_links` row) and the queue; the worker's send_welcome
 * texts it through the Notifier on the console driver (Kestrel is a demo org), and the Demo phone,
 * open on Marco's thread in a second tab since before the invite, shows the row over Realtime
 * with no navigation or reload. The link resolves at field-api. A HELP typed as Marco runs the
 * inbound handler (sms-webhook's `/demo-reply`, inline) and re-sends the same link (codes are
 * derived, spec §4.5).
 */
test.describe.configure({ mode: 'serial' });

const WORKER_HEALTH_URL = process.env.WORKER_HEALTH_URL ?? 'http://127.0.0.1:8080/health';
const MARCO = { name: 'Marco Ruiz', national: '555 014 3378', e164: '+15550143378' };
const ELM = 'Elm St. Townhomes';

test.beforeAll(async () => {
  const up = await fetch(WORKER_HEALTH_URL)
    .then((r) => r.ok)
    .catch(() => false);
  // Locally the spec needs `pnpm dev:worker` against the same stack; CI must never skip it.
  test.skip(!up && !process.env.CI, `no worker at ${WORKER_HEALTH_URL} (pnpm dev:worker)`);
  expect(up, `the worker answers at ${WORKER_HEALTH_URL}`).toBe(true);
});

test.beforeEach(async ({ page }) => {
  await signInWithMagicLink(page);
});

/** The personal link in a text: `{FIELD_APP_URL}/r/{code}`. */
function linkCode(href: string | null): string {
  const m = /\/r\/([^/?#\s]+)$/.exec(href ?? '');
  if (!m) throw new Error(`not a personal link: ${href}`);
  return m[1]!;
}

async function openMarcoThread(page: Page) {
  await page.goto('/dev/phone');
  await expect(page.getByRole('heading', { level: 1, name: 'Demo phone' })).toBeVisible();
  const reporters = page.getByRole('navigation', { name: 'Reporters' });
  await reporters.getByRole('button', { name: new RegExp(MARCO.name) }).click();
  const thread = page.getByRole('list', { name: `Texts with ${MARCO.name}` });
  await expect(thread).toBeVisible();
  return thread;
}

test('inviting Marco to another site shows the welcome text with a working personal link', async ({
  page,
  context,
}) => {
  // The Demo phone first, in a second tab of the same session, on Marco's thread: whatever the
  // worker writes from now on can only reach it over Realtime (no navigation, no reload below).
  const phone = await context.newPage();
  const thread = await openMarcoThread(phone);
  const welcomeBubbles = thread.getByRole('listitem').filter({ hasText: `at ${ELM}` });
  const before = await welcomeBubbles.count();

  await page.getByRole('link', { name: 'Team & numbers' }).click();
  await page.getByRole('button', { name: 'Invite reporter' }).first().click();
  const dialog = page.getByRole('dialog', { name: 'Invite reporter' });
  await dialog.getByLabel('Name', { exact: true }).fill(MARCO.name);
  await dialog.getByTestId('invite-phone').fill(MARCO.national);
  await dialog.getByRole('checkbox', { name: ELM }).check();
  await dialog.getByRole('checkbox', { name: 'Spanish' }).check();
  await dialog.getByRole('button', { name: 'Send welcome text' }).click();
  await expect(dialog).toBeHidden();
  await expect(page.getByText(`Welcome text queued for ${MARCO.name}.`)).toBeVisible();

  // The same phone in the same org is the same reporter, now also on Elm St. (§F2 edge case).
  const { data: marco } = await admin()
    .from('reporters')
    .select('id')
    .eq('org_id', SEED.orgId)
    .eq('phone_e164', MARCO.e164)
    .single();
  const { data: onElm } = await admin()
    .from('site_reporters')
    .select('site_id')
    .eq('reporter_id', marco!.id)
    .eq('site_id', SEED.sites.elm);
  expect(onElm).toHaveLength(1);

  // The worker's send_welcome, on the console driver, arrives in the thread that was already open.
  await expect(welcomeBubbles).toHaveCount(before + 1, { timeout: 60_000 });
  const welcome = welcomeBubbles.last();
  await expect(welcome).toBeVisible();
  await expect(phone).toHaveURL(/\/dev\/phone$/);
  await expect(welcome).toContainText("Hi Marco, I'm TalkOlog");
  await expect(welcome).toContainText('welcome');
  const link = welcome.getByRole('link', { name: /\/r\// });
  await expect(link).toHaveAttribute('target', '_blank');
  const code = linkCode(await link.getAttribute('href'));

  // The row as the worker wrote it: console provider, full text (a demo org), the welcome key;
  // queued first, then delivered once the console driver has taken it.
  await expect
    .poll(async () => {
      const { data } = await admin()
        .from('messages')
        .select('provider, channel, direction, status')
        .eq('reporter_id', marco!.id)
        .eq('copy_key', 'welcome')
        .like('body', `%${code}%`);
      return data;
    })
    .toEqual([{ provider: 'console', channel: 'sms', direction: 'out', status: 'delivered' }]);

  // The link works: field-api resolves it to Marco's personal link (F4 step 1).
  const res = await fetch(`${SUPABASE_URL}/functions/v1/field-api/resolve`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json' },
    body: JSON.stringify({ code }),
  });
  expect(res.status).toBe(200);
  const resolved = (await res.json()) as {
    reporter: { name: string };
    link: { kind: string };
    country: { code: string; twoWaySms: boolean };
  };
  expect(resolved.reporter.name).toBe(MARCO.name);
  expect(resolved.link.kind).toBe('personal');
  expect(resolved.country).toMatchObject({ code: 'US', twoWaySms: true });

  // HELP typed as Marco: the inbound handler answers with the same personal link.
  await phone.getByRole('textbox', { name: `Reply as ${MARCO.name}` }).fill('HELP');
  await phone.getByRole('button', { name: 'Send', exact: true }).click();
  const help = thread
    .getByRole('listitem')
    .filter({ hasText: 'TalkOlog daily reports for Kestrel Build Group' })
    .last();
  await expect(help).toBeVisible();
  expect(linkCode(await help.getByRole('link', { name: /\/r\// }).getAttribute('href'))).toBe(code);
  await phone.close();
});
