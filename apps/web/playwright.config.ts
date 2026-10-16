import { existsSync } from 'node:fs';
import { defineConfig, devices } from '@playwright/test';

/**
 * 4173 unless `WEB_E2E_PORT` says otherwise, so a run beside another one on 4173 (whose server
 * `reuseExistingServer` would otherwise test) can take a free port; CI leaves it unset.
 */
const PORT = Number(process.env.WEB_E2E_PORT ?? 4173);
const baseURL = `http://localhost:${PORT}`;

/**
 * The sandbox ships a Chromium build that is older than the one @playwright/test expects, so
 * we point at it explicitly when present; CI installs the matching browser (or sets
 * PLAYWRIGHT_CHROMIUM_PATH).
 */
export const chromiumExecutablePath =
  process.env.PLAYWRIGHT_CHROMIUM_PATH ??
  (existsSync('/opt/pw-browsers/chromium') ? '/opt/pw-browsers/chromium' : undefined);

/**
 * CI (or PW_PREVIEW=1) tests a production build served by `vite preview`: faster page loads
 * than the dev server and no HMR reloads mid-test. Locally the dev server is reused.
 */
const preview = !!process.env.CI || process.env.PW_PREVIEW === '1';
const DEMO_DIST = 'node_modules/.e2e/demo';

export default defineConfig({
  testDir: './e2e',
  // Demo-mode specs only; e2e/supabase/** runs against a local Supabase stack
  // (playwright.supabase.config.ts) and the screenshots spec has its own config.
  testMatch: /(smoke|a11y|sites|hours|glossary|weather|report-call)\.spec\.ts/,
  testIgnore: /supabase\//,
  timeout: 60_000,
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? [['list'], ['html', { open: 'never' }]] : [['list']],
  use: {
    baseURL,
    trace: 'retain-on-failure',
    launchOptions: { executablePath: chromiumExecutablePath },
  },
  projects: [
    {
      name: 'chromium',
      testMatch: /(smoke|sites|hours|glossary|weather|report-call)\.spec\.ts/,
      use: { ...devices['Desktop Chrome'] },
    },
    // §15 / M9: axe WCAG 2.2 AA scan of every route at 1440 and 375 px + keyboard checks.
    { name: 'a11y', testMatch: /a11y\.spec\.ts/, use: { ...devices['Desktop Chrome'] } },
  ],
  webServer: {
    command: preview
      ? `pnpm exec vite build --outDir ${DEMO_DIST} --emptyOutDir && pnpm exec vite preview --outDir ${DEMO_DIST} --port ${PORT} --strictPort`
      : `pnpm exec vite --port ${PORT} --strictPort`,
    url: baseURL,
    reuseExistingServer: !process.env.CI,
    timeout: 180_000,
    env: { VITE_DEMO: 'true' },
  },
});
