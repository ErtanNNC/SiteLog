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

export const ConfigSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  LOG_LEVEL: z.enum(['debug', 'info', 'warn', 'error']).default('info'),

  SUPABASE_URL: z.string().default(''),
  SUPABASE_SERVICE_ROLE_KEY: z.string().default(''),
  SUPABASE_DB_URL: z.string().min(1, 'SUPABASE_DB_URL is required'),

  WA_PHONE_NUMBER_ID: z.string().default(''),
  WA_BUSINESS_ACCOUNT_ID: z.string().default(''),
  WA_ACCESS_TOKEN: z.string().default(''),
  WA_GRAPH_VERSION: z.string().default('v21.0'),
  WA_GRAPH_BASE: z.string().default('https://graph.facebook.com'),
  WA_DISPLAY_NUMBER: z.string().default('+15550142290'),

  OPENAI_API_KEY: z.string().default(''),
  TRANSCRIBE_MODEL: z.string().default('whisper-1'),
  ANTHROPIC_API_KEY: z.string().default(''),
  CLAUDE_MODEL: z.string().default('claude-sonnet-5-5'),
  CLAUDE_MODEL_FAST: z.string().default(''),

  WEATHER_API_BASE: z.string().default('https://customer-api.open-meteo.com/v1/forecast'),
  WEATHER_API_KEY: z.string().default(''),

  EMAIL_PROVIDER: z.enum(['resend', 'console']).default('resend'),
  RESEND_API_KEY: z.string().default(''),
  EMAIL_FROM: z.string().default('SiteLog <reports@sitelog.app>'),

  APP_URL: z.string().default('https://app.sitelog.app'),
  WORKER_CONCURRENCY: intFrom(4).pipe(z.number().min(1).max(64)),
  WORKER_PORT: intFrom(8080),
  WORKER_ID: z.string().default(''),
  JOB_TIMEOUT_MS: intFrom(5 * 60_000),
  POLL_INTERVAL_MS: intFrom(1000),
  SWEEP_INTERVAL_MS: intFrom(60_000),
  AUDIO_RETENTION_DAYS: intFrom(730),
  SENTRY_DSN: z.string().default(''),
  FFMPEG_PATH: z.string().default(''),
  /** Skip the ffmpeg + storage path in tests. */
  WORKER_DRY_RUN: bool.default(false),
});

export type Config = z.infer<typeof ConfigSchema>;

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
