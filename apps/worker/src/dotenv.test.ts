import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { evalMain } from './ai/eval';
import { loadConfig } from './config';
import { dotenvPaths, findRepoRoot, loadDotenv } from './dotenv';

const REPO_ROOT = resolve(import.meta.dirname, '..', '..', '..');

describe('worker .env loading', () => {
  let root: string;
  let worker: string;

  beforeEach(() => {
    // A throwaway workspace shaped like the repo: <root>/pnpm-workspace.yaml + <root>/apps/worker.
    root = mkdtempSync(join(tmpdir(), 'sitelog-dotenv-'));
    worker = join(root, 'apps', 'worker');
    mkdirSync(worker, { recursive: true });
    writeFileSync(join(root, 'pnpm-workspace.yaml'), 'packages:\n  - apps/*\n');
  });

  afterEach(() => {
    vi.restoreAllMocks();
    rmSync(root, { recursive: true, force: true });
  });

  it('finds this repository root from the worker package (pnpm dev:worker runs there)', () => {
    expect(findRepoRoot(join(REPO_ROOT, 'apps', 'worker'))).toBe(REPO_ROOT);
    expect(dotenvPaths(join(REPO_ROOT, 'apps', 'worker'))).toEqual([
      join(REPO_ROOT, 'apps', 'worker', '.env'),
      join(REPO_ROOT, '.env'),
    ]);
  });

  it('lists <cwd>/.env first and the root .env once when run from the root', () => {
    expect(dotenvPaths(worker)).toEqual([join(worker, '.env'), join(root, '.env')]);
    expect(dotenvPaths(root)).toEqual([join(root, '.env')]);
  });

  it('reads the root .env from apps/worker, so the worker config loads from it', async () => {
    writeFileSync(
      join(root, '.env'),
      'SUPABASE_DB_URL=postgresql://postgres:postgres@127.0.0.1:54322/postgres\nCLAUDE_MODEL=from-root\n',
    );
    const env: NodeJS.ProcessEnv = { NODE_ENV: 'development' };

    const read = await loadDotenv({ cwd: worker, env });

    expect(read).toEqual([join(root, '.env')]);
    const config = loadConfig(env);
    expect(config.SUPABASE_DB_URL).toBe('postgresql://postgres:postgres@127.0.0.1:54322/postgres');
    expect(config.CLAUDE_MODEL).toBe('from-root');
  });

  it('prefers <cwd>/.env over the root .env, and the environment over both', async () => {
    writeFileSync(join(root, '.env'), 'CLAUDE_MODEL=from-root\nLOG_LEVEL=warn\nAPP_URL=root\n');
    writeFileSync(join(worker, '.env'), 'CLAUDE_MODEL=from-worker\n');
    const env: NodeJS.ProcessEnv = { NODE_ENV: 'development', APP_URL: 'from-shell' };

    await loadDotenv({ cwd: worker, env });

    expect(env.CLAUDE_MODEL).toBe('from-worker');
    expect(env.LOG_LEVEL).toBe('warn');
    expect(env.APP_URL).toBe('from-shell');
  });

  it('reads nothing in production', async () => {
    writeFileSync(join(root, '.env'), 'CLAUDE_MODEL=from-root\n');
    const env: NodeJS.ProcessEnv = { NODE_ENV: 'production' };

    expect(await loadDotenv({ cwd: worker, env })).toEqual([]);
    expect(env.CLAUDE_MODEL).toBeUndefined();
  });

  it('pnpm eval reads the root .env too, so a key kept there reaches the live run', async () => {
    // One broken case: with a key the run passes the key check and stops at the broken fixture
    // (exit 1, before any API call); without a key it is skipped (exit 0).
    const fixtures = join(root, 'fixtures');
    mkdirSync(join(fixtures, 'transcripts'), { recursive: true });
    writeFileSync(join(fixtures, 'transcripts', 'broken.json'), '{}');
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});

    const withoutKey: NodeJS.ProcessEnv = { NODE_ENV: 'development' };
    expect(await evalMain([], { cwd: worker, env: withoutKey, dir: fixtures })).toBe(0);
    expect(log).toHaveBeenCalledWith(expect.stringContaining('ANTHROPIC_API_KEY is not set'));

    writeFileSync(join(root, '.env'), 'ANTHROPIC_API_KEY=test-key-from-root\n');
    const env: NodeJS.ProcessEnv = { NODE_ENV: 'development' };
    expect(await evalMain([], { cwd: worker, env, dir: fixtures })).toBe(1);
    expect(env.ANTHROPIC_API_KEY).toBe('test-key-from-root');
    expect(error).toHaveBeenCalledWith(expect.stringContaining('broken fixtures'));
  });

  it('reads nothing when neither file exists', async () => {
    const env: NodeJS.ProcessEnv = { NODE_ENV: 'development' };
    expect(await loadDotenv({ cwd: worker, env })).toEqual([]);
    expect(Object.keys(env)).toEqual(['NODE_ENV']);
  });
});
