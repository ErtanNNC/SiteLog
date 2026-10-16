import { expect, test } from '@playwright/test';
import { SEED, signInWithMagicLink } from './support';

/**
 * W2-16 Done when, the Demo phone's part, against the local stack (no worker needed: the Demo
 * phone's replies are handled inline by sms-webhook's `/demo-reply`): on Demir Yapı (TR pack,
 * one-way SMS, WhatsApp listed since 20261016000250) the admin types HELP as Emre Yıldız on the
 * WhatsApp thread, and the Turkish help text comes back there, labelled WhatsApp, with the
 * personal link (spec §9.5, §19 Q26). The reply box offers WhatsApp only: TR texts are one-way.
 */
test.describe.configure({ mode: 'serial' });

const EMRE = 'Emre Yıldız';

test('Demo phone (TR): HELP on WhatsApp is answered there in Turkish', async ({ page }) => {
  await signInWithMagicLink(page, SEED.demirAdmin.email);
  await page.goto('/dev/phone');
  await expect(page.getByRole('heading', { level: 1, name: 'Demo telefon' })).toBeVisible();
  const reporters = page.getByRole('navigation', { name: 'Rapor verenler' });
  await reporters.getByRole('button', { name: new RegExp(EMRE) }).click();
  // The one-way note belongs to the open thread, so it shows once a reporter is picked.
  await expect(
    page.getByText(
      'TR ülke paketinde SMS tek yönlü: rapor veren SiteLog’a WhatsApp’tan yanıt verir.',
    ),
  ).toBeVisible();
  const thread = page.getByRole('list', { name: `${EMRE} ile mesajlar` });
  // No texts reply on a one-way pack (§19 Q35): only the WhatsApp box.
  await expect(page.getByRole('textbox', { name: `${EMRE} olarak yanıtla` })).toHaveCount(0);
  await page.getByRole('textbox', { name: `${EMRE} olarak WhatsApp'tan yanıtla` }).fill('HELP');
  await page.getByRole('button', { name: 'Gönder', exact: true }).click();
  const help = thread
    .getByRole('listitem')
    .filter({ hasText: 'Demir Yapı A.Ş. için SiteLog günlük raporları' })
    .last();
  await expect(help).toBeVisible();
  await expect(help).toContainText('WhatsApp');
  await expect(help.getByRole('link', { name: /\/r\// })).toBeVisible();
});
