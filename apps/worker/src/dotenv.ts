import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';

/**
 * Development `.env` loading. `pnpm dev:worker` runs in `apps/worker`, so the worker reads
 * `<cwd>/.env` first and then the repository root's `.env` (the file `.env.example` is copied to).
 * Values already in the environment win over both files, and `<cwd>/.env` wins over the root
 * file. Production (`NODE_ENV=production`) reads neither: the host provides the environment.
 */

/** The nearest directory at or above `from` that holds `pnpm-workspace.yaml`. */
export function findRepoRoot(from: string): string | undefined {
  let dir = resolve(from);
  for (;;) {
    if (existsSync(join(dir, 'pnpm-workspace.yaml'))) return dir;
    const parent = dirname(dir);
    if (parent === dir) return undefined;
    dir = parent;
  }
}

/** Candidate `.env` files, highest precedence first: `<cwd>/.env`, then `<repo root>/.env`. */
export function dotenvPaths(cwd: string = process.cwd()): string[] {
  const paths = [resolve(cwd, '.env')];
  const root = findRepoRoot(cwd);
  if (root) {
    const rootEnv = join(root, '.env');
    if (!paths.includes(rootEnv)) paths.push(rootEnv);
  }
  return paths;
}

/**
 * Loads the existing candidate files into `env` (default `process.env`) without overriding
 * values that are already set. Returns the files it read; none in production.
 */
export async function loadDotenv(
  opts: { cwd?: string; env?: NodeJS.ProcessEnv } = {},
): Promise<string[]> {
  const env = opts.env ?? process.env;
  if (env.NODE_ENV === 'production') return [];
  const paths = dotenvPaths(opts.cwd).filter((p) => existsSync(p));
  if (paths.length === 0) return [];
  try {
    const dotenv = await import('dotenv');
    // With several paths and no `override`, the first file that sets a variable wins.
    dotenv.config({ path: paths, processEnv: env as Record<string, string>, quiet: true });
  } catch {
    /* dotenv is a dev convenience */
    return [];
  }
  return paths;
}
