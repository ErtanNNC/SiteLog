import { defineConfig } from 'vitest/config';

/**
 * `pnpm test:stack` (W1-10): the worker's real-Postgres suites (`*.stack.test.ts` under src: the
 * runner, LISTEN and the poll fallback against claim_jobs() and enqueue_job()'s NOTIFY), against
 * the local Supabase stack named by SUPABASE_DB_URL. Without it every suite skips. CI runs it in the
 * e2e-supabase job, before it starts the worker.
 */
export default defineConfig({
  test: {
    include: ['src/**/*.stack.test.ts'],
    environment: 'node',
    testTimeout: 60_000,
    hookTimeout: 60_000,
    fileParallelism: false,
  },
});
