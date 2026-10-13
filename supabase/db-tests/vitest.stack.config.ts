import { defineConfig } from 'vitest/config';
import { SKIP_MESSAGE, STACK_DB_URL } from './stack/db.ts';

if (!STACK_DB_URL) console.warn(`\n${SKIP_MESSAGE}\n`);

/**
 * `pnpm test:stack`: tests that need real Postgres (several sessions, row locks, LISTEN), run
 * against the database of a running local Supabase stack (`supabase start`) named by
 * SUPABASE_DB_URL. Without it every suite skips. PGlite (`pnpm test:db`) is one session only.
 */
export default defineConfig({
  test: {
    include: ['stack/**/*.test.ts'],
    environment: 'node',
    testTimeout: 60_000,
    hookTimeout: 60_000,
    fileParallelism: false,
  },
});
