import AxeBuilder from '@axe-core/playwright';
import { expect, type Page } from '@playwright/test';

/** The WCAG 2.2 AA rule tags axe runs on every field screen (CLAUDE.md "WCAG 2.2 AA"). */
export const WCAG_22_AA = ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22a', 'wcag22aa'];

export async function expectNoAxeViolations(page: Page) {
  await page.evaluate(() => document.fonts.ready);
  const { violations } = await new AxeBuilder({ page }).withTags(WCAG_22_AA).analyze();
  const report = violations
    .map(
      (v) =>
        `${v.id} (${v.impact ?? 'n/a'}): ${v.help} → ${v.nodes.map((n) => n.target.join(' ')).join(', ')}`,
    )
    .join('\n');
  expect(report).toBe('');
}

/** Every field screen works at 390 px: nothing scrolls sideways. */
export async function expectNoSidewaysScroll(page: Page) {
  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
  );
  expect(overflow, 'horizontal overflow in px').toBeLessThanOrEqual(0);
}

/**
 * §14.6: field targets are at least 56 px both ways. Links inside a sentence (the privacy notice)
 * are exempt (WCAG 2.5.8 "inline"); none is on a screen this checks.
 */
export async function expectFieldTargets(page: Page) {
  for (const target of await page.locator('a[href], button').all()) {
    const box = await target.boundingBox();
    expect(box, await target.evaluate((el) => el.outerHTML)).not.toBeNull();
    const html = await target.evaluate((el) => el.outerHTML.slice(0, 160));
    expect(Math.round(box!.height), html).toBeGreaterThanOrEqual(56);
    expect(Math.round(box!.width), html).toBeGreaterThanOrEqual(56);
  }
}

/** The three checks every field screen passes at 390 px. */
export async function expectFieldScreen(page: Page) {
  await expectNoSidewaysScroll(page);
  await expectFieldTargets(page);
  await expectNoAxeViolations(page);
}
