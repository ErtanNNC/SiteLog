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
});
