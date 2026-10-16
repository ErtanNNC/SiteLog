import { NEVER_ABORTED, abortableFetch } from './abort';
import { createServer } from 'node:http';
import * as Sentry from '@sentry/node';
import { createExtractionClient } from './ai/fake-claude';
import { createOpenAiClient } from './ai/transcribe';
import { createTranscriber } from './ai/transcriber';
import { loadConfig, workerClock, type Config } from './config';
import { createMetrics, type Ctx } from './context';
import { connectDb } from './db';
import { loadDotenv } from './dotenv';
import { createEmailProvider } from './email/provider';
import { createLogger } from './log';
import { createWorkerNotifier, describePackTransports } from './messaging';
import { vapidConfigured } from './push';
import { createFfmpegRunner, resolveFfmpegPath } from './media/ffmpeg';
import {
  createJobListener,
  looksLikeTransactionPooler,
  postgresListenConnect,
  type JobListener,
} from './listener';
import { createRunner, type Runner } from './runner';
import { createMemoryStorage, createStorage } from './storage';
import { createWaClient } from './wa/client';

export const VERSION = '0.1.0';

export function buildContext(config: Config): Ctx {
  const log = createLogger(
    { service: 'sitelog-worker', worker_id: config.WORKER_ID },
    { level: config.LOG_LEVEL },
  );
  const db = connectDb(config.SUPABASE_DB_URL, { max: config.WORKER_CONCURRENCY + 2 });
  const storage = config.WORKER_DRY_RUN
    ? createMemoryStorage()
    : createStorage(config.SUPABASE_URL, config.SUPABASE_SERVICE_ROLE_KEY);
  const wa = createWaClient(
    {
      graphBase: config.WA_GRAPH_BASE,
      graphVersion: config.WA_GRAPH_VERSION,
      phoneNumberId: config.WA_PHONE_NUMBER_ID,
      accessToken: config.WA_ACCESS_TOKEN,
    },
    log,
    abortableFetch(),
  );
  const openai = createOpenAiClient(config.OPENAI_API_KEY);
  // The real clock, or CI's test clock (WORKER_CLOCK_OVERRIDE, never in production).
  const now = workerClock(config);
  const ffmpeg = createFfmpegRunner(
    resolveFfmpegPath({
      ...process.env,
      FFMPEG_PATH: config.FFMPEG_PATH || process.env.FFMPEG_PATH,
    }),
  );
  return {
    config,
    db,
    wa,
    storage,
    ai: {
      claude: createExtractionClient(config, log),
      openai,
      transcriber: createTranscriber(config, { openai, ffmpeg, log }),
    },
    email: createEmailProvider(
      { provider: config.EMAIL_PROVIDER, apiKey: config.RESEND_API_KEY, from: config.EMAIL_FROM },
      log,
      { insertConsoleEmail: (row) => db.insertConsoleEmail(row) },
    ),
    notifier: createWorkerNotifier(config, db, undefined, now),
    ffmpeg,
    log,
    now,
    metrics: createMetrics(),
    signal: NEVER_ABORTED,
  };
}

/**
 * LISTEN jobs on its own session connection (W1-10, src/listener.ts): a `NOTIFY jobs` wakes the
 * runner, and so does every (re)connect (jobs enqueued while nobody listened). The 5 s poll covers
 * the rest.
 */
export function startJobListener(config: Config, ctx: Ctx, runner: Runner): JobListener {
  const url = config.SUPABASE_DB_LISTEN_URL || config.SUPABASE_DB_URL;
  if (looksLikeTransactionPooler(url)) {
    ctx.log.warn(
      'the LISTEN connection is a transaction pooler (port 6543), which delivers no NOTIFY: set SUPABASE_DB_LISTEN_URL to a session-mode connection; polling every POLL_INTERVAL_MS meanwhile',
      { poll_ms: config.POLL_INTERVAL_MS },
    );
  }
  const listener = createJobListener({
    connect: postgresListenConnect(url),
    onNotify: () => runner.wake(),
    onConnected: () => runner.wake(),
    log: ctx.log,
  });
  listener.start();
  return listener;
}

export async function main(): Promise<void> {
  await loadDotenv();
  const config = loadConfig();
  if (config.SENTRY_DSN) {
    Sentry.init({
      dsn: config.SENTRY_DSN,
      environment: config.NODE_ENV,
      release: `sitelog-worker@${VERSION}`,
      tracesSampleRate: 0,
    });
  }
  const ctx = buildContext(config);
  const startedAt = Date.now();
  let exitForStuckJob: (() => void) | null = null;
  const runner = createRunner(ctx, {
    concurrency: config.WORKER_CONCURRENCY,
    pollIntervalMs: config.POLL_INTERVAL_MS,
    sweepIntervalMs: config.SWEEP_INTERVAL_MS,
    jobTimeoutMs: config.JOB_TIMEOUT_MS,
    workerId: config.WORKER_ID,
    // A handler that ignores its abort for STUCK_JOB_MS: exit, so the platform restarts the
    // worker and claim_jobs() re-runs the job after the stale lock (the handler dies with us).
    onStuck: (job) => {
      ctx.log.error('exiting: a job handler is stuck', { job_id: job.id, job_type: job.type });
      exitForStuckJob?.();
    },
  });

  let listener: JobListener | null = null;
  const server = createServer(async (req, res) => {
    if (req.method === 'GET' && (req.url === '/health' || req.url === '/')) {
      try {
        const queue = await ctx.db.queueStats();
        // A stuck handler (runner.ts STUCK_JOB_MS) makes the worker unhealthy until it restarts.
        const healthy = runner.stuck === 0;
        const body = {
          ok: healthy,
          version: VERSION,
          uptimeS: Math.round((Date.now() - startedAt) / 1000),
          queue,
          active: runner.active,
          // LISTEN jobs is connected (W1-10); false: polling every POLL_INTERVAL_MS only.
          listening: listener?.connected ?? false,
          stuckJobs: runner.stuck,
        };
        res.writeHead(healthy ? 200 : 503, { 'Content-Type': 'application/json' });
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
  server.listen(config.WORKER_PORT, () =>
    ctx.log.info('health server listening', {
      port: config.WORKER_PORT,
      ffmpeg: resolveFfmpegPath(),
    }),
  );
  // One line per country pack: the SMS transport a real org of the pack gets here (demo orgs:
  // always console). A failure here only loses the line.
  ctx.db
    .listCountries()
    .then((rows) =>
      ctx.log.info('sms transport per country pack', {
        packs: describePackTransports(rows),
        email: config.EMAIL_PROVIDER,
        // W2-14: real orgs' push needs the VAPID key pair; demo orgs' push is console.
        push: vapidConfigured(config) ? 'webpush' : 'console (no VAPID key pair: demo orgs only)',
      }),
    )
    .catch((err: unknown) => ctx.log.warn('could not read the country packs', { err }));
  if (config.WORKER_CLOCK_OVERRIDE)
    ctx.log.warn(
      'WORKER_CLOCK_OVERRIDE: the worker runs on a test clock (never on a hosted project)',
      {
        start: config.WORKER_CLOCK_START,
        now: ctx.now().toISOString(),
      },
    );
  runner.start();
  listener = startJobListener(config, ctx, runner);

  let stopping = false;
  const shutdown = async (signal: string) => {
    if (stopping) return;
    stopping = true;
    ctx.log.info('shutting down', { signal });
    server.close();
    await listener?.stop();
    await runner.stop();
    await ctx.db.close();
    await Sentry.flush(2000).catch(() => undefined);
    process.exit(0);
  };
  exitForStuckJob = () => {
    if (stopping) return;
    stopping = true;
    // No graceful stop: runner.stop() would wait for the stuck handler.
    server.close();
    void Promise.allSettled([listener?.stop(), Sentry.flush(2000)]).finally(() => process.exit(1));
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
