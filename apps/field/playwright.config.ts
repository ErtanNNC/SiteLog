import { existsSync } from 'node:fs';
import { defineConfig, devices } from '@playwright/test';
import { FIELD_PREVIEW_PORT } from './config/server.ts';

/** Its own port, next to `pnpm preview`'s (4174), so a preview you started by hand is never reused. */
const PORT = FIELD_PREVIEW_PORT + 1;
const baseURL = `http://localhost:${PORT}`;

/** The sandbox's Chromium when present (as in apps/web); CI installs the matching browser. */
const chromiumExecutablePath =
  process.env.PLAYWRIGHT_CHROMIUM_PATH ??
  (existsSync('/opt/pw-browsers/chromium') ? '/opt/pw-browsers/chromium' : undefined);

/**
 * The field app's smoke test runs against the production build (`vite preview`), the shape that is
 * deployed and installed: service worker, manifest and icons included. The build goes to its own
 * folder so it never touches `dist/`.
 */
const E2E_DIST = 'node_modules/.e2e/field';

export default defineConfig({
  testDir: './e2e',
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
      // §14.6 / CLAUDE.md: every field screen works at 390 px.
      name: 'phone-390',
      use: {
        ...devices['Desktop Chrome'],
        viewport: { width: 390, height: 844 },
        isMobile: true,
        hasTouch: true,
        deviceScaleFactor: 2,
      },
    },
  ],
  webServer: {
    command: `pnpm exec vite build --outDir ${E2E_DIST} --emptyOutDir && pnpm exec vite preview --outDir ${E2E_DIST} --port ${PORT} --strictPort`,
    url: baseURL,
    reuseExistingServer: !process.env.CI,
    timeout: 180_000,
  },
});
