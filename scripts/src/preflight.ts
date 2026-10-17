/**
 * The local checks behind `pnpm cutover:preflight` (W1-19, docs/RUNBOOK.md §2 "Cut-over (W1-19),
 * step by step"): an inventory of the environment variables (what the edge functions, the worker
 * and the browser bundles read, against `.env.example` and `.github/workflows/deploy.yml`) and a
 * scan of the built browser bundles for anything secret. Pure functions over the repo's files, so
 * `preflight.test.ts` runs them in `pnpm check`; the CLI is `cutover-preflight.ts`.
 */
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

export const ROOT = join(import.meta.dirname, '..', '..');

/** Injected into every edge function by the Supabase platform (never `supabase secrets set`). */
export const PLATFORM_FUNCTION_ENV = new Set([
  'SUPABASE_URL',
  'SUPABASE_ANON_KEY',
  'SUPABASE_SERVICE_ROLE_KEY',
]);

/**
 * Read by code but deliberately not in `.env.example`, each with its reason. Anything else a
 * function or the worker reads must be listed there.
 */
export const NOT_IN_ENV_EXAMPLE: Record<string, string> = {
  STRIPE_PRICE_ID_SITE:
    'legacy price id, read by api-billing only while STRIPE_PRICE_ID_SITE_US is unset (GAP 9.1)',
  NODE_ENV:
    'set by the runtime (Fly: production; pnpm dev:worker: development, production for the cut-over worker via apps/worker/.env, RUNBOOK §2 step 7)',
  WA_GRAPH_BASE: 'v1.0 test hook for the Meta Graph API base URL (step 22)',
  WORKER_ID: 'defaults to the host name / Fly machine id',
  JOB_TIMEOUT_MS: 'tuning, default 5 min (RUNBOOK §3)',
  SWEEP_INTERVAL_MS: 'tuning, default 60 s',
  FFMPEG_PATH: 'defaults to ffmpeg-static',
  WORKER_DRY_RUN: 'tests only',
  SCHEDULER_CLOCK_OVERRIDE:
    "tests only: scheduler-tick takes `?now=` (CI's e2e-supabase functions env, the W2-06 ladder spec); never set on a hosted project",
  WORKER_CLOCK_OVERRIDE:
    "tests only: the worker's clock starts at WORKER_CLOCK_START and runs on in real time (CI's e2e-supabase worker, the W2-06 ladder spec); refused in production, never set on a hosted project",
  WORKER_CLOCK_START: 'tests only: the start of the WORKER_CLOCK_OVERRIDE clock (an ISO instant)',
  SMS_PROVIDER_STUB:
    "tests only (W4-12): the SMS drivers send to the local SMS stand-in (`pnpm sms:stand-in`; CI's e2e-supabase worker and functions env); refused in production by the worker, never set on a hosted project",
  TWILIO_API_BASE: 'tests only: the SMS stand-in for Twilio, read only with SMS_PROVIDER_STUB=true',
  ILETIMERKEZI_API_BASE:
    'tests only: the SMS stand-in for İletimerkezi, read only with SMS_PROVIDER_STUB=true',
};

/**
 * The only `VITE_*` names a browser bundle may read (CLAUDE.md: the Supabase URL and anon key,
 * the field-api path, feature flags and public URLs).
 */
export const PUBLIC_VITE = new Set([
  'VITE_SUPABASE_URL',
  'VITE_SUPABASE_ANON_KEY',
  'VITE_FIELD_API_URL',
  'VITE_APP_URL',
  'VITE_DEMO',
  'VITE_SENTRY_DSN',
  'VITE_DEMO_PHONE_ALL_ORGS',
  'VITE_WA_DISPLAY_NUMBER',
  'VITE_ROUTER',
]);

/**
 * Server-side names whose values are public (URLs, model names, regions, flags): neither a
 * sentinel in the bundle build nor a secret value to look for in the bundles.
 */
export const PUBLIC_SERVER_ENV = new Set([
  'SUPABASE_URL',
  'SUPABASE_ANON_KEY',
  'STORAGE_PUBLIC_URL',
  'APP_URL',
  'CORS_EXTRA_ORIGINS',
  'FIELD_APP_URL',
  'FIELD_API_URL',
  'LINK_SHORT_DOMAIN',
  'DAILY_LINK_TTL_HOURS',
  'SMS_WEBHOOK_URL',
  'WA_DISPLAY_NUMBER',
  'WA_GRAPH_VERSION',
  'CLAUDE_MODEL',
  'CLAUDE_MODEL_FAST',
  'TRANSCRIBE_PROVIDER',
  'TRANSCRIBE_MODEL',
  'WEATHER_API_BASE',
  'EMAIL_PROVIDER',
  'EMAIL_FROM',
  'LIVEKIT_URL',
  'LIVEKIT_AGENT_NAME',
  'VOICE_MAX_CONCURRENT_CALLS',
  'VOICE_RING_TIMEOUT_S',
  'CONSOLE_CALL_RING_S',
  'STT_MODEL',
  'TTS_VOICE_EN',
  'TTS_VOICE_ES',
  'TTS_VOICE_TR',
  'AZURE_SPEECH_REGION',
  'VAPID_PUBLIC_KEY',
  'VAPID_SUBJECT',
  'STRIPE_PRICE_ID_SITE_US',
  'TR_BILLING_PROVIDER',
  'WORKER_CONCURRENCY',
  'WORKER_PORT',
  'POLL_INTERVAL_MS',
  'AUDIO_RETENTION_DAYS',
  'SENTRY_DSN',
  'LOG_LEVEL',
  'COST_WA_TEMPLATE_USD',
  'COST_SMS_USD',
  'COST_WHATSAPP_TEMPLATE_USD',
]);

/**
 * What the cut-over sets (PLAN W1-19 "Secrets and settings"), and where each one goes: the edge
 * functions' secrets on the staging project, or the worker's `.env` on the developer machine.
 */
export const CUTOVER_SETTINGS: ReadonlyArray<{
  name: string;
  where: 'functions' | 'worker' | 'functions+worker';
}> = [
  { name: 'LINK_SIGNING_SECRET', where: 'functions+worker' },
  { name: 'FIELD_APP_URL', where: 'functions+worker' },
  { name: 'APP_URL', where: 'functions+worker' },
  { name: 'CORS_EXTRA_ORIGINS', where: 'functions' },
  { name: 'STRIPE_PRICE_ID_SITE_US', where: 'functions' },
  { name: 'DEEPGRAM_API_KEY', where: 'worker' },
  { name: 'ANTHROPIC_API_KEY', where: 'worker' },
];

/** Names assigned in a dotenv-style file (`NAME=value  # comment`). */
export function envFileNames(text: string): Set<string> {
  const names = new Set<string>();
  for (const line of text.split('\n')) {
    const m = /^\s*(?:export\s+)?([A-Z][A-Z0-9_]*)=/.exec(line);
    if (m) names.add(m[1]!);
  }
  return names;
}

function walk(dir: string, keep: (file: string) => boolean): string[] {
  if (!existsSync(dir)) return [];
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    if (entry === 'node_modules' || entry === 'dist' || entry.startsWith('.')) continue;
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) out.push(...walk(path, keep));
    else if (keep(path)) out.push(path);
  }
  return out;
}

const isTest = (f: string) => /(_test|\.test|\.spec)\.tsx?$/.test(f) || f.includes('/e2e/');

/**
 * Names the edge functions read: through `_shared/env.ts` (requireEnv, optionalEnv, envOr),
 * `Deno.env.get`, or an injected `env('NAME')` reader (api-billing's `sitePriceId`).
 */
export function functionEnvNames(root = ROOT): Map<string, string[]> {
  const out = new Map<string, string[]>();
  const files = walk(join(root, 'supabase', 'functions'), (f) => f.endsWith('.ts') && !isTest(f));
  for (const file of files) {
    const text = readFileSync(file, 'utf8');
    for (const m of text.matchAll(
      /\b(?:requireEnv|optionalEnv|envOr|Deno\.env\.get|env)\(\s*['"]([A-Z][A-Z0-9_]*)['"]/g,
    )) {
      const list = out.get(m[1]!) ?? [];
      list.push(relative(root, file));
      out.set(m[1]!, list);
    }
  }
  return out;
}

/** The keys of the worker's ConfigSchema (apps/worker/src/config.ts), which reads process.env. */
export function workerEnvNames(root = ROOT): string[] {
  const text = readFileSync(join(root, 'apps', 'worker', 'src', 'config.ts'), 'utf8');
  const body = text.slice(text.indexOf('export const ConfigSchema = z.object({'));
  const end = body.indexOf('\n});');
  return [...body.slice(0, end).matchAll(/^ {2}([A-Z][A-Z0-9_]*):/gm)].map((m) => m[1]!);
}

/** Every `VITE_*` name in the panel's and the field app's source (tests excluded). */
export function viteNames(root = ROOT): Map<string, string[]> {
  const out = new Map<string, string[]>();
  for (const app of ['web', 'field']) {
    const files = walk(join(root, 'apps', app, 'src'), (f) => /\.(ts|tsx)$/.test(f) && !isTest(f));
    for (const file of files) {
      for (const m of readFileSync(file, 'utf8').matchAll(/\bVITE_[A-Z0-9_]+\b/g)) {
        const list = out.get(m[0]) ?? [];
        if (!list.includes(app)) list.push(app);
        out.set(m[0], list);
      }
    }
  }
  return out;
}

/** GitHub Environment variables and secrets the Deploy workflow reads. */
export function workflowNames(yaml: string): { vars: Set<string>; secrets: Set<string> } {
  const vars = new Set<string>();
  const secrets = new Set<string>();
  for (const m of yaml.matchAll(/\b(vars|secrets)\.([A-Z][A-Z0-9_]*)/g)) {
    (m[1] === 'vars' ? vars : secrets).add(m[2]!);
  }
  return { vars, secrets };
}

export interface EnvInventory {
  envExample: Set<string>;
  functions: Map<string, string[]>;
  worker: string[];
  vite: Map<string, string[]>;
  workflow: { vars: Set<string>; secrets: Set<string> };
  problems: string[];
}

/** The inventory and what is wrong with it (an empty `problems` is a pass). */
export function envInventory(root = ROOT): EnvInventory {
  const envExample = envFileNames(readFileSync(join(root, '.env.example'), 'utf8'));
  const functions = functionEnvNames(root);
  const worker = workerEnvNames(root);
  const vite = viteNames(root);
  const workflow = workflowNames(
    readFileSync(join(root, '.github', 'workflows', 'deploy.yml'), 'utf8'),
  );
  const problems: string[] = [];
  for (const [name, files] of functions) {
    if (PLATFORM_FUNCTION_ENV.has(name) || envExample.has(name) || name in NOT_IN_ENV_EXAMPLE)
      continue;
    problems.push(`${name}: read by ${files.join(', ')} but missing from .env.example`);
  }
  for (const name of worker) {
    if (envExample.has(name) || name in NOT_IN_ENV_EXAMPLE) continue;
    problems.push(
      `${name}: read by the worker (apps/worker/src/config.ts) but missing from .env.example`,
    );
  }
  for (const [name, apps] of vite) {
    if (!PUBLIC_VITE.has(name))
      problems.push(`${name}: read by apps/${apps.join(', apps/')} but not a public VITE_* name`);
  }
  for (const name of [...workflow.vars, ...workflow.secrets]) {
    if (name.startsWith('VITE_') && !PUBLIC_VITE.has(name))
      problems.push(`${name}: deploy.yml passes it to a browser build but it is not a public name`);
  }
  for (const name of workflow.secrets) {
    if (name.startsWith('VITE_'))
      problems.push(
        `${name}: a VITE_* value is public by design; make it a variable, not a secret`,
      );
  }
  for (const { name, where } of CUTOVER_SETTINGS) {
    if (!envExample.has(name))
      problems.push(`${name}: a cut-over setting missing from .env.example`);
    const readByFunctions = functions.has(name);
    const readByWorker = worker.includes(name);
    if (where.includes('functions') && !readByFunctions)
      problems.push(
        `${name}: the cut-over sets it on the functions, but no edge function reads it`,
      );
    if (where.includes('worker') && !readByWorker)
      problems.push(
        `${name}: the cut-over sets it for the worker, but the worker does not read it`,
      );
  }
  return { envExample, functions, worker, vite, workflow, problems };
}

// ── Bundle scan ───────────────────────────────────────────────────────────────────────────────

export interface Finding {
  file: string;
  kind: string;
  /** Redacted: never the secret itself. */
  hint: string;
}

/** Server-only variable names that have no business in a browser bundle. */
export const SERVER_ONLY_NAMES = [
  'SUPABASE_SERVICE_ROLE_KEY',
  'SUPABASE_DB_URL',
  'SUPABASE_DB_PASSWORD',
  'LINK_SIGNING_SECRET',
  'SCHEDULER_SECRET',
  'ANTHROPIC_API_KEY',
  'DEEPGRAM_API_KEY',
  'OPENAI_API_KEY',
  'RESEND_API_KEY',
  'TWILIO_AUTH_TOKEN',
  'ILETIMERKEZI_API_KEY',
  'ILETIMERKEZI_API_HASH',
  'STRIPE_SECRET_KEY',
  'STRIPE_WEBHOOK_SECRET',
  'LIVEKIT_API_SECRET',
  'VOICE_AGENT_TOOL_SECRET',
  'AZURE_SPEECH_KEY',
  'VAPID_PRIVATE_KEY',
  'WA_ACCESS_TOKEN',
  'WA_APP_SECRET',
  'DEMO_OFFICE_PASSWORD',
];

/** Key shapes (a value, not a bare prefix: supabase-js itself contains the string `sb_secret_`). */
const KEY_PATTERNS: Array<[string, RegExp]> = [
  ['Supabase secret key', /\bsb_secret_[A-Za-z0-9_-]{20,}/g],
  ['Anthropic key', /\bsk-ant-[A-Za-z0-9_-]{20,}/g],
  ['OpenAI key', /\bsk-(?:proj-)?[A-Za-z0-9]{32,}/g],
  ['Stripe secret key', /\b(?:sk|rk)_(?:live|test)_[A-Za-z0-9]{16,}/g],
  ['Stripe webhook secret', /\bwhsec_[A-Za-z0-9+/=]{20,}/g],
  ['Postgres URL with a password', /\bpostgres(?:ql)?:\/\/[^\s"'`/:@]+:[^\s"'`@]+@[^\s"'`]+/g],
];

const JWT = /\beyJ[A-Za-z0-9_-]{8,}\.(eyJ[A-Za-z0-9_-]{8,})\.[A-Za-z0-9_-]{8,}/g;

function redact(value: string): string {
  return `${value.slice(0, 6)}… (${value.length} chars)`;
}

/** The JWTs in `text` whose payload says `role: service_role`. */
export function serviceRoleJwts(text: string): string[] {
  const out: string[] = [];
  for (const m of text.matchAll(JWT)) {
    try {
      const payload = JSON.parse(Buffer.from(m[1]!, 'base64url').toString('utf8')) as {
        role?: unknown;
      };
      if (payload.role === 'service_role') out.push(m[0]);
    } catch {
      // Not a JWT after all.
    }
  }
  return out;
}

/**
 * What in one built file must not be there. `secrets` are values that must never appear (the
 * build's sentinels, the local `.env` files' secret values), by name.
 */
export function scanText(
  file: string,
  text: string,
  secrets: ReadonlyArray<{ name: string; value: string }> = [],
): Finding[] {
  const findings: Finding[] = [];
  for (const jwt of serviceRoleJwts(text))
    findings.push({ file, kind: 'service_role JWT', hint: redact(jwt) });
  for (const [kind, re] of KEY_PATTERNS) {
    for (const m of text.matchAll(re)) findings.push({ file, kind, hint: redact(m[0]) });
  }
  // Source maps carry the sources, whose comments may name a variable: names only in code.
  if (!file.endsWith('.map')) {
    for (const name of SERVER_ONLY_NAMES) {
      if (new RegExp(`\\b${name}\\b`).test(text))
        findings.push({ file, kind: 'server-only variable name', hint: name });
    }
  }
  for (const { name, value } of secrets) {
    if (value && text.includes(value))
      findings.push({ file, kind: 'secret value', hint: `the value of ${name}` });
  }
  return findings;
}

const SCANNED = /\.(js|mjs|cjs|html|css|json|webmanifest|txt|map|svg)$|(^|\/)_redirects$/;

/** Every finding in a built `dist` folder. */
export function scanDist(
  dir: string,
  secrets: ReadonlyArray<{ name: string; value: string }> = [],
): Finding[] {
  const out: Finding[] = [];
  const files: string[] = [];
  const visit = (d: string) => {
    for (const entry of readdirSync(d)) {
      const path = join(d, entry);
      if (statSync(path).isDirectory()) visit(path);
      else if (SCANNED.test(path)) files.push(path);
    }
  };
  visit(dir);
  for (const file of files)
    out.push(...scanText(relative(ROOT, file), readFileSync(file, 'utf8'), secrets));
  return out;
}

/**
 * The secret values of local env files (name → value): every non-`VITE_*` value of 12+
 * characters that is not public (PUBLIC_SERVER_ENV) and not a URL.
 */
export function secretValues(env: Record<string, string>): Array<{ name: string; value: string }> {
  return Object.entries(env)
    .filter(
      ([name, value]) =>
        !name.startsWith('VITE_') &&
        !PUBLIC_SERVER_ENV.has(name) &&
        value.trim().length >= 12 &&
        !/^[a-z]+:\/\/[^@]*$/i.test(value.trim()),
    )
    .map(([name, value]) => ({ name, value: value.trim() }));
}

/**
 * Stand-in values for every secret-bearing name of `.env.example`, set in the bundle builds'
 * environment: a sentinel found in a bundle means a server value reached it.
 */
export function sentinels(names: Iterable<string>, tag: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const name of names) {
    if (name.startsWith('VITE_') || PUBLIC_SERVER_ENV.has(name)) continue;
    out[name] = `PREFLIGHT_SENTINEL_${tag}_${name}`;
  }
  return out;
}
