import { expect, type Page } from '@playwright/test';
import { UI_RESOURCES } from '@sitelog/shared/copy/ui/index.ts';

const copy = UI_RESOURCES.en.field;

/** The Today header's site switcher (F14): its name holds the site shown (WCAG 2.5.3). */
export function siteSwitcher(page: Page, siteName?: string) {
  return page.getByRole('button', {
    name: siteName
      ? `${siteName}, ${copy.today.changeSite}`
      : new RegExp(`, ${copy.today.changeSite}$`),
  });
}

/**
 * Shows `siteName` on Today through the switcher (F14), unless it is the site shown already (the
 * sheet's current row reloads nothing).
 */
export async function pickSite(page: Page, siteName: string): Promise<void> {
  // Today loaded (the header names the loaded site only then).
  await expect(page.getByRole('heading', { name: copy.today.promptsTitle })).toBeVisible();
  const switcher = siteSwitcher(page);
  await expect(switcher).toBeVisible();
  if ((await switcher.getAttribute('aria-label')) === `${siteName}, ${copy.today.changeSite}`)
    return;
  await switcher.click();
  await page
    .getByRole('dialog', { name: copy.today.siteSheetTitle })
    .getByRole('button', { name: siteName, exact: true })
    .click();
  await expect(siteSwitcher(page, siteName)).toBeVisible();
  await expect(page.getByRole('heading', { name: copy.today.promptsTitle })).toBeVisible();
}
