import AxeBuilder from '@axe-core/playwright';
import { expect, test, type Page } from '@playwright/test';
import { demoId } from '@sitelog/shared/demo/ids.ts';

/**
 * W3-05 · P7 for a call in demo mode (spec §11.3 `MediaPlayer`, P7): Northgate's Oct 9 call plays
 * its synthetic two-lane recording, the speaker filter hides the assistant's lines, a crew line's
 * *call 0:10* seeks it, with axe WCAG 2.2 AA, keyboard use and no sideways scroll at 1440 and
 * 390 px, in English and in Turkish.
 */

const WCAG_22_AA = ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22a', 'wcag22aa'];
const NORTHGATE_REPORT = demoId('report:northgate:2026-10-09');

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
    heading: /Northgate/,
    filter: 'Speaker',
    both: 'Both',
    reporter: 'Site manager',
    agentLane: 'TalkOlog assistant',
    call: /^call 0:10/,
  },
  tr: {
    heading: /Northgate/,
    filter: 'Konuşan',
    both: 'İkisi de',
    reporter: 'Şantiye şefi',
    agentLane: 'TalkOlog asistanı',
    call: /^arama 0:10/,
  },
} as const;

for (const lang of ['en', 'tr'] as const) {
  for (const width of [1440, 390] as const) {
    test(`Northgate's call on P7 at ${width}px (${lang})`, async ({ page }) => {
      const c = COPY[lang];
      await page.setViewportSize({ width, height: width === 390 ? 844 : 900 });
      await signInFast(page, lang);
      await page.goto(`/reports/${NORTHGATE_REPORT}`);
      await expect(page.getByRole('heading', { name: c.heading, level: 1 })).toBeVisible({
        timeout: 20_000,
      });

      // Two lanes, labelled, and the synthetic recording loaded.
      const player = page.getByTestId('media-player');
      await expect(player).toHaveAttribute('data-lanes', '2');
      await expect(player.getByTestId('lane-reporter')).toContainText(c.reporter);
      await expect(player.getByTestId('lane-agent')).toContainText(c.agentLane);
      await expect(player.locator('audio')).toHaveAttribute('src', /demo\/call-northgate\.ogg$/);
      expect(await overflow(page), 'P7').toBeLessThanOrEqual(0);
      await expectNoViolations(page);

      // The filter, by keyboard: the site manager only hides the assistant's lines.
      const clip = page.getByTestId('source-clip');
      await expect(clip.getByText(/Hi Kevin, this is the TalkOlog assistant/)).toBeVisible();
      const filter = page.getByRole('group', { name: c.filter });
      const reporterOnly = filter.getByRole('button', { name: c.reporter });
      await reporterOnly.focus();
      await page.keyboard.press('Enter');
      await expect(reporterOnly).toHaveAttribute('aria-pressed', 'true');
      await expect(player.getByTestId('lane-agent')).toHaveAttribute('data-dimmed', 'true');
      await expect(clip.getByText(/Hi Kevin/)).toHaveCount(0);
      await expect(clip.getByText(/Apex, 3 guys, 8 hours/)).toBeVisible();
      await expectNoViolations(page);
      await filter.getByRole('button', { name: c.both }).click();
      await expect(clip.getByText(/Hi Kevin/)).toBeVisible();

      // A crew line's call second seeks the call and plays it.
      // (A table at 1440 px, crew cards at 390 px: the first crew line is Apex at 0:10.)
      await page.getByRole('button', { name: c.call }).first().click();
      await expect(player.getByTestId('player-toggle')).toHaveAttribute('aria-pressed', 'true');
      await expect(player.getByTestId('player-position')).toHaveAttribute(
        'aria-valuetext',
        /^0:1\d$/,
      );
      // The recording really plays (Chromium decodes the Ogg Opus file).
      await expect
        .poll(() => player.locator('audio').evaluate((a: HTMLAudioElement) => a.currentTime), {
          timeout: 10_000,
        })
        .toBeGreaterThan(10.2);
      await player.getByTestId('player-toggle').click();
      await expect(player.getByTestId('player-toggle')).toHaveAttribute('aria-pressed', 'false');
    });
  }
}
