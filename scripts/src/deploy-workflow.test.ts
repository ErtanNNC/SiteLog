import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * Static checks of .github/workflows/deploy.yml (W1-01, D40/D41): every job that changes staging or
 * production carries the live-branch guard in its own `if:` (on the full branch ref, so a tag with
 * the same name does not pass), no other Environment deploys to or builds against the staging
 * project, pull requests take nothing from `staging` but the Netlify token and site, and the
 * inventory job only reads. actionlint checks the syntax in CI review; this keeps the safety rules
 * from regressing when a job is added (e.g. the field site in W1-04).
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

const JOBS = jobs(WORKFLOW);
const MUTATING = [/db push/, /functions deploy/, /flyctl deploy/, /--prod\b/, /secrets set/];

describe('deploy.yml', () => {
  it('names the live staging branch once, and repeats it literally in the guards', () => {
    expect(WORKFLOW).toContain(`LIVE_BRANCH: ${LIVE_BRANCH}`);
    expect(WORKFLOW).toContain('PREVIEW_BRANCH: spec-v1.2');
    expect(WORKFLOW).toContain(`STAGING_PROJECT_REF: ${STAGING_PROJECT_REF}`);
    expect([...JOBS.keys()]).toEqual(['plan', 'supabase', 'worker', 'preview', 'web', 'inventory']);
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
    const changing = [...JOBS].filter(([, j]) => MUTATING.some((re) => re.test(commands(j.text))));
    expect(changing.map(([id]) => id).sort()).toEqual(['supabase', 'web', 'worker']);
    for (const [id, job] of changing) {
      expect(job.condition, id).toContain(GUARD);
      expect(job.condition, id).toMatch(/needs\.plan\.outputs\.\w+ == 'true'/);
    }
    // The worker never deploys for preview; the panel's --prod path neither.
    expect(JOBS.get('worker')!.condition).toContain("inputs.environment != 'preview'");
    expect(JOBS.get('web')!.condition).toContain(
      `(github.ref == 'refs/heads/${LIVE_BRANCH}' && inputs.environment != 'preview')`,
    );
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
    // A preview URL on the staging project builds in demo mode, even before staging's vars exist.
    expect(web).toContain('[[ "$url" == *"$STAGING_PROJECT_REF"* ]]');
    // The PR path keeps the panel site's `staging` key and deploys an alias, never --prod.
    expect(web).toContain('flags=(--alias "pr-$PR_NUMBER")');
    const preview = JOBS.get('preview')!;
    expect(preview.text).toContain('environment: preview');
    expect(preview.text).not.toContain(STAGING_PROJECT_REF);
    expect(preview.condition).toContain("github.event_name == 'pull_request'");
    expect(preview.text).not.toMatch(/secrets\./);
  });

  it('takes nothing from staging for a pull request but the Netlify token and site (D41)', () => {
    // Variables that only feed a comparison in the PR path and are not VITE_* (never in the bundle).
    const compareOnly = new Set(['LIVE_PROJECT_REF', 'LIVE_PROJECT_URL']);
    const web = JOBS.get('web')!.text;
    const uses = web.split('\n').filter((l) => /\bvars\./.test(l) && !/^\s*#/.test(l));
    expect(uses.length).toBeGreaterThan(0);
    for (const line of uses) {
      const name = /^\s*([A-Z][A-Z0-9_]*):/.exec(line)?.[1] ?? line.trim();
      if (name === 'NETLIFY_SITE_ID') {
        expect(line.trim()).toBe('NETLIFY_SITE_ID: ${{ vars.NETLIFY_SITE_ID }}');
      } else if (compareOnly.has(name)) {
        expect(name).not.toMatch(/^VITE_/);
      } else {
        // Blanked (or replaced by a non-staging value) on pull requests.
        expect(line, name).toMatch(
          /: \$\{\{ github\.event_name != 'pull_request' && vars\.\w+ \|\| ('[^']*'|steps\.[\w.]+) \}\}$/,
        );
      }
    }
    for (const name of ['VITE_WA_DISPLAY_NUMBER', 'VITE_SENTRY_DSN']) {
      expect(web, name).toContain(
        `${name}: \${{ github.event_name != 'pull_request' && vars.${name} || '' }}`,
      );
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
