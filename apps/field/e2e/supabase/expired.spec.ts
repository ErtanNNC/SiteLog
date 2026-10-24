import { expect, test } from '@playwright/test';
import { UI_RESOURCES } from '@sitelog/shared/copy/ui/index.ts';
import { linkCodeHash, LINK_CODE_ALPHABET } from '@sitelog/shared/links.ts';
import { expectFieldScreen } from '../support/checks.ts';
import {
  createFieldFixture,
  dropFieldFixture,
  inList,
  rest,
  verifiedDevice,
  type FieldFixture,
} from './stack.ts';

/**
 * W2-03 (F16) against the local Supabase stack: a reporter opens a daily link that expired → the
 * Expired screen → *Send me today's link* → the real field-api makes today's daily link of the
 * same site and the Notifier writes the `daily_link` text as a console row (a demo org), as the
 * panel's Demo phone shows it. The answer and the screen never hold the new link.
 */
const copy = UI_RESOURCES.en.field;
let f: FieldFixture | undefined;
let expiredId = '';

test.beforeAll(async () => {
  f = await createFieldFixture();
  // Consents (the Notifier needs `sms`) without the phone's cookie: the expired link needs none.
  await verifiedDevice(f);
  // Every day a working day, so the run never meets `not_working_day`.
  await rest('PATCH', `org_settings?org_id=eq.${f.orgId}`, { working_days: [1, 2, 3, 4, 5, 6, 7] });
});

test.afterAll(async () => {
  if (expiredId) await rest('DELETE', `rate_limits?key=${inList([`expired_link:${expiredId}`])}`);
  await dropFieldFixture(f);
});

test(
  'an expired daily link sends today’s link to the Demo phone',
  { tag: ['@m6', '@F16'] },
  async ({ page }) => {
    const fx = f!;
    const code = Array.from(crypto.getRandomValues(new Uint8Array(8)), (b) =>
      LINK_CODE_ALPHABET.charAt(b % LINK_CODE_ALPHABET.length),
    ).join('');
    const [row] = await rest<{ id: string }[]>('POST', 'field_links', {
      code_hash: linkCodeHash(code),
      reporter_id: fx.reporter.id,
      site_id: fx.site.id,
      kind: 'daily',
      report_date: '2026-10-05',
      expires_at: new Date(Date.now() - 3_600_000).toISOString(),
    });
    expiredId = row!.id;

    await page.goto(`/r/${code}`);
    await expect(page).toHaveURL(/\/expired$/);
    await expect(page.getByRole('heading', { level: 1, name: copy.expired.title })).toBeVisible();
    await expectFieldScreen(page);
    await page.getByRole('button', { name: copy.expired.send }).click();
    await expect(page.getByRole('status').filter({ hasText: copy.expired.sent })).toBeVisible();

    // The Demo phone's text: today's daily link of the same site, never the expired one.
    await expect
      .poll(async () => {
        const rows = await rest<{ body: string; provider: string }[]>(
          'GET',
          `messages?select=body,provider&reporter_id=eq.${fx.reporter.id}&copy_key=eq.daily_link`,
        );
        return rows.map((r) => r.provider);
      })
      .toEqual(['console']);
    const links = await rest<{ id: string; site_id: string }[]>(
      'GET',
      `field_links?select=id,site_id&reporter_id=eq.${fx.reporter.id}&kind=eq.daily&expires_at=gt.${encodeURIComponent(new Date().toISOString())}`,
    );
    expect(links.map((l) => l.site_id)).toEqual([fx.site.id]);
    const audits = await rest<{ action: string }[]>(
      'GET',
      `audit_log?select=action&org_id=eq.${fx.orgId}&action=eq.daily_link.requested`,
    );
    expect(audits).toHaveLength(1);
  },
);
