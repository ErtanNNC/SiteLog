import { describe, expect, it } from 'vitest';
import { registry } from './jobs/registry';
import { createRunner } from './runner';
import { createHarness } from './test/harness';

describe('runner', () => {
  it('claims the next job as soon as a slot frees up instead of waiting a poll interval', async () => {
    const h = createHarness();
    const finished: number[] = [];
    const original = registry.weekly_digest;
    registry.weekly_digest = async () => {
      await new Promise((r) => setTimeout(r, 50));
      finished.push(Date.now());
    };
    const runner = createRunner(h.ctx, {
      concurrency: 1,
      pollIntervalMs: 5_000,
      sweepIntervalMs: 60_000,
      jobTimeoutMs: 5_000,
      workerId: 'w-test',
    });
    try {
      await h.db.enqueueJob('weekly_digest', { orgId: h.org.id, weekStart: '2026-10-05' });
      await h.db.enqueueJob('weekly_digest', { orgId: h.org.id, weekStart: '2026-10-05' });
      const started = Date.now();
      runner.start();
      while (finished.length < 2 && Date.now() - started < 4_000) {
        await new Promise((r) => setTimeout(r, 20));
      }
      // With one slot, the second job used to wait for the full 5 s poll after the first finished.
      expect(finished).toHaveLength(2);
      expect(finished[1]! - started).toBeLessThan(1_500);
    } finally {
      await runner.stop();
      registry.weekly_digest = original;
    }
  });

  it('wakes for a delayed job when it falls due instead of sleeping the whole poll', async () => {
    const h = createHarness();
    let claims = 0;
    const claimJobs = h.db.claimJobs.bind(h.db);
    h.db.claimJobs = async (worker, limit) => {
      claims++;
      return claimJobs(worker, limit);
    };
    // A delayed job (a console call's ring end) due in 100 ms; its run_after sends no NOTIFY.
    h.db.msUntilNextJob = async () => 100;
    const runner = createRunner(h.ctx, {
      concurrency: 1,
      pollIntervalMs: 60_000,
      sweepIntervalMs: 60_000,
      jobTimeoutMs: 5_000,
      workerId: 'w-test',
    });
    try {
      runner.start();
      await new Promise((r) => setTimeout(r, 1_000));
      // Without the lookup the loop claims once and sleeps the 60 s poll.
      expect(claims).toBeGreaterThanOrEqual(3);
    } finally {
      await runner.stop();
    }
  });

  it('falls back to the poll when there is no delayed job or the lookup fails', async () => {
    const h = createHarness();
    let claims = 0;
    const claimJobs = h.db.claimJobs.bind(h.db);
    h.db.claimJobs = async (worker, limit) => {
      claims++;
      return claimJobs(worker, limit);
    };
    h.db.msUntilNextJob = async () => {
      throw new Error('database went away');
    };
    const runner = createRunner(h.ctx, {
      concurrency: 1,
      pollIntervalMs: 60_000,
      sweepIntervalMs: 60_000,
      jobTimeoutMs: 5_000,
      workerId: 'w-test',
    });
    try {
      runner.start();
      await new Promise((r) => setTimeout(r, 500));
      expect(claims).toBe(1);
    } finally {
      await runner.stop();
    }
  });
});
