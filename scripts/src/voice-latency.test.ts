import { describe, expect, it } from 'vitest';
import { CallMetricsSchema } from '@sitelog/shared';
import {
  CALLS_SQL,
  F6_TARGETS,
  failsTargets,
  formatSummary,
  parseLatencyArgs,
  percentile,
  refuseLatencyTarget,
  runVoiceLatency,
  sampleOf,
  summarizeRows,
  type CallRow,
} from './voice-latency.ts';

/**
 * W3-16: `pnpm voice:latency` without a database: the period, the metrics as the agent writes
 * them (`CallMetricsSchema`, metrics.py), the pooling per transport and language, F6's flags, and
 * that the only database access is one SELECT inside the read-only runner.
 */

const NOW = new Date('2026-10-17T15:00:00Z');

/** An `end_call` metrics object exactly as the contract has it (validated). */
function metrics(p50: number | null, p95: number | null, interruptions = 0, turns = 6) {
  return CallMetricsSchema.parse({
    latencyP50Ms: p50,
    latencyP95Ms: p95,
    interruptions,
    sttConfidence: 0.91,
    turns,
  });
}

let n = 0;
function row(
  transport: 'pstn' | 'web',
  language: string | null,
  m: unknown,
  duration: number | null = 240,
): CallRow {
  n += 1;
  return {
    id: `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`,
    transport,
    language,
    duration_s: duration,
    outcome: 'filed',
    metrics: m,
  };
}

describe('parseLatencyArgs', () => {
  it('defaults to the last 7 days, today included (UTC)', () => {
    expect(parseLatencyArgs([], NOW)).toMatchObject({ from: '2026-10-11', to: '2026-10-18' });
    expect(parseLatencyArgs(['--', '--days', '1'], NOW)).toMatchObject({
      from: '2026-10-17',
      to: '2026-10-18',
    });
  });
  it('takes --from/--to, --json and --check', () => {
    expect(
      parseLatencyArgs(['--from=2026-10-19', '--to', '2026-10-21', '--json', '--check'], NOW),
    ).toEqual({ from: '2026-10-19', to: '2026-10-21', json: true, check: true });
    expect(parseLatencyArgs(['--from', '2026-10-01'], NOW).to).toBe('2026-10-18');
  });
  it('refuses bad input', () => {
    expect(() => parseLatencyArgs(['--days', '0'], NOW)).toThrow(/--days/);
    expect(() => parseLatencyArgs(['--days', '2', '--from', '2026-10-01'], NOW)).toThrow(
      /not both/,
    );
    expect(() => parseLatencyArgs(['--from', '10/01/2026'], NOW)).toThrow(/YYYY-MM-DD/);
    expect(() => parseLatencyArgs(['--from', '2026-10-05', '--to', '2026-10-05'], NOW)).toThrow(
      /not before/,
    );
    expect(() => parseLatencyArgs(['--write'], NOW)).toThrow(/unknown argument/);
  });
});

describe('percentile (nearest rank, as metrics.py)', () => {
  it('matches the agent', () => {
    expect(percentile([], 50)).toBeNull();
    expect(percentile([900], 95)).toBe(900);
    expect(percentile([400, 100, 300, 200], 50)).toBe(200);
    expect(percentile([1, 2, 3, 4, 5, 6, 7, 8, 9, 10], 95)).toBe(10);
  });
});

describe('sampleOf', () => {
  it('reads end_call metrics, the transport and the language', () => {
    const s = sampleOf(row('pstn', 'es-US', metrics(950, 2100, 2)));
    expect(s).toMatchObject({
      transport: 'sip',
      language: 'es',
      p50: 950,
      p95: 2100,
      interruptions: 2,
      backstopOnly: false,
    });
    expect(sampleOf(row('web', 'tr', metrics(null, null, 0, 0))).p50).toBeNull();
  });
  it('a backstop-only row has no latency; an unknown shape is never guessed', () => {
    const b = sampleOf(
      row('pstn', 'en', { backstop: { event: 'room_finished', outcome: 'abandoned' } }),
    );
    expect(b).toMatchObject({ backstopOnly: true, p50: null, interruptions: null });
    expect(sampleOf(row('web', null, ['x'])).language).toBe('??');
    expect(sampleOf(row('web', 'en', { latencyP50Ms: '900' })).p50).toBeNull();
  });
});

describe('summarizeRows', () => {
  const rows = [
    row('pstn', 'en', metrics(800, 1900, 1), 300),
    row('pstn', 'en', metrics(1000, 2200, 0), 330),
    row('pstn', 'en', metrics(1500, 3100, 3), 420),
    row('web', 'en', metrics(700, 1500, 0), 200),
    row('web', 'tr', metrics(1300, 2600, 1), 380),
    row('pstn', 'es', { backstop: { event: 'room_finished' } }, 90),
  ];
  const groups = summarizeRows(rows);

  it('one row per transport × language, then the total', () => {
    expect(groups.map((g) => `${g.transport}/${g.language}:${g.calls}`)).toEqual([
      'sip/en:3',
      'sip/es:1',
      'web/en:1',
      'web/tr:1',
      'all/all:6',
    ]);
  });

  it("pools the calls' percentiles and flags F6's targets", () => {
    const sipEn = groups[0]!;
    expect(sipEn).toMatchObject({
      measured: 3,
      latencyBasis: 'calls',
      latencyP50Ms: 1000,
      latencyP95Ms: 3100,
      interruptionsP50: 1,
      durationP50S: 330,
    });
    expect(sipEn.verdicts).toEqual({
      latencyP50: 'ok',
      latencyP95: 'over',
      bargeIn: 'n/a',
      duration: 'ok',
    });
    expect(groups[1]).toMatchObject({ measured: 0, backstopOnly: 1, latencyBasis: 'none' });
    expect(groups[1]!.verdicts.latencyP50).toBe('n/a');
    expect(groups[3]!.verdicts).toMatchObject({ latencyP50: 'over', duration: 'over' });
    const total = groups.at(-1)!;
    expect(total).toMatchObject({ measured: 5, latencyP50Ms: 1000, latencyP95Ms: 3100 });
    expect(failsTargets(groups)).toBe(true);
    expect(failsTargets(summarizeRows(rows.slice(3, 4)))).toBe(false);
  });

  it('pools per-turn samples and barge-in times when every call has them (§19 Q226)', () => {
    const g = summarizeRows([
      row('web', 'en', { ...metrics(600, 900), latenciesMs: [500, 600, 900], bargeInMs: [180] }),
      row('web', 'en', {
        ...metrics(1400, 1600),
        latenciesMs: [1300, 1400, 1600],
        bargeInMs: [250, 420],
      }),
    ])[0]!;
    expect(g).toMatchObject({
      latencyBasis: 'turns',
      latencyP50Ms: 900,
      latencyP95Ms: 1600,
      bargeInP50Ms: 250,
      bargeInP95Ms: 420,
    });
    expect(g.verdicts.bargeIn).toBe('over');
  });

  it("reads the agent's end_call metrics with samples and prints no pooling notes (§19 Q226)", () => {
    // The shape `metrics.py` sends since Q226 (always both lists, possibly empty).
    const withSamples = summarizeRows([
      row('pstn', 'en', { ...metrics(700, 900), latenciesMs: [600, 700, 900], bargeInMs: [210] }),
      row('pstn', 'en', { ...metrics(800, 800), latenciesMs: [800], bargeInMs: [] }),
    ]);
    expect(withSamples.at(-1)).toMatchObject({
      latencyBasis: 'turns',
      bargeInP95Ms: 210,
      verdicts: { bargeIn: 'ok' },
    });
    const text = formatSummary({ from: 'a', to: 'b', json: false, check: false }, withSamples).join(
      '\n',
    );
    expect(text).not.toContain('Latency pooled per call');
    expect(text).not.toContain('Barge-in: not measured');
  });

  it('prints the table with the notes', () => {
    const text = formatSummary(
      { from: '2026-10-19', to: '2026-10-20', json: false, check: false },
      groups,
    ).join('\n');
    expect(text).toContain('calls created 2026-10-19 … 2026-10-20');
    expect(text).toContain(`p50 ≤ ${F6_TARGETS.latencyP50Ms} ms`);
    expect(text).toMatch(/^sip\s+en\s+3\s+3 \(calls\)\s+1000 ms ok\s+3100 ms OVER/m);
    expect(text).toContain('Barge-in: not measured');
    expect(text).toContain('1 call(s) ended by the voice-events backstop');
    expect(
      formatSummary({ from: 'a', to: 'b', json: false, check: false }, summarizeRows([])).join(
        '\n',
      ),
    ).toContain('No answered calls in this period.');
  });
});

describe('runVoiceLatency', () => {
  it('reads with one SELECT through the read-only runner, never printing the password', async () => {
    const seen: { sql: string; params: readonly unknown[]; url: string }[] = [];
    const lines: string[] = [];
    const { exitCode, groups } = await runVoiceLatency(['--days', '2', '--check'], {
      env: {
        SUPABASE_DB_URL:
          'postgresql://postgres.abcdefghijklmnopqrst:s3cret@aws-0.pooler.supabase.com:5432/postgres',
      },
      now: NOW,
      log: (l) => lines.push(l),
      readOnly: async (url, fn) =>
        fn(async (sql, params) => {
          seen.push({ sql, params, url });
          return [row('web', 'en', metrics(900, 1800, 0), 250)];
        }),
    });
    expect(seen).toHaveLength(1);
    expect(seen[0]!.sql).toBe(CALLS_SQL);
    expect(seen[0]!.params).toEqual(['2026-10-16', '2026-10-18']);
    expect(CALLS_SQL.trim().toLowerCase().startsWith('select')).toBe(true);
    expect(CALLS_SQL).not.toMatch(/\b(insert|update|delete|alter|create|drop|truncate|grant)\b/i);
    expect(lines.join('\n')).not.toContain('s3cret');
    expect(lines[0]).toContain('read-only');
    expect(lines[0]).toContain('Supabase project abcdefghijklmnopqrst');
    expect(exitCode).toBe(0);
    expect(groups.at(-1)!.latencyP50Ms).toBe(900);
  });

  it('--check exits 1 when a measured target is over; --json prints JSON only', async () => {
    const lines: string[] = [];
    const { exitCode } = await runVoiceLatency(['--check', '--json'], {
      env: { DB_URL: 'postgresql://postgres:postgres@127.0.0.1:54322/postgres' },
      now: NOW,
      log: (l) => lines.push(l),
      readOnly: async (_url, fn) => fn(async () => [row('pstn', 'en', metrics(1800, 4000), 200)]),
    });
    expect(exitCode).toBe(1);
    expect(lines).toHaveLength(1);
    expect(JSON.parse(lines[0]!).groups.at(-1).verdicts.latencyP50).toBe('over');
  });

  it('refuses without a postgres URL, before connecting', async () => {
    expect(refuseLatencyTarget(undefined)).toMatch(/SUPABASE_DB_URL is not set/);
    expect(refuseLatencyTarget('https://x.supabase.co')).toMatch(/postgres:\/\//);
    await expect(
      runVoiceLatency([], {
        env: {},
        log: () => undefined,
        readOnly: () => {
          throw new Error('connected');
        },
      }),
    ).rejects.toThrow(/SUPABASE_DB_URL is not set/);
  });
});
