import { defineConfig, devices } from '@playwright/test';
import { chromiumExecutablePath } from './playwright.config';
import { ANON_KEY, APP_URL, SUPABASE_URL } from './e2e/supabase/support';

/**
 * §17 E2E against a local Supabase stack (`supabase start`; see e2e/supabase/support.ts):
 *   set -a; eval "$(supabase status -o env)"; set +a
 *   pnpm --filter @sitelog/web e2e:supabase
 * The panel is built in Supabase mode (no VITE_DEMO) and served on :5173, the origin that
 * supabase/config.toml allows as a magic-link redirect and APP_URL allows for CORS.
 *
 * Two projects: `supabase` (every spec but e2e/supabase/worker/) runs with no worker, so the jobs
 * it enqueues stay queued; `worker` (e2e/supabase/worker/) needs the worker running against the
 * same stack (`pnpm dev:worker`, its /health at WORKER_HEALTH_URL) and skips locally without it.
 * CI runs `--project=supabase`, starts the worker, then `--project=worker` (ci.yml e2e-supabase).
 */
const DIST = 'node_modules/.e2e/supabase';
const PORT = new URL(APP_URL).port;

export default defineConfig({
  testDir: './e2e/supabase',
  testMatch: /\.spec\.ts$/,
  timeout: 90_000,
  expect: { timeout: 15_000 },
  fullyParallel: false,
  workers: 1,
  forbidOnly: !!process.env.CI,
  retries: 0,
  reporter: process.env.CI ? [['list'], ['html', { open: 'never' }]] : [['list']],
  use: {
    ...devices['Desktop Chrome'],
    baseURL: APP_URL,
    viewport: { width: 1440, height: 900 },
    trace: 'retain-on-failure',
    launchOptions: { executablePath: chromiumExecutablePath },
  },
  projects: [
    { name: 'supabase', testIgnore: /\/worker\// },
    { name: 'worker', testMatch: /\/worker\/.*\.spec\.ts$/ },
  ],
  webServer: {
    command: `pnpm exec vite build --outDir ${DIST} --emptyOutDir && pnpm exec vite preview --outDir ${DIST} --port ${PORT} --strictPort`,
    url: APP_URL,
    reuseExistingServer: false,
    timeout: 180_000,
    env: {
      VITE_DEMO: 'false',
      VITE_SUPABASE_URL: SUPABASE_URL,
      VITE_SUPABASE_ANON_KEY: ANON_KEY,
      VITE_APP_URL: APP_URL,
    },
  },
});
