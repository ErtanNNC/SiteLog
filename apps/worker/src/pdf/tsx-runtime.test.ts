import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * `pnpm dev:worker` runs the worker from source under tsx (`tsx watch src/index.ts`), not under
 * Vite: tsx compiled packages/pdf's .tsx files (outside the worker tsconfig's `include`) with the
 * classic JSX runtime, so render_pdf and build_evidence_pack died with "React is not defined"
 * (CI "E2E · local Supabase stack"). Vitest cannot see that, so this renders both documents
 * through the functions those jobs call (pdf/render.ts) in a tsx child process (pdf/tsx-smoke.ts)
 * started the way the dev script starts it: from the worker's directory, with no --tsconfig.
 */
const workerRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const tsx = join(workerRoot, 'node_modules', '.bin', 'tsx');

describe.skipIf(!existsSync(tsx))('PDF rendering under tsx (the dev worker runtime)', () => {
  it('renders the report and the evidence pack without a JSX runtime error', () => {
    const run = spawnSync(tsx, ['src/pdf/tsx-smoke.ts'], {
      cwd: workerRoot,
      encoding: 'utf8',
      timeout: 120_000,
      env: { ...process.env, NODE_OPTIONS: '' },
    });
    expect(run.stderr).not.toMatch(/React is not defined|reading 'props'/);
    expect(run.status, run.stderr).toBe(0);
    expect(run.stdout).toMatch(/^rendered \d+ \d+ \d+/m);
  }, 150_000);
});
