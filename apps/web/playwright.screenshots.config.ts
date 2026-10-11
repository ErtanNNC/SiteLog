import { defineConfig, devices } from '@playwright/test';
import base, { chromiumExecutablePath } from './playwright.config';

/** Visual-review screenshots (not pixel-gated): `pnpm --filter @sitelog/web screenshots`. */
export default defineConfig({
  ...base,
  testMatch: /screenshots\.spec\.ts/,
  fullyParallel: false,
  retries: 0,
  reporter: [['list']],
  use: {
    ...base.use,
    launchOptions: { executablePath: chromiumExecutablePath },
    ignoreHTTPSErrors: process.env.PW_IGNORE_HTTPS_ERRORS === 'true',
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
});
