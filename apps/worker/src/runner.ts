import * as Sentry from '@sentry/node';
import { JOB_TYPES, parseJobPayload, waCopy, type JobRow, type JobTypeKey } from '@sitelog/shared';
import { childCtx, createMetrics, type Ctx } from './context';
import { costUsdAcrossAttempts, refreshCostAfterJob } from './cost';
import { registry } from './jobs/registry';
import { rawPayload } from './jobs/types';
import { contextOf } from './router/context';
import { runTimeoutSweep } from './router/timeouts';
import { sendFreeForm } from './wa/send';

/**
 * Job loop: claim_jobs (FOR UPDATE SKIP LOCKED) → handler with a per-job timeout → complete_job /
 * fail_job (backoff + dead after 5 attempts). Dead jobs go to Sentry and the reporter hears
 * `error_retry` once. Metrics (tokens, audio seconds, latency, cost) land in jobs.payload.metrics;
 * a job that references a filed report then refreshes that report's cost estimate (src/cost.ts).
 */

export interface RunnerOptions {
  concurrency: number;
  pollIntervalMs: number;
  sweepIntervalMs: number;
  jobTimeoutMs: number;
  workerId: string;
}

export class JobTimeoutError extends Error {
  constructor(
    public readonly jobId: number,
    ms: number,
  ) {
    super(`job ${jobId} exceeded ${ms} ms`);
    this.name = 'JobTimeoutError';
  }
}

export async function runJob(
  baseCtx: Ctx,
  job: JobRow,
  timeoutMs: number,
): Promise<{ ok: boolean; error?: string }> {
  const metrics = createMetrics();
  const type = job.type as JobTypeKey;
  const ctx: Ctx = {
    ...childCtx(baseCtx, { job_id: job.id, job_type: job.type, attempt: job.attempts }),
    metrics,
  };
  const started = Date.now();
  if (!(JOB_TYPES as readonly string[]).includes(type)) {
    const error = `unknown job type ${job.type}`;
    await ctx.db.failJob(job.id, error);
    return { ok: false, error };
  }
  try {
    const payload = parseJobPayload(type, job.payload);
    const handler = registry[type] as (c: Ctx, p: unknown, j: JobRow) => Promise<void>;
    await withTimeout(
      handler(ctx, payload, job),
      timeoutMs,
      () => new JobTimeoutError(job.id, timeoutMs),
    );
    await ctx.db.completeJob(job.id);
    await saveMetrics(ctx, job, metrics.snapshot(), Date.now() - started);
    await refreshCostAfterJob(ctx, job);
    ctx.log.info('job done', { ms: Date.now() - started });
    return { ok: true };
  } catch (err) {
    const error = err instanceof Error ? `${err.name}: ${err.message}` : String(err);
    ctx.log.error('job failed', { err, ms: Date.now() - started });
    await ctx.db.failJob(job.id, error);
    await saveMetrics(ctx, job, metrics.snapshot(), Date.now() - started);
    await refreshCostAfterJob(ctx, job);
    const after = await ctx.db.getJob(job.id);
    if (after?.status === 'dead') await onDeadJob(ctx, job, err);
    return { ok: false, error };
  }
}

async function saveMetrics(
  ctx: Ctx,
  job: JobRow,
  m: ReturnType<ReturnType<typeof createMetrics>['snapshot']>,
  latencyMs: number,
): Promise<void> {
  try {
    // Retries: keep the cost of the earlier attempts (each one may have called the models).
    const costUsdTotal = costUsdAcrossAttempts(job, m.estCostUsd ?? 0);
    await ctx.db.updateJobMetrics(job.id, {
      ...m,
      latencyMs,
      ...(costUsdTotal !== null ? { costUsdTotal } : {}),
    });
  } catch (err) {
    ctx.log.warn('metrics not saved', { err });
  }
}

/** §10.1: after 5 attempts → dead + Sentry alert + reporter gets error_retry once. */
async function onDeadJob(ctx: Ctx, job: JobRow, err: unknown): Promise<void> {
  ctx.log.error('job dead', { err });
  Sentry.captureException(err instanceof Error ? err : new Error(String(err)), {
    tags: { job_type: job.type },
    extra: { job_id: job.id, payload: job.payload },
  });
  try {
    const convo = await conversationForJob(ctx, job);
    if (!convo) return;
    const c = contextOf(convo);
    const key = String(c.active_report_id ?? rawPayload(job).messageId ?? job.id);
    if (c.error_notified_for === key) return;
    await sendFreeForm(ctx, convo, waCopy.errorRetry(), undefined, { kind: 'error_retry' });
    await ctx.db.updateConversation(convo.id, { context: { ...c, error_notified_for: key } });
  } catch (notifyErr) {
    ctx.log.warn('error_retry notice failed', { err: notifyErr });
  }
}

async function conversationForJob(ctx: Ctx, job: JobRow) {
  const p = rawPayload(job);
  if (typeof p.conversationId === 'string') return ctx.db.getConversation(p.conversationId);
  if (typeof p.messageId === 'string') {
    const m = await ctx.db.getMessage(p.messageId);
    if (m) return ctx.db.getConversation(m.conversation_id);
  }
  if (typeof p.reportId === 'string') {
    const r = await ctx.db.getReport(p.reportId);
    const reporter = r?.reporter_id ? await ctx.db.getReporter(r.reporter_id) : null;
    if (reporter) return ctx.db.getConversationByPhone(reporter.phone_e164);
  }
  return null;
}

export function withTimeout<T>(p: Promise<T>, ms: number, makeError: () => Error): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(makeError()), ms);
  });
  return Promise.race([p, timeout]).finally(() => clearTimeout(timer)) as Promise<T>;
}

export interface Runner {
  start(): void;
  stop(): Promise<void>;
  readonly active: number;
  /** One claim+run cycle (tests). Returns the number of jobs run. */
  tick(): Promise<number>;
}

export function createRunner(ctx: Ctx, opts: RunnerOptions): Runner {
  let running = false;
  let active = 0;
  let loop: Promise<void> | null = null;
  let sweepTimer: NodeJS.Timeout | null = null;
  const inflight = new Set<Promise<unknown>>();
  /** Ends the main loop's current wait early: a finished job frees a slot and often enqueued a follow-up. */
  let wake: (() => void) | null = null;
  const idle = (ms: number) =>
    new Promise<void>((resolve) => {
      const timer = setTimeout(done, ms);
      function done() {
        clearTimeout(timer);
        wake = null;
        resolve();
      }
      wake = done;
    });

  const track = <T>(p: Promise<T>): Promise<T> => {
    inflight.add(p);
    return p.finally(() => inflight.delete(p));
  };

  async function tick(): Promise<number> {
    const free = opts.concurrency - active;
    if (free <= 0) return 0;
    const jobs = await ctx.db.claimJobs(opts.workerId, free);
    for (const job of jobs) {
      active++;
      void track(
        runJob(ctx, job, opts.jobTimeoutMs).finally(() => {
          active--;
          wake?.();
        }),
      );
    }
    return jobs.length;
  }

  async function sweep(): Promise<void> {
    try {
      const r = await runTimeoutSweep(ctx);
      if (r.answered || r.nudged || r.filed || r.delayed) ctx.log.info('timeout sweep', { ...r });
    } catch (err) {
      ctx.log.error('timeout sweep failed', { err });
      Sentry.captureException(err);
    }
  }

  async function mainLoop(): Promise<void> {
    while (running) {
      let n: number;
      try {
        n = await tick();
      } catch (err) {
        ctx.log.error('claim failed', { err });
        await sleep(Math.min(opts.pollIntervalMs * 5, 10_000));
        continue;
      }
      if (n === 0 || active >= opts.concurrency) await idle(opts.pollIntervalMs);
    }
  }

  return {
    get active() {
      return active;
    },
    tick,
    start() {
      if (running) return;
      running = true;
      loop = mainLoop();
      sweepTimer = setInterval(() => void sweep(), opts.sweepIntervalMs);
      void sweep();
      ctx.log.info('runner started', { concurrency: opts.concurrency, worker_id: opts.workerId });
    },
    async stop() {
      running = false;
      wake?.();
      if (sweepTimer) clearInterval(sweepTimer);
      await loop;
      const deadline = Date.now() + 30_000;
      while (inflight.size > 0 && Date.now() < deadline) await sleep(200);
      ctx.log.info('runner stopped', { unfinished: inflight.size });
    },
  };
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
