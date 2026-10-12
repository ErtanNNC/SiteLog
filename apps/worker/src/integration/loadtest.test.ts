import { describe, expect, it } from 'vitest';
import { DEFAULTS, formatResult, parseArgs, percentiles, runLoadTest } from './loadtest';

describe('load test script', () => {
  it('parses options (scale-1 seconds, ranges, DATABASE_URL)', () => {
    const o = parseArgs(
      ['--', '--reports', '20', '--time-scale', '0.1', '--claude', '5-9', '--no-photo'],
      { DATABASE_URL: 'postgres://x' },
    );
    expect(o).toMatchObject({
      reports: 20,
      timeScale: 0.1,
      photoDelay: null,
      databaseUrl: 'postgres://x',
    });
    expect(o.latency.claude).toEqual([5, 9]);
    expect(o.latency.transcribe).toEqual(DEFAULTS.latency.transcribe);
    expect(() => parseArgs(['--time-scale', '2'])).toThrow(/time-scale/);
    expect(() => parseArgs(['--bogus'])).toThrow(/unknown option/);
  });

  it('computes nearest-rank percentiles and ignores missing values', () => {
    expect(percentiles([3, 1, 2, NaN, 10])).toEqual({ n: 4, p50: 2, p95: 10, max: 10 });
    expect(percentiles([])).toEqual({ n: 0, p50: null, p95: null, max: null });
  });

  it('pushes a handful of reports through the real job loop on PGlite', async () => {
    const r = await runLoadTest(
      {
        ...DEFAULTS,
        reports: 6,
        windowMin: 1,
        timeScale: 0.01,
        timeoutMin: 120,
        databaseUrl: null,
        think: [2, 5],
      },
      () => undefined,
    );
    expect(r.timedOut).toBe(false);
    expect(r.reports.closed).toBe(6);
    expect(r.reports.notClosed).toEqual([]);
    expect(r.jobs.dead).toBe(0); // (a retried job is possible: see the known races in RUNBOOK §7)
    expect(r.privacy.phoneLeaksToClaude).toBe(0);
    expect(r.projection.slotSecondsPerReportAtScale1).toBeGreaterThan(10);
    expect(formatResult(r)).toContain('500 reports in 30 min');
  }, 90_000);
});
