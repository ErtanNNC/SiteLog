import { z } from 'zod';

/**
 * Worker configuration (§5.1). Parsed once at boot; every value is validated.
 * Secrets that are only needed by some jobs (WhatsApp, OpenAI, Anthropic, Resend)
 * default to '' so the worker can start in a partial environment; the client that
 * needs a missing secret throws a clear error when first used.
 */

const bool = z
  .union([z.string(), z.boolean()])
  .transform((v) =>
    typeof v === 'boolean' ? v : ['1', 'true', 'yes', 'on'].includes(v.toLowerCase()),
  );

const intFrom = (def: number) =>
  z
    .union([z.string(), z.number()])
    .default(def)
    .transform((v) => (typeof v === 'number' ? v : Number.parseInt(v, 10)))
    .pipe(z.number().int().min(0));

/**
 * claim_jobs() takes a running job back after this long (GAP D18; the interval in
 * supabase/migrations/20261014000001_queue_rls_fixes.sql), so a worker that died mid-job loses its
 * jobs after 10 minutes. A live worker never lets its running job go stale: it refreshes the job's
 * `locked_at` every JOB_HEARTBEAT_MS until the handler settles, including after a timeout, when the
 * handler's AbortSignal is aborted and the job is failed (re-queued) only once the handler has
 * stopped (runner.ts, W1-10). So a timed-out job never runs twice at once.
 */
export const STALE_LOCK_MS = 10 * 60_000;

/** How often a running job's `locked_at` is refreshed (well inside STALE_LOCK_MS). */
export const JOB_HEARTBEAT_MS = 60_000;

/**
 * After a timeout aborts a job's signal, how long the runner waits for the handler to settle before
 * it alerts Sentry that the handler ignores its signal. It keeps waiting (and heartbeating): the
 * job is never handed to another slot while its handler may still run.
 */
export const ABORT_GRACE_MS = 30_000;

/**
 * The hard cap after a timeout's abort (W1-10): a handler that still has not settled this long
 * after its signal was aborted is stuck. The runner stops heartbeating its row and reports it
 * (`onStuck`); the worker process then exits (src/index.ts), Fly restarts it, and claim_jobs()
 * takes the row back after STALE_LOCK_MS, which is safe because the stuck handler died with the
 * process. Without the cap a hung handler would hold its lock key (`report:<id>`, `sms:<phone>`,
 * `convo:<id>`) and its slot until the next deploy. `/health` answers 503 while a job is stuck.
 */
export const STUCK_JOB_MS = 5 * 60_000;

export const ConfigSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  LOG_LEVEL: z.enum(['debug', 'info', 'warn', 'error']).default('info'),

  SUPABASE_URL: z.string().default(''),
  SUPABASE_SERVICE_ROLE_KEY: z.string().default(''),
  SUPABASE_DB_URL: z.string().min(1, 'SUPABASE_DB_URL is required'),
  /**
   * W1-10: the connection the worker LISTENs on for `NOTIFY jobs` (enqueue_job). It must be a
   * session-mode connection (direct, or Supavisor's session pooler on port 5432): a transaction
   * pooler (port 6543) does not deliver notifications. Empty: SUPABASE_DB_URL. Without
   * notifications the worker still finds every job by polling (POLL_INTERVAL_MS).
   */
  SUPABASE_DB_LISTEN_URL: z.string().default(''),

  WA_PHONE_NUMBER_ID: z.string().default(''),
  WA_BUSINESS_ACCOUNT_ID: z.string().default(''),
  WA_ACCESS_TOKEN: z.string().default(''),
  WA_GRAPH_VERSION: z.string().default('v21.0'),
  WA_GRAPH_BASE: z.string().default('https://graph.facebook.com'),
  WA_DISPLAY_NUMBER: z.string().default('+15550142290'),

  OPENAI_API_KEY: z.string().default(''),
  /**
   * §10.2 transcription (W1-11, src/ai/transcriber.ts): Deepgram by default, OpenAI the fallback,
   * `fake` the fixtures/voice transcripts. Outside production a provider without its key becomes
   * the fake; in production it never does (the job fails until the key is set).
   */
  TRANSCRIBE_PROVIDER: z.enum(['deepgram', 'openai', 'fake']).default('deepgram'),
  DEEPGRAM_API_KEY: z.string().default(''),
  /** The provider's model; empty: nova-3 for Deepgram, whisper-1 for OpenAI. */
  TRANSCRIBE_MODEL: z.string().default(''),
  /**
   * The model calls (`ctx.ai.claude`: extraction, answers, corrections, day-off, site guess):
   * Claude by default, `fake` the recorded tool outputs of fixtures/tool-outputs
   * (src/ai/fake-claude.ts). Outside production Claude without ANTHROPIC_API_KEY becomes the
   * fake; in production `fake` is ignored and a missing key fails the jobs.
   */
  EXTRACT_PROVIDER: z.enum(['claude', 'fake']).default('claude'),
  ANTHROPIC_API_KEY: z.string().default(''),
  CLAUDE_MODEL: z.string().default('claude-sonnet-5-5'),
  CLAUDE_MODEL_FAST: z.string().default(''),

  WEATHER_API_BASE: z.string().default('https://customer-api.open-meteo.com/v1/forecast'),
  WEATHER_API_KEY: z.string().default(''),

  EMAIL_PROVIDER: z.enum(['resend', 'console']).default('resend'),
  RESEND_API_KEY: z.string().default(''),
  EMAIL_FROM: z.string().default('SiteLog <reports@sitelog.app>'),

  APP_URL: z.string().default('https://app.sitelog.app'),
  /**
   * Messaging (W1-08, spec §4.5, §5.1): the field app's host for the links in texts, the secret
   * personal link codes are derived with (the same LINK_SIGNING_SECRET as field-api), the SMS
   * providers' credentials (only for packs whose sender id is set in this database), and the
   * public URL of sms-webhook for Twilio's delivery callbacks.
   */
  FIELD_APP_URL: z.string().default(''),
  LINK_SIGNING_SECRET: z.string().default(''),
  TWILIO_ACCOUNT_SID: z.string().default(''),
  TWILIO_AUTH_TOKEN: z.string().default(''),
  ILETIMERKEZI_API_KEY: z.string().default(''),
  ILETIMERKEZI_API_HASH: z.string().default(''),
  SMS_WEBHOOK_URL: z.string().default(''),
  WORKER_CONCURRENCY: intFrom(4).pipe(z.number().min(1).max(64)),
  WORKER_PORT: intFrom(8080),
  WORKER_ID: z.string().default(''),
  JOB_TIMEOUT_MS: intFrom(5 * 60_000).pipe(
    z.number().max(STALE_LOCK_MS - 60_000, 'must end a minute before claim_jobs reclaims (10 min)'),
  ),
  /**
   * The poll fallback (W1-10): NOTIFY wakes the worker for a job due now; the poll finds jobs that
   * come due later (run_after, backoff), notifications missed while LISTEN reconnects, and a
   * transaction pooler that delivers none.
   */
  POLL_INTERVAL_MS: intFrom(5000),
  SWEEP_INTERVAL_MS: intFrom(60_000),
  AUDIO_RETENTION_DAYS: intFrom(730),
  SENTRY_DSN: z.string().default(''),
  /**
   * §15 cost guardrail: USD Meta bills per delivered template message (Utility, US rate card).
   * Free-form replies inside the 24 h window cost nothing. See src/cost.ts.
   */
  COST_WA_TEMPLATE_USD: z
    .union([z.string(), z.number()])
    .default(0.004)
    .transform((v) => (typeof v === 'number' ? v : Number.parseFloat(v)))
    .pipe(z.number().min(0).max(1)),
  FFMPEG_PATH: z.string().default(''),
  /** Skip the ffmpeg + storage path in tests. */
  WORKER_DRY_RUN: bool.default(false),
});

export type Config = z.infer<typeof ConfigSchema>;

/**
 * The OpenAI model of the v1.0 WhatsApp voice notes (`transcribe_audio`, the unknown-sender
 * snippet), which keep calling OpenAI until step 22: TRANSCRIBE_MODEL when OpenAI is the
 * configured provider, else OpenAI's default (TRANSCRIBE_MODEL then names a Deepgram model).
 */
export function openAiTranscribeModel(
  config: Pick<Config, 'TRANSCRIBE_PROVIDER' | 'TRANSCRIBE_MODEL'>,
): string {
  return config.TRANSCRIBE_PROVIDER === 'openai' && config.TRANSCRIBE_MODEL
    ? config.TRANSCRIBE_MODEL
    : 'whisper-1';
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const parsed = ConfigSchema.safeParse(env);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ');
    throw new Error(`Invalid worker configuration: ${issues}`);
  }
  const cfg = parsed.data;
  if (!cfg.CLAUDE_MODEL_FAST) cfg.CLAUDE_MODEL_FAST = cfg.CLAUDE_MODEL;
  if (!cfg.WORKER_ID) cfg.WORKER_ID = `${hostname()}-${process.pid}`;
  if (cfg.EMAIL_PROVIDER === 'resend' && !cfg.RESEND_API_KEY) cfg.EMAIL_PROVIDER = 'console';
  return cfg;
}

function hostname(): string {
  try {
    return process.env.HOSTNAME || process.env.FLY_MACHINE_ID || 'worker';
  } catch {
    return 'worker';
  }
}

/** A config for unit tests: no network, no secrets. */
export function testConfig(overrides: Partial<Config> = {}): Config {
  return {
    ...loadConfig({ SUPABASE_DB_URL: 'postgres://test', NODE_ENV: 'test', WORKER_DRY_RUN: 'true' }),
    ...overrides,
  };
}
