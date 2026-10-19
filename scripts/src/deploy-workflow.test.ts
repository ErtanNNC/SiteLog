import { spawnSync } from 'node:child_process';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';

/**
 * Checks of .github/workflows/deploy.yml (W1-01, D40/D41; W1-04, D42/D43): every job that changes
 * staging or production carries the live-branch guard in its own `if:` (on the full branch ref, so a
 * tag with the same name does not pass), no other Environment deploys to or builds against the
 * staging project, pull requests take nothing from `staging` but the Netlify token and site, the
 * field app deploys to its own Netlify site, never the panel's, and the inventory job only reads.
 * Static checks read the YAML; the `plan` step and the field job's steps also run under bash with
 * stand-ins for curl, pnpm and npx. actionlint checks the syntax in CI review.
 */

const ROOT = join(import.meta.dirname, '..', '..');
const WORKFLOW = readFileSync(join(ROOT, '.github', 'workflows', 'deploy.yml'), 'utf8');
const LIVE_BRANCH = 'claude/focused-newton-5v0u2q';
const STAGING_PROJECT_REF = 'abuanbyzttuqksdctqcp';
const GUARD = `github.ref == 'refs/heads/${LIVE_BRANCH}'`;

/** Jobs by id: the text from `  <id>:` to the next job, and its (possibly folded) `if:`. */
function jobs(yaml: string): Map<string, { text: string; condition: string }> {
  const body = yaml.slice(yaml.indexOf('\njobs:\n') + '\njobs:\n'.length);
  const out = new Map<string, { text: string; condition: string }>();
  const parts = body.split(/^(?= {2}[a-z][\w-]*:\s*$)/m);
  for (const part of parts) {
    const id = /^ {2}([a-z][\w-]*):/.exec(part)?.[1];
    if (!id) continue;
    const lines = part.split('\n');
    const start = lines.findIndex((l) => /^ {4}if:/.test(l));
    let condition = '';
    if (start >= 0) {
      condition = lines[start]!.replace(/^ {4}if:\s*(>-)?/, '');
      for (const l of lines.slice(start + 1)) {
        if (!/^ {6}/.test(l)) break;
        condition += ` ${l.trim()}`;
      }
    }
    out.set(id, { text: part, condition: condition.replace(/\s+/g, ' ').trim() });
  }
  return out;
}

/** What a job executes: its text without comments and without the lines that only print. */
function commands(text: string): string {
  return text
    .split('\n')
    .filter((l) => !/^\s*#/.test(l) && !/^\s*(echo|\{ echo) /.test(l) && !/::notice::/.test(l))
    .join('\n');
}

/** A job's steps: each `      - ` item, named by its `name:` (else its `uses:` or `run:` line). */
function jobSteps(text: string): { name: string; text: string }[] {
  const body = text.slice(text.indexOf('\n    steps:\n') + '\n    steps:\n'.length);
  return body
    .split(/^(?= {6}- )/m)
    .filter((part) => part.startsWith('      - '))
    .map((part) => ({
      name:
        /^ {6}- name: (.+)$/m.exec(part)?.[1] ??
        /^ {6}[- ] {1,3}(?:uses|run): (.+)$/m.exec(part)?.[1] ??
        part.split('\n')[0]!.trim(),
      text: part,
    }));
}

const JOBS = jobs(WORKFLOW);
const MUTATING = [/db push/, /functions deploy/, /flyctl deploy/, /--prod\b/, /secrets set/];

describe('deploy.yml', () => {
  it('names the live staging branch once, and repeats it literally in the guards', () => {
    expect(WORKFLOW).toContain(`LIVE_BRANCH: ${LIVE_BRANCH}`);
    expect(WORKFLOW).toContain('PREVIEW_BRANCH: spec-v1.2');
    expect(WORKFLOW).toContain(`STAGING_PROJECT_REF: ${STAGING_PROJECT_REF}`);
    expect([...JOBS.keys()]).toEqual([
      'plan',
      'supabase',
      'seed',
      'countries-set',
      'phone-setup',
      'preview-worker',
      'voice-setup',
      'billing-setup',
      'eval',
      'worker',
      'preview',
      'web',
      'field',
      'inventory',
    ]);
  });

  it('seeds only the preview project, from spec-v1.2, and only when asked (W1-06 apply mode)', () => {
    const seed = JOBS.get('seed')!;
    expect(seed.condition).toContain("needs.plan.outputs.seed == 'true'");
    expect(seed.condition).toContain("inputs.environment == 'preview'");
    expect(seed.condition).toContain("github.ref == 'refs/heads/spec-v1.2'");
    expect(seed.text).toContain('environment: preview');
    expect(seed.text).toContain('pnpm seed:demo -- --date today --apply');
    expect(seed.text).not.toContain('--allow-staging');
    const plan = JOBS.get('plan')!.text;
    // `all` never includes the seed.
    expect(plan).toContain('[ "$1" != seed ]');
  });

  it('runs the worker against the preview project only, from spec-v1.2, for 60 minutes', () => {
    const job = JOBS.get('preview-worker')!;
    expect(job.condition).toContain("needs.plan.outputs.preview_worker == 'true'");
    expect(job.condition).toContain("inputs.environment == 'preview'");
    expect(job.condition).toContain("github.ref == 'refs/heads/spec-v1.2'");
    expect(job.text).toContain('environment: preview');
    expect(job.text).toMatch(/^ {4}timeout-minutes: 75$/m);
    expect(job.text).toContain("RUN_MINUTES: '60'");
    expect(job.text).toContain('"$SUPABASE_PROJECT_REF" = "$STAGING_PROJECT_REF"');
    // It never sets or changes a Supabase secret (not even in a comment's example).
    expect(job.text).not.toMatch(/secrets set/);
    expect(job.text).not.toMatch(/secrets (unset|list)/);
    // Console texts and email; never production. Transcription and extraction are real only
    // when the preview Environment holds their key, else the fakes.
    for (const line of [
      'NODE_ENV: development',
      'EMAIL_PROVIDER: console',
      "TRANSCRIBE_PROVIDER: ${{ secrets.DEEPGRAM_API_KEY != '' && 'deepgram' || 'fake' }}",
      "EXTRACT_PROVIDER: ${{ secrets.ANTHROPIC_API_KEY != '' && 'claude' || 'fake' }}",
      'ANTHROPIC_API_KEY: ${{ secrets.ANTHROPIC_API_KEY }}',
      'DEEPGRAM_API_KEY: ${{ secrets.DEEPGRAM_API_KEY }}',
      'WEATHER_API_BASE: https://api.open-meteo.com/v1/forecast',
    ])
      expect(job.text).toContain(line);
    // The models come from the preview Environment's variables, with config defaults in the YAML,
    // and reach the worker process only (never GITHUB_ENV).
    const startStep = jobSteps(job.text).find((s) => s.name === 'Start the worker')!.text;
    expect(startStep).toContain("CLAUDE_MODEL: ${{ vars.CLAUDE_MODEL || 'claude-sonnet-5-5' }}");
    expect(startStep).toContain(
      "CLAUDE_MODEL_FAST: ${{ vars.CLAUDE_MODEL_FAST || 'claude-haiku-5-5' }}",
    );
    expect(job.text).not.toMatch(/CLAUDE_MODEL[A-Z_]*.*GITHUB_ENV/);
    expect(job.text).toContain('TWILIO_ACCOUNT_SID: ${{ secrets.TWILIO_ACCOUNT_SID }}');
    expect(job.text).toContain('TWILIO_AUTH_TOKEN: ${{ secrets.TWILIO_AUTH_TOKEN }}');
    for (const k of ['VAPID_PUBLIC_KEY', 'VAPID_PRIVATE_KEY', 'VAPID_SUBJECT'])
      expect(job.text).toContain(`${k}: \${{ secrets.${k} }}`);
    expect(job.text).not.toMatch(/ILETIMERKEZI_|RESEND_/);
    expect(job.text).not.toMatch(/VAPID_[A-Z_]*.*GITHUB_ENV/);
    // billing_sync's Stripe key (test mode, billing-setup), to the worker process only.
    expect(startStep).toContain('STRIPE_SECRET_KEY: ${{ secrets.STRIPE_SECRET_KEY }}');
    expect(job.text).not.toMatch(/STRIPE_[A-Z_]*.*GITHUB_ENV/);
    expect(job.text).not.toMatch(/TWILIO_[A-Z_]*.*GITHUB_ENV/);
    // The AI keys come only from the preview Environment's secrets, never written to GITHUB_ENV.
    expect(job.text).not.toMatch(/(ANTHROPIC|DEEPGRAM)_API_KEY.*GITHUB_ENV/);
    expect(job.text).toContain('pnpm --filter @sitelog/worker exec tsx src/index.ts');
    // The link secret is made in the job, masked, and handed to the worker process only.
    const start = stepScript('preview-worker', 'Start the worker');
    expect(start).toContain('link_secret="$(openssl rand -hex 32)"');
    expect(start).toContain('echo "::add-mask::$link_secret"');
    expect(start).toContain('LINK_SIGNING_SECRET="$link_secret"');
    expect(start).not.toMatch(/LINK_SIGNING_SECRET.*GITHUB_ENV|link_secret.*GITHUB_ENV/);
    expect(start).not.toMatch(/SUPABASE_SERVICE_ROLE_KEY.*GITHUB_ENV|\$key.*GITHUB_ENV/);
    // `all` never includes it.
    expect(JOBS.get('plan')!.text).toContain('[ "$1" != preview-worker ]');
  });

  it('compares full refs, so a tag named like a branch passes no guard', () => {
    // `github.ref_name` is the same for a branch and a tag; only the full ref tells them apart.
    for (const [id, job] of JOBS) expect(job.condition, id).not.toContain('github.ref_name');
    const plan = JOBS.get('plan')!.text;
    expect(plan).toMatch(/^ {10}REF: \$\{\{ github\.ref \}\}$/m);
    expect(plan).toContain('[ "$REF" = "refs/heads/$LIVE_BRANCH" ]');
    expect(plan).toContain('[ "$REF" = "refs/heads/$PREVIEW_BRANCH" ]');
    expect(commands(plan)).not.toMatch(/\[ "\$REF_NAME" =/);
  });

  it('guards every job that changes staging or production with the live branch (D40)', () => {
    // phone-setup, voice-setup and billing-setup set function secrets on the preview project only,
    // countries-set its country packs (their own guard, below and in their own tests).
    const PREVIEW_ONLY = ['phone-setup', 'voice-setup', 'billing-setup', 'countries-set'];
    for (const id of PREVIEW_ONLY) {
      const job = JOBS.get(id)!;
      expect(job.condition, id).toContain(`needs.plan.outputs.${id.replace('-', '_')} == 'true'`);
      expect(job.condition, id).toContain("inputs.environment == 'preview'");
      expect(job.condition, id).toContain("github.ref == 'refs/heads/spec-v1.2'");
      expect(job.text, id).toMatch(/^ {4}environment: preview$/m);
      expect(job.text, id).toContain('"$SUPABASE_PROJECT_REF" = "$STAGING_PROJECT_REF"');
    }
    const changing = [...JOBS].filter(
      ([id, j]) => !PREVIEW_ONLY.includes(id) && MUTATING.some((re) => re.test(commands(j.text))),
    );
    expect(changing.map(([id]) => id).sort()).toEqual(['field', 'supabase', 'web', 'worker']);
    const phone = JOBS.get('phone-setup')!;
    expect(phone.condition).toContain("inputs.environment == 'preview'");
    expect(phone.condition).toContain("github.ref == 'refs/heads/spec-v1.2'");
    expect(phone.text).toContain('environment: preview');
    expect(phone.text).toContain('"$SUPABASE_PROJECT_REF" = "$STAGING_PROJECT_REF"');
    // The VAPID public key (owner-approved, 2026-10-16) comes from the preview Environment; the
    // private half never reaches a function secret.
    expect(phone.text).toContain('VAPID_PUBLIC_KEY: ${{ secrets.VAPID_PUBLIC_KEY }}');
    expect(phone.text).toContain('set_args+=("VAPID_PUBLIC_KEY=$VAPID_PUBLIC_KEY")');
    expect(phone.text).not.toMatch(/VAPID_PRIVATE_KEY|VAPID_SUBJECT/);
    for (const [id, job] of changing) {
      expect(job.condition, id).toContain(GUARD);
      expect(job.condition, id).toMatch(/needs\.plan\.outputs\.\w+ == 'true'/);
    }
    // The worker never deploys for preview; the --prod paths of the panel and the field app neither.
    expect(JOBS.get('worker')!.condition).toContain("inputs.environment != 'preview'");
    for (const id of ['web', 'field']) {
      expect(JOBS.get(id)!.condition, id).toContain(
        `(github.event_name == 'pull_request' || (github.ref == 'refs/heads/${LIVE_BRANCH}' && inputs.environment != 'preview'))`,
      );
    }
    // The preview project also takes migrations and functions from spec-v1.2 (D41).
    expect(JOBS.get('supabase')!.condition).toContain(
      "(inputs.environment == 'preview' && github.ref == 'refs/heads/spec-v1.2')",
    );
  });

  it('refuses to deploy another Environment to the staging project (D40/D41)', () => {
    // A missing `preview` value resolves from the repository or organization, so it can be staging's.
    const supabase = JOBS.get('supabase')!.text;
    const refusal =
      'if [ "$ENVIRONMENT" != staging ] && [ "$SUPABASE_PROJECT_REF" = "$STAGING_PROJECT_REF" ]; then';
    expect(supabase).toContain(refusal);
    const afterRefusal = supabase.slice(supabase.indexOf(refusal));
    // It fails the job before the job is marked ready, so link, db push and deploy never run.
    expect(supabase.indexOf(refusal)).toBeGreaterThan(0);
    expect(afterRefusal.indexOf('exit 1')).toBeGreaterThan(0);
    expect(afterRefusal.indexOf('exit 1')).toBeLessThan(afterRefusal.indexOf('ready=true'));
    expect(afterRefusal.indexOf('ready=true')).toBeLessThan(afterRefusal.indexOf('supabase link'));
  });

  it('never builds a pull request preview against the staging project (D41)', () => {
    const web = JOBS.get('web')!.text;
    for (const name of [
      'SUPABASE_PROJECT_REF',
      'SUPABASE_URL_VAR',
      'DEPLOY_ANON_KEY',
      'VITE_APP_URL',
    ]) {
      expect(web, name).toMatch(
        new RegExp(
          `^ {6}${name}: \\$\\{\\{ github\\.event_name != 'pull_request' && vars\\.\\w+ \\|\\| '' \\}\\}$`,
          'm',
        ),
      );
    }
    expect(web).toContain('PREVIEW_SUPABASE_URL: ${{ needs.preview.outputs.supabase_url }}');
    expect(web).toContain('echo "VITE_DEMO=true"');
    // A preview URL on the staging project builds in demo mode, even before staging's vars exist
    // (run under bash below).
    expect(web).toContain('[[ "${url,,}" == *"${STAGING_PROJECT_REF,,}"* ]]');
    // The PR path keeps the panel site's `staging` key and deploys an alias, never --prod.
    expect(web).toContain('flags=(--alias "pr-$PR_NUMBER")');
    const preview = JOBS.get('preview')!;
    expect(preview.text).toContain('environment: preview');
    expect(preview.text).not.toContain(STAGING_PROJECT_REF);
    expect(preview.condition).toContain("github.event_name == 'pull_request'");
    expect(preview.text).not.toMatch(/secrets\./);
  });

  it('takes nothing from staging for a pull request but the Netlify token and site (D41)', () => {
    // Variables that only feed a comparison in the PR path and are not VITE_* (never in a bundle).
    const compareOnly: Record<string, Set<string>> = {
      web: new Set(['LIVE_PROJECT_REF', 'LIVE_PROJECT_URL']),
      field: new Set(['LIVE_PROJECT_REF', 'LIVE_PROJECT_URL', 'PANEL_SITE_ID']),
    };
    for (const id of ['web', 'field']) {
      const text = JOBS.get(id)!.text;
      const uses = text.split('\n').filter((l) => /\bvars\./.test(l) && !/^\s*#/.test(l));
      expect(uses.length, id).toBeGreaterThan(0);
      for (const line of uses) {
        const name = /^\s*([A-Z][A-Z0-9_]*):/.exec(line)?.[1] ?? line.trim();
        if (id === 'web' && name === 'NETLIFY_SITE_ID') {
          expect(line.trim()).toBe('NETLIFY_SITE_ID: ${{ vars.NETLIFY_SITE_ID }}');
        } else if (compareOnly[id]!.has(name)) {
          expect(name).not.toMatch(/^VITE_/);
        } else {
          // Blanked (or replaced by a non-staging value) on pull requests.
          expect(line, `${id}: ${name}`).toMatch(
            /: \$\{\{ github\.event_name != 'pull_request' && vars\.\w+ \|\| ('[^']*'|steps\.[\w.]+) \}\}$/,
          );
        }
      }
      // The only secret either job reads is the Netlify token.
      expect(new Set(text.match(/\bsecrets\.\w+/g)), id).toEqual(
        new Set(['secrets.NETLIFY_AUTH_TOKEN']),
      );
    }
    for (const name of ['VITE_WA_DISPLAY_NUMBER', 'VITE_SENTRY_DSN', 'VITE_DEMO_PHONE_ALL_ORGS']) {
      expect(JOBS.get('web')!.text, name).toContain(
        `${name}: \${{ github.event_name != 'pull_request' && vars.${name} || '' }}`,
      );
    }
  });

  it('hands the Netlify token only to the steps that call Netlify, never to install or build', () => {
    for (const id of ['web', 'field']) {
      const text = JOBS.get(id)!.text;
      // Not in the job's env, which every step (pnpm install, the build) inherits.
      const jobEnv = text.slice(text.indexOf('\n    env:\n'), text.indexOf('\n    steps:\n'));
      expect(jobEnv, id).toContain('EVENT:');
      expect(jobEnv, id).not.toMatch(/secrets\.|NETLIFY_AUTH_TOKEN:/);
      const all = jobSteps(text);
      const withToken = all.filter((s) => /^ {10}NETLIFY_AUTH_TOKEN: /m.test(s.text));
      expect(
        withToken.map((s) => s.name),
        id,
      ).toEqual(['Netlify site', 'Deploy']);
      for (const step of withToken) {
        expect(step.text).toContain('NETLIFY_AUTH_TOKEN: ${{ secrets.NETLIFY_AUTH_TOKEN }}');
      }
      // Check configuration learns whether the token exists, not the token.
      const cfg = all.find((s) => s.name === 'Check configuration')!;
      expect(cfg.text).toContain("HAS_NETLIFY_TOKEN: ${{ secrets.NETLIFY_AUTH_TOKEN != '' }}");
      expect(cfg.text).not.toContain('$NETLIFY_AUTH_TOKEN');
      // Every other step: no secret at all.
      for (const step of all.filter(
        (s) => !['Check configuration', 'Netlify site', 'Deploy'].includes(s.name),
      )) {
        expect(step.text, `${id}: ${step.name}`).not.toMatch(/secrets\.|NETLIFY_AUTH_TOKEN/);
      }
      expect(
        all.some((s) => /pnpm install --frozen-lockfile/.test(s.text)),
        id,
      ).toBe(true);
      expect(
        all.some((s) => s.name === 'Build'),
        id,
      ).toBe(true);
    }
  });

  it('keeps the inventory read-only (W1-01 step 0)', () => {
    const inventory = JOBS.get('inventory')!;
    expect(inventory.text).toContain('environment: staging');
    expect(inventory.condition).toContain("inputs.environment == 'staging'");
    for (const re of [
      ...MUTATING,
      /db reset/,
      /migration (repair|up|down)/,
      /db dump/,
      /decrypted/,
    ]) {
      expect(commands(inventory.text)).not.toMatch(re);
    }
    expect(inventory.text).toContain('-f supabase/ops/inventory.sql');
    // `supabase link` gets no database password, so it can only use the Management API.
    const link = commands(inventory.text)
      .split('\n')
      .filter((l) => /supabase link/.test(l));
    expect(link).toHaveLength(1);
    expect(link[0]!.trim()).toMatch(/^run: env -u SUPABASE_DB_PASSWORD supabase link /);
    expect(link[0]).not.toContain('--password');
    // Secret digests never reach the log or the summary: only the parsed names are printed.
    expect(inventory.text).toContain('rm -f "$raw"');
    expect(inventory.text).not.toMatch(/cat "\$raw"/);
  });
});

/* ── Running the workflow's own shell steps ─────────────────────────────────────────────────────── */

/** The workflow-level constants the steps read (`env:` at the top of the file). */
const WORKFLOW_ENV = Object.fromEntries(
  ['LIVE_BRANCH', 'PREVIEW_BRANCH', 'STAGING_PROJECT_REF'].map((name) => {
    const value = new RegExp(`^ {2}${name}: (\\S+)$`, 'm').exec(WORKFLOW)?.[1];
    if (!value) throw new Error(`deploy.yml has no top-level ${name}`);
    return [name, value];
  }),
);

/** The `run: |` script of a job's step, dedented, exactly as the runner gets it. */
function stepScript(jobId: string, stepName: string): string {
  const lines = JOBS.get(jobId)!.text.split('\n');
  const start = lines.indexOf(`      - name: ${stepName}`);
  if (start < 0) throw new Error(`${jobId} has no step "${stepName}"`);
  let i = start + 1;
  while (i < lines.length && !/^ {8}run: \|$/.test(lines[i]!)) {
    if (/^ {6}- /.test(lines[i]!)) throw new Error(`${jobId} step "${stepName}" has no run block`);
    i++;
  }
  const body: string[] = [];
  for (const line of lines.slice(i + 1)) {
    if (line.trim() !== '' && !/^ {10}/.test(line)) break;
    body.push(line.slice(10));
  }
  const script = body.join('\n').trimEnd();
  // Expressions would be substituted by the runner; these steps read only environment variables.
  expect(script, `${jobId} step "${stepName}"`).not.toContain('${{');
  return script;
}

const scratch: string[] = [];
afterAll(() => {
  for (const dir of scratch.splice(0)) rmSync(dir, { recursive: true, force: true });
});

interface StepRun {
  status: number | null;
  log: string;
  outputs: Record<string, string>;
  /** What the step appended to `$GITHUB_ENV` (for the next steps). */
  envFile: Record<string, string>;
  summary: string;
  dir: string;
}

/** `name=value` lines of a GitHub command file. */
function keyValues(file: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of readFileSync(file, 'utf8').split('\n')) {
    const eq = line.indexOf('=');
    if (eq > 0) out[line.slice(0, eq)] = line.slice(eq + 1);
  }
  return out;
}

/**
 * Runs a step script the way GitHub runs `run:` on Linux (`bash --noprofile --norc -eo pipefail`),
 * in a scratch directory, with only the given environment, the workflow constants and PATH (plus
 * `bin`, for stand-ins of curl, pnpm and npx). Returns the step outputs and the summary it wrote.
 */
function runStep(
  script: string,
  env: Record<string, string>,
  setup?: (dir: string) => void,
  bin?: Record<string, string>,
): StepRun {
  const dir = mkdtempSync(join(tmpdir(), 'deploy-step-'));
  scratch.push(dir);
  const binDir = join(dir, '.bin');
  mkdirSync(binDir);
  for (const [name, body] of Object.entries(bin ?? {})) {
    writeFileSync(join(binDir, name), `#!/usr/bin/env bash\n${body}\n`);
    chmodSync(join(binDir, name), 0o755);
  }
  const output = join(dir, '.github-output');
  const envFile = join(dir, '.github-env');
  const summary = join(dir, '.github-summary');
  writeFileSync(output, '');
  writeFileSync(envFile, '');
  writeFileSync(summary, '');
  setup?.(dir);
  const res = spawnSync('bash', ['--noprofile', '--norc', '-eo', 'pipefail', '-c', script], {
    cwd: dir,
    encoding: 'utf8',
    env: {
      PATH: `${binDir}:${process.env.PATH ?? ''}`,
      ...WORKFLOW_ENV,
      GITHUB_OUTPUT: output,
      GITHUB_ENV: envFile,
      GITHUB_STEP_SUMMARY: summary,
      GITHUB_WORKSPACE: dir,
      ...env,
    },
  });
  return {
    status: res.status,
    log: `${res.stdout}${res.stderr}`,
    outputs: keyValues(output),
    envFile: keyValues(envFile),
    summary: readFileSync(summary, 'utf8'),
    dir,
  };
}

const PLAN_TARGETS = ['supabase', 'worker', 'web', 'field', 'preview', 'inventory'] as const;

describe('deploy.yml plan step, run under bash', () => {
  const plan = stepScript('plan', 'Decide what this run may touch');
  const LIVE = `refs/heads/${LIVE_BRANCH}`;
  const PREVIEW = 'refs/heads/spec-v1.2';

  /** The targets the plan turns on for an event. */
  function decide(event: string, ref: string, environment = 'staging', target = 'all') {
    const run = runStep(plan, {
      EVENT: event,
      REF: ref,
      REF_NAME: ref.replace(/^refs\/(heads|tags|pull)\//, ''),
      TARGET: target,
      ENVIRONMENT: environment,
      PR_NUMBER: event === 'pull_request' ? '1' : '',
    });
    expect(run.status, run.log).toBe(0);
    for (const t of PLAN_TARGETS) expect(run.outputs[t], t).toMatch(/^(true|false)$/);
    return { on: PLAN_TARGETS.filter((t) => run.outputs[t] === 'true'), run };
  }

  it('pull requests: the panel and field previews, and the preview settings; nothing else', () => {
    const { on, run } = decide('pull_request', 'refs/pull/1/merge');
    expect(on).toEqual(['web', 'field', 'preview']);
    expect(run.log).toContain('panel and field app previews only (alias pr-1)');
    expect(run.summary).toContain('| field | true |');
  });

  it('dispatch staging or production from the live branch: all four targets, or the one asked for', () => {
    expect(decide('workflow_dispatch', LIVE).on).toEqual(['supabase', 'worker', 'web', 'field']);
    expect(decide('workflow_dispatch', LIVE, 'production').on).toEqual([
      'supabase',
      'worker',
      'web',
      'field',
    ]);
    expect(decide('workflow_dispatch', LIVE, 'staging', 'field').on).toEqual(['field']);
    expect(decide('workflow_dispatch', LIVE, 'staging', 'web').on).toEqual(['web']);
  });

  it('turns nothing on from any other ref, a tag named like the live branch included (D40)', () => {
    for (const ref of [PREVIEW, `refs/tags/${LIVE_BRANCH}`, 'refs/heads/main']) {
      for (const target of ['all', 'field', 'web']) {
        const { on, run } = decide('workflow_dispatch', ref, 'staging', target);
        expect(on, `${ref} ${target}`).toEqual([]);
        expect(run.log).toContain('Deploy guard (D40)');
      }
    }
    expect(decide('push', 'refs/heads/main').on).toEqual([]);
  });

  it('the preview Environment takes the supabase target only, and never the field app (D41)', () => {
    const { on, run } = decide('workflow_dispatch', PREVIEW, 'preview');
    expect(on).toEqual(['supabase']);
    expect(run.log).toContain(
      'takes the supabase target only (migrations and functions to the preview project): field skipped',
    );
    expect(decide('workflow_dispatch', PREVIEW, 'preview', 'field').on).toEqual([]);
    expect(decide('workflow_dispatch', 'refs/heads/other', 'preview').on).toEqual([]);
  });

  it('preview-worker: only for the preview Environment from spec-v1.2, and never in `all`', () => {
    const run = (ref: string, environment: string, target: string) =>
      runStep(plan, {
        EVENT: 'workflow_dispatch',
        REF: ref,
        REF_NAME: ref.replace(/^refs\/(heads|tags)\//, ''),
        TARGET: target,
        ENVIRONMENT: environment,
        PR_NUMBER: '',
      });
    const ok = run(PREVIEW, 'preview', 'preview-worker');
    expect(ok.status, ok.log).toBe(0);
    expect(ok.outputs.preview_worker).toBe('true');
    expect(PLAN_TARGETS.filter((t) => ok.outputs[t] === 'true')).toEqual([]);
    expect(ok.summary).toContain('| preview_worker | true |');
    for (const [ref, environment] of [
      [PREVIEW, 'staging'],
      [PREVIEW, 'production'],
      [LIVE, 'preview'],
      [LIVE, 'staging'],
      [`refs/tags/spec-v1.2`, 'preview'],
    ] as const) {
      const r = run(ref, environment, 'preview-worker');
      expect(r.outputs.preview_worker, `${ref} ${environment}`).toBe('false');
      expect(r.log).toContain('preview-worker skipped');
    }
    for (const environment of ['preview', 'staging']) {
      const all = run(environment === 'preview' ? PREVIEW : LIVE, environment, 'all');
      expect(all.outputs.preview_worker, environment).toBe('false');
    }
  });

  it('eval: only for the preview Environment from spec-v1.2, never in `all`, read-only through eval.yml', () => {
    const run = (ref: string, environment: string, target: string) =>
      runStep(plan, {
        EVENT: 'workflow_dispatch',
        REF: ref,
        REF_NAME: ref.replace(/^refs\/(heads|tags)\//, ''),
        TARGET: target,
        ENVIRONMENT: environment,
        PR_NUMBER: '',
      });
    const ok = run(PREVIEW, 'preview', 'eval');
    expect(ok.status, ok.log).toBe(0);
    expect(ok.outputs.eval).toBe('true');
    expect(ok.outputs.preview_worker).toBe('false');
    expect(PLAN_TARGETS.filter((t) => ok.outputs[t] === 'true')).toEqual([]);
    for (const [ref, environment] of [
      [PREVIEW, 'staging'],
      [LIVE, 'preview'],
      [`refs/tags/spec-v1.2`, 'preview'],
    ] as const) {
      const r = run(ref, environment, 'eval');
      expect(r.outputs.eval, `${ref} ${environment}`).toBe('false');
      expect(r.log).toContain('eval skipped');
    }
    expect(run(PREVIEW, 'preview', 'all').outputs.eval).toBe('false');
    const job = JOBS.get('eval')!;
    expect(job.condition).toContain("needs.plan.outputs.eval == 'true'");
    expect(job.condition).toContain("inputs.environment == 'preview'");
    expect(job.condition).toContain("github.ref == 'refs/heads/spec-v1.2'");
    expect(job.text).toMatch(/^ {4}uses: \.\/\.github\/workflows\/eval\.yml$/m);
    expect(job.text).toMatch(/^ {4}permissions:\n {6}contents: read$/m);
    // A called workflow sees no repository secret unless inherited; eval.yml reads only the key.
    expect(job.text).toMatch(/^ {4}secrets: inherit$/m);
  });

  it('voice-setup and billing-setup: only for the preview Environment from spec-v1.2, never in `all`', () => {
    const run = (ref: string, environment: string, target: string) =>
      runStep(plan, {
        EVENT: 'workflow_dispatch',
        REF: ref,
        REF_NAME: ref.replace(/^refs\/(heads|tags)\//, ''),
        TARGET: target,
        ENVIRONMENT: environment,
        PR_NUMBER: '',
      });
    for (const target of ['voice-setup', 'billing-setup', 'countries-set']) {
      const output = target.replace('-', '_');
      const ok = run(PREVIEW, 'preview', target);
      expect(ok.status, ok.log).toBe(0);
      expect(ok.outputs[output], target).toBe('true');
      expect(PLAN_TARGETS.filter((t) => ok.outputs[t] === 'true')).toEqual([]);
      for (const other of [
        'voice_setup',
        'billing_setup',
        'countries_set',
        'preview_worker',
        'seed',
        'eval',
      ]) {
        if (other !== output) expect(ok.outputs[other], `${target}: ${other}`).toBe('false');
      }
      expect(ok.summary).toContain(`| ${output} | true |`);
      for (const [ref, environment] of [
        [PREVIEW, 'staging'],
        [PREVIEW, 'production'],
        [LIVE, 'preview'],
        [LIVE, 'staging'],
        [`refs/tags/spec-v1.2`, 'preview'],
      ] as const) {
        const r = run(ref, environment, target);
        expect(r.outputs[output], `${target} ${ref} ${environment}`).toBe('false');
        expect(r.log).toContain(`${target} skipped`);
      }
      expect(run(PREVIEW, 'preview', 'all').outputs[output]).toBe('false');
      expect(run(LIVE, 'staging', 'all').outputs[output]).toBe('false');
      expect(JOBS.get('plan')!.text).toContain(`[ "$1" != ${target} ]`);
    }
  });

  it('the inventory runs alone, from staging only', () => {
    expect(decide('workflow_dispatch', PREVIEW, 'staging', 'inventory').on).toEqual(['inventory']);
    expect(decide('workflow_dispatch', LIVE, 'production', 'inventory').on).toEqual([]);
  });
});

describe('deploy.yml preview job, run under bash', () => {
  const cfg = stepScript('preview', 'Read the preview project settings');
  const jwt = (ref: string) =>
    ['{"alg":"HS256"}', JSON.stringify({ iss: 'supabase', ref, role: 'anon' })]
      .map((p) => Buffer.from(p).toString('base64url'))
      .join('.') + '.sig';
  const URL_ = 'https://previewprojectref00.supabase.co';

  it("passes the project's own anon key on, base64-encoded", () => {
    const key = jwt('previewprojectref00');
    const run = runStep(cfg, { SUPABASE_URL_VAR: URL_, ANON_KEY: key });
    expect(run.status, run.log).toBe(0);
    expect(run.outputs).toEqual({
      supabase_url: URL_,
      anon_key_b64: Buffer.from(key).toString('base64'),
    });
  });

  it("refuses another project's anon key (staging's copied into preview)", () => {
    const run = runStep(cfg, { SUPABASE_URL_VAR: URL_, ANON_KEY: jwt('otherprojectref0000') });
    expect(run.status, run.log).toBe(0);
    expect(run.outputs).toEqual({});
    expect(run.log).toContain('belongs to project otherprojectref0000, not previewprojectref00');
  });
});

describe('deploy.yml web job Check configuration, run under bash', () => {
  const cfg = stepScript('web', 'Check configuration');
  const STAGING_URL = `https://${STAGING_PROJECT_REF}.supabase.co`;
  const KEY = 'eyJpreview';
  const pr = (env: Record<string, string>) =>
    runStep(cfg, {
      EVENT: 'pull_request',
      ENVIRONMENT: 'staging',
      HAS_NETLIFY_TOKEN: 'true',
      PREVIEW_ANON_KEY: KEY,
      ...env,
    });

  it('pull requests: the preview project when it is its own', () => {
    const run = pr({ PREVIEW_SUPABASE_URL: 'https://previewprojectref00.supabase.co' });
    expect(run.status, run.log).toBe(0);
    expect(run.envFile).toEqual({
      VITE_DEMO: 'false',
      VITE_SUPABASE_URL: 'https://previewprojectref00.supabase.co',
      VITE_SUPABASE_ANON_KEY: KEY,
    });
    expect(run.outputs).toMatchObject({ mode: 'preview Supabase project', ready: 'true' });
  });

  it('pull requests: decodes the base64 anon key the preview job passes (a secret-valued output is dropped)', () => {
    const run = runStep(cfg, {
      EVENT: 'pull_request',
      ENVIRONMENT: 'staging',
      HAS_NETLIFY_TOKEN: 'true',
      PREVIEW_SUPABASE_URL: 'https://previewprojectref00.supabase.co',
      PREVIEW_ANON_KEY_B64: Buffer.from(KEY).toString('base64'),
    });
    expect(run.status, run.log).toBe(0);
    expect(run.envFile).toMatchObject({ VITE_DEMO: 'false', VITE_SUPABASE_ANON_KEY: KEY });
  });

  it('pull requests: demo mode for staging however it is spelled (D41)', () => {
    for (const env of [
      { PREVIEW_SUPABASE_URL: STAGING_URL },
      { PREVIEW_SUPABASE_URL: STAGING_URL.toUpperCase() },
      { PREVIEW_SUPABASE_URL: `https://%61${STAGING_PROJECT_REF.slice(1)}.supabase.co` },
      { PREVIEW_SUPABASE_URL: `https://\uff41${STAGING_PROJECT_REF.slice(1)}.supabase.co` },
      { PREVIEW_SUPABASE_URL: `https://${STAGING_PROJECT_REF}.supabase.co.` },
      {
        PREVIEW_SUPABASE_URL: 'https://OTHERLIVE0000000000.supabase.co',
        LIVE_PROJECT_REF: 'otherlive0000000000',
      },
      {
        PREVIEW_SUPABASE_URL: 'https://db.example.com',
        LIVE_PROJECT_URL: 'https://DB.example.com/',
      },
    ] as Record<string, string>[]) {
      const run = pr(env);
      expect(run.status, run.log).toBe(0);
      expect(run.envFile, JSON.stringify(env)).toEqual({
        VITE_DEMO: 'true',
        VITE_SUPABASE_URL: '',
        VITE_SUPABASE_ANON_KEY: '',
      });
      expect(run.log).toContain('::warning::');
    }
  });

  it('skips with a notice while NETLIFY_AUTH_TOKEN is missing', () => {
    const run = pr({ HAS_NETLIFY_TOKEN: 'false' });
    expect(run.outputs.ready).toBe('false');
    expect(run.log).toContain('::notice::Web preview skipped: set NETLIFY_AUTH_TOKEN');
  });
});

describe('deploy.yml field job (W1-04, D42/D43)', () => {
  const field = JOBS.get('field')!;
  const SITES = JSON.parse(
    readFileSync(join(ROOT, '.github', 'netlify-sites.json'), 'utf8'),
  ) as Record<string, string>;

  it('is planned like the panel and builds after the preview settings', () => {
    expect(field.text).toMatch(/^ {4}needs: \[plan, supabase, preview\]$/m);
    expect(field.condition).toContain("needs.plan.outputs.field == 'true'");
    expect(field.text).toContain("environment: ${{ inputs.environment || 'staging' }}");
    expect(JOBS.get('plan')!.text).toContain('field: ${{ steps.plan.outputs.field }}');
    const options = /target:[\s\S]*?options:\s*\[([^\]]*)\]/.exec(WORKFLOW)?.[1] ?? '';
    expect(
      options
        .split(',')
        .map((o) => o.trim())
        .filter(Boolean),
    ).toEqual([
      'all',
      'supabase',
      'worker',
      'web',
      'field',
      'inventory',
      'seed',
      'phone-setup',
      'preview-worker',
      'voice-setup',
      'billing-setup',
      'countries-set',
      'eval',
    ]);
  });

  it("uses its own Netlify site key and name, never the panel's (D42)", () => {
    const site = stepScript('field', 'Netlify site');
    expect(site).toContain('key="field-${ENVIRONMENT}"');
    expect(site).toContain('name="sitelog-field-${ENVIRONMENT}-${owner}"');
    expect(field.text).not.toMatch(/^\s*NETLIFY_SITE_ID:/m);
    expect(field.text).not.toContain('$NETLIFY_SITE_ID');
    expect(field.text).not.toContain('name="sitelog-${ENVIRONMENT}-');
    // The panel's job never reads a field key or name.
    expect(JOBS.get('web')!.text).not.toMatch(/field-|sitelog-field/);
    // The site file: environment keys for the panel, field-<environment> keys for the field app, and
    // no id used twice.
    for (const key of Object.keys(SITES)) {
      expect(key).toMatch(/^(field-)?(staging|production)$/);
    }
    const ids = Object.values(SITES);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('deploys the pr-<n> alias for pull requests and --prod only otherwise, from apps/field/dist', () => {
    const deploy = stepScript('field', 'Deploy');
    expect(deploy).toContain('flags=(--alias "pr-$PR_NUMBER")');
    expect(deploy).toContain('--filter @sitelog/field --dir "$GITHUB_WORKSPACE/apps/field/dist"');
    expect(deploy).not.toContain('apps/web');
  });

  it('gives the build only the checked Supabase URL (D41, D43)', () => {
    const build = field.text.slice(field.text.indexOf('      - name: Build'));
    const env = build.slice(build.indexOf('        env:'), build.indexOf('        run: |'));
    expect(
      env
        .trim()
        .split('\n')
        .slice(1)
        .map((l) => l.trim()),
    ).toEqual([
      'SUPABASE_URL: ${{ steps.cfg.outputs.supabase_url }}',
      'VITE_SUPABASE_URL: ${{ steps.cfg.outputs.supabase_url }}',
    ]);
    expect(field.text).toContain('PREVIEW_SUPABASE_URL: ${{ needs.preview.outputs.supabase_url }}');
    expect(field.text).not.toMatch(/ANON_KEY|SENTRY|WA_DISPLAY|GITHUB_ENV/);
    expect(stepScript('field', 'Build')).toMatch(/^pnpm --filter @sitelog\/field build$/m);
  });

  describe('Check configuration, run under bash', () => {
    const cfg = stepScript('field', 'Check configuration');
    const PREVIEW_URL = 'https://previewprojectref00.supabase.co';
    const STAGING_URL = `https://${STAGING_PROJECT_REF}.supabase.co`;
    const pr = (env: Record<string, string>) =>
      runStep(cfg, {
        EVENT: 'pull_request',
        ENVIRONMENT: 'staging',
        HAS_NETLIFY_TOKEN: 'true',
        ...env,
      });
    const dispatch = (env: Record<string, string>) =>
      runStep(cfg, {
        EVENT: 'workflow_dispatch',
        ENVIRONMENT: 'staging',
        HAS_NETLIFY_TOKEN: 'true',
        ...env,
      });

    it('pull requests: /api to the preview project', () => {
      const run = pr({ PREVIEW_SUPABASE_URL: PREVIEW_URL, LIVE_PROJECT_REF: STAGING_PROJECT_REF });
      expect(run.status, run.log).toBe(0);
      expect(run.outputs).toEqual({
        supabase_url: PREVIEW_URL,
        mode: '/api to the preview Supabase project',
        ready: 'true',
      });
    });

    it('pull requests: no /api rule without a preview project, never a staging fallback', () => {
      // Even if the Environment's values reached the step, the pull-request path does not read them.
      const run = pr({
        SUPABASE_URL_VAR: 'https://deployproject000000.supabase.co',
        SUPABASE_PROJECT_REF: 'deployproject000000',
      });
      expect(run.status, run.log).toBe(0);
      expect(run.outputs.supabase_url).toBe('');
      expect(run.outputs.mode).toMatch(/^no \/api/);
      expect(run.outputs.ready).toBe('true');
    });

    it('pull requests: a preview URL on the staging project builds without /api (D41)', () => {
      const cases: Record<string, string>[] = [
        { PREVIEW_SUPABASE_URL: STAGING_URL },
        {
          PREVIEW_SUPABASE_URL: 'https://otherlive0000000000.supabase.co',
          LIVE_PROJECT_REF: 'otherlive0000000000',
        },
        {
          PREVIEW_SUPABASE_URL: 'https://db.example.com',
          LIVE_PROJECT_URL: 'https://db.example.com',
        },
        { PREVIEW_SUPABASE_URL: 'http://previewprojectref00.supabase.co' },
      ];
      for (const env of cases) {
        const run = pr(env);
        expect(run.status, run.log).toBe(0);
        expect(run.outputs.supabase_url, JSON.stringify(env)).toBe('');
        expect(run.log).toContain('::warning::');
      }
    });

    it('pull requests: staging spelled another way still builds without /api', () => {
      // The build's URL parser lowercases the host and decodes escapes (apps/field/config/redirects.ts),
      // so each of these would forward /api to staging if the step compared the raw text.
      const staging = [
        STAGING_URL.toUpperCase(),
        `https://${STAGING_PROJECT_REF.toUpperCase()}.supabase.co`,
        `https://%61${STAGING_PROJECT_REF.slice(1)}.supabase.co`,
        `https://${STAGING_PROJECT_REF}%2esupabase.co`,
        `https://\uff41${STAGING_PROJECT_REF.slice(1)}.supabase.co`,
        `https://user@${STAGING_PROJECT_REF}.supabase.co`,
        `https://${STAGING_PROJECT_REF}.supabase.co.`,
        `https://${STAGING_PROJECT_REF}.supabase.co:443/`,
      ];
      for (const url of staging) {
        const run = pr({ PREVIEW_SUPABASE_URL: url });
        expect(run.status, run.log).toBe(0);
        expect(run.outputs.supabase_url, url).toBe('');
        expect(run.outputs.mode, url).toMatch(/^no \/api/);
        expect(run.log, url).toContain('::warning::');
      }
      // Staging's own variables, written differently from the preview's value.
      const live: Record<string, string>[] = [
        {
          PREVIEW_SUPABASE_URL: 'https://OTHERLIVE0000000000.supabase.co',
          LIVE_PROJECT_REF: 'otherlive0000000000',
        },
        {
          PREVIEW_SUPABASE_URL: 'https://db.example.com',
          LIVE_PROJECT_URL: 'https://DB.example.com/',
        },
        {
          PREVIEW_SUPABASE_URL: 'https://DB.example.com.:443/',
          LIVE_PROJECT_URL: 'https://db.example.com',
        },
      ];
      for (const env of live) {
        const run = pr(env);
        expect(run.outputs.supabase_url, JSON.stringify(env)).toBe('');
      }
      // A different project on the same kind of host still passes.
      const other = pr({
        PREVIEW_SUPABASE_URL: 'https://Preview.example.com/',
        LIVE_PROJECT_URL: 'https://db.example.com/',
      });
      expect(other.outputs.supabase_url).toBe('https://Preview.example.com/');
    });

    it('skips with a notice while NETLIFY_AUTH_TOKEN is missing', () => {
      const run = pr({ HAS_NETLIFY_TOKEN: 'false', PREVIEW_SUPABASE_URL: PREVIEW_URL });
      expect(run.status, run.log).toBe(0);
      expect(run.outputs.ready).toBe('false');
      expect(run.log).toContain('::notice::Field preview skipped: set NETLIFY_AUTH_TOKEN');
      const deploy = dispatch({
        HAS_NETLIFY_TOKEN: 'false',
        SUPABASE_PROJECT_REF: STAGING_PROJECT_REF,
      });
      expect(deploy.outputs.ready).toBe('false');
      expect(deploy.log).toContain('::notice::Field deploy skipped for staging');
    });

    it("deploys: /api to the Environment's project, the URL derived from the ref when needed", () => {
      const derived = dispatch({
        SUPABASE_PROJECT_REF: STAGING_PROJECT_REF,
        SUPABASE_URL_VAR: 'https://<ref>.supabase.co',
      });
      expect(derived.status, derived.log).toBe(0);
      expect(derived.outputs).toMatchObject({ supabase_url: STAGING_URL, ready: 'true' });
      const given = dispatch({ SUPABASE_PROJECT_REF: 'x', SUPABASE_URL_VAR: STAGING_URL });
      expect(given.outputs.supabase_url).toBe(STAGING_URL);
      const none = dispatch({});
      expect(none.outputs).toMatchObject({ supabase_url: '', ready: 'false' });
    });

    it('deploys: refuses another Environment that resolves to the staging project', () => {
      const run = dispatch({
        ENVIRONMENT: 'production',
        SUPABASE_PROJECT_REF: STAGING_PROJECT_REF,
      });
      expect(run.status).not.toBe(0);
      expect(run.log).toContain('::error::production resolves to the staging Supabase project');
      expect(run.outputs.ready).toBeUndefined();
      const own = dispatch({
        ENVIRONMENT: 'production',
        SUPABASE_PROJECT_REF: 'prodprojectref000000',
      });
      expect(own.outputs).toMatchObject({
        supabase_url: 'https://prodprojectref000000.supabase.co',
        ready: 'true',
      });
      const bad = dispatch({ SUPABASE_PROJECT_REF: 'a b' });
      expect(bad.status).not.toBe(0);
    });

    it('deploys: refuses staging spelled another way for another Environment', () => {
      for (const env of [
        { SUPABASE_URL_VAR: `https://${STAGING_PROJECT_REF.toUpperCase()}.supabase.co` },
        { SUPABASE_PROJECT_REF: STAGING_PROJECT_REF.toUpperCase() },
        { SUPABASE_URL_VAR: `https://${STAGING_PROJECT_REF}.supabase.co./` },
      ] as Record<string, string>[]) {
        const run = dispatch({ ENVIRONMENT: 'production', ...env });
        expect(run.status, JSON.stringify(env)).not.toBe(0);
        expect(run.log).toContain('::error::production resolves to the staging Supabase project');
        expect(run.outputs.ready).toBeUndefined();
      }
      // An escaped, Unicode or upper-case-scheme spelling is not used at all: the URL then comes from
      // the ref, if any.
      for (const url of [
        STAGING_URL.toUpperCase(),
        `https://%61${STAGING_PROJECT_REF.slice(1)}.supabase.co`,
        `https://\uff41${STAGING_PROJECT_REF.slice(1)}.supabase.co`,
      ]) {
        const none = dispatch({ ENVIRONMENT: 'production', SUPABASE_URL_VAR: url });
        expect(none.status, none.log).toBe(0);
        expect(none.outputs).toMatchObject({ supabase_url: '', ready: 'false' });
        const own = dispatch({
          ENVIRONMENT: 'production',
          SUPABASE_URL_VAR: url,
          SUPABASE_PROJECT_REF: 'prodprojectref000000',
        });
        expect(own.outputs.supabase_url).toBe('https://prodprojectref000000.supabase.co');
      }
    });
  });

  describe('Build, run under bash with a stand-in for pnpm', () => {
    const build = stepScript('field', 'Build');
    const API =
      '/api/*  https://previewprojectref00.supabase.co/functions/v1/field-api/:splat  200';
    const FALLBACK = '/*  /index.html  200';
    const withRedirects = (url: string, ...rules: string[]) =>
      runStep(build, { SUPABASE_URL: url, VITE_SUPABASE_URL: url }, undefined, {
        // What `pnpm --filter @sitelog/field build` leaves in dist/.
        pnpm: `mkdir -p apps/field/dist && printf '%s\\n' ${['# generated', ...rules].map((r) => `'${r}'`).join(' ')} > apps/field/dist/_redirects`,
      });

    it('accepts the /api rule first and the app fallback last', () => {
      expect(withRedirects('https://previewprojectref00.supabase.co', API, FALLBACK).status).toBe(
        0,
      );
      expect(withRedirects('', FALLBACK).status).toBe(0);
    });

    it('fails when the file does not match the URL it was given', () => {
      const missing = withRedirects('https://previewprojectref00.supabase.co', FALLBACK);
      expect(missing.status).not.toBe(0);
      expect(missing.log).toContain('does not start with the /api rule');
      const unexpected = withRedirects('', API, FALLBACK);
      expect(unexpected.status).not.toBe(0);
      expect(unexpected.log).toContain('forwards /api although no Supabase URL was given');
      const noFallback = withRedirects('https://previewprojectref00.supabase.co', FALLBACK, API);
      expect(noFallback.status).not.toBe(0);
    });

    it('refuses a rule that forwards a pull request or another Environment to staging', () => {
      // What the generator writes for an Environment value such as https://ABUAN….supabase.co or
      // https://%61buan….supabase.co (its URL parser lowercases and decodes the host).
      const toStaging = `/api/*  https://${STAGING_PROJECT_REF}.supabase.co/functions/v1/field-api/:splat  200`;
      const run = (env: Record<string, string>, rule: string) =>
        runStep(
          build,
          {
            SUPABASE_URL: 'https://x.supabase.co',
            VITE_SUPABASE_URL: 'https://x.supabase.co',
            ...env,
          },
          undefined,
          {
            pnpm: `mkdir -p apps/field/dist && printf '%s\\n' '${rule}' '${FALLBACK}' > apps/field/dist/_redirects`,
          },
        );
      for (const env of [
        { EVENT: 'pull_request', ENVIRONMENT: 'staging' },
        { EVENT: 'workflow_dispatch', ENVIRONMENT: 'production' },
      ]) {
        const refused = run(env, toStaging);
        expect(refused.status, JSON.stringify(env)).not.toBe(0);
        expect(refused.log).toContain(`forwards /api to ${STAGING_PROJECT_REF}.supabase.co`);
      }
      // Staging's own deploy forwards to staging.
      expect(run({ EVENT: 'workflow_dispatch', ENVIRONMENT: 'staging' }, toStaging).status).toBe(0);
      // On a pull request, staging's own variables count too, however they are written.
      const custom = '/api/*  https://db.example.com/functions/v1/field-api/:splat  200';
      const pr = { EVENT: 'pull_request', ENVIRONMENT: 'staging' };
      expect(run({ ...pr, LIVE_PROJECT_URL: 'https://DB.Example.com./' }, custom).status).not.toBe(
        0,
      );
      expect(
        run({ ...pr, LIVE_PROJECT_URL: 'https://db.example.com:443' }, custom).status,
      ).not.toBe(0);
      expect(run({ ...pr, LIVE_PROJECT_URL: 'https://other.example.com' }, custom).status).toBe(0);
      expect(
        run(
          { ...pr, LIVE_PROJECT_REF: 'otherlive0000000000' },
          API.replace('previewprojectref00', 'OTHERLIVE0000000000'.toLowerCase()),
        ).status,
      ).not.toBe(0);
      expect(run(pr, API).status).toBe(0);
      // A target that does not parse is refused rather than trusted.
      expect(run(pr, '/api/*  https://[bad/functions/v1/field-api/:splat  200').status).not.toBe(0);
    });
  });

  describe('Netlify site, run under bash with a stand-in for curl', () => {
    const site = stepScript('field', 'Netlify site');
    /** Answers the three Netlify calls the step makes and logs each request. */
    const curl = [
      'echo "$*" >> "$CURL_LOG"',
      'url="${!#}"',
      'case "$url" in',
      '  *"/sites?name="*) printf "%s" "${FAKE_LIST:-[]}" ;;',
      '  */sites/*) id="${url##*/sites/}"; printf \'{"id":"%s","name":"%s","ssl_url":"https://%s.netlify.app"}\' "$id" "${FAKE_NAME:-site-$id}" "$id" ;;',
      '  */sites) name="$(jq -r .name)"; printf \'{"id":"new-%s","name":"%s","ssl_url":"https://%s.netlify.app"}\' "$name" "$name" "$name" ;;',
      '  *) exit 22 ;;',
      'esac',
    ].join('\n');
    const resolve = (sites: Record<string, string>, env: Record<string, string> = {}) =>
      runStep(
        site,
        {
          ENVIRONMENT: 'staging',
          NETLIFY_AUTH_TOKEN: 't',
          GITHUB_REPOSITORY_OWNER: 'Acme',
          PANEL_SITE_ID: '',
          CURL_LOG: 'curl.log',
          ...env,
        },
        (dir) => {
          mkdirSync(join(dir, '.github'));
          writeFileSync(join(dir, '.github', 'netlify-sites.json'), JSON.stringify(sites));
          writeFileSync(join(dir, 'curl.log'), '');
        },
        { curl },
      );
    const requests = (run: StepRun) => readFileSync(join(run.dir, 'curl.log'), 'utf8');

    it('takes the field-<environment> key when it exists', () => {
      const run = resolve({ staging: 'panel-id', 'field-staging': 'field-id' });
      expect(run.status, run.log).toBe(0);
      expect(run.outputs).toEqual({ id: 'field-id', url: 'https://field-id.netlify.app' });
      expect(requests(run)).toContain('/sites/field-id');
      expect(requests(run)).not.toContain('panel-id');
    });

    it("otherwise finds or creates sitelog-field-<environment>-<owner>, never the panel's site", () => {
      const created = resolve({ staging: 'panel-id' });
      expect(created.status, created.log).toBe(0);
      expect(created.outputs.id).toBe('new-sitelog-field-staging-acme');
      expect(requests(created)).toContain('/sites?name=sitelog-field-staging-acme&filter=all');
      expect(requests(created)).not.toContain('panel-id');
      expect(created.log).toContain('under "field-staging" so a rename keeps deploys on it');

      const found = resolve(
        {},
        {
          FAKE_LIST: JSON.stringify([
            { id: 'p', name: 'sitelog-staging-acme' },
            { id: 'f', name: 'sitelog-field-staging-acme', ssl_url: 'https://f.netlify.app' },
          ]),
        },
      );
      expect(found.status, found.log).toBe(0);
      expect(found.outputs.id).toBe('f');
      expect(requests(found)).not.toMatch(/-d @-/);

      const production = resolve(
        { 'field-production': 'field-prod-id' },
        { ENVIRONMENT: 'production' },
      );
      expect(production.outputs.id).toBe('field-prod-id');
    });

    it("refuses a site that is the panel's, by key, by NETLIFY_SITE_ID or by name", () => {
      for (const [sites, env] of [
        [{ staging: 'same-id', 'field-staging': 'same-id' }, {}],
        [{ 'field-staging': 'panel-var-id' }, { PANEL_SITE_ID: 'panel-var-id' }],
        [{ 'field-staging': 'x' }, { FAKE_NAME: 'sitelog-staging-acme' }],
      ] as const) {
        const run = resolve(sites, env);
        expect(run.status, JSON.stringify(sites)).not.toBe(0);
        expect(run.log).toContain("is the panel's; refusing to deploy over the panel");
        expect(run.outputs.id).toBeUndefined();
      }
    });
  });

  describe('Deploy, run under bash with a stand-in for npx', () => {
    const deploy = stepScript('field', 'Deploy');
    const npx = [
      'echo "$*" > npx.args',
      'printf \'{"deploy_url":"https://pr-7--sitelog-field-staging-acme.netlify.app"}\'',
    ].join('\n');
    const run = (event: string) =>
      runStep(
        deploy,
        {
          EVENT: event,
          ENVIRONMENT: 'staging',
          NETLIFY_AUTH_TOKEN: 't',
          SITE_ID: 'field-id',
          SITE_URL: 'https://sitelog-field-staging-acme.netlify.app',
          PR_NUMBER: event === 'pull_request' ? '7' : '',
          MODE: 'm',
          GITHUB_SHA: 'abcdef0123456',
        },
        undefined,
        { npx },
      );

    it('pull requests deploy the pr-<n> alias of the field site, never --prod', () => {
      const pr = run('pull_request');
      expect(pr.status, pr.log).toBe(0);
      const args = readFileSync(join(pr.dir, 'npx.args'), 'utf8');
      expect(args).toContain('--alias pr-7');
      expect(args).not.toContain('--prod');
      expect(args).toContain('--site field-id');
      expect(args).toContain(`--dir ${pr.dir}/apps/field/dist`);
      expect(pr.summary).toContain('### Field app preview (pr-7, m)');
      expect(pr.summary).toContain('https://pr-7--sitelog-field-staging-acme.netlify.app/today');
    });

    it('a dispatch deploys --prod', () => {
      const prod = run('workflow_dispatch');
      expect(prod.status, prod.log).toBe(0);
      const args = readFileSync(join(prod.dir, 'npx.args'), 'utf8');
      expect(args).toContain('--prod');
      expect(args).not.toContain('--alias');
      expect(prod.summary).toContain('### Field app (staging, m)');
    });
  });
});

describe('deploy.yml preview-worker steps, run under bash', () => {
  it('Check configuration refuses the staging project and missing settings', () => {
    const check = stepScript('preview-worker', 'Check configuration');
    const base = {
      SUPABASE_ACCESS_TOKEN: 'token',
      SUPABASE_DB_PASSWORD_SECRET: ' pw ',
      SUPABASE_PROJECT_REF: 'previewref0000000000',
    };
    const ok = runStep(check, base);
    expect(ok.status, ok.log).toBe(0);
    const staging = runStep(check, { ...base, SUPABASE_PROJECT_REF: STAGING_PROJECT_REF });
    expect(staging.status).toBe(1);
    expect(staging.log).toContain('refusing to run the worker');
    const missing = runStep(check, { ...base, SUPABASE_DB_PASSWORD_SECRET: '' });
    expect(missing.status).toBe(1);
  });

  const heartbeat = stepScript(
    'preview-worker',
    'Keep the worker running (heartbeat every 5 minutes)',
  );
  const redact = stepScript('preview-worker', 'Start the worker')
    .split('\n')
    .reduce<{ on: boolean; lines: string[] }>(
      (acc, l) => {
        if (/<<'JS'$/.test(l)) return { on: true, lines: acc.lines };
        if (acc.on && l === 'JS') return { on: false, lines: acc.lines };
        if (acc.on) acc.lines.push(l);
        return acc;
      },
      { on: false, lines: [] },
    )
    .lines.join('\n');

  function beat(curl: string) {
    return runStep(
      heartbeat,
      {
        RUN_MINUTES: '60',
        // The step's cwd is the scratch directory, where redact.mjs and worker.log are.
        RUNNER_TEMP: '.',
        // Far enough ahead that a slow runner still reaches the first /health check (with + 1 the
        // limit could pass before the loop started, and the step ended 0 without checking).
        WORKER_UNTIL: String(Math.floor(Date.now() / 1000) + 3),
      },
      (dir) => {
        writeFileSync(join(dir, 'redact.mjs'), redact);
        writeFileSync(
          join(dir, 'worker.log'),
          [
            JSON.stringify({ msg: 'question ready', report_id: 'r1' }),
            JSON.stringify({
              msg: 'email (console provider)',
              to: ['lena@kestrelbuild.example'],
              text_preview: 'call +1 312 555 0142',
            }),
            'Error: duplicate key (phone_e164)=(+13125550142) at https://x.netlify.app/r/K7Q2MXABCD23',
          ].join('\n'),
        );
      },
      { curl },
    );
  }

  it('runs until the limit, printing the health and a redacted log tail', () => {
    const r = beat('echo \'{"ok":true,"listening":true}\'');
    expect(r.status, r.log).toBe(0);
    expect(r.log).toContain('Time limit reached (60 minutes)');
    expect(r.log).toContain('"listening":true');
    expect(r.log).toContain('question ready');
    expect(r.log).toContain('1 recipient(s)');
    expect(r.log).toContain('(phone_e164)=([phone])');
    expect(r.log).toContain('/r/[code]');
    expect(r.log).not.toMatch(/555|kestrelbuild|K7Q2MX|text_preview/);
  });

  it('fails when the worker stops answering /health', () => {
    const r = beat('exit 7');
    expect(r.status).toBe(1);
    expect(r.log).toContain('stopped answering /health');
  });
});

/* ── voice-setup and billing-setup (the preview project's LiveKit Cloud and Stripe test mode) ─── */

describe('deploy.yml voice-setup job', () => {
  const job = JOBS.get('voice-setup')!;

  it('reads the voice keys from the preview Environment and pins the lk CLI by checksum', () => {
    for (const name of [
      'LIVEKIT_URL',
      'LIVEKIT_API_KEY',
      'LIVEKIT_API_SECRET',
      'DEEPGRAM_API_KEY',
      'ANTHROPIC_API_KEY',
    ])
      expect(job.text, name).toContain(`${name}: \${{ secrets.${name} }}`);
    // The preview worker's fast-model default, unchanged.
    expect(job.text).toContain(
      "CLAUDE_MODEL_FAST: ${{ vars.CLAUDE_MODEL_FAST || 'claude-haiku-5-5' }}",
    );
    // English only: no Azure key, no TR or ES voice.
    expect(job.text).not.toMatch(/secrets\.AZURE|TTS_VOICE_(TR|ES)=/);
    // Secrets never reach GITHUB_ENV (only the list of names does).
    expect(job.text).not.toMatch(
      /(LIVEKIT_API_SECRET|_API_KEY|tool_secret|call_secret).*GITHUB_ENV/,
    );
    expect(job.text).toMatch(/^ {6}LK_VERSION: \d+\.\d+\.\d+$/m);
    expect(job.text).toMatch(/^ {6}LK_SHA256: [0-9a-f]{64}$/m);
    const install = stepScript('voice-setup', 'Install the lk CLI');
    expect(install).toContain('sha256sum -c -');
    expect(install).toContain(
      'https://github.com/livekit/livekit-cli/releases/download/v${LK_VERSION}/$archive',
    );
    // The contract check runs before anything is deployed.
    const steps = jobSteps(job.text).map((s) => s.name);
    expect(steps.indexOf('Voice contract is current')).toBeLessThan(
      steps.indexOf('Function secrets on the preview project'),
    );
    expect(jobSteps(job.text).find((s) => s.name === 'Voice contract is current')!.text).toMatch(
      /^ {8}run: pnpm voice:contract -- --check$/m,
    );
    // The secrets files and the lk config are removed whatever happened.
    const cleanup = jobSteps(job.text).find(
      (s) => s.name === 'Remove the secrets files and the lk config',
    )!;
    expect(cleanup.text).toContain('if: always()');
    expect(cleanup.text).toContain('"$RUNNER_TEMP/voice-agent.env"');
    expect(cleanup.text).toContain('"$HOME/.livekit"');
  });

  it('updates the agent the project has, else creates one, never by a committed livekit.toml', () => {
    const agent = stepScript('voice-setup', 'Agent on LiveKit Cloud');
    expect(agent).toContain('lk agent list --project "$LK_PROJECT" --json');
    expect(agent).toContain(
      'lk agent update-secrets --project "$LK_PROJECT" --id "$id" --secrets-file "$secrets" --yes',
    );
    expect(agent).toContain('lk agent deploy --project "$LK_PROJECT" --id "$id" --yes');
    expect(agent).toContain(
      'lk agent create --project "$LK_PROJECT" --region "$LIVEKIT_AGENT_REGION" --secrets-file "$secrets" --yes',
    );
    expect(existsSync(join(ROOT, 'apps', 'voice-agent', 'livekit.toml'))).toBe(false);
    expect(stepScript('voice-setup', 'LiveKit project for the lk CLI')).toContain(
      'lk project add "$LK_PROJECT" --url "$LIVEKIT_URL" --api-key "$LIVEKIT_API_KEY" --api-secret "$LIVEKIT_API_SECRET" --default --yes >/dev/null',
    );
    const summary = stepScript('voice-setup', 'Agent status and summary');
    expect(summary).toContain(
      'https://${SUPABASE_PROJECT_REF}.supabase.co/functions/v1/voice-events',
    );
  });

  describe('Check configuration, run under bash', () => {
    const check = stepScript('voice-setup', 'Check configuration');
    const base = {
      SUPABASE_ACCESS_TOKEN: 'token',
      SUPABASE_PROJECT_REF: 'previewref0000000000',
      LIVEKIT_URL: 'wss://sitelog-preview.livekit.cloud',
      LIVEKIT_API_KEY: 'APIkey',
      LIVEKIT_API_SECRET: 'lk-secret-value',
      DEEPGRAM_API_KEY: 'dg-value',
      ANTHROPIC_API_KEY: 'sk-ant-value',
    };

    it('passes with every value, and names each missing one without printing a value', () => {
      expect(runStep(check, base).status).toBe(0);
      const missing = runStep(check, {
        ...base,
        LIVEKIT_API_SECRET: '',
        DEEPGRAM_API_KEY: '',
        SUPABASE_PROJECT_REF: '',
      });
      expect(missing.status).toBe(1);
      expect(missing.log).toContain(
        'LIVEKIT_API_SECRET (secret) DEEPGRAM_API_KEY (secret) SUPABASE_PROJECT_REF (variable)',
      );
      expect(missing.log).not.toMatch(/APIkey|sk-ant-value|lk-secret-value/);
    });

    it('refuses the staging project, a pasted line break and a URL that is not wss://', () => {
      const staging = runStep(check, { ...base, SUPABASE_PROJECT_REF: STAGING_PROJECT_REF });
      expect(staging.status).toBe(1);
      expect(staging.log).toContain('refusing');
      const pasted = runStep(check, { ...base, ANTHROPIC_API_KEY: 'sk-ant-value\n' });
      expect(pasted.status).toBe(1);
      expect(pasted.log).toContain('ANTHROPIC_API_KEY holds a space or a line break');
      expect(pasted.log).not.toContain('sk-ant-value');
      const https = runStep(check, { ...base, LIVEKIT_URL: 'https://sitelog.livekit.cloud' });
      expect(https.status).toBe(1);
      expect(https.log).toContain('LIVEKIT_URL must be');
    });
  });

  describe('Secrets files, run under bash with a stand-in for supabase', () => {
    const script = stepScript('voice-setup', 'Secrets files');
    const env = {
      SUPABASE_PROJECT_REF: 'previewref0000000000',
      LIVEKIT_URL: 'wss://sitelog-preview.livekit.cloud',
      LIVEKIT_API_KEY: 'APIkey',
      LIVEKIT_API_SECRET: 'lk-secret-value',
      DEEPGRAM_API_KEY: 'dg-value',
      ANTHROPIC_API_KEY: 'sk-ant-value',
      CLAUDE_MODEL_FAST: 'fast-model-from-env',
      LIVEKIT_AGENT_NAME: 'sitelog-voice',
      RUNNER_TEMP: '.',
    };
    const files = (names: string[]) =>
      runStep(script, env, undefined, {
        supabase: `printf '%s' '${JSON.stringify(names.map((name) => ({ name, value: 'digest' })))}'`,
      });
    const read = (run: StepRun, file: string) =>
      Object.fromEntries(
        readFileSync(join(run.dir, file), 'utf8')
          .trim()
          .split('\n')
          .map((l) => [l.slice(0, l.indexOf('=')), l.slice(l.indexOf('=') + 1)]),
      );

    it('one new tool secret in both files; the call-token secret only when missing', () => {
      const fresh = files(['LINK_SIGNING_SECRET']);
      expect(fresh.status, fresh.log).toBe(0);
      const fn = read(fresh, 'voice-functions.env');
      const agent = read(fresh, 'voice-agent.env');
      expect(Object.keys(fn)).toEqual([
        'LIVEKIT_URL',
        'LIVEKIT_API_KEY',
        'LIVEKIT_API_SECRET',
        'LIVEKIT_AGENT_NAME',
        'VOICE_AGENT_TOOL_SECRET',
        'VOICE_CALL_TOKEN_SECRET',
      ]);
      expect(fn.LIVEKIT_AGENT_NAME).toBe('sitelog-voice');
      expect(Buffer.from(fn.VOICE_AGENT_TOOL_SECRET!, 'base64')).toHaveLength(32);
      expect(fn.VOICE_CALL_TOKEN_SECRET).not.toBe(fn.VOICE_AGENT_TOOL_SECRET);
      expect(fresh.log).toContain(`::add-mask::${fn.VOICE_AGENT_TOOL_SECRET}`);
      expect(fresh.log).toContain(`::add-mask::${fn.VOICE_CALL_TOKEN_SECRET}`);
      expect(agent).toEqual({
        FIELD_API_URL: 'https://previewref0000000000.supabase.co/functions/v1/field-api',
        VOICE_AGENT_TOOL_SECRET: fn.VOICE_AGENT_TOOL_SECRET,
        DEEPGRAM_API_KEY: 'dg-value',
        ANTHROPIC_API_KEY: 'sk-ant-value',
        CLAUDE_MODEL_FAST: 'fast-model-from-env',
        STT_MODEL: 'nova-3',
        TTS_VOICE_EN: 'aura-2-thalia-en',
        LIVEKIT_AGENT_NAME: 'sitelog-voice',
        NODE_ENV: 'production',
        SENTRY_ENVIRONMENT: 'preview',
      });
      for (const file of ['voice-functions.env', 'voice-agent.env'])
        expect(statSync(join(fresh.dir, file)).mode & 0o777, file).toBe(0o600);
      expect(fresh.envFile.VOICE_FUNCTION_SECRETS).toBe(
        'LIVEKIT_URL LIVEKIT_API_KEY LIVEKIT_API_SECRET LIVEKIT_AGENT_NAME VOICE_AGENT_TOOL_SECRET VOICE_CALL_TOKEN_SECRET',
      );

      const again = files(['VOICE_CALL_TOKEN_SECRET', 'VOICE_AGENT_TOOL_SECRET']);
      expect(again.status, again.log).toBe(0);
      const fn2 = read(again, 'voice-functions.env');
      expect(fn2.VOICE_CALL_TOKEN_SECRET).toBeUndefined();
      expect(again.log).toContain('VOICE_CALL_TOKEN_SECRET already set: kept.');
      // The tool secret is new on every run, and the agent gets the same one.
      expect(fn2.VOICE_AGENT_TOOL_SECRET).not.toBe(fn.VOICE_AGENT_TOOL_SECRET);
      expect(read(again, 'voice-agent.env').VOICE_AGENT_TOOL_SECRET).toBe(
        fn2.VOICE_AGENT_TOOL_SECRET,
      );
      expect(again.envFile.VOICE_FUNCTION_SECRETS).not.toContain('VOICE_CALL_TOKEN_SECRET');
    });
  });

  describe('livekit-pick-agent.mjs', () => {
    const pick = (agents: unknown) => {
      const dir = mkdtempSync(join(tmpdir(), 'lk-agents-'));
      scratch.push(dir);
      const file = join(dir, 'agents.json');
      writeFileSync(file, agents === undefined ? '' : JSON.stringify(agents));
      const res = spawnSync(
        process.execPath,
        [join(ROOT, '.github', 'scripts', 'livekit-pick-agent.mjs'), file],
        {
          encoding: 'utf8',
          env: { PATH: process.env.PATH ?? '', LIVEKIT_AGENT_NAME: 'sitelog-voice' },
        },
      );
      return { status: res.status, id: res.stdout.trim(), err: res.stderr };
    };

    it('the agent named sitelog-voice, else the only one, else none', () => {
      expect(pick(undefined)).toMatchObject({ status: 0, id: '' });
      expect(pick({})).toMatchObject({ status: 0, id: '' });
      expect(pick({ agents: [{ agentId: 'CA_one' }] })).toMatchObject({ status: 0, id: 'CA_one' });
      expect(
        pick({
          agents: [
            { agentId: 'CA_other', agentName: 'other' },
            { agentId: 'CA_ours', agentName: 'sitelog-voice' },
          ],
        }),
      ).toMatchObject({ status: 0, id: 'CA_ours' });
    });

    it('refuses to choose among several agents none (or more than one) of them named sitelog-voice', () => {
      const none = pick({ agents: [{ agentId: 'CA_a' }, { agentId: 'CA_b', agentName: 'x' }] });
      expect(none.status).toBe(3);
      expect(none.id).toBe('');
      expect(none.err).toContain('CA_a, CA_b');
      const two = pick({
        agents: [
          { agentId: 'CA_a', agentName: 'sitelog-voice' },
          { agentId: 'CA_b', agentName: 'sitelog-voice' },
        ],
      });
      expect(two.status).toBe(3);
    });
  });
});

describe('deploy.yml billing-setup job', () => {
  const job = JOBS.get('billing-setup')!;

  it('test mode only, the Stripe key from the preview Environment, never to GITHUB_ENV', () => {
    expect(new Set(job.text.match(/\bsecrets\.\w+/g))).toEqual(
      new Set(['secrets.SUPABASE_ACCESS_TOKEN', 'secrets.STRIPE_SECRET_KEY']),
    );
    expect(job.text).not.toMatch(/STRIPE_SECRET_KEY.*GITHUB_ENV|whsec.*GITHUB_ENV/);
    // The endpoint's API version is the one supabase/functions/README.md pins for the SDK.
    const version = /^ {6}STRIPE_WEBHOOK_API_VERSION: (\S+)$/m.exec(job.text)?.[1];
    expect(version).toBeTruthy();
    expect(readFileSync(join(ROOT, 'supabase', 'functions', 'README.md'), 'utf8')).toContain(
      `\`${version}\``,
    );
    const secrets = stepScript('billing-setup', 'Function secrets on the preview project');
    expect(secrets).toContain(
      'supabase secrets set --project-ref "$SUPABASE_PROJECT_REF" --env-file "$f" >/dev/null',
    );
    const cleanup = jobSteps(job.text).find((s) => s.name === 'Remove the secrets file')!;
    expect(cleanup.text).toContain('if: always()');
  });

  describe('Check configuration, run under bash', () => {
    const check = stepScript('billing-setup', 'Check configuration');
    const base = {
      SUPABASE_ACCESS_TOKEN: 'token',
      SUPABASE_PROJECT_REF: 'previewref0000000000',
      STRIPE_SECRET_KEY: 'sk_test_abc',
    };

    it('takes a test-mode key and refuses a live or restricted one, staging and missing values', () => {
      expect(runStep(check, base).status).toBe(0);
      for (const key of ['sk_live_abc', 'rk_test_abc', 'pk_test_abc']) {
        const r = runStep(check, { ...base, STRIPE_SECRET_KEY: key });
        expect(r.status, key).toBe(1);
        expect(r.log).toContain('not a test-mode secret key');
        expect(r.log).not.toContain(key);
      }
      const staging = runStep(check, { ...base, SUPABASE_PROJECT_REF: STAGING_PROJECT_REF });
      expect(staging.status).toBe(1);
      const missing = runStep(check, { ...base, STRIPE_SECRET_KEY: '' });
      expect(missing.status).toBe(1);
      expect(missing.log).toContain('STRIPE_SECRET_KEY (secret)');
    });
  });

  describe('Function secrets, run under bash with a stand-in for supabase', () => {
    const script = stepScript('billing-setup', 'Function secrets on the preview project');
    const run = (names: string[]) =>
      runStep(
        script,
        {
          SUPABASE_PROJECT_REF: 'previewref0000000000',
          STRIPE_SECRET_KEY: 'sk_test_abc',
          PANEL_URL: 'https://panel.example',
          RUNNER_TEMP: '.',
        },
        (dir) =>
          writeFileSync(
            join(dir, 'billing-functions.env'),
            'STRIPE_WEBHOOK_SECRET=whsec_x\nSTRIPE_PRICE_ID_SITE_US=price_x\n',
          ),
        {
          supabase: [
            'if [ "$1 $2" = "secrets list" ]; then',
            `  printf '%s' '${JSON.stringify(names.map((name) => ({ name })))}'`,
            'else',
            '  echo "$*" > supabase.args',
            'fi',
          ].join('\n'),
        },
      );

    it('sets the three Stripe secrets, and APP_URL only when it is missing', () => {
      const fresh = run(['FIELD_APP_URL']);
      expect(fresh.status, fresh.log).toBe(0);
      expect(readFileSync(join(fresh.dir, 'billing-functions.env'), 'utf8')).toBe(
        'STRIPE_WEBHOOK_SECRET=whsec_x\nSTRIPE_PRICE_ID_SITE_US=price_x\nSTRIPE_SECRET_KEY=sk_test_abc\nAPP_URL=https://panel.example\n',
      );
      expect(readFileSync(join(fresh.dir, 'supabase.args'), 'utf8').trim()).toBe(
        'secrets set --project-ref previewref0000000000 --env-file ./billing-functions.env',
      );
      expect(fresh.envFile.BILLING_FUNCTION_SECRETS).toBe(
        'STRIPE_SECRET_KEY STRIPE_WEBHOOK_SECRET STRIPE_PRICE_ID_SITE_US APP_URL',
      );
      const kept = run(['APP_URL', 'STRIPE_PRICE_ID_SITE']);
      expect(kept.status, kept.log).toBe(0);
      expect(readFileSync(join(kept.dir, 'billing-functions.env'), 'utf8')).not.toContain(
        'APP_URL',
      );
      expect(kept.log).toContain('APP_URL already set: kept.');
      expect(kept.log).toContain('::warning::The old STRIPE_PRICE_ID_SITE');
    });
  });
});

describe('stripe-billing-setup.mjs, run with a stand-in for fetch', () => {
  const SCRIPT = join(ROOT, '.github', 'scripts', 'stripe-billing-setup.mjs');
  const URL_ = 'https://previewref0000000000.supabase.co/functions/v1/stripe-webhook';
  const LOGIC = readFileSync(
    join(ROOT, 'supabase', 'functions', 'stripe-webhook', 'logic.ts'),
    'utf8',
  );
  const HANDLED_BLOCK = /export const HANDLED_EVENTS = \[([\s\S]*?)\]/.exec(LOGIC)?.[1] ?? '';
  const HANDLED = [...HANDLED_BLOCK.matchAll(/'([a-z_.]+)'/g)].map((m) => m[1]);

  interface State {
    products: unknown[];
    prices: unknown[];
    endpoints: { id: string; url: string }[];
    portal: unknown[];
  }
  /** A fake Stripe: answers the calls the script makes and logs each (method, path, form). */
  const FAKE = `
import { appendFileSync, readFileSync } from 'node:fs';
const state = JSON.parse(readFileSync(process.env.FAKE_STATE, 'utf8'));
globalThis.fetch = async (url, init = {}) => {
  const u = new URL(url);
  const method = init.method ?? 'GET';
  const params = method === 'GET' ? u.searchParams.toString() : String(init.body ?? '');
  appendFileSync(process.env.FAKE_LOG, JSON.stringify({ method, path: u.pathname, params, auth: init.headers?.Authorization }) + '\\n');
  const ok = (body) => new Response(JSON.stringify(body), { status: 200 });
  const p = u.pathname;
  if (method === 'GET' && p === '/v1/products') return ok({ data: state.products });
  if (method === 'POST' && p === '/v1/products') return ok({ id: 'prod_new' });
  if (method === 'GET' && p === '/v1/prices') return ok({ data: state.prices });
  if (method === 'POST' && p === '/v1/prices') return ok({ id: 'price_new' });
  if (method === 'GET' && p === '/v1/webhook_endpoints') return ok({ data: state.endpoints });
  if (method === 'POST' && p === '/v1/webhook_endpoints') return ok({ id: 'we_new', secret: 'whsec_new', api_version: new URLSearchParams(params).get('api_version') });
  if (method === 'DELETE' && p.startsWith('/v1/webhook_endpoints/')) return ok({ deleted: true });
  if (method === 'GET' && p === '/v1/billing_portal/configurations') return ok({ data: state.portal });
  return new Response(JSON.stringify({ error: { message: 'unexpected ' + method + ' ' + p } }), { status: 400 });
};
`;

  function setup(state: State, key = 'sk_test_abc') {
    const dir = mkdtempSync(join(tmpdir(), 'stripe-setup-'));
    scratch.push(dir);
    writeFileSync(join(dir, 'fake.mjs'), FAKE);
    writeFileSync(join(dir, 'state.json'), JSON.stringify(state));
    writeFileSync(join(dir, 'log.jsonl'), '');
    const res = spawnSync(process.execPath, ['--import', join(dir, 'fake.mjs'), SCRIPT], {
      encoding: 'utf8',
      env: {
        PATH: process.env.PATH ?? '',
        STRIPE_SECRET_KEY: key,
        WEBHOOK_URL: URL_,
        WEBHOOK_API_VERSION: '2026-09-30.endive',
        OUT_ENV: join(dir, 'out.env'),
        OUT_JSON: join(dir, 'out.json'),
        FAKE_STATE: join(dir, 'state.json'),
        FAKE_LOG: join(dir, 'log.jsonl'),
      },
    });
    const calls = readFileSync(join(dir, 'log.jsonl'), 'utf8')
      .trim()
      .split('\n')
      .filter(Boolean)
      .map((l) => JSON.parse(l) as { method: string; path: string; params: string; auth: string });
    return { res, dir, calls, log: `${res.stdout}${res.stderr}` };
  }

  const fittingPrice = {
    id: 'price_kept',
    product: 'prod_kept',
    unit_amount: 39900,
    currency: 'usd',
    type: 'recurring',
    billing_scheme: 'per_unit',
    recurring: { interval: 'month', interval_count: 1, usage_type: 'licensed' },
  };

  it('creates the product, price and endpoint on an empty account, with exactly the handled events', () => {
    const run = setup({ products: [], prices: [], endpoints: [], portal: [] });
    expect(run.res.status, run.log).toBe(0);
    const posts = run.calls.filter((c) => c.method === 'POST');
    expect(posts.map((c) => c.path)).toEqual([
      '/v1/products',
      '/v1/prices',
      '/v1/webhook_endpoints',
    ]);
    expect(new URLSearchParams(posts[0]!.params).get('metadata[sitelog]')).toBe('site');
    const price = new URLSearchParams(posts[1]!.params);
    expect(Object.fromEntries(price)).toMatchObject({
      product: 'prod_new',
      currency: 'usd',
      unit_amount: '39900',
      'recurring[interval]': 'month',
      'recurring[usage_type]': 'licensed',
      lookup_key: 'sitelog_site_usd_monthly',
      transfer_lookup_key: 'true',
    });
    const endpoint = new URLSearchParams(posts[2]!.params);
    expect(endpoint.get('url')).toBe(URL_);
    expect(endpoint.getAll('enabled_events[]')).toEqual(HANDLED);
    expect(HANDLED).toContain('checkout.session.completed');
    expect(endpoint.get('api_version')).toBe('2026-09-30.endive');
    expect(run.calls.every((c) => c.auth === 'Bearer sk_test_abc')).toBe(true);
    expect(readFileSync(join(run.dir, 'out.env'), 'utf8')).toBe(
      'STRIPE_WEBHOOK_SECRET=whsec_new\nSTRIPE_PRICE_ID_SITE_US=price_new\n',
    );
    expect(statSync(join(run.dir, 'out.env')).mode & 0o777).toBe(0o600);
    expect(run.res.stdout).toContain('::add-mask::whsec_new');
    // The mask comes before any other line that could carry the secret.
    expect(run.res.stdout.indexOf('::add-mask::whsec_new')).toBe(
      run.res.stdout.indexOf('whsec_new') - '::add-mask::'.length,
    );
    const out = JSON.parse(readFileSync(join(run.dir, 'out.json'), 'utf8'));
    expect(out).toMatchObject({
      productId: 'prod_new',
      productCreated: true,
      priceId: 'price_new',
      priceCreated: true,
      endpointId: 'we_new',
      deletedEndpoints: [],
      portalConfigured: false,
    });
    expect(JSON.stringify(out)).not.toContain('whsec');
  });

  it('keeps a fitting product and price, and replaces only the endpoints on this URL', () => {
    const run = setup({
      products: [
        { id: 'prod_other', metadata: {} },
        { id: 'prod_kept', metadata: { sitelog: 'site' } },
      ],
      prices: [fittingPrice],
      endpoints: [
        { id: 'we_old', url: URL_ },
        { id: 'we_elsewhere', url: 'https://example.com/hook' },
      ],
      portal: [{ id: 'bpc_1' }],
    });
    expect(run.res.status, run.log).toBe(0);
    expect(run.calls.filter((c) => c.method === 'POST').map((c) => c.path)).toEqual([
      '/v1/webhook_endpoints',
    ]);
    expect(run.calls.filter((c) => c.method === 'DELETE').map((c) => c.path)).toEqual([
      '/v1/webhook_endpoints/we_old',
    ]);
    // The new endpoint exists before the old one goes.
    const order = run.calls.map((c) => `${c.method} ${c.path}`);
    expect(order.indexOf('POST /v1/webhook_endpoints')).toBeLessThan(
      order.indexOf('DELETE /v1/webhook_endpoints/we_old'),
    );
    expect(readFileSync(join(run.dir, 'out.env'), 'utf8')).toContain(
      'STRIPE_PRICE_ID_SITE_US=price_kept',
    );
    expect(JSON.parse(readFileSync(join(run.dir, 'out.json'), 'utf8'))).toMatchObject({
      productId: 'prod_kept',
      productCreated: false,
      priceId: 'price_kept',
      priceCreated: false,
      deletedEndpoints: ['we_old'],
      portalConfigured: true,
    });
  });

  it('moves the lookup key to a new price when the existing one has another amount', () => {
    const run = setup({
      products: [{ id: 'prod_kept', metadata: { sitelog: 'site' } }],
      prices: [{ ...fittingPrice, unit_amount: 29900 }],
      endpoints: [],
      portal: [],
    });
    expect(run.res.status, run.log).toBe(0);
    const price = run.calls.find((c) => c.method === 'POST' && c.path === '/v1/prices')!;
    expect(new URLSearchParams(price.params).get('transfer_lookup_key')).toBe('true');
    expect(new URLSearchParams(price.params).get('product')).toBe('prod_kept');
  });

  it('refuses a key that is not a test-mode secret key before calling Stripe', () => {
    for (const key of ['sk_live_abc', 'rk_test_abc', '']) {
      const run = setup({ products: [], prices: [], endpoints: [], portal: [] }, key);
      expect(run.res.status, key).toBe(1);
      expect(run.res.stdout).toContain('::error::STRIPE_SECRET_KEY is not a test-mode secret key');
      expect(run.calls).toEqual([]);
    }
  });

  it('--summary writes ids and names only', () => {
    const run = setup({ products: [], prices: [], endpoints: [], portal: [] });
    const summary = join(run.dir, 'summary.md');
    writeFileSync(summary, '');
    const res = spawnSync(process.execPath, [SCRIPT, '--summary', join(run.dir, 'out.json')], {
      encoding: 'utf8',
      env: {
        PATH: process.env.PATH ?? '',
        GITHUB_STEP_SUMMARY: summary,
        SUPABASE_PROJECT_REF: 'previewref0000000000',
        BILLING_FUNCTION_SECRETS: 'STRIPE_SECRET_KEY STRIPE_WEBHOOK_SECRET STRIPE_PRICE_ID_SITE_US',
      },
    });
    expect(res.status, res.stderr).toBe(0);
    const text = readFileSync(summary, 'utf8');
    expect(text).toContain('`prod_new`');
    expect(text).toContain('`price_new`');
    expect(text).toContain('`we_new`');
    expect(text).toContain(URL_);
    expect(text).toContain('Customer portal');
    expect(text).not.toMatch(/whsec_|sk_test_/);
  });
});
