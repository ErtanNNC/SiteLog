/**
 * W3-16 · `pnpm voice:latency`: the calls' quality numbers of a period against F6's targets
 * (spec F6 acceptance, §16.2 M7 "latency ≤ 1.2 s p50 measured", §17 Voice).
 *
 *   SUPABASE_DB_URL='<db>' pnpm voice:latency                       # the last 7 days (UTC)
 *   SUPABASE_DB_URL='<db>' pnpm voice:latency -- --days 1
 *   SUPABASE_DB_URL='<db>' pnpm voice:latency -- --from 2026-10-19 --to 2026-10-20
 *   … -- --json            # the summary as JSON;  … -- --check   # exit 1 when a measured target fails
 *
 * Read-only, always: the session is opened with `default_transaction_read_only = on` and the one
 * SELECT runs in a `read only` transaction, so the script cannot write to any database, local or
 * hosted. It prints the target (never the password) before it connects.
 *
 * What it reads: `calls.metrics` as the agent's `end_call` writes it (`CallMetricsSchema`,
 * `apps/voice-agent/src/sitelog_voice/metrics.py`): per call `latencyP50Ms` / `latencyP95Ms`
 * (the reporter's end of speech → the agent's first audio, nearest rank), `interruptions`,
 * `sttConfidence`, `turns`; plus `calls.transport` (`pstn` = the number, shown as `sip`; `web` =
 * Talk now), `calls.language` and `calls.duration_s`, of every call with metrics (an ended call;
 * the seeded demo calls have none). A row the W3-04 backstop ended (no `end_call`) has only
 * `metrics.backstop` and counts as a call without latency.
 *
 * The agent stores each call's percentiles, not its turns, so the group's figures are pooled per
 * call: "p50" is the median of the calls' p50s, "p95" the 95th percentile of the calls' p95s
 * (spec §19 Q226 asks for the per-turn samples, which this script already reads when a row holds
 * `latenciesMs`). Barge-in: the agent counts interruptions but records no stop time, so the
 * 300 ms target reads "not measured" until it does (§19 Q226; read from `bargeInMs` when present).
 */
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describeTarget } from './seed-target.ts';

/** F6 acceptance: latency ≤ 1.2 s p50 / 2.5 s p95; barge-in stops TTS within 300 ms; ≤ 6 min. */
export const F6_TARGETS = {
  latencyP50Ms: 1200,
  latencyP95Ms: 2500,
  bargeInMs: 300,
  /** "full call ≤ 6 min for a typical report": the median call. */
  durationP50S: 360,
} as const;

export interface LatencyArgs {
  from: string;
  to: string;
  json: boolean;
  check: boolean;
}

const DAY_MS = 86_400_000;
const isDate = (s: string) => /^\d{4}-\d{2}-\d{2}$/.test(s) && !Number.isNaN(Date.parse(s));

/** `--from/--to` (UTC dates, `to` exclusive; `--to` defaults to tomorrow) or `--days N` (default 7). */
export function parseLatencyArgs(argv: readonly string[], now = new Date()): LatencyArgs {
  const rest = argv.filter((a) => a !== '--');
  let from: string | undefined;
  let to: string | undefined;
  let days: number | undefined;
  let json = false;
  let check = false;
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i]!;
    const value = (name: string) => {
      const eq = a.indexOf('=');
      if (eq > 0) return a.slice(eq + 1);
      const next = rest[i + 1];
      if (next === undefined || next.startsWith('--')) throw new Error(`${name} needs a value`);
      i += 1;
      return next;
    };
    if (a === '--json') json = true;
    else if (a === '--check') check = true;
    else if (a === '--from' || a.startsWith('--from=')) from = value('--from');
    else if (a === '--to' || a.startsWith('--to=')) to = value('--to');
    else if (a === '--days' || a.startsWith('--days=')) {
      const v = value('--days');
      if (!/^\d+$/.test(v) || Number(v) < 1 || Number(v) > 366)
        throw new Error(`--days takes 1 to 366 (got "${v}")`);
      days = Number(v);
    } else throw new Error(`unknown argument ${a}`);
  }
  if (days !== undefined && (from !== undefined || to !== undefined))
    throw new Error('--days or --from/--to, not both');
  for (const [name, v] of [
    ['--from', from],
    ['--to', to],
  ] as const)
    if (v !== undefined && !isDate(v)) throw new Error(`${name} takes YYYY-MM-DD (got "${v}")`);
  const tomorrow = new Date(
    Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()) + DAY_MS,
  );
  const iso = (d: Date) => d.toISOString().slice(0, 10);
  const end = to ?? iso(tomorrow);
  const start = from ?? iso(new Date(Date.parse(end) - (days ?? 7) * DAY_MS));
  if (Date.parse(start) >= Date.parse(end))
    throw new Error(`--from ${start} is not before --to ${end}`);
  return { from: start, to: end, json, check };
}

/** One `calls` row as the query returns it. */
export interface CallRow {
  id: string;
  transport: string;
  language: string | null;
  duration_s: number | null;
  outcome: string | null;
  metrics: unknown;
}

/** The select (read-only; `$1` from inclusive, `$2` to exclusive, UTC dates). */
export const CALLS_SQL = `select c.id::text as id, c.transport::text as transport, c.language,
       c.duration_s, c.outcome::text as outcome, c.metrics
  from calls c
 where c.created_at >= $1::date and c.created_at < $2::date
   and c.metrics is not null
 order by c.created_at`;

/** Nearest-rank percentile, as the agent's `metrics.percentile`; null for no values. */
export function percentile(values: readonly number[], p: number): number | null {
  if (values.length === 0) return null;
  const ordered = [...values].sort((a, b) => a - b);
  const rank = Math.max(1, Math.ceil((p / 100) * ordered.length));
  return ordered[rank - 1]!;
}

const num = (v: unknown): number | null =>
  typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : null;
const nums = (v: unknown): number[] =>
  Array.isArray(v) ? v.map(num).filter((x): x is number => x !== null) : [];

/** What one call adds to its group (unknown shapes are read as "no value", never guessed). */
export interface CallSample {
  transport: 'sip' | 'web';
  language: string;
  p50: number | null;
  p95: number | null;
  /** Per-turn latencies, when the row holds them (§19 Q226). */
  turnLatencies: number[];
  bargeIns: number[];
  interruptions: number | null;
  turns: number | null;
  durationS: number | null;
  backstopOnly: boolean;
}

export function sampleOf(row: CallRow): CallSample {
  const m =
    row.metrics && typeof row.metrics === 'object' && !Array.isArray(row.metrics)
      ? (row.metrics as Record<string, unknown>)
      : {};
  return {
    transport: row.transport === 'web' ? 'web' : 'sip',
    language: (row.language ?? '').slice(0, 2).toLowerCase() || '??',
    p50: num(m.latencyP50Ms),
    p95: num(m.latencyP95Ms),
    turnLatencies: nums(m.latenciesMs),
    bargeIns: nums(m.bargeInMs),
    interruptions: num(m.interruptions),
    turns: num(m.turns),
    durationS: num(row.duration_s),
    backstopOnly: 'backstop' in m && !('turns' in m),
  };
}

export type Verdict = 'ok' | 'over' | 'n/a';

export interface GroupSummary {
  transport: 'sip' | 'web' | 'all';
  language: string;
  calls: number;
  /** Calls with a latency (an `end_call` with at least one answered turn). */
  measured: number;
  backstopOnly: number;
  /** "turns" when per-turn samples were pooled, else "calls" (the calls' own percentiles). */
  latencyBasis: 'turns' | 'calls' | 'none';
  latencyP50Ms: number | null;
  latencyP95Ms: number | null;
  bargeInP50Ms: number | null;
  bargeInP95Ms: number | null;
  interruptionsP50: number | null;
  interruptionsP95: number | null;
  durationP50S: number | null;
  durationP95S: number | null;
  verdicts: { latencyP50: Verdict; latencyP95: Verdict; bargeIn: Verdict; duration: Verdict };
}

const verdict = (value: number | null, max: number): Verdict =>
  value === null ? 'n/a' : value <= max ? 'ok' : 'over';

export function summarize(
  samples: readonly CallSample[],
  transport: GroupSummary['transport'],
  language: string,
): GroupSummary {
  const turnPool = samples.flatMap((s) => s.turnLatencies);
  // Per-turn samples only when every measured call has them; a mix would weigh calls unevenly.
  const measured = samples.filter((s) => s.p50 !== null || s.turnLatencies.length > 0);
  const allTurns = measured.length > 0 && measured.every((s) => s.turnLatencies.length > 0);
  const p50s = measured.map((s) => s.p50).filter((x): x is number => x !== null);
  const p95s = measured.map((s) => s.p95).filter((x): x is number => x !== null);
  const latencyP50Ms = allTurns ? percentile(turnPool, 50) : percentile(p50s, 50);
  const latencyP95Ms = allTurns ? percentile(turnPool, 95) : percentile(p95s, 95);
  const barge = samples.flatMap((s) => s.bargeIns);
  const interruptions = samples
    .filter((s) => !s.backstopOnly)
    .map((s) => s.interruptions)
    .filter((x): x is number => x !== null);
  const durations = samples.map((s) => s.durationS).filter((x): x is number => x !== null);
  const bargeInP95Ms = percentile(barge, 95);
  const durationP50S = percentile(durations, 50);
  return {
    transport,
    language,
    calls: samples.length,
    measured: measured.length,
    backstopOnly: samples.filter((s) => s.backstopOnly).length,
    latencyBasis: measured.length === 0 ? 'none' : allTurns ? 'turns' : 'calls',
    latencyP50Ms,
    latencyP95Ms,
    bargeInP50Ms: percentile(barge, 50),
    bargeInP95Ms,
    interruptionsP50: percentile(interruptions, 50),
    interruptionsP95: percentile(interruptions, 95),
    durationP50S,
    durationP95S: percentile(durations, 95),
    verdicts: {
      latencyP50: verdict(latencyP50Ms, F6_TARGETS.latencyP50Ms),
      latencyP95: verdict(latencyP95Ms, F6_TARGETS.latencyP95Ms),
      // The target is about every barge-in stopping in time: its p95 is held to 300 ms.
      bargeIn: verdict(bargeInP95Ms, F6_TARGETS.bargeInMs),
      duration: verdict(durationP50S, F6_TARGETS.durationP50S),
    },
  };
}

/** One row per transport × language, sorted, then the total row. */
export function summarizeRows(rows: readonly CallRow[]): GroupSummary[] {
  const samples = rows.map(sampleOf);
  const groups = new Map<string, CallSample[]>();
  for (const s of samples) {
    const key = `${s.transport}\u0000${s.language}`;
    groups.set(key, [...(groups.get(key) ?? []), s]);
  }
  const out = [...groups.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([key, list]) => {
      const [transport, language] = key.split('\u0000') as ['sip' | 'web', string];
      return summarize(list, transport, language);
    });
  out.push(summarize(samples, 'all', 'all'));
  return out;
}

const ms = (v: number | null) => (v === null ? '—' : `${Math.round(v)} ms`);
const secs = (v: number | null) =>
  v === null ? '—' : `${Math.floor(v / 60)}:${String(Math.round(v % 60)).padStart(2, '0')}`;
const count = (v: number | null) => (v === null ? '—' : String(v));
const mark = (v: Verdict) => (v === 'ok' ? 'ok' : v === 'over' ? 'OVER' : 'n/a');

/** The table the script prints (plain text, fixed columns). */
export function formatSummary(args: LatencyArgs, groups: readonly GroupSummary[]): string[] {
  const head = [
    'transport',
    'lang',
    'calls',
    'measured',
    'latency p50',
    'p95',
    'barge-in p50',
    'p95',
    'interrupts p50/p95',
    'duration p50',
    'p95',
  ];
  const body = groups.map((g) => [
    g.transport,
    g.language,
    String(g.calls),
    String(g.measured) +
      (g.latencyBasis === 'calls' ? ' (calls)' : g.latencyBasis === 'turns' ? ' (turns)' : ''),
    `${ms(g.latencyP50Ms)} ${mark(g.verdicts.latencyP50)}`,
    `${ms(g.latencyP95Ms)} ${mark(g.verdicts.latencyP95)}`,
    ms(g.bargeInP50Ms),
    `${ms(g.bargeInP95Ms)} ${mark(g.verdicts.bargeIn)}`,
    `${count(g.interruptionsP50)}/${count(g.interruptionsP95)}`,
    `${secs(g.durationP50S)} ${mark(g.verdicts.duration)}`,
    secs(g.durationP95S),
  ]);
  const widths = head.map((h, i) => Math.max(h.length, ...body.map((r) => r[i]!.length)));
  const line = (cells: readonly string[]) =>
    cells
      .map((c, i) => c.padEnd(widths[i]!))
      .join('  ')
      .trimEnd();
  const total = groups.at(-1);
  const out = [
    `voice:latency · calls created ${args.from} … ${args.to} (UTC, to exclusive)`,
    `F6 targets: latency p50 ≤ ${F6_TARGETS.latencyP50Ms} ms, p95 ≤ ${F6_TARGETS.latencyP95Ms} ms; barge-in ≤ ${F6_TARGETS.bargeInMs} ms; typical call ≤ ${F6_TARGETS.durationP50S / 60} min`,
    '',
    line(head),
    line(widths.map((w) => '-'.repeat(w))),
    ...body.map(line),
    '',
  ];
  if (!total || total.calls === 0) out.push('No answered calls in this period.');
  else {
    if (total.latencyBasis === 'calls')
      out.push(
        "Latency pooled per call (the median of the calls' p50s, the 95th percentile of their p95s): the agent stores no per-turn samples (spec §19 Q226).",
      );
    if (total.verdicts.bargeIn === 'n/a')
      out.push(
        'Barge-in: not measured. The agent counts interruptions but records no stop time (spec §19 Q226); check it by ear on the calls.',
      );
    if (total.backstopOnly > 0)
      out.push(
        `${total.backstopOnly} call(s) ended by the voice-events backstop (no end_call): no latency, no interruptions.`,
      );
  }
  return out;
}

/** Any measured target over its limit (the total row), for `--check`. */
export function failsTargets(groups: readonly GroupSummary[]): boolean {
  const total = groups.at(-1);
  return !!total && Object.values(total.verdicts).some((v) => v === 'over');
}

export type ReadOnlyQuery = (text: string, params: readonly unknown[]) => Promise<CallRow[]>;

export interface LatencyDeps {
  env: NodeJS.ProcessEnv;
  /** Runs `fn` in a read-only session and transaction, then closes the connection. */
  readOnly: <T>(dbUrl: string, fn: (q: ReadOnlyQuery) => Promise<T>) => Promise<T>;
  log: (line: string) => void;
  now?: Date;
}

export function refuseLatencyTarget(dbUrl: string | undefined): string | null {
  if (!dbUrl)
    return 'SUPABASE_DB_URL is not set: give the Postgres connection string to read (locally the DB_URL of `supabase status -o env`)';
  try {
    const url = new URL(dbUrl);
    if (url.protocol !== 'postgres:' && url.protocol !== 'postgresql:') throw new Error();
  } catch {
    return 'SUPABASE_DB_URL is not a postgres:// connection string';
  }
  return null;
}

export async function runVoiceLatency(
  argv: readonly string[],
  deps: LatencyDeps,
): Promise<{ groups: GroupSummary[]; exitCode: number }> {
  const args = parseLatencyArgs(argv, deps.now);
  const dbUrl = deps.env.SUPABASE_DB_URL?.trim() || deps.env.DB_URL?.trim() || undefined;
  const refusal = refuseLatencyTarget(dbUrl);
  if (refusal) throw new Error(refusal);
  if (!args.json) deps.log(`voice:latency (read-only) → ${describeTarget(dbUrl!)}`);
  const rows = await deps.readOnly(dbUrl!, (q) => q(CALLS_SQL, [args.from, args.to]));
  const groups = summarizeRows(rows);
  if (args.json)
    deps.log(
      JSON.stringify({ from: args.from, to: args.to, targets: F6_TARGETS, groups }, null, 2),
    );
  else for (const line of formatSummary(args, groups)) deps.log(line);
  return { groups, exitCode: args.check && failsTargets(groups) ? 1 : 0 };
}

/** postgres.js with the session read-only and the one query in a `read only` transaction. */
export async function readOnlyPostgres<T>(
  dbUrl: string,
  fn: (q: ReadOnlyQuery) => Promise<T>,
): Promise<T> {
  const { default: postgres } = await import('postgres');
  const db = postgres(dbUrl, {
    max: 1,
    onnotice: () => undefined,
    connection: { default_transaction_read_only: true, application_name: 'sitelog-voice-latency' },
  });
  try {
    let out: T | undefined;
    await db.begin('read only', async (sql) => {
      out = await fn(
        async (text, params) => (await sql.unsafe(text, params as never[])) as unknown as CallRow[],
      );
    });
    return out!;
  } finally {
    await db.end({ timeout: 5 });
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  runVoiceLatency(process.argv.slice(2), {
    env: process.env,
    readOnly: readOnlyPostgres,
    log: (line) => console.log(line),
  }).then(
    ({ exitCode }) => process.exit(exitCode),
    (err: unknown) => {
      console.error(`voice:latency: ${err instanceof Error ? err.message : String(err)}`);
      process.exit(2);
    },
  );
}
