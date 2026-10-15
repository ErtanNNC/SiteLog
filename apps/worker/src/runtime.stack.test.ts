import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Sql } from 'postgres';
import { connectStack, STACK_DB_URL } from '../../../supabase/db-tests/stack/db.ts';
import { NEVER_ABORTED } from './abort';
import { testConfig } from './config';
import { createMetrics, type Ctx } from './context';
import { connectDb, type Db } from './db';
import { registry } from './jobs/registry';
import { createJobListener, postgresListenConnect, type JobListener } from './listener';
import { silentLogger } from './log';
import { createRunner, type Runner } from './runner';

/**
 * W1-10 on real Postgres (`pnpm test:stack`, CI's e2e-supabase job; skipped without
 * SUPABASE_DB_URL): the runner and the LISTEN connection against the stack's claim_jobs(),
 * enqueue_job() and its NOTIFY.
 *
 * - 100 jobs, two workers of concurrency 4 (separate pools and LISTEN connections), polling only
 *   once a minute: every job runs exactly once, at most 4 at a time per worker, woken by NOTIFY.
 * - The LISTEN wake-up, the reconnect after the server drops the LISTEN connection, and the poll
 *   fallback (500 ms here; 5 s by default) for a job that comes due later (no NOTIFY).
 *
 * The suite's jobs are `weekly_digest` jobs of a made-up org with a test handler. Other due jobs of
 * the stack (seed rows, earlier suites) are moved an hour into the future while it runs and moved
 * back after, so no other handler runs here. It runs before CI starts the real worker.
 */

const describeStack = STACK_DB_URL ? describe : describe.skip;
const ORG = randomUUID();
const PARKED = interval(3600);

function interval(s: number): string {
  return `${s} seconds`;
}

interface Worker {
  db: Db;
  runner: Runner;
  listener: JobListener;
  maxActive: number;
}

describeStack('worker runtime on real Postgres (W1-10)', () => {
  let sql: Sql;
  let parked: string[] = [];
  const runs = new Map<number, number>();
  const ranBy = new Map<number, string>();
  const original = registry.weekly_digest;
  const workers: Worker[] = [];

  function ctxFor(db: Db): Ctx {
    return {
      config: testConfig(),
      db,
      log: silentLogger,
      now: () => new Date(),
      metrics: createMetrics(),
      signal: NEVER_ABORTED,
    } as unknown as Ctx;
  }

  async function startWorker(name: string, pollIntervalMs: number, backoffMs = 1000) {
    const db = connectDb(STACK_DB_URL!, { max: 6 });
    const w: Worker = { db, maxActive: 0 } as Worker;
    w.runner = createRunner(ctxFor(db), {
      concurrency: 4,
      pollIntervalMs,
      sweepIntervalMs: 3_600_000,
      sweep: false,
      jobTimeoutMs: 30_000,
      workerId: name,
    });
    w.listener = createJobListener({
      connect: postgresListenConnect(STACK_DB_URL!),
      onNotify: () => w.runner.wake(),
      onConnected: () => w.runner.wake(),
      log: silentLogger,
      backoffMs: () => backoffMs,
    });
    workers.push(w);
    w.runner.start();
    w.listener.start();
    const deadline = Date.now() + 10_000;
    while (!w.listener.connected && Date.now() < deadline) await sleep(20);
    expect(w.listener.connected).toBe(true);
    return w;
  }

  async function stopWorkers() {
    for (const w of workers.splice(0)) {
      await w.listener.stop();
      await w.runner.stop();
      await w.db.close();
    }
  }

  async function enqueue(n: number, runAfterS: number | null = null): Promise<number[]> {
    const rows = await sql<{ id: string }[]>`
      select enqueue_job('weekly_digest',
                         jsonb_build_object('orgId', ${ORG}::text, 'weekStart', '2026-10-05', 'n', g),
                         ${runAfterS === null ? null : new Date(Date.now() + runAfterS * 1000)},
                         null)::text as id
      from generate_series(1, ${n}) g`;
    return rows.map((r) => Number(r.id));
  }

  async function waitDone(ids: number[], ms: number): Promise<void> {
    const deadline = Date.now() + ms;
    while (Date.now() < deadline) {
      const [row] = await sql<{ n: number }[]>`
        select count(*)::int as n from jobs where id in ${sql(ids)} and status = 'done'`;
      if (row!.n === ids.length) return;
      await sleep(50);
    }
  }

  beforeAll(async () => {
    sql = connectStack(4);
    parked = (
      await sql<{ id: string }[]>`
        update jobs set run_after = run_after + ${PARKED}::interval
        where status = 'queued' and run_after <= now() + interval '10 minutes'
        returning id::text`
    ).map((r) => r.id);
    registry.weekly_digest = async (ctx, payload, job) => {
      if (payload.orgId !== ORG) throw new Error('not this suite’s job');
      const w = workers.find((x) => x.db === ctx.db)!;
      runs.set(job.id, (runs.get(job.id) ?? 0) + 1);
      ranBy.set(job.id, job.locked_by ?? '?');
      w.maxActive = Math.max(w.maxActive, w.runner.active);
      await sleep(5 + Math.floor(Math.random() * 20));
    };
  });

  afterAll(async () => {
    await stopWorkers();
    registry.weekly_digest = original;
    if (sql) {
      await sql`delete from jobs where payload->>'orgId' = ${ORG}`;
      if (parked.length > 0)
        await sql`
          update jobs set run_after = run_after - ${PARKED}::interval
          where id in ${sql(parked.map(Number))}`;
      await sql.end({ timeout: 5 });
    }
  });

  it('runs 100 jobs exactly once with two workers of concurrency 4, woken by NOTIFY', async () => {
    runs.clear();
    // A poll a minute apart: only NOTIFY (and a finished job) wakes the loops.
    const a = await startWorker('stack-a', 60_000);
    const b = await startWorker('stack-b', 60_000);
    const started = Date.now();
    const ids = [...(await enqueue(40)), ...(await enqueue(60))];
    expect(new Set(ids).size).toBe(100);
    await waitDone(ids, 30_000);
    const elapsed = Date.now() - started;
    expect([...runs.keys()].sort((x, y) => x - y)).toEqual([...ids].sort((x, y) => x - y));
    expect([...runs.values()].every((n) => n === 1)).toBe(true);
    const rows = await sql<{ status: string; attempts: number }[]>`
      select status::text, attempts from jobs where id in ${sql(ids)}`;
    expect(rows.every((r) => r.status === 'done' && r.attempts === 1)).toBe(true);
    expect(a.maxActive).toBeLessThanOrEqual(4);
    expect(b.maxActive).toBeLessThanOrEqual(4);
    // Both workers took part, and nothing waited for the minute-long poll.
    expect(new Set(ranBy.values())).toEqual(new Set(['stack-a', 'stack-b']));
    expect(elapsed).toBeLessThan(30_000);
    await stopWorkers();
  });

  it('wakes on NOTIFY, and again after the server drops the LISTEN connection', async () => {
    runs.clear();
    const w = await startWorker('stack-listen', 60_000, 100);
    const [first] = await enqueue(1);
    const t0 = Date.now();
    await waitDone([first!], 5_000);
    expect(runs.get(first!)).toBe(1);
    expect(Date.now() - t0).toBeLessThan(5_000);

    // The server ends the LISTEN session (a restart, a failover): the listener reconnects.
    const killed = await sql<{ pid: number }[]>`
      select pg_terminate_backend(pid) as ok, pid from pg_stat_activity
      where application_name = 'sitelog-worker-listen' and pid <> pg_backend_pid()`;
    expect(killed.length).toBeGreaterThan(0);
    const deadline = Date.now() + 10_000;
    while (w.listener.connected && Date.now() < deadline) await sleep(20);
    while (!w.listener.connected && Date.now() < deadline) await sleep(20);
    expect(w.listener.connected).toBe(true);
    const [second] = await enqueue(1);
    const t1 = Date.now();
    await waitDone([second!], 5_000);
    expect(runs.get(second!)).toBe(1);
    expect(Date.now() - t1).toBeLessThan(5_000);
    await stopWorkers();
  });

  it('finds a job that comes due later (no NOTIFY) by the poll fallback', async () => {
    runs.clear();
    await startWorker('stack-poll', 500);
    const [later] = await enqueue(1, 1);
    await waitDone([later!], 6_000);
    expect(runs.get(later!)).toBe(1);
    await stopWorkers();
  });
});

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
