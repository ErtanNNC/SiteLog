/**
 * W3-15 · the scripted call simulator (spec §17 Voice, §10.13, §16.2 M7; PLAN_WEEK3 W3-15):
 *
 *   pnpm simulate:call -- fixtures/calls/northgate-file-en.json   # one script
 *   pnpm simulate:call -- --all                                   # every script with `simulate`
 *   pnpm simulate:call -- --live fixtures/calls/<id>.json         # audio level, by hand (W3-16)
 *
 * Text level (the default): the script's call against a **local** Supabase stack, as the voice
 * agent makes it with no audio and no model: `POST /voice/calls/start` and each step's tool
 * request to field-api with the agent's bearer secret, each answer checked against the voice
 * contract and the script's recorded answer, then what the call left behind (the call's outcome,
 * the filed report and its totals, the site-day, the reporter, the texts, the unknown contact,
 * the call's audit trail). The worker must run on the same stack with the fake providers
 * (`TRANSCRIBE_PROVIDER=fake`, `EXTRACT_PROVIDER=fake`): the live tools, the filings and the
 * post-call job are its jobs. Each run makes an org of its own (`call-sim/stack.ts`).
 *
 * Env (from the shell; `set -a; eval "$(supabase status -o env)"; set +a` gives the first two):
 * SUPABASE_DB_URL (or DB_URL), FIELD_API_URL (or API_URL + /functions/v1/field-api), and
 * VOICE_AGENT_TOOL_SECRET (else read from supabase/functions/.env, the local functions' env).
 * SIP scripts dial the US pack's voice number: `pnpm countries:set -- --code US --voice <number>`.
 *
 * `--live` (W3-16, by hand): plays TTS-generated reporter audio with site noise into a LiveKit
 * room against the deployed agent and records latency and barge-in. It needs LIVEKIT_URL,
 * LIVEKIT_API_KEY, LIVEKIT_API_SECRET and DEEPGRAM_API_KEY and is not built yet: how the
 * reporter's audio is made and measured is spec §19 Q212.
 */
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runCallScript } from './call-sim/run.ts';
import { isSimScript, listSimScripts, loadCallScript, type SimScript } from './call-sim/script.ts';
import {
  fetchVoiceHttp,
  refuseTarget,
  sqlSimStack,
  transcriptSegments,
  type Query,
} from './call-sim/stack.ts';

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
export const FIXTURES_DIR = join(REPO_ROOT, 'fixtures');
export const CALLS_DIR = join(FIXTURES_DIR, 'calls');

/** The keys `--live` needs (W3-16). */
export const LIVE_ENV = [
  'LIVEKIT_URL',
  'LIVEKIT_API_KEY',
  'LIVEKIT_API_SECRET',
  'DEEPGRAM_API_KEY',
];

export interface SimArgs {
  files: string[];
  all: boolean;
  live: boolean;
}

export function parseSimArgs(argv: readonly string[]): SimArgs {
  const args: SimArgs = { files: [], all: false, live: false };
  for (const a of argv) {
    if (a === '--') continue;
    else if (a === '--all') args.all = true;
    else if (a === '--live') args.live = true;
    else if (a.startsWith('--')) throw new Error(`unknown argument ${a}`);
    else args.files.push(a);
  }
  if (args.all && args.files.length) throw new Error('--all or files, not both');
  if (!args.all && args.files.length === 0)
    throw new Error('name a script (fixtures/calls/<id>.json) or --all');
  return args;
}

/** A KEY=value of a dotenv file (no expansion), or undefined. */
export function dotenvValue(text: string, key: string): string | undefined {
  for (const line of text.split(/\r?\n/)) {
    const m = /^\s*(?:export\s+)?([A-Z0-9_]+)\s*=\s*(.*)$/.exec(line);
    if (!m || m[1] !== key) continue;
    const raw = m[2]!.trim();
    const quoted = /^(["'])(.*)\1(?:\s+#.*)?$/.exec(raw);
    const v = quoted ? quoted[2]! : raw.replace(/\s+#.*$/, '');
    return v || undefined;
  }
  return undefined;
}

export interface SimEnv {
  dbUrl: string | undefined;
  fieldApiUrl: string;
  toolSecret: string | undefined;
}

export function simEnv(env: NodeJS.ProcessEnv, functionsEnv: string | null): SimEnv {
  const api = (env.API_URL ?? env.SUPABASE_URL ?? 'http://127.0.0.1:54321').replace(/\/+$/, '');
  return {
    dbUrl: env.SUPABASE_DB_URL || env.DB_URL || undefined,
    fieldApiUrl: env.FIELD_API_URL || `${api}/functions/v1/field-api`,
    toolSecret:
      env.VOICE_AGENT_TOOL_SECRET ||
      (functionsEnv ? dotenvValue(functionsEnv, 'VOICE_AGENT_TOOL_SECRET') : undefined),
  };
}

function scriptsOf(args: SimArgs): SimScript[] {
  if (args.all) return listSimScripts(CALLS_DIR);
  return args.files.map((f) => {
    const path = resolve(process.env.INIT_CWD ?? process.cwd(), f);
    const s = loadCallScript(path);
    if (!isSimScript(s)) throw new Error(`${f} has no \`simulate\` block`);
    return s;
  });
}

async function main(): Promise<number> {
  const args = parseSimArgs(process.argv.slice(2));
  const scripts = scriptsOf(args);
  if (args.live) {
    const missing = LIVE_ENV.filter((k) => !process.env[k]);
    console.error(
      missing.length
        ? `--live needs ${missing.join(', ')} (W3-16, by hand).`
        : '--live (W3-16): TTS reporter audio with site noise into a LiveKit room against the deployed agent is not built yet (spec §19 Q212). Run the scripts by phone or Talk now and read the latency with `calls.metrics`.',
    );
    return 2;
  }
  const functionsEnvPath = join(REPO_ROOT, 'supabase', 'functions', '.env');
  const env = simEnv(
    process.env,
    existsSync(functionsEnvPath) ? readFileSync(functionsEnvPath, 'utf8') : null,
  );
  const refused = refuseTarget(env.dbUrl, env.fieldApiUrl);
  if (refused) {
    console.error(`simulate:call refused: ${refused}`);
    return 2;
  }
  if (!env.toolSecret) {
    console.error(
      'simulate:call: VOICE_AGENT_TOOL_SECRET is not set (nor in supabase/functions/.env): field-api needs the same value',
    );
    return 2;
  }
  const { default: postgres } = await import('postgres');
  const db = postgres(env.dbUrl!, { max: 2, onnotice: () => undefined });
  const q: Query = async (text, params = []) =>
    (await db.unsafe(text, params as never[])) as unknown as never[];
  const deps = {
    http: fetchVoiceHttp(env.fieldApiUrl, env.toolSecret),
    stack: sqlSimStack({ q }),
    segments: transcriptSegments(FIXTURES_DIR),
    log: (line: string) => console.log(line),
  };
  let failed = 0;
  try {
    for (const s of scripts) {
      console.log(`${s.id} · ${s.simulate.title} (@${s.simulate.milestone} @${s.simulate.flow})`);
      const t0 = Date.now();
      const r = await runCallScript(s, deps);
      const secs = ((Date.now() - t0) / 1000).toFixed(1);
      if (r.failures.length) {
        failed += 1;
        console.log(`FAIL ${s.id} (call ${r.callId ?? 'none'}, ${secs} s)`);
      } else {
        console.log(`PASS ${s.id} (call ${r.callId}, ${r.steps.length} steps, ${secs} s)`);
      }
    }
  } finally {
    await db.end({ timeout: 5 });
  }
  console.log(`${scripts.length - failed}/${scripts.length} scripted calls passed`);
  return failed ? 1 : 0;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().then(
    (code) => process.exit(code),
    (err: unknown) => {
      console.error(err instanceof Error ? err.message : err);
      process.exit(1);
    },
  );
}
