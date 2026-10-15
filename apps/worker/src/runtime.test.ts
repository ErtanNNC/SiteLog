import { SmsSendError } from '@sitelog/shared';
import { describe, expect, it, vi } from 'vitest';
import { abortableFetch, currentSignal, runWithSignal } from './abort';
import { registry } from './jobs/registry';
import { createJobListener, listenBackoffMs, type ListenHandlers } from './listener';
import { silentLogger } from './log';
import { createRunner, runJob } from './runner';
import { createHarness, SITE_RIVERSIDE } from './test/harness';

/**
 * W1-10 worker runtime: the timeout race (docs/AUDIT_BACKLOG.md), the NOTIFY wake-up and the poll
 * fallback, the LISTEN reconnect, the `notify` job and the dead-job office notice.
 */

const until = async (cond: () => boolean, ms = 3_000) => {
  const start = Date.now();
  while (!cond()) {
    if (Date.now() - start > ms) throw new Error('timed out waiting');
    await new Promise((r) => setTimeout(r, 5));
  }
};

describe('abort: the job signal reaches the HTTP calls', () => {
  it('abortableFetch adds the running job signal, and only inside a job', async () => {
    const seen: Array<AbortSignal | null | undefined> = [];
    const base = (async (_u: unknown, init?: RequestInit) => {
      seen.push(init?.signal);
      return new Response('ok');
    }) as typeof fetch;
    const f = abortableFetch(base);
    await f('https://example.test/a');
    expect(seen[0]).toBeUndefined();
    const c = new AbortController();
    await runWithSignal(c.signal, async () => {
      expect(currentSignal()).toBe(c.signal);
      await f('https://example.test/b');
    });
    expect(seen[1]).toBe(c.signal);
    c.abort();
    expect(seen[1]!.aborted).toBe(true);
  });
});

describe('runJob: a timed-out job is aborted and never runs twice at once', () => {
  it('aborts the handler, keeps the row running until it settles, then fails it with the backoff', async () => {
    const h = createHarness();
    const original = registry.weekly_digest;
    let running = 0;
    let maxRunning = 0;
    let sawAbort = false;
    registry.weekly_digest = async (ctx) => {
      running++;
      maxRunning = Math.max(maxRunning, running);
      try {
        // A provider call that only stops when the job's signal aborts.
        await new Promise<void>((_, reject) => {
          ctx.signal.addEventListener('abort', () => {
            sawAbort = true;
            // The handler cleans up for a while after the abort.
            setTimeout(() => reject(ctx.signal.reason as Error), 60);
          });
        });
      } finally {
        running--;
      }
    };
    try {
      const id = await h.db.enqueueJob('weekly_digest', {
        orgId: h.org.id,
        weekStart: '2026-10-05',
      });
      const [job] = await h.db.claimJobs('w1', 1);
      const result = runJob(h.ctx, job!, 30, { workerId: 'w1', heartbeatMs: 10 });
      // After the timeout and before the handler settles: still running, still ours, not claimable.
      await until(() => sawAbort);
      expect(h.db.data.jobs.get(id)!.status).toBe('running');
      expect(await h.db.claimJobs('w2', 1)).toEqual([]);
      expect(await result).toMatchObject({ ok: false, timedOut: true });
      expect(maxRunning).toBe(1);
      const row = h.db.data.jobs.get(id)!;
      expect(row).toMatchObject({ status: 'queued', locked_by: null });
      expect(row.last_error).toMatch(/^JobTimeoutError: job \d+ exceeded 30 ms$/);
      expect(Date.parse(row.run_after) - h.now.getTime()).toBe(30_000);
    } finally {
      registry.weekly_digest = original;
    }
  });

  it('waits for a handler that ignores its signal, heartbeating, and reports it to Sentry', async () => {
    const h = createHarness();
    const original = registry.weekly_digest;
    let release!: () => void;
    registry.weekly_digest = () => new Promise<void>((r) => (release = r));
    const heartbeat = vi.spyOn(h.db, 'heartbeatJob');
    try {
      const id = await h.db.enqueueJob('weekly_digest', {
        orgId: h.org.id,
        weekStart: '2026-10-05',
      });
      const [job] = await h.db.claimJobs('w1', 1);
      const result = runJob(h.ctx, job!, 20, { workerId: 'w1', heartbeatMs: 10, abortGraceMs: 20 });
      await new Promise((r) => setTimeout(r, 120));
      expect(h.db.data.jobs.get(id)!.status).toBe('running');
      expect(heartbeat.mock.calls.length).toBeGreaterThan(3);
      expect(heartbeat).toHaveBeenCalledWith(id, 'w1');
      // It finished its work after all: done, not run again.
      release();
      expect(await result).toEqual({ ok: true, timedOut: true });
      expect(h.db.data.jobs.get(id)!.status).toBe('done');
    } finally {
      registry.weekly_digest = original;
    }
  });

  it('gives up on a handler that never settles: heartbeat stops, onStuck, the row left for the reclaim', async () => {
    const h = createHarness();
    const original = registry.weekly_digest;
    registry.weekly_digest = () => new Promise<void>(() => undefined);
    const heartbeat = vi.spyOn(h.db, 'heartbeatJob');
    const stuck: number[] = [];
    try {
      const id = await h.db.enqueueJob('weekly_digest', {
        orgId: h.org.id,
        weekStart: '2026-10-05',
      });
      const [job] = await h.db.claimJobs('w1', 1);
      void runJob(h.ctx, job!, 20, {
        workerId: 'w1',
        heartbeatMs: 10,
        abortGraceMs: 10,
        stuckAfterMs: 60,
        onStuck: (j) => stuck.push(j.id),
      });
      await until(() => stuck.length === 1, 2_000);
      expect(stuck).toEqual([id]);
      const beats = heartbeat.mock.calls.length;
      expect(beats).toBeGreaterThan(3);
      await new Promise((r) => setTimeout(r, 80));
      // No more heartbeats: locked_at ages and claim_jobs() takes the row back after the stale
      // lock (the worker process has exited by then). The row is not failed or completed here.
      expect(heartbeat.mock.calls.length).toBe(beats);
      expect(h.db.data.jobs.get(id)!.status).toBe('running');
    } finally {
      registry.weekly_digest = original;
    }
  });

  it('the runner counts a stuck job (for /health) and passes it to onStuck', async () => {
    const h = createHarness();
    const original = registry.weekly_digest;
    registry.weekly_digest = () => new Promise<void>(() => undefined);
    const stuck: number[] = [];
    const runner = createRunner(h.ctx, {
      concurrency: 1,
      pollIntervalMs: 10,
      sweepIntervalMs: 3_600_000,
      sweep: false,
      jobTimeoutMs: 20,
      workerId: 'w-stuck',
      heartbeatMs: 10,
      abortGraceMs: 10,
      stuckAfterMs: 30,
      onStuck: (j) => stuck.push(j.id),
    });
    try {
      const id = await h.db.enqueueJob('weekly_digest', {
        orgId: h.org.id,
        weekStart: '2026-10-05',
      });
      expect(runner.stuck).toBe(0);
      await runner.tick();
      await until(() => runner.stuck === 1, 2_000);
      expect(stuck).toEqual([id]);
    } finally {
      registry.weekly_digest = original;
    }
  });
});

describe('runner: NOTIFY wake-up and the poll fallback', () => {
  const opts = (pollIntervalMs: number) => ({
    concurrency: 2,
    pollIntervalMs,
    sweepIntervalMs: 3_600_000,
    jobTimeoutMs: 5_000,
    workerId: 'w-test',
  });

  it('claims a new job at once on wake(), long before the poll', async () => {
    const h = createHarness();
    const original = registry.weekly_digest;
    const ran: number[] = [];
    registry.weekly_digest = async (_c, _p, job) => {
      ran.push(job.id);
    };
    const runner = createRunner(h.ctx, opts(60_000));
    try {
      runner.start();
      await new Promise((r) => setTimeout(r, 30));
      const id = await h.db.enqueueJob('weekly_digest', {
        orgId: h.org.id,
        weekStart: '2026-10-05',
      });
      const started = Date.now();
      runner.wake();
      await until(() => ran.length === 1, 1_000);
      expect(ran).toEqual([id]);
      expect(Date.now() - started).toBeLessThan(500);
    } finally {
      await runner.stop();
      registry.weekly_digest = original;
    }
  });

  it('keeps a wake that arrives while it is claiming', async () => {
    const h = createHarness();
    const original = registry.weekly_digest;
    const ran: number[] = [];
    registry.weekly_digest = async (_c, _p, job) => {
      ran.push(job.id);
    };
    const claim = h.db.claimJobs.bind(h.db);
    let first = true;
    // The NOTIFY of a job enqueued just after the claim's snapshot lands mid-claim.
    h.db.claimJobs = async (w, n) => {
      const rows = await claim(w, n);
      if (first) {
        first = false;
        await h.db.enqueueJob('weekly_digest', { orgId: h.org.id, weekStart: '2026-10-12' });
        runner.wake();
      }
      return rows;
    };
    const runner = createRunner(h.ctx, opts(60_000));
    try {
      runner.start();
      await until(() => ran.length === 1, 1_000);
    } finally {
      await runner.stop();
      registry.weekly_digest = original;
    }
  });

  it('finds a job nobody announced by polling (no LISTEN, a missed NOTIFY)', async () => {
    const h = createHarness();
    const original = registry.weekly_digest;
    const ran: number[] = [];
    registry.weekly_digest = async (_c, _p, job) => {
      ran.push(job.id);
    };
    const runner = createRunner(h.ctx, opts(80));
    try {
      runner.start();
      await new Promise((r) => setTimeout(r, 20));
      await h.db.enqueueJob('weekly_digest', { orgId: h.org.id, weekStart: '2026-10-05' });
      const started = Date.now();
      await until(() => ran.length === 1, 1_000);
      const waited = Date.now() - started;
      expect(waited).toBeGreaterThan(20);
      expect(waited).toBeLessThan(500);
    } finally {
      await runner.stop();
      registry.weekly_digest = original;
    }
  });
});

describe('LISTEN: its own connection, reconnecting with backoff', () => {
  it('backs off 1 s doubling to 30 s', () => {
    expect([1, 2, 3, 4, 5, 6, 7].map(listenBackoffMs)).toEqual([
      1000, 2000, 4000, 8000, 16000, 30000, 30000,
    ]);
  });

  it('retries a failed connect, wakes on every (re)connect and on NOTIFY, reconnects after a close', async () => {
    const attempts: number[] = [];
    let handlers: ListenHandlers | null = null;
    let connects = 0;
    const events: string[] = [];
    const listener = createJobListener({
      connect: async (channel, h) => {
        expect(channel).toBe('jobs');
        connects++;
        if (connects <= 2) throw new Error('connection refused');
        handlers = h;
        return { close: async () => void events.push('closed') };
      },
      onNotify: (payload) => events.push(`notify:${payload}`),
      onConnected: () => events.push('connected'),
      log: silentLogger,
      backoffMs: (n) => {
        attempts.push(n);
        return 5;
      },
    });
    listener.start();
    await until(() => listener.connected);
    expect(attempts).toEqual([1, 2]);
    handlers!.onNotify('42');
    expect(events).toEqual(['connected', 'notify:42']);
    // The server goes away: reconnect from a fresh backoff.
    const before = handlers!;
    handlers!.onClose();
    expect(listener.connected).toBe(false);
    await until(() => listener.connected);
    expect(attempts).toEqual([1, 2, 1]);
    expect(events.filter((e) => e === 'connected')).toHaveLength(2);
    // A late notification of the dropped connection is ignored.
    before.onNotify('7');
    expect(events).not.toContain('notify:7');
    await listener.stop();
    expect(events.at(-1)).toBe('closed');
    expect(listener.connected).toBe(false);
  });
});

describe('notify job (§10.1, D48)', () => {
  it('sends the key through the Notifier once per dedupe key', async () => {
    const h = createHarness();
    h.db.data.orgs.get(h.org.id)!.is_demo = true;
    h.db.data.consents.push({
      id: 'c1',
      reporter_id: h.marco.id,
      type: 'sms',
      method: 'web_checkbox',
      text_version: 'v1',
      evidence: null,
      given_at: h.now.toISOString(),
      revoked_at: null,
    });
    const payload = {
      reporterId: h.marco.id,
      key: 'filed' as const,
      vars: { report_no: 'RL-2041-0188', pdf_link: 'https://go.sitelog.app/p/x' },
      dedupeKey: 'notify:filed:r1',
    };
    await h.runJob('notify', payload);
    await h.runJob('notify', payload);
    expect(h.sms.map((s) => s.body)).toEqual([
      'Filed: Daily Report RL-2041-0188. PDF: https://go.sitelog.app/p/x',
    ]);
    const [m] = [...h.db.data.messages.values()];
    expect(m).toMatchObject({ copy_key: 'filed', reporter_id: h.marco.id, status: 'delivered' });
  });

  it('tells the office when a real org has no SMS sender here (console)', async () => {
    const h = createHarness();
    h.db.data.consents.push({
      id: 'c1',
      reporter_id: h.marco.id,
      type: 'sms',
      method: 'web_checkbox',
      text_version: 'v1',
      evidence: null,
      given_at: h.now.toISOString(),
      revoked_at: null,
    });
    await h.runJob('notify', {
      reporterId: h.marco.id,
      key: 'filed',
      vars: { report_no: 'RL-2041-0188', pdf_link: 'https://go.sitelog.app/p/x' },
      dedupeKey: 'notify:filed:r1',
    });
    expect(h.sms).toEqual([]);
    expect(h.db.data.notifications).toEqual([
      expect.objectContaining({ kind: 'message_failed', target_path: '/team' }),
    ]);
    expect(h.db.data.audit.map((a) => a.action)).toContain('notify.failed');
  });

  const consentedDemo = () => {
    const h = createHarness();
    h.db.data.orgs.get(h.org.id)!.is_demo = true;
    h.db.data.consents.push({
      id: 'c1',
      reporter_id: h.marco.id,
      type: 'sms',
      method: 'web_checkbox',
      text_version: 'v1',
      evidence: null,
      given_at: h.now.toISOString(),
      revoked_at: null,
    });
    return h;
  };
  const notifyPayload = (h: ReturnType<typeof createHarness>) => ({
    reporterId: h.marco.id,
    key: 'filed' as const,
    vars: { report_no: 'RL-2041-0188', pdf_link: 'https://go.sitelog.app/p/x' },
    dedupeKey: 'notify:filed:r1',
  });

  it('a permanent refusal (undeliverable number) tells the office once and completes without a retry', async () => {
    const h = consentedDemo();
    h.failSms(
      new SmsSendError("twilio 400 21211: The 'To' number is not a valid phone number", {
        driver: 'console',
        retryable: false,
        undeliverable: true,
        code: '21211',
      }),
    );
    const id = await h.db.enqueueJob('notify', notifyPayload(h));
    const [job] = await h.db.claimJobs('w1', 1);
    expect(await runJob(h.ctx, job!, 5_000, { workerId: 'w1' })).toEqual({ ok: true });
    expect(h.db.data.jobs.get(id)!.status).toBe('done');
    expect(h.db.data.notifications).toEqual([
      expect.objectContaining({ kind: 'message_failed', target_path: '/team' }),
    ]);
    expect(h.db.data.notifications[0]!.body).toContain('refused their number');
    const failed = h.db.data.audit.filter((a) => a.action === 'notify.failed');
    expect(failed).toHaveLength(1);
    expect(failed[0]!.diff).toMatchObject({ key: 'filed', dedupe_key: 'notify:filed:r1' });
    expect(h.sms).toEqual([]);
  });

  it('a provider outage (retryable) fails the job for the 30 s backoff and tells nobody yet', async () => {
    const h = consentedDemo();
    h.failSms(
      new SmsSendError('twilio 429: Too Many Requests', { driver: 'console', retryable: true }),
    );
    const id = await h.db.enqueueJob('notify', notifyPayload(h));
    const [job] = await h.db.claimJobs('w1', 1);
    const result = await runJob(h.ctx, job!, 5_000, { workerId: 'w1' });
    expect(result.ok).toBe(false);
    expect(result.error).toContain('SmsSendError');
    const row = h.db.data.jobs.get(id)!;
    expect(row.status).toBe('queued');
    expect(new Date(row.run_after).getTime() - h.now.getTime()).toBe(30_000);
    expect(h.db.data.notifications).toEqual([]);
    expect(h.db.data.audit.map((a) => a.action)).not.toContain('notify.failed');
  });
});

describe('dead jobs (§10.1): the office is told, no WhatsApp error_retry', () => {
  it('a reporter-facing message job that dies notifies the office (message_failed) and is audited', async () => {
    const h = createHarness();
    const original = registry.send_welcome;
    registry.send_welcome = async () => {
      throw new Error('provider down');
    };
    try {
      const id = await h.db.enqueueJob('send_welcome', {
        reporterId: h.marco.id,
        siteId: SITE_RIVERSIDE,
      });
      h.db.data.jobs.get(id)!.attempts = 5;
      const [job] = await h.db.claimJobs('w1', 1);
      expect(job!.attempts).toBe(6);
      expect(await runJob(h.ctx, job!, 5_000)).toMatchObject({ ok: false });
      expect(h.db.data.jobs.get(id)!.status).toBe('dead');
      expect(h.wa.sent).toEqual([]);
      expect(h.db.data.notifications).toEqual([
        expect.objectContaining({
          org_id: h.org.id,
          kind: 'message_failed',
          title: `${h.marco.name}: a message to them was not sent`,
          target_path: '/team',
        }),
      ]);
      expect(h.db.data.audit.find((a) => a.action === 'job.dead')).toMatchObject({
        org_id: h.org.id,
        entity: 'reporter',
        entity_id: h.marco.id,
        diff: { job_id: id, type: 'send_welcome', attempts: 6, notified: 'message_failed' },
      });
    } finally {
      registry.send_welcome = original;
    }
  });

  it('a report step that dies notifies the office (processing_failed); an office-only job does not', async () => {
    const h = createHarness();
    const siteDay = await h.db.getOrCreateSiteDay(
      SITE_RIVERSIDE,
      '2026-10-09',
      new Date('2026-10-09T22:30:00Z'),
    );
    const report = await h.db.insertReport({
      org_id: h.org.id,
      site_id: SITE_RIVERSIDE,
      site_day_id: siteDay.id,
      report_no: 'RL-2041-0187',
      reporter_id: h.marco.id,
      received_at: '2026-10-09T22:00:00Z',
      kind: 'daily',
      status: 'processing',
    });
    const originals = { extract: registry.extract_report, digest: registry.weekly_digest };
    registry.extract_report = async () => {
      throw new Error('model down');
    };
    registry.weekly_digest = async () => {
      throw new Error('smtp down');
    };
    try {
      for (const [type, payload] of [
        ['extract_report', { reportId: report.id }],
        ['weekly_digest', { orgId: h.org.id, weekStart: '2026-10-05' }],
      ] as const) {
        const id = await h.db.enqueueJob(type, payload);
        h.db.data.jobs.get(id)!.attempts = 5;
        const [job] = await h.db.claimJobs('w1', 1);
        await runJob(h.ctx, job!, 5_000);
        expect(h.db.data.jobs.get(id)!.status).toBe('dead');
      }
      expect(h.db.data.notifications).toEqual([
        expect.objectContaining({
          kind: 'processing_failed',
          title: `${report.report_no}: processing stopped`,
          target_path: `/reports/${report.id}`,
        }),
      ]);
      expect(h.db.data.audit.filter((a) => a.action === 'job.dead').map((a) => a.diff)).toEqual([
        expect.objectContaining({ type: 'extract_report', notified: 'processing_failed' }),
        expect.objectContaining({ type: 'weekly_digest', notified: null }),
      ]);
    } finally {
      registry.extract_report = originals.extract;
      registry.weekly_digest = originals.digest;
    }
  });
});
