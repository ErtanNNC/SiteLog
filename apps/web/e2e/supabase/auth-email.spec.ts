import { expect, test } from '@playwright/test';
import { admin, SEED, signInWithMagicLink } from './support';

/**
 * W4-09 (spec §13 "Magic link … Sign-in button (EN/TR)", §19 Q239; M11 Done when: "a magic link
 * requested with the language switch on TR arrives in Turkish on the local stack"). The sign-in
 * page's switch on Türkçe sends `ui_locale: tr-TR` with the request (`signInWithOtp`'s data); a new
 * address keeps it as the user's metadata and `supabase/templates/magic_link.html` (wired in
 * supabase/config.toml) picks the Turkish body. The mail is read from the local stack's mail
 * catcher: Mailpit (Supabase CLI 2.x, `/api/v1/search`) or the older Inbucket
 * (`/api/v1/mailbox/<name>`), at MAILPIT_URL / INBUCKET_URL (from `supabase status -o env`), else
 * http://127.0.0.1:54324. CI starts the stack with Mailpit on.
 */
const MAIL_URL = (
  process.env.MAILPIT_URL ??
  process.env.INBUCKET_URL ??
  'http://127.0.0.1:54324'
).replace(/\/+$/, '');

interface CaughtMail {
  id: string;
  subject: string;
  html: string;
  text: string;
}

async function getJson(url: string): Promise<unknown | null> {
  const res = await fetch(url).catch(() => null);
  if (!res || !res.ok) return null;
  return res.json().catch(() => null);
}

/** The newest email to `address`, or null while none has arrived. */
async function latestMailTo(address: string): Promise<CaughtMail | null> {
  // Mailpit
  const search = (await getJson(
    `${MAIL_URL}/api/v1/search?query=${encodeURIComponent(`to:"${address}"`)}`,
  )) as { messages?: Array<{ ID: string }> } | null;
  if (search && Array.isArray(search.messages)) {
    const id = search.messages[0]?.ID;
    if (!id) return null;
    const m = (await getJson(`${MAIL_URL}/api/v1/message/${id}`)) as {
      Subject?: string;
      HTML?: string;
      Text?: string;
    } | null;
    return m ? { id, subject: m.Subject ?? '', html: m.HTML ?? '', text: m.Text ?? '' } : null;
  }
  // Inbucket: the mailbox is the local part.
  const box = address.split('@')[0]!;
  const list = (await getJson(`${MAIL_URL}/api/v1/mailbox/${encodeURIComponent(box)}`)) as Array<{
    id: string;
  }> | null;
  const last = Array.isArray(list) ? list[list.length - 1] : undefined;
  if (!last) return null;
  const m = (await getJson(
    `${MAIL_URL}/api/v1/mailbox/${encodeURIComponent(box)}/${encodeURIComponent(last.id)}`,
  )) as { subject?: string; body?: { html?: string; text?: string } } | null;
  return m
    ? { id: last.id, subject: m.subject ?? '', html: m.body?.html ?? '', text: m.body?.text ?? '' }
    : null;
}

async function mailCatcherReachable(): Promise<boolean> {
  return fetch(`${MAIL_URL}/`)
    .then((r) => r.status < 500)
    .catch(() => false);
}

test.describe('Sign-in email in the reader’s language (W4-09)', { tag: ['@m11', '@F1'] }, () => {
  // A new address each run: GoTrue keeps the request's metadata only when it creates the user.
  const email = `w409-tr-${Date.now().toString(36)}@sitelog-e2e.example`;

  test.afterAll(async () => {
    const { data } = await admin().auth.admin.listUsers({ page: 1, perPage: 1000 });
    const user = data?.users.find((u) => u.email === email);
    if (user) await admin().auth.admin.deleteUser(user.id);
  });

  test('a magic link requested with the switch on Türkçe arrives in Turkish', async ({ page }) => {
    const reachable = await mailCatcherReachable();
    test.skip(
      !reachable && !process.env.CI,
      `No mail catcher at ${MAIL_URL}: start the stack with Mailpit (not -x mailpit)`,
    );

    await page.goto('/login');
    await page
      .getByTestId('language-switch')
      .first()
      .getByRole('button', { name: 'Türkçe' })
      .click();
    await expect(page.getByRole('heading', { name: 'Ofis paneline giriş yapın' })).toBeVisible();
    await page.getByLabel('İş e-postası').fill(email);
    await page.getByRole('button', { name: 'Bana giriş linki gönder' }).click();
    await expect(page.getByTestId('login-sent')).toContainText(email);

    // The user GoTrue created carries the switch's language.
    const { data } = await admin().auth.admin.listUsers({ page: 1, perPage: 1000 });
    const user = data.users.find((u) => u.email === email);
    expect(user?.user_metadata).toMatchObject({ ui_locale: 'tr-TR' });

    let mail: CaughtMail | null = null;
    await expect
      .poll(
        async () => {
          mail = await latestMailTo(email);
          return mail?.subject ?? '';
        },
        { timeout: 30_000, intervals: [500, 1000, 2000] },
      )
      .toBe('TalkOlog giriş linkiniz');
    const caught = mail as CaughtMail | null;
    expect(caught!.html).toContain('TalkOlog’a giriş yapın');
    expect(caught!.html).toContain('Giriş yap');
    expect(caught!.html).toContain('lang="tr"');
    expect(caught!.html).not.toContain('Sign in to TalkOlog');
    // The button carries GoTrue's verify link back to the panel.
    expect(caught!.html).toMatch(/\/auth\/v1\/verify\?token=/);
  });
});

/**
 * §19 Q340: GoTrue ignores `signInWithOtp`'s data for an existing user, so the panel writes the
 * language chosen in the account menu into the user's metadata; the next sign-in email follows.
 * The seeded admin's metadata is `en-US` and is put back afterwards.
 */
test.describe('Sign-in email after a language switch (§19 Q340)', { tag: ['@m11', '@F1'] }, () => {
  async function lena() {
    const { data } = await admin().auth.admin.listUsers({ page: 1, perPage: 1000 });
    return data.users.find((u) => u.email === SEED.admin.email);
  }

  test.afterAll(async () => {
    const user = await lena();
    if (user) {
      await admin().auth.admin.updateUserById(user.id, {
        user_metadata: { ...user.user_metadata, ui_locale: 'en-US' },
      });
    }
  });

  test('an existing user who switched to Türkçe gets the next magic link in Turkish', async ({
    page,
  }) => {
    const reachable = await mailCatcherReachable();
    test.skip(
      !reachable && !process.env.CI,
      `No mail catcher at ${MAIL_URL}: start the stack with Mailpit (not -x mailpit)`,
    );
    const before = await lena();
    expect(before?.user_metadata).toMatchObject({ ui_locale: 'en-US' });
    const previousMail = (await latestMailTo(SEED.admin.email))?.id ?? null;

    await signInWithMagicLink(page);
    await page
      .getByRole('button', { name: /Account menu$/ })
      .first()
      .click();
    await page
      .getByRole('group', { name: 'Language' })
      .getByRole('menuitemradio', { name: 'Türkçe' })
      .click();
    await expect(page.getByRole('navigation', { name: 'Ana gezinme' }).first()).toBeVisible();
    await expect.poll(async () => (await lena())?.user_metadata?.ui_locale).toBe('tr-TR');

    await page
      .getByRole('button', { name: /Hesap menüsü$/ })
      .first()
      .click();
    await page.getByRole('menuitem', { name: 'Çıkış yap' }).click();
    await page.waitForURL((url) => url.pathname === '/login');
    await page.getByLabel('İş e-postası').fill(SEED.admin.email);
    // GoTrue refuses a second email to the same user within its minimum interval (429
    // over_email_send_rate_limit), and the sign-in above just sent one: ask again until it passes.
    await expect(async () => {
      if (!(await page.getByTestId('login-sent').isVisible())) {
        await page.getByRole('button', { name: 'Bana giriş linki gönder' }).click();
      }
      await expect(page.getByTestId('login-sent')).toContainText(SEED.admin.email, {
        timeout: 3_000,
      });
    }).toPass({ timeout: 30_000, intervals: [1_000, 2_000] });

    let mail: CaughtMail | null = null;
    await expect
      .poll(
        async () => {
          mail = await latestMailTo(SEED.admin.email);
          return mail && mail.id !== previousMail ? mail.subject : '';
        },
        { timeout: 30_000, intervals: [500, 1000, 2000] },
      )
      .toBe('TalkOlog giriş linkiniz');
    const caught = mail as CaughtMail | null;
    expect(caught!.html).toContain('lang="tr"');
    expect(caught!.html).not.toContain('Sign in to TalkOlog');
  });
});
