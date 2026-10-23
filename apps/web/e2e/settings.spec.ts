import AxeBuilder from '@axe-core/playwright';
import { expect, test, type Page } from '@playwright/test';

/**
 * W4-05 · Settings on v1.2 (spec P12, F22, §19 Q231–Q233) in demo mode: Kestrel's Field channels
 * (the US pack read-only, the daily link, calls, the recording notice, the test message dialog),
 * Reports & reminders without a WhatsApp word, and the report language card, in English and in
 * Turkish, axe WCAG 2.2 AA and no sideways scroll at 1440 and 390 px. Demir Yapı's TR pack is the
 * page test (`src/app/settings/Page.test.tsx`) and W4-16's stack run.
 */

const WCAG_22_AA = ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22a', 'wcag22aa'];

async function signInFast(page: Page, lang: 'en' | 'tr') {
  await page.addInitScript((tr) => {
    window.localStorage.setItem('sitelog.demo.session', JSON.stringify({ key: 'admin' }));
    if (tr) window.localStorage.setItem('sitelog.language', JSON.stringify('tr'));
  }, lang === 'tr');
}

async function expectNoViolations(page: Page) {
  await page.evaluate(() => document.fonts.ready);
  const { violations } = await new AxeBuilder({ page }).withTags(WCAG_22_AA).analyze();
  expect(
    violations
      .map((v) => `${v.id}: ${v.help} ${v.nodes.map((n) => n.target.join(' ')).join(', ')}`)
      .join('\n'),
  ).toBe('');
}

const overflow = (page: Page) =>
  page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);

const COPY = {
  en: {
    title: 'Settings',
    talkNow: 'Talk now only',
    twoWay: 'Two-way',
    order: 'Notifications → WhatsApp',
    test: 'Send me a test message',
    attest: 'This is my own number.',
    send: 'Send test message',
    demo: 'Demo company: nothing was sent.',
    dailyLink: 'Daily link',
    perPerson: 'Text or call — per person',
    reportLocale: 'Report language and units',
  },
  tr: {
    title: 'Ayarlar',
    talkNow: 'Yalnızca Şimdi konuş',
    twoWay: 'Çift yönlü',
    order: 'Bildirimler → WhatsApp',
    test: 'Bana deneme mesajı gönder',
    attest: 'Bu numara bana ait.',
    send: 'Deneme mesajı gönder',
    demo: 'Demo şirket: hiçbir şey gönderilmedi.',
    dailyLink: 'Günlük bağlantı',
    perPerson: 'Mesaj veya arama — kişiye göre',
    reportLocale: 'Rapor dili ve birimler',
  },
} as const;

for (const width of [1440, 390] as const) {
  for (const lang of ['en', 'tr'] as const) {
    test(`Kestrel's Field channels and Reports & reminders, ${lang} at ${width} px`, async ({
      page,
    }) => {
      const c = COPY[lang];
      await page.setViewportSize({ width, height: 900 });
      await signInFast(page, lang);

      await page.goto('/settings/channels');
      await expect(page.getByRole('heading', { level: 1, name: c.title })).toBeVisible();
      const pack = page.getByTestId('pack-card');
      await expect(pack).toContainText(c.talkNow);
      await expect(pack).toContainText(c.twoWay);
      await expect(page.getByTestId('channel-order')).toHaveText(c.order);
      await expect(page.getByTestId('recording-notice')).toContainText(
        'This call is recorded to write your daily report.',
      );
      expect(await overflow(page)).toBeLessThanOrEqual(0);
      await expectNoViolations(page);

      // The test message: a demo org's text is console (the panel says so), audited.
      await page.getByRole('button', { name: c.test }).click();
      const dialog = page.getByRole('dialog', { name: c.test });
      await expect(dialog).toBeVisible();
      await dialog.getByTestId('test-phone').fill('(555) 014-2290');
      await dialog.getByRole('checkbox', { name: c.attest }).check();
      await expectNoViolations(page);
      await dialog.getByRole('button', { name: c.send }).click();
      await expect(dialog.getByTestId('test-result')).toContainText(c.demo);
      await page.keyboard.press('Escape');

      await page.goto('/settings/reports');
      const ladder = page.getByTestId('ladder');
      await expect(ladder.getByTestId('stage-dailyLink')).toContainText(c.dailyLink);
      await expect(ladder.getByTestId('stage-reminder1')).toContainText(c.perPerson);
      await expect(page.locator('main')).not.toContainText('WhatsApp');
      expect(await overflow(page)).toBeLessThanOrEqual(0);
      await expectNoViolations(page);

      await page.goto('/settings/pdf');
      await expect(page.getByTestId('report-locale')).toContainText(c.reportLocale);
      expect(await overflow(page)).toBeLessThanOrEqual(0);
      await expectNoViolations(page);
    });
  }
}
