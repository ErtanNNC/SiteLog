import { expect, test } from '@playwright/test';
import { admin } from './support';

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
    return m ? { subject: m.Subject ?? '', html: m.HTML ?? '', text: m.Text ?? '' } : null;
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
    ? { subject: m.subject ?? '', html: m.body?.html ?? '', text: m.body?.text ?? '' }
    : null;
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
    const reachable = await fetch(`${MAIL_URL}/`)
      .then((r) => r.status < 500)
      .catch(() => false);
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
      .toBe('SiteLog giriş linkiniz');
    const caught = mail as CaughtMail | null;
    expect(caught!.html).toContain('SiteLog’a giriş yapın');
    expect(caught!.html).toContain('Giriş yap');
    expect(caught!.html).toContain('lang="tr"');
    expect(caught!.html).not.toContain('Sign in to SiteLog');
    // The button carries GoTrue's verify link back to the panel.
    expect(caught!.html).toMatch(/\/auth\/v1\/verify\?token=/);
  });
});
