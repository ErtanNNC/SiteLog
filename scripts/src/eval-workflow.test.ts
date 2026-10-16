import { spawnSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';

/**
 * Checks of .github/workflows/eval.yml (the model comparison on the golden sets): dispatch only,
 * from spec-v1.2 only, in the preview Environment, read-only, with ANTHROPIC_API_KEY as its one
 * secret, handed to the eval step only and never printed, and nothing that reaches a database.
 * The static checks read the YAML; the two shell steps also run under bash with a stand-in for pnpm.
 */

const ROOT = join(import.meta.dirname, '..', '..');
const WORKFLOW = readFileSync(join(ROOT, '.github', 'workflows', 'eval.yml'), 'utf8');

/** The YAML without comment lines (what GitHub reads). */
const CODE = WORKFLOW.split('\n')
  .filter((l) => !/^\s*#/.test(l))
  .join('\n');

/** A top-level block: from `<key>:` to the next top-level key. */
function topLevel(key: string): string {
  const m = new RegExp(`^${key}:.*\\n((?:(?: .*)?\\n)*)`, 'm').exec(CODE);
  if (!m) throw new Error(`eval.yml has no top-level ${key}`);
  return m[0];
}

/** Steps of the one job, by name. */
function steps(): { name: string; text: string }[] {
  const body = CODE.slice(CODE.indexOf('\n    steps:\n') + '\n    steps:\n'.length);
  return body
    .split(/^(?= {6}- )/m)
    .filter((p) => p.startsWith('      - '))
    .map((p) => ({
      name:
        /^ {6}- name: (.+)$/m.exec(p)?.[1] ??
        /^ {6}[- ] {1,3}(?:uses|run): (.+)$/m.exec(p)?.[1] ??
        p.split('\n')[0]!.trim(),
      text: p,
    }));
}

/** The `run: |` script of a step, dedented, as the runner gets it. */
function stepScript(name: string): string {
  const step = steps().find((s) => s.name === name);
  if (!step) throw new Error(`eval.yml has no step "${name}"`);
  const lines = step.text.split('\n');
  const i = lines.findIndex((l) => /^ {8}run: \|$/.test(l));
  if (i < 0) throw new Error(`step "${name}" has no run block`);
  const body: string[] = [];
  for (const line of lines.slice(i + 1)) {
    if (line.trim() !== '' && !/^ {10}/.test(line)) break;
    body.push(line.slice(10));
  }
  const script = body.join('\n').trimEnd();
  expect(script, `step "${name}" reads environment variables only`).not.toContain('${{');
  return script;
}

const scratch: string[] = [];
afterAll(() => {
  for (const dir of scratch.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function keyValues(file: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of readFileSync(file, 'utf8').split('\n')) {
    const eq = line.indexOf('=');
    if (eq > 0) out[line.slice(0, eq)] = line.slice(eq + 1);
  }
  return out;
}

/** Runs a step as GitHub runs `run:` on Linux, with only the given env and stand-ins on PATH. */
function runStep(script: string, env: Record<string, string>, bin: Record<string, string> = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'eval-step-'));
  scratch.push(dir);
  const binDir = join(dir, '.bin');
  mkdirSync(binDir);
  for (const [name, body] of Object.entries(bin)) {
    writeFileSync(join(binDir, name), `#!/usr/bin/env bash\n${body}\n`);
    chmodSync(join(binDir, name), 0o755);
  }
  const envFile = join(dir, '.github-env');
  const summary = join(dir, '.github-summary');
  const temp = join(dir, 'runner-temp');
  mkdirSync(temp);
  writeFileSync(envFile, '');
  writeFileSync(summary, '');
  const res = spawnSync('bash', ['--noprofile', '--norc', '-eo', 'pipefail', '-c', script], {
    cwd: dir,
    encoding: 'utf8',
    env: {
      PATH: `${binDir}:${process.env.PATH ?? ''}`,
      GITHUB_ENV: envFile,
      GITHUB_STEP_SUMMARY: summary,
      RUNNER_TEMP: temp,
      ...env,
    },
  });
  return {
    status: res.status,
    log: `${res.stdout}${res.stderr}`,
    envFile: keyValues(envFile),
    summary: readFileSync(summary, 'utf8'),
    temp,
  };
}

describe('eval.yml', () => {
  it('runs on workflow_dispatch, or called by Deploy (target eval), with the models and sets inputs', () => {
    const on = topLevel('on');
    expect(on.split('\n').filter((l) => /^ {2}\S/.test(l))).toEqual([
      '  workflow_dispatch:',
      '  workflow_call:',
    ]);
    expect(CODE).not.toMatch(
      /^\s*(push|pull_request|pull_request_target|schedule|workflow_run|repository_dispatch):/m,
    );
    // Both triggers take the same inputs, and a call passes no secrets (the job reads the preview
    // Environment's key itself).
    const [dispatch, call] = on.replace(/^on:\n/, '').split(/^ {2}workflow_call:$/m);
    expect(call.replace(/^ {2}#.*\n/gm, '').trim()).toBe(
      dispatch
        .replace(/^ {2}workflow_dispatch:$/m, '')
        .replace(/^ {2}#.*\n/gm, '')
        .trim(),
    );
    expect(on).not.toMatch(/^ {4}secrets:/m);
    expect(on).toContain('default: claude-sonnet-5-5,claude-haiku-5-5,claude-opus-5-5');
    expect(on).toMatch(/ {6}sets:\n(?: {8}.*\n)*? {8}default: all\n/);
  });

  it('has one job, in the preview Environment, guarded to spec-v1.2 on the full ref', () => {
    const jobs = topLevel('jobs');
    expect(jobs.split('\n').filter((l) => /^ {2}\S/.test(l))).toEqual(['  eval:']);
    expect(jobs).toMatch(/^ {4}environment: preview$/m);
    expect(jobs).toMatch(/^ {4}if: github\.ref == 'refs\/heads\/spec-v1\.2'$/m);
    expect(CODE.match(/environment:/g)).toHaveLength(1);
  });

  it('is read-only: contents: read and nothing else, at the top and nowhere else', () => {
    expect(topLevel('permissions').trim()).toBe('permissions:\n  contents: read');
    expect(CODE.match(/permissions:/g)).toHaveLength(1);
    expect(CODE).not.toMatch(/:\s*write\b/);
    expect(CODE).not.toMatch(/write-all/);
    const checkout = steps().find((s) => s.name === 'actions/checkout@v4')!;
    expect(checkout.text).toContain('persist-credentials: false');
  });

  it('uses ANTHROPIC_API_KEY as its one secret, in the eval step only, never printed', () => {
    const secrets = [...CODE.matchAll(/secrets\.([A-Za-z_]+)/g)].map((m) => m[1]);
    expect(secrets).toEqual(['ANTHROPIC_API_KEY']);
    expect(CODE).not.toMatch(/\bvars\./);
    expect(CODE).not.toContain('GITHUB_TOKEN');
    expect(CODE).not.toMatch(/secrets\s*:\s*inherit/);
    const withKey = steps().filter((s) => s.text.includes('ANTHROPIC_API_KEY'));
    expect(withKey.map((s) => s.name)).toEqual(['Run the golden sets']);
    expect(topLevel('jobs')).not.toMatch(/^ {4}env:/m);
    expect(CODE).not.toMatch(/^env:/m);
    const run = stepScript('Run the golden sets');
    expect(run).not.toMatch(/(echo|printf|cat)[^\n]*\$\{?ANTHROPIC_API_KEY/);
    expect(run).not.toMatch(/ANTHROPIC_API_KEY[^\n]*GITHUB_(ENV|OUTPUT|STEP_SUMMARY)/);
    expect(run).not.toMatch(/set -x|env\b\s*$|printenv/m);
  });

  it('never reaches a database or another provider', () => {
    for (const re of [
      /SUPABASE/i,
      /DB_URL|DATABASE_URL|PGPASSWORD|postgres:\/\//i,
      /\bpsql\b|seed:demo|countries:set|db (push|reset)|--apply/,
      /DEEPGRAM|TWILIO|RESEND|VAPID|NETLIFY|FLY_/,
    ])
      expect(CODE).not.toMatch(re);
  });

  it('uploads the JSON results, even when a set failed', () => {
    const upload = steps().find((s) => s.name === 'Upload the results')!;
    expect(upload.text).toContain('uses: actions/upload-artifact@v4');
    expect(upload.text).toContain('if: always()');
    expect(upload.text).toContain('name: eval-results');
  });
});

describe('eval.yml Check inputs, run under bash', () => {
  const check = stepScript('Check inputs');

  it('trims, de-duplicates and passes the models and sets on', () => {
    const r = runStep(check, {
      MODELS_INPUT: ' claude-sonnet-5-5, claude-haiku-5-5 ,claude-sonnet-5-5,,',
      SETS_INPUT: 'Answers, utterances,answers',
    });
    expect(r.status, r.log).toBe(0);
    expect(r.envFile).toEqual({
      EVAL_MODELS: 'claude-sonnet-5-5,claude-haiku-5-5',
      EVAL_SETS: 'answers,utterances',
    });
  });

  it('all (or nothing) is every set', () => {
    for (const SETS of ['all', '', 'extraction,all']) {
      const r = runStep(check, { MODELS_INPUT: 'm', SETS_INPUT: SETS });
      expect(r.status, r.log).toBe(0);
      expect(r.envFile.EVAL_SETS).toBe('extraction,answers,corrections,utterances');
    }
  });

  it('refuses ids that are not ids, unknown sets and no models', () => {
    for (const MODELS of ['claude"; rm -rf /', '$(id)', 'a/b', 'a;b', ' , ']) {
      const r = runStep(check, { MODELS_INPUT: MODELS, SETS_INPUT: 'all' });
      expect(r.status, MODELS).toBe(1);
      expect(r.envFile).toEqual({});
    }
    const r = runStep(check, { MODELS_INPUT: 'm', SETS_INPUT: 'extraction,nope' });
    expect(r.status).toBe(1);
    expect(r.log).toContain('unknown golden set: nope');
  });
});

describe('eval.yml Run the golden sets, run under bash with a stand-in for pnpm', () => {
  const script = stepScript('Run the golden sets');
  const KEY = 'sk-ant-test-0123456789-SECRET';
  /**
   * pnpm stand-in: `eval -- --set S --json F` records the models it got and writes F (except for
   * the set named in FAIL_SET, which ends without one); `--summarize` prints the files it got.
   */
  const pnpm = `
args="$*"
if [[ "$args" == *--summarize* ]]; then echo "TABLE $args"; exit 0; fi
set=""; file=""
while [ $# -gt 0 ]; do
  case "$1" in --set) set="$2"; shift ;; --json) file="$2"; shift ;; esac
  shift
done
echo "ran $set with CLAUDE_MODEL=$CLAUDE_MODEL CLAUDE_MODEL_FAST=$CLAUDE_MODEL_FAST" >> "$RUNNER_TEMP/calls"
if [ "$set" = "$FAIL_SET" ]; then echo "broken fixtures"; exit 1; fi
echo '{"set":"'"$set"'"}' > "$file"
[ "$set" = answers ] && exit 1
exit 0`;

  it('runs every model × set with the model as both env names and writes one table', () => {
    const r = runStep(
      script,
      {
        ANTHROPIC_API_KEY: KEY,
        EVAL_MODELS: 'model-a,org/model:b',
        EVAL_SETS: 'extraction,answers',
      },
      { pnpm },
    );
    expect(r.status, r.log).toBe(0);
    expect(readFileSync(join(r.temp, 'calls'), 'utf8').trim().split('\n')).toEqual([
      'ran extraction with CLAUDE_MODEL=model-a CLAUDE_MODEL_FAST=model-a',
      'ran answers with CLAUDE_MODEL=model-a CLAUDE_MODEL_FAST=model-a',
      'ran extraction with CLAUDE_MODEL=org/model:b CLAUDE_MODEL_FAST=org/model:b',
      'ran answers with CLAUDE_MODEL=org/model:b CLAUDE_MODEL_FAST=org/model:b',
    ]);
    // Failed cases are a notice, not a failed run; the files are named safely for the artifact.
    expect(r.log).toContain('::notice::model-a · answers: some cases failed');
    expect(r.summary).toContain('## Eval: models × golden sets');
    expect(r.summary).toMatch(
      /TABLE .*--summarize .*model-a\.extraction\.json .*org_model_b\.answers\.json/,
    );
    expect(r.log + r.summary).not.toContain(KEY);
  });

  it('fails when a set ends without its summary, and still writes the table of the others', () => {
    const r = runStep(
      script,
      {
        ANTHROPIC_API_KEY: KEY,
        EVAL_MODELS: 'model-a',
        EVAL_SETS: 'extraction,corrections',
        FAIL_SET: 'corrections',
      },
      { pnpm },
    );
    expect(r.status).toBe(1);
    expect(r.log).toContain('::error::model-a · corrections ended without a summary');
    expect(r.summary).toContain('model-a.extraction.json');
    expect(r.summary).not.toContain('corrections.json');
  });

  it('stops before any call without the key', () => {
    const r = runStep(script, { EVAL_MODELS: 'model-a', EVAL_SETS: 'extraction' }, { pnpm });
    expect(r.status).toBe(1);
    expect(r.log).toContain('no ANTHROPIC_API_KEY secret');
    expect(r.summary).toBe('');
  });
});
