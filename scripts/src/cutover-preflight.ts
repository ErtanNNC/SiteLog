/**
 * `pnpm cutover:preflight` — the W1-19 cut-over's local pre-flight (docs/RUNBOOK.md §2 "Cut-over
 * (W1-19), step by step", step 0). It touches nothing remote: no network, no hosted database.
 *
 *   1. Environment inventory: what the edge functions, the worker and the browser bundles read,
 *      against .env.example and deploy.yml, and where each cut-over setting goes.
 *   2. Database: the staging-shaped cut-over rehearsal on PGlite (supabase/db-tests/src/
 *      cutover.test.ts: v1.0 schema → discard-backlog.sql → every v1.2 migration in one push →
 *      today's demo seed) plus the migration and seed suites; `--full-db` runs all of `pnpm test:db`.
 *   3. Demo seed for today: what `pnpm seed:demo -- --date today --apply` would write right now
 *      (Chicago's date and clock), and whether it is late enough for §18.1's 17:00 view.
 *   4. Builds: the panel and the field app, with a sentinel value in every secret-bearing variable
 *      of .env.example, then a scan of both dist folders for those sentinels, the secret values of
 *      the local .env files, service-role JWTs, key shapes and server-only variable names.
 *   5. Git: the branch, a clean tree, and how far it is from origin/spec-v1.2 (information only).
 *
 * Flags: --skip-db, --full-db, --skip-build. Exit code 1 when a check fails.
 */
import { spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parse as parseDotenv } from 'dotenv';
import { buildSeedSql } from '@sitelog/shared/demo/seed-sql.ts';
import { todayIn } from '@sitelog/shared/demo/calendar.ts';
import { buildKestrelDemo, DEMO_TZ } from '@sitelog/shared/demo/kestrel.ts';
import { formatTimeInTz } from '@sitelog/shared/format.ts';
import {
  CUTOVER_SETTINGS,
  envInventory,
  ROOT,
  scanDist,
  secretValues,
  sentinels,
  type Finding,
} from './preflight.ts';

type Result = { step: string; ok: boolean; note: string };
const results: Result[] = [];

function heading(text: string): void {
  console.log(`\n== ${text}`);
}

function run(cmd: string, args: string[], env: NodeJS.ProcessEnv = process.env): boolean {
  console.log(`$ ${cmd} ${args.join(' ')}`);
  const r = spawnSync(cmd, args, { cwd: ROOT, env, stdio: 'inherit' });
  return r.status === 0;
}

function capture(cmd: string, args: string[]): string {
  const r = spawnSync(cmd, args, { cwd: ROOT, encoding: 'utf8' });
  return r.status === 0 ? r.stdout.trim() : '';
}

function stepEnv(): void {
  heading('1. Environment inventory');
  const inv = envInventory();
  console.log(`.env.example names: ${inv.envExample.size}`);
  console.log(`edge functions read: ${[...inv.functions.keys()].sort().join(', ')}`);
  console.log(`worker reads: ${inv.worker.length} names (apps/worker/src/config.ts)`);
  console.log(`browser bundles read: ${[...inv.vite.keys()].sort().join(', ')}`);
  console.log(`deploy.yml variables: ${[...inv.workflow.vars].sort().join(', ')}`);
  console.log(`deploy.yml secrets: ${[...inv.workflow.secrets].sort().join(', ')}`);
  console.log('cut-over settings (PLAN W1-19), where each one goes:');
  for (const { name, where } of CUTOVER_SETTINGS) {
    const target =
      where === 'functions'
        ? 'supabase secrets set (staging project)'
        : where === 'worker'
          ? "the worker's .env (developer machine)"
          : 'supabase secrets set AND the worker’s .env (same value)';
    console.log(`  ${name.padEnd(24)} → ${target}`);
  }
  for (const p of inv.problems) console.log(`  PROBLEM ${p}`);
  results.push({
    step: 'env inventory',
    ok: inv.problems.length === 0,
    note: inv.problems.length ? `${inv.problems.length} problem(s)` : 'consistent',
  });
}

function stepDb(full: boolean): void {
  heading('2. Database (PGlite)');
  const ok = full
    ? run('pnpm', ['test:db'])
    : run('pnpm', [
        '--filter',
        '@sitelog/db',
        'exec',
        'vitest',
        'run',
        'src/cutover.test.ts',
        'src/migrations.test.ts',
        'src/migration-files.test.ts',
        'src/countries.test.ts',
        'src/renames.test.ts',
        'src/inventory.test.ts',
        'src/seed-apply.test.ts',
      ]);
  results.push({
    step: full ? 'pnpm test:db' : 'cut-over rehearsal + migration suites',
    ok,
    note: ok ? 'green' : 'failed',
  });
}

function stepSeed(): void {
  heading('3. Demo seed for today');
  const date = todayIn(DEMO_TZ);
  const clock = new Date().toISOString();
  const linkBase = process.env.FIELD_APP_URL?.trim() || 'https://<the staging field site>';
  try {
    const sql = buildSeedSql({ date, clock, linkBase, globalRows: false });
    const { now } = buildKestrelDemo({ date, clock });
    const asOf = formatTimeInTz(now, DEMO_TZ);
    console.log(
      `demo day ${date} as of ${asOf} Chicago; ${(sql.length / 1024).toFixed(0)} KB of SQL`,
    );
    console.log(`links in the seeded texts: ${linkBase}`);
    if (asOf < '17:00')
      console.log(
        '  note: before 17:00 Chicago the live day stops at the clock (before 16:59 Pier 9 is awaiting too);' +
          ' run the apply after 17:00 Chicago for §18.1’s view, five sites awaiting.',
      );
    results.push({ step: 'seed for today', ok: true, note: `${date} as of ${asOf} Chicago` });
  } catch (err) {
    console.log(`  PROBLEM ${(err as Error).message}`);
    results.push({ step: 'seed for today', ok: false, note: 'buildSeedSql failed' });
  }
}

function localSecrets(): Array<{ name: string; value: string }> {
  const files = ['.env', 'supabase/functions/.env', 'apps/worker/.env'];
  const out: Array<{ name: string; value: string }> = [];
  for (const f of files) {
    const path = join(ROOT, f);
    if (!existsSync(path)) continue;
    out.push(...secretValues(parseDotenv(readFileSync(path))));
  }
  return out;
}

function stepBuild(): void {
  heading('4. Builds and the bundle scan');
  const tag = randomBytes(4).toString('hex');
  const envExample = readFileSync(join(ROOT, '.env.example'), 'utf8');
  const names = [...envExample.matchAll(/^([A-Z][A-Z0-9_]*)=/gm)].map((m) => m[1]!);
  const planted = sentinels(names, tag);
  const env = { ...process.env, ...planted };
  console.log(`sentinels planted in the build environment: ${Object.keys(planted).length} names`);
  const web = run('pnpm', ['--filter', '@sitelog/web', 'build'], env);
  const field = run('pnpm', ['--filter', '@sitelog/field', 'build'], env);
  results.push({ step: 'build web', ok: web, note: web ? 'apps/web/dist' : 'failed' });
  results.push({ step: 'build field', ok: field, note: field ? 'apps/field/dist' : 'failed' });
  if (!web || !field) return;
  const secrets = [
    ...Object.entries(planted).map(([name, value]) => ({ name: `${name} (sentinel)`, value })),
    ...localSecrets(),
  ];
  const findings: Finding[] = [
    ...scanDist(join(ROOT, 'apps', 'web', 'dist'), secrets),
    ...scanDist(join(ROOT, 'apps', 'field', 'dist'), secrets),
  ];
  for (const f of findings) console.log(`  PROBLEM ${f.file}: ${f.kind} (${f.hint})`);
  const redirects = join(ROOT, 'apps', 'field', 'dist', '_redirects');
  if (existsSync(redirects)) {
    const rule = readFileSync(redirects, 'utf8')
      .split('\n')
      .find((l) => l.startsWith('/api/'));
    console.log(
      `field _redirects: ${rule ?? 'no /api rule (no SUPABASE_URL at build time; the Deploy job hands it one)'}`,
    );
  }
  results.push({
    step: 'no secrets in bundles',
    ok: findings.length === 0,
    note: findings.length ? `${findings.length} finding(s)` : `${secrets.length} values checked`,
  });
}

function stepGit(): void {
  heading('5. Git');
  const branch = capture('git', ['rev-parse', '--abbrev-ref', 'HEAD']);
  const head = capture('git', ['rev-parse', '--short', 'HEAD']);
  const dirty = capture('git', ['status', '--porcelain']);
  const counts = capture('git', ['rev-list', '--left-right', '--count', 'origin/spec-v1.2...HEAD']);
  console.log(
    `branch ${branch || '(detached)'} at ${head}; tree ${dirty ? 'has changes' : 'clean'}`,
  );
  if (counts) {
    const [behind, ahead] = counts.split(/\s+/);
    console.log(
      `against origin/spec-v1.2: ${ahead} ahead, ${behind} behind (fetch first for a fresh answer)`,
    );
  }
  results.push({ step: 'git', ok: true, note: `${head}${dirty ? ', uncommitted changes' : ''}` });
}

function main(argv: string[]): void {
  const flags = new Set(argv.filter((a) => a !== '--'));
  for (const f of flags) {
    if (!['--skip-db', '--full-db', '--skip-build'].includes(f)) {
      console.error(`cutover:preflight: unknown flag ${f} (--skip-db, --full-db, --skip-build)`);
      process.exit(2);
    }
  }
  console.log('W1-19 cut-over pre-flight: local checks only (nothing remote is read or changed).');
  stepEnv();
  if (!flags.has('--skip-db')) stepDb(flags.has('--full-db'));
  stepSeed();
  if (!flags.has('--skip-build')) stepBuild();
  stepGit();
  heading('Summary');
  for (const r of results) console.log(`${r.ok ? 'PASS' : 'FAIL'}  ${r.step.padEnd(40)} ${r.note}`);
  const failed = results.filter((r) => !r.ok).length;
  console.log(
    failed
      ? `\n${failed} check(s) failed: fix them before asking for the cut-over.`
      : '\nAll local checks pass. The remote steps (RUNBOOK §2, steps 1–8) each need the owner’s approval.',
  );
  process.exit(failed ? 1 : 0);
}

if (process.argv[1]?.endsWith('cutover-preflight.ts')) main(process.argv.slice(2));
