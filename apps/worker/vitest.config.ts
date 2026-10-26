import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['src/**/*.test.ts', 'src/**/*.test.tsx'],
    // Real-Postgres suites: `pnpm test:stack` (vitest.stack.config.ts).
    exclude: ['src/**/*.stack.test.ts', '**/node_modules/**'],
    environment: 'node',
    testTimeout: 30_000,
    hookTimeout: 30_000,
  },
});
