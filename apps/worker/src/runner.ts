import * as Sentry from '@sentry/node';
import { JOB_TYPES, parseJobPayload, type JobRow, type JobTypeKey } from '@sitelog/shared';
import { runWithSignal } from './abort';
import { ABORT_GRACE_MS, JOB_HEARTBEAT_MS, STUCK_JOB_MS } from './config';
import { childCtx, createMetrics, type Ctx } from './context';
import { costUsdAcrossAttempts, refreshCostAfterJob } from './cost';
import { onDeadJob } from './dead-jobs';
import { registry } from './jobs/registry';
import { runTimeoutSweep } from './router/timeouts';

/**
 * Job loop (spec §10.1; W1-10): claim_jobs (FOR UPDATE SKIP LOCKED, lock keys, priorities) →
 * handler → complete_job / fail_job (backoff 30 s · 2 min · 10 min · 30 min · 2 h, dead after the
 * sixth failure, GAP D17). The loop sleeps until a `NOTIFY jobs` (`wake()`, src/listener.ts), a
 * finished job, or the poll fallback (POLL_INTERVAL_MS, 5 s), whichever comes first.
 *
 * Timeouts never run a job twice at once (docs/AUDIT_BACKLOG.md): each job gets its own
 * AbortSignal (`Ctx.signal`, and through `runWithSignal` every HTTP call of the boot-time
 * clients). When JOB_TIMEOUT_MS passes the signal is aborted, and the job is failed (re-queued)
 * only once its handler has settled. Until then the row stays `running` and its `locked_at` is
 * refreshed every JOB_HEARTBEAT_MS, so claim_jobs() never hands it to another slot; a handler that
 * ignores its signal for ABORT_GRACE_MS is reported to Sentry and still waited for. The wait is
 * bounded: STUCK_JOB_MS after the abort the job is stuck, its heartbeat stops and `onStuck` runs
 * (src/index.ts exits the process so the platform restarts it and the stale-lock reclaim re-runs
 * the job once the stuck handler is gone with the process; `/health` answers 503 meanwhile).
 *
 * A dead job goes to Sentry, and a reporter-facing one to the office (src/dead-jobs.ts). Metrics
 * (tokens, audio seconds, latency, cost) land in jobs.payload.metrics; a job that references a
 * filed report then refreshes that report's cost estimate (src/cost.ts).
 */

export interface RunnerOptions {
  concurrency: number;
  /** The poll fallback: the longest the loop sleeps without a NOTIFY. */
  pollIntervalMs: number;
  sweepIntervalMs: number;
  /** The WhatsApp answer/confirmation timeout sweep (default on); test:stack turns it off. */
  sweep?: boolean;
  jobTimeoutMs: number;
  workerId: string;
  /** Tests: the heartbeat and the abort grace (default JOB_HEARTBEAT_MS, ABORT_GRACE_MS). */
  heartbeatMs?: number;
  abortGraceMs?: number;
  /** Tests: the hard cap after the abort (default STUCK_JOB_MS). */
  stuckAfterMs?: number;
  /** A handler that has not settled STUCK_JOB_MS after its abort (src/index.ts exits). */
  onStuck?: (job: JobRow) => void;
}

export interface RunJobOptions {
  /** The worker holding the job (`locked_by`), for the heartbeat. */
  workerId?: string;
  heartbeatMs?: number;
  abortGraceMs?: number;
  stuckAfterMs?: number;
  onStuck?: (job: JobRow) => void;
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
  opts: RunJobOptions = {},
): Promise<{ ok: boolean; error?: string; timedOut?: boolean }> {
  const metrics = createMetrics();
  const type = job.type as JobTypeKey;
  const controller = new AbortController();
  const ctx: Ctx = {
    ...childCtx(baseCtx, { job_id: job.id, job_type: job.type, attempt: job.attempts }),
    metrics,
    signal: controller.signal,
  };
  const started = Date.now();
  if (!(JOB_TYPES as readonly string[]).includes(type)) {
    const error = `unknown job type ${job.type}`;
    await ctx.db.failJob(job.id, error);
    return { ok: false, error };
  }

  // The row stays ours while the handler runs, a timed-out one included.
  const workerId = opts.workerId ?? job.locked_by;
  const heartbeat = workerId
    ? setInterval(() => {
        ctx.db.heartbeatJob(job.id, workerId).then(
          (held) => {
            if (!held) ctx.log.warn('job heartbeat found the job no longer ours');
          },
          (err: unknown) => ctx.log.warn('job heartbeat failed', { err }),
        );
      }, opts.heartbeatMs ?? JOB_HEARTBEAT_MS)
    : null;
  let timedOut = false;
  let stuck = false;
  let graceTimer: NodeJS.Timeout | undefined;
  let stuckTimer: NodeJS.Timeout | undefined;
  const timeoutTimer = setTimeout(() => {
    timedOut = true;
    ctx.log.warn('job timed out; aborting its handler', { timeout_ms: timeoutMs });
    controller.abort(new JobTimeoutError(job.id, timeoutMs));
    graceTimer = setTimeout(() => {
      ctx.log.error('job handler ignores its abort signal; still waiting for it', {
        ms: Date.now() - started,
      });
      Sentry.captureMessage(`job ${job.id} (${job.type}) still running after its timeout`, {
        level: 'error',
        tags: { job_type: job.type },
        extra: { job_id: job.id },
      });
    }, opts.abortGraceMs ?? ABORT_GRACE_MS);
    stuckTimer = setTimeout(() => {
      // Bounded wait: the row is no longer kept alive, and the process is told to go.
      stuck = true;
      if (heartbeat) clearInterval(heartbeat);
      ctx.log.error('job handler is stuck after its abort; heartbeat stopped', {
        ms: Date.now() - started,
      });
      Sentry.captureMessage(`job ${job.id} (${job.type}) is stuck; restarting the worker`, {
        level: 'fatal',
        tags: { job_type: job.type },
        extra: { job_id: job.id },
      });
      opts.onStuck?.(job);
    }, opts.stuckAfterMs ?? STUCK_JOB_MS);
  }, timeoutMs);

  let outcome: { ok: true } | { ok: false; err: unknown };
  try {
    const payload = parseJobPayload(type, job.payload);
    const handler = registry[type] as (c: Ctx, p: unknown, j: JobRow) => Promise<void>;
    await runWithSignal(controller.signal, () => handler(ctx, payload, job), job.attempts);
    outcome = { ok: true };
  } catch (err) {
    outcome = { ok: false, err };
  } finally {
    clearTimeout(timeoutTimer);
    clearTimeout(graceTimer);
    clearTimeout(stuckTimer);
    if (heartbeat) clearInterval(heartbeat);
  }

  if (stuck) {
    // The row stopped being ours when the heartbeat stopped: claim_jobs() may have handed it to
    // another worker. Leave it to that one (or to the stale-lock reclaim).
    ctx.log.warn('stuck job settled after all; its row is left to the stale-lock reclaim', {
      ms: Date.now() - started,
    });
    return { ok: false, error: 'stuck', timedOut: true };
  }

  if (outcome.ok) {
    // A handler that finished its work after the timeout fired still finished it.
    await ctx.db.completeJob(job.id);
    await saveMetrics(ctx, job, metrics.snapshot(), Date.now() - started);
    await refreshCostAfterJob(ctx, job);
    ctx.log.info('job done', {
      ms: Date.now() - started,
      ...(timedOut ? { timed_out: true } : {}),
    });
    return { ok: true, ...(timedOut ? { timedOut } : {}) };
  }
  // The handler has settled: only now may the job run again.
  const err = timedOut ? new JobTimeoutError(job.id, timeoutMs) : outcome.err;
  const error = err instanceof Error ? `${err.name}: ${err.message}` : String(err);
  ctx.log.error('job failed', { err: outcome.err, ms: Date.now() - started, timed_out: timedOut });
  await ctx.db.failJob(job.id, error);
  await saveMetrics(ctx, job, metrics.snapshot(), Date.now() - started);
  await refreshCostAfterJob(ctx, job);
  const after = await ctx.db.getJob(job.id);
  if (after?.status === 'dead') await onDeadJob(ctx, after, err);
  return { ok: false, error, ...(timedOut ? { timedOut } : {}) };
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

export interface Runner {
  start(): void;
  stop(): Promise<void>;
  readonly active: number;
  /** One claim+run cycle (tests). Returns the number of jobs run. */
  tick(): Promise<number>;
  /**
   * A new job may be due (`NOTIFY jobs`, a LISTEN reconnect): the loop claims now instead of at
   * the next poll. A wake while the loop is busy is kept for its next wait.
   */
  wake(): void;
  /** Jobs whose handler has not settled STUCK_JOB_MS after its abort (`/health` answers 503). */
  readonly stuck: number;
}

export function createRunner(ctx: Ctx, opts: RunnerOptions): Runner {
  let running = false;
  let active = 0;
  let stuck = 0;
  let loop: Promise<void> | null = null;
  let sweepTimer: NodeJS.Timeout | null = null;
  const inflight = new Set<Promise<unknown>>();
  /** Ends the main loop's current wait early. */
  let wakeWait: (() => void) | null = null;
  /** A wake that came while the loop was claiming: its next wait returns at once. */
  let pendingWake = false;
  const wake = () => {
    if (wakeWait) wakeWait();
    else pendingWake = true;
  };
  const idle = (ms: number) =>
    new Promise<void>((resolve) => {
      if (pendingWake) {
        pendingWake = false;
        resolve();
        return;
      }
      const timer = setTimeout(done, ms);
      function done() {
        clearTimeout(timer);
        wakeWait = null;
        resolve();
      }
      wakeWait = done;
    });

  const track = <T>(p: Promise<T>): Promise<T> => {
    inflight.add(p);
    return p.finally(() => inflight.delete(p));
  };

  async function tick(): Promise<number> {
    const free = opts.concurrency - active;
    if (free <= 0) return 0;
    // A wake that arrives after this claim's snapshot must not be lost.
    pendingWake = false;
    const jobs = await ctx.db.claimJobs(opts.workerId, free);
    for (const job of jobs) {
      active++;
      void track(
        runJob(ctx, job, opts.jobTimeoutMs, {
          workerId: opts.workerId,
          heartbeatMs: opts.heartbeatMs,
          abortGraceMs: opts.abortGraceMs,
          stuckAfterMs: opts.stuckAfterMs,
          onStuck: (j) => {
            stuck++;
            opts.onStuck?.(j);
          },
        })
          .catch((err: unknown) => {
            // complete_job / fail_job failed (the database went away): the row stays running and
            // claim_jobs() takes it back after the stale lock.
            ctx.log.error('job bookkeeping failed', { err, job_id: job.id });
            Sentry.captureException(err);
          })
          .finally(() => {
            active--;
            wake();
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

  /**
   * The poll, or less when a delayed job (a console call's ring end, a retry's backoff) falls due
   * first: its `run_after` passing sends no NOTIFY, so the loop wakes for it itself.
   */
  async function idleMs(): Promise<number> {
    if (!ctx.db.msUntilNextJob) return opts.pollIntervalMs;
    try {
      const ms = await ctx.db.msUntilNextJob();
      if (ms === null) return opts.pollIntervalMs;
      return Math.min(opts.pollIntervalMs, Math.max(0, Math.ceil(ms)) + 50);
    } catch (err) {
      ctx.log.warn('next job lookup failed', { err });
      return opts.pollIntervalMs;
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
      if (n === 0 || active >= opts.concurrency) await idle(await idleMs());
    }
  }

  return {
    get active() {
      return active;
    },
    get stuck() {
      return stuck;
    },
    tick,
    wake,
    start() {
      if (running) return;
      running = true;
      loop = mainLoop();
      if (opts.sweep !== false) {
        sweepTimer = setInterval(() => void sweep(), opts.sweepIntervalMs);
        void sweep();
      }
      ctx.log.info('runner started', {
        concurrency: opts.concurrency,
        worker_id: opts.workerId,
        poll_ms: opts.pollIntervalMs,
      });
    },
    async stop() {
      running = false;
      wake();
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
