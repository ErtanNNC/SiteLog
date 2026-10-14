import { expect, test } from '@playwright/test';
import { DEMIR_ORG_ID } from '@sitelog/shared/demo/demir.ts';
import { admin, pinSeedClock, signInWithMagicLink } from './support';

/**
 * §18.2 TR demo org Demir Yapı A.Ş. in the panel (W1-06 Done when): its sites with the shell in
 * Turkish, from the org's tr-TR locale. The seed has no Demir Yapı office user (spec §19 question
 * 18), so this test makes a temporary one with the service role and deletes it afterwards. Its
 * pages get Turkish copy in W1-16 … W1-18; the Overview is still English inside the TR shell.
 */
test.describe.configure({ mode: 'serial' });

const EMAIL = `e2e-tr-${Date.now()}@demiryapi.example`;
let userId = '';

test.beforeAll(async () => {
  const created = await admin().auth.admin.createUser({ email: EMAIL, email_confirm: true });
  if (created.error) throw created.error;
  userId = created.data.user!.id;
  // A project manager, not an admin: removing the seat needs no other admin (guard_last_admin).
  await admin()
    .from('org_members')
    .insert({ org_id: DEMIR_ORG_ID, user_id: userId, role: 'pm', display_name: 'E2E TR' })
    .throwOnError();
});

test.afterAll(async () => {
  // Deleting the user deletes the membership (org_members cascades from auth.users).
  if (userId) await admin().auth.admin.deleteUser(userId);
});

test('Demir Yapı A.Ş.: the org’s sites with the shell in Turkish', async ({ page }) => {
  await pinSeedClock(page);
  await signInWithMagicLink(page, EMAIL);
  await expect(page.locator('html')).toHaveAttribute('lang', 'tr');
  await expect(
    page.getByRole('button', { name: 'Demir Yapı A.Ş. 2 aktif şantiye, Şirket değiştir' }),
  ).toBeVisible();
  const nav = page.getByRole('navigation', { name: 'Ana gezinme' });
  for (const name of ['Genel bakış', 'Şantiyeler', 'Raporlar', 'Puantaj'])
    await expect(nav.getByRole('link', { name })).toBeVisible();
  await expect(page.getByRole('heading', { level: 1, name: 'Today across 2 sites' })).toBeVisible();
  const table = page.getByRole('table', { name: 'Sites today' });
  for (const name of ['Kartal Konutları — B Blok', 'Ataşehir Ofis Binası'])
    await expect(table.getByRole('link', { name, exact: true })).toBeVisible();
  await expect(table.getByText('Emre Yıldız')).toBeVisible();
  // Only its own org: nothing of Kestrel's.
  await expect(page.getByText('Riverside Lofts — Block B')).toHaveCount(0);
});
