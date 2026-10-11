import { createServer } from 'node:http';
import * as Sentry from '@sentry/node';
import { createAnthropicClient } from './ai/claude';
import { createOpenAiClient } from './ai/transcribe';
import { loadConfig, type Config } from './config';
import { createMetrics, type Ctx } from './context';
import { connectDb } from './db';
import { createEmailProvider } from './email/provider';
import { createLogger } from './log';
import { createFfmpegRunner, resolveFfmpegPath } from './media/ffmpeg';
import { createRunner } from './runner';
import { createMemoryStorage, createStorage } from './storage';
import { createWaClient } from './wa/client';

export const VERSION = '0.1.0';

async function loadDotenv(): Promise<void> {
  if (process.env.NODE_ENV === 'production') return;
  try {
    const dotenv = await import('dotenv');
    dotenv.config({ quiet: true });
  } catch {
    /* dotenv is a dev convenience */
  }
}

export function buildContext(config: Config): Ctx {
  const log = createLogger({ service: 'sitelog-worker', worker_id: config.WORKER_ID }, { level: config.LOG_LEVEL });
  const db = connectDb(config.SUPABASE_DB_URL, { max: config.WORKER_CONCURRENCY + 2 });
  const storage = config.WORKER_DRY_RUN ? createMemoryStorage() : createStorage(config.SUPABASE_URL, config.SUPABASE_SERVICE_ROLE_KEY);
  const wa = createWaClient({ graphBase: config.WA_GRAPH_BASE, graphVersion: config.WA_GRAPH_VERSION, phoneNumberId: config.WA_PHONE_NUMBER_ID, accessToken: config.WA_ACCESS_TOKEN }, log);
  return {
    config,
    db,
    wa,
    storage,
    ai: { claude: createAnthropicClient(config.ANTHROPIC_API_KEY), openai: createOpenAiClient(config.OPENAI_API_KEY) },
    email: createEmailProvider({ provider: config.EMAIL_PROVIDER, apiKey: config.RESEND_API_KEY, from: config.EMAIL_FROM }, log),
    ffmpeg: createFfmpegRunner(resolveFfmpegPath({ ...process.env, FFMPEG_PATH: config.FFMPEG_PATH || process.env.FFMPEG_PATH })),
    log,
    now: () => new Date(),
    metrics: createMetrics(),
  };
}

export async function main(): Promise<void> {
  await loadDotenv();
  const config = loadConfig();
  if (config.SENTRY_DSN) {
    Sentry.init({ dsn: config.SENTRY_DSN, environment: config.NODE_ENV, release: `sitelog-worker@${VERSION}`, tracesSampleRate: 0 });
  }
  const ctx = buildContext(config);
  const startedAt = Date.now();
  const runner = createRunner(ctx, {
    concurrency: config.WORKER_CONCURRENCY,
    pollIntervalMs: config.POLL_INTERVAL_MS,
    sweepIntervalMs: config.SWEEP_INTERVAL_MS,
    jobTimeoutMs: config.JOB_TIMEOUT_MS,
    workerId: config.WORKER_ID,
  });

  const server = createServer(async (req, res) => {
    if (req.method === 'GET' && (req.url === '/health' || req.url === '/')) {
      try {
        const queue = await ctx.db.queueStats();
        const body = { ok: true, version: VERSION, uptimeS: Math.round((Date.now() - startedAt) / 1000), queue, active: runner.active };
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(body));
      } catch (err) {
        ctx.log.error('health check failed', { err });
        res.writeHead(503, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: false, version: VERSION, error: 'database unavailable' }));
      }
      return;
    }
    res.writeHead(404);
    res.end();
  });
  server.listen(config.WORKER_PORT, () => ctx.log.info('health server listening', { port: config.WORKER_PORT, ffmpeg: resolveFfmpegPath() }));
  runner.start();

  let stopping = false;
  const shutdown = async (signal: string) => {
    if (stopping) return;
    stopping = true;
    ctx.log.info('shutting down', { signal });
    server.close();
    await runner.stop();
    await ctx.db.close();
    await Sentry.flush(2000).catch(() => undefined);
    process.exit(0);
  };
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('unhandledRejection', (reason) => {
    ctx.log.error('unhandled rejection', { err: reason });
    Sentry.captureException(reason);
  });
}

const isDirect = process.argv[1] && /index\.(ts|js)$/.test(process.argv[1]) && !process.env.VITEST;
if (isDirect) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
