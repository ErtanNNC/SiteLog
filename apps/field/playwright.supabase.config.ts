import { defineConfig } from '@playwright/test';
import { chromiumExecutablePath, FAKE_MEDIA_ARGS, PHONE_390 } from './playwright.config';
import { API_URL, FIELD_E2E_PORT, FIELD_E2E_URL } from './e2e/supabase/stack';

/**
 * W1-09 field flow against a local Supabase stack (`supabase start`; see e2e/supabase/stack.ts):
 *   set -a; eval "$(supabase status -o env)"; set +a
 *   pnpm --filter @sitelog/field e2e:supabase
 * The production build is served by `vite preview` on :4176 with its `/api` proxy pointed at the
 * stack (`SUPABASE_URL`, config/server.ts), so the app calls the real field-api same-origin as on
 * the field host. `supabase/functions/.env` must allow that origin (`CORS_EXTRA_ORIGINS` with
 * http://localhost:4176) and set `STORAGE_PUBLIC_URL` to the API URL, so the signed upload URLs
 * name a host the browser reaches (CI's e2e-supabase job does both). Chromium gets a fake
 * microphone (a tone) with the permission granted.
 */
const DIST = 'node_modules/.e2e/field-supabase';

export default defineConfig({
  testDir: './e2e/supabase',
  testMatch: /\.spec\.ts$/,
  timeout: 120_000,
  expect: { timeout: 15_000 },
  fullyParallel: false,
  workers: 1,
  forbidOnly: !!process.env.CI,
  retries: 0,
  reporter: process.env.CI ? [['list'], ['html', { open: 'never' }]] : [['list']],
  use: {
    ...PHONE_390,
    baseURL: FIELD_E2E_URL,
    locale: 'en-US',
    permissions: ['microphone'],
    trace: 'retain-on-failure',
    launchOptions: { executablePath: chromiumExecutablePath, args: FAKE_MEDIA_ARGS },
  },
  webServer: {
    command: `pnpm exec vite build --outDir ${DIST} --emptyOutDir && pnpm exec vite preview --outDir ${DIST} --port ${FIELD_E2E_PORT} --strictPort`,
    url: FIELD_E2E_URL,
    reuseExistingServer: false,
    timeout: 180_000,
    // The /api proxy's target (server-side only: nothing here reaches the bundle).
    env: { SUPABASE_URL: API_URL, VITE_FIELD_API_URL: '/api' },
  },
});
