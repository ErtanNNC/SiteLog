import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import {
  CUTOVER_SETTINGS,
  envFileNames,
  envInventory,
  PUBLIC_VITE,
  scanDist,
  scanText,
  secretValues,
  sentinels,
  serviceRoleJwts,
  workflowNames,
} from './preflight.ts';

/** The W1-19 pre-flight's pure checks (scripts/src/preflight.ts; the CLI is cutover-preflight.ts). */

const jwt = (payload: object) =>
  [
    Buffer.from('{"alg":"HS256","typ":"JWT"}').toString('base64url'),
    Buffer.from(JSON.stringify(payload)).toString('base64url'),
    'c2lnbmF0dXJlLXNpZ25hdHVyZQ',
  ].join('.');

const dirs: string[] = [];
afterAll(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});

describe('the repo as it stands', () => {
  const inv = envInventory();

  it('has a consistent environment inventory (no problems)', () => {
    expect(inv.problems).toEqual([]);
  });

  it('finds what the functions, the worker and the bundles read', () => {
    expect([...inv.functions.keys()]).toEqual(
      expect.arrayContaining(['LINK_SIGNING_SECRET', 'FIELD_APP_URL', 'STRIPE_PRICE_ID_SITE_US']),
    );
    expect(inv.worker).toEqual(
      expect.arrayContaining(['SUPABASE_DB_URL', 'DEEPGRAM_API_KEY', 'ANTHROPIC_API_KEY']),
    );
    for (const name of inv.vite.keys()) expect(PUBLIC_VITE.has(name), name).toBe(true);
    expect(inv.workflow.secrets.has('NETLIFY_AUTH_TOKEN')).toBe(true);
  });

  it('puts every cut-over setting where something reads it', () => {
    for (const { name, where } of CUTOVER_SETTINGS) {
      if (where.includes('functions')) expect(inv.functions.has(name), name).toBe(true);
      if (where.includes('worker')) expect(inv.worker, name).toContain(name);
    }
  });
});

describe('envFileNames and workflowNames', () => {
  it('reads assignments with inline comments and ignores comment lines', () => {
    expect(envFileNames('# NOT=1\nA_B=1   # c\nexport C=\n lower=1\nD="x y"\n')).toEqual(
      new Set(['A_B', 'C', 'D']),
    );
  });

  it('splits Environment variables from secrets', () => {
    const { vars, secrets } = workflowNames(
      "x: ${{ vars.SUPABASE_PROJECT_REF }}\ny: ${{ secrets.NETLIFY_AUTH_TOKEN != '' }}",
    );
    expect([...vars]).toEqual(['SUPABASE_PROJECT_REF']);
    expect([...secrets]).toEqual(['NETLIFY_AUTH_TOKEN']);
  });
});

describe('scanText', () => {
  it('flags a service-role JWT and leaves the anon key alone', () => {
    const service = jwt({ iss: 'supabase', ref: 'abc', role: 'service_role' });
    const anon = jwt({ iss: 'supabase', ref: 'abc', role: 'anon' });
    expect(serviceRoleJwts(`a="${anon}";b="${service}"`)).toEqual([service]);
    const findings = scanText('x.js', `const k="${service}"`);
    expect(findings.map((f) => f.kind)).toEqual(['service_role JWT']);
    // The hint never holds the secret.
    expect(findings[0]!.hint).not.toContain(service);
    expect(scanText('x.js', `const k="${anon}"`)).toEqual([]);
  });

  it('flags key shapes but not the bare prefixes libraries contain', () => {
    expect(scanText('x.js', 'e.startsWith(`sb_secret_`)||e.startsWith(`sb_publishable_`)')).toEqual(
      [],
    );
    const kinds = scanText(
      'x.js',
      [
        'sb_secret_abcdefghijklmnopqrstuvwxyz',
        'sk-ant-api03-abcdefghijklmnopqrstuvwxyz',
        'sk_live_abcdefghijklmnop1234',
        'whsec_abcdefghijklmnopqrstuvwx',
        'postgresql://postgres.ref:hunter2hunter2@aws-0.pooler.supabase.com:5432/postgres',
      ].join(' '),
    ).map((f) => f.kind);
    expect(kinds).toEqual([
      'Supabase secret key',
      'Anthropic key',
      'Stripe secret key',
      'Stripe webhook secret',
      'Postgres URL with a password',
    ]);
    // A local URL without a password is no finding.
    expect(scanText('x.js', 'postgresql://127.0.0.1:54322/postgres')).toEqual([]);
  });

  it('flags server-only variable names in code, not in source maps', () => {
    const code = 'console.log(process.env.LINK_SIGNING_SECRET)';
    expect(scanText('a.js', code).map((f) => f.hint)).toEqual(['LINK_SIGNING_SECRET']);
    expect(scanText('a.js.map', code)).toEqual([]);
  });

  it('flags a planted or local secret value by name, wherever it is', () => {
    const secrets = [{ name: 'DEEPGRAM_API_KEY', value: 'dg-0123456789abcdef' }];
    expect(scanText('a.js.map', '"dg-0123456789abcdef"', secrets)).toEqual([
      { file: 'a.js.map', kind: 'secret value', hint: 'the value of DEEPGRAM_API_KEY' },
    ]);
  });
});

describe('scanDist', () => {
  it('walks a dist folder, including _redirects and nested assets', () => {
    const dir = mkdtempSync(join(tmpdir(), 'preflight-'));
    dirs.push(dir);
    mkdirSync(join(dir, 'assets'));
    writeFileSync(join(dir, 'index.html'), '<script src="/assets/a.js"></script>');
    writeFileSync(join(dir, 'assets', 'a.js'), 'const x = "PREFLIGHT_SENTINEL_t_RESEND_API_KEY";');
    writeFileSync(
      join(dir, '_redirects'),
      '/api/*  https://ref.supabase.co/functions/v1/field-api/:splat  200',
    );
    writeFileSync(join(dir, 'assets', 'logo.png'), 'PREFLIGHT_SENTINEL_t_RESEND_API_KEY');
    const planted = sentinels(['RESEND_API_KEY', 'APP_URL', 'VITE_DEMO'], 't');
    expect(planted).toEqual({ RESEND_API_KEY: 'PREFLIGHT_SENTINEL_t_RESEND_API_KEY' });
    const findings = scanDist(
      dir,
      Object.entries(planted).map(([name, value]) => ({ name, value })),
    );
    // The PNG is not scanned; the script is. The public URL in _redirects is no finding.
    expect(findings.map((f) => [f.file.endsWith('a.js'), f.kind, f.hint])).toEqual([
      [true, 'secret value', 'the value of RESEND_API_KEY'],
    ]);
  });
});

describe('secretValues', () => {
  it('keeps secret-looking values only', () => {
    expect(
      secretValues({
        VITE_SUPABASE_ANON_KEY: 'eyJpublicpublicpublic',
        SUPABASE_URL: 'https://abc.supabase.co',
        APP_URL: 'https://staging-sitelog.netlify.app',
        LINK_SIGNING_SECRET: 'abcdef0123456789abcdef',
        SUPABASE_DB_URL: 'postgresql://postgres:secretpassword@db.example:5432/postgres',
        SHORT: 'short',
        CLAUDE_MODEL: 'claude-model-name-long',
      }).map((s) => s.name),
    ).toEqual(['LINK_SIGNING_SECRET', 'SUPABASE_DB_URL']);
  });
});
