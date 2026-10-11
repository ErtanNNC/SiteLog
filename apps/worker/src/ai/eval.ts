import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { DailyReportData } from '@sitelog/shared';
import { createAnthropicClient } from './claude';
import { runExtraction, type ExtractionInput } from './extract';
import { createLogger } from '../log';

/**
 * §10.12 evaluation set: run extraction on every fixtures/transcripts/*.json and compare with
 * fixtures/expected/*.json. Checks: manpower counts exact, hours exact, weather lostHours ±0.5,
 * every non-null number carries a source, unknown companies flagged. Exit 1 on failure.
 * Without ANTHROPIC_API_KEY it prints "skipped" and exits 0 (CI without secrets).
 */

const here = dirname(fileURLToPath(import.meta.url));
const FIXTURES = join(here, '..', '..', '..', '..', 'fixtures');

export interface EvalCheck {
  name: string;
  ok: boolean;
  detail?: string;
}

export interface EvalCase {
  id: string;
  checks: EvalCheck[];
  ok: boolean;
  latencyMs: number;
  costUsd: number;
}

function key(m: { companyName: string; companyNameHeard: string }): string {
  return m.companyName.toLowerCase().trim() || m.companyNameHeard.toLowerCase().trim();
}

function num(v: number | null | undefined): string {
  return v === null || v === undefined ? 'null' : String(v);
}

/** Pure comparison (also unit-tested). */
export function compareReport(actual: DailyReportData, expected: DailyReportData): EvalCheck[] {
  const checks: EvalCheck[] = [];
  const act = new Map(actual.manpower.map((m) => [key(m), m]));
  const exp = new Map(expected.manpower.map((m) => [key(m), m]));

  // Manpower counts exact (per company) and no extra / missing crews.
  for (const [k, e] of exp) {
    const a = act.get(k);
    if (!a) {
      checks.push({ name: `manpower ${e.companyName}: present`, ok: false, detail: 'missing' });
      continue;
    }
    checks.push({
      name: `manpower ${e.companyName}: workers`,
      ok: a.workers === e.workers,
      detail: `got ${num(a.workers)}, want ${num(e.workers)}`,
    });
    checks.push({
      name: `manpower ${e.companyName}: hours`,
      ok: a.totalHours === e.totalHours,
      detail: `got ${num(a.totalHours)}, want ${num(e.totalHours)}`,
    });
    checks.push({
      name: `manpower ${e.companyName}: company resolution`,
      ok: (a.companyId === null) === (e.companyId === null),
      detail: `got ${a.companyId ? 'known' : 'unknown'}, want ${e.companyId ? 'known' : 'unknown'}`,
    });
  }
  for (const k of act.keys())
    if (!exp.has(k)) checks.push({ name: `manpower ${k}: unexpected crew`, ok: false });

  // Weather lostHours ±0.5 (total and per period count).
  const lostA = actual.weather.periods.reduce((s, p) => s + p.lostHours, 0);
  const lostE = expected.weather.periods.reduce((s, p) => s + p.lostHours, 0);
  checks.push({
    name: 'weather lostHours ±0.5',
    ok: Math.abs(lostA - lostE) <= 0.5,
    detail: `got ${lostA}, want ${lostE}`,
  });
  const fullA = actual.weather.periods.some((p) => p.fullDay === true);
  const fullE = expected.weather.periods.some((p) => p.fullDay === true);
  checks.push({
    name: 'weather fullDay',
    ok: fullA === fullE,
    detail: `got ${fullA}, want ${fullE}`,
  });

  // Every non-null number carries a source.
  const unsourced: string[] = [];
  actual.manpower.forEach((m, i) => {
    if ((m.workers !== null || m.totalHours !== null) && m.source.length === 0)
      unsourced.push(`manpower[${i}]`);
  });
  actual.weather.periods.forEach((p, i) => {
    if (p.lostHours > 0 && p.source.length === 0) unsourced.push(`weather.periods[${i}]`);
  });
  actual.workPerformed.forEach((w, i) => {
    if ((w.percentComplete !== undefined || w.quantity) && w.source.length === 0)
      unsourced.push(`workPerformed[${i}]`);
  });
  checks.push({
    name: 'every non-null number has a source',
    ok: unsourced.length === 0,
    detail: unsourced.join(', '),
  });

  // Unknown companies flagged (companyId null + newTerms company entry or proposed question).
  const unknownE = expected.manpower.filter((m) => m.companyId === null);
  for (const e of unknownE) {
    const a = act.get(key(e));
    const flagged =
      !!a &&
      a.companyId === null &&
      (actual.newTerms.some((t) => t.kind === 'company') ||
        actual.proposedQuestions.some((q) => q.field === 'company.unknown'));
    checks.push({ name: `unknown company flagged: ${e.companyName}`, ok: flagged });
  }

  // Safety: an explicit "no incidents" must not be invented.
  if (!expected.safety.noIncidentsStated)
    checks.push({ name: 'noIncidentsStated not invented', ok: !actual.safety.noIncidentsStated });
  return checks;
}

export function loadFixtures(
  dir = FIXTURES,
): Array<{ id: string; input: ExtractionInput; expected: DailyReportData }> {
  const files = readdirSync(join(dir, 'transcripts')).filter((f) => f.endsWith('.json'));
  return files.map((f) => {
    const id = f.replace(/\.json$/, '');
    const input = JSON.parse(readFileSync(join(dir, 'transcripts', f), 'utf8')) as ExtractionInput;
    const expected = JSON.parse(readFileSync(join(dir, 'expected', f), 'utf8')) as DailyReportData;
    return { id, input, expected };
  });
}

export function printTable(cases: EvalCase[]): string {
  const lines: string[] = [];
  const w = Math.max(...cases.map((c) => c.id.length), 4);
  lines.push(`${'case'.padEnd(w)}  result  checks   latency   cost`);
  for (const c of cases) {
    const passed = c.checks.filter((x) => x.ok).length;
    lines.push(
      `${c.id.padEnd(w)}  ${c.ok ? 'PASS ' : 'FAIL '}   ${String(passed).padStart(2)}/${String(c.checks.length).padEnd(3)}  ${String(c.latencyMs).padStart(6)} ms  $${c.costUsd.toFixed(4)}`,
    );
    for (const x of c.checks.filter((y) => !y.ok))
      lines.push(`${''.padEnd(w)}    - ${x.name}${x.detail ? ` (${x.detail})` : ''}`);
  }
  const total = cases.filter((c) => c.ok).length;
  lines.push(`${total}/${cases.length} cases passed`);
  return lines.join('\n');
}

export async function runEval(): Promise<number> {
  const apiKey = process.env.ANTHROPIC_API_KEY ?? '';
  if (!apiKey) {
    console.log('skipped: ANTHROPIC_API_KEY is not set');
    return 0;
  }
  const model = process.env.CLAUDE_MODEL || 'claude-sonnet-5-5';
  const client = createAnthropicClient(apiKey)!;
  const log = createLogger({ eval: true }, { level: 'warn' });
  const cases: EvalCase[] = [];
  for (const f of loadFixtures()) {
    try {
      const res = await runExtraction(client, model, f.input, log);
      const checks = compareReport(res.data, f.expected);
      cases.push({
        id: f.id,
        checks,
        ok: checks.every((c) => c.ok),
        latencyMs: res.call.latencyMs,
        costUsd: res.call.estCostUsd,
      });
    } catch (err) {
      cases.push({
        id: f.id,
        checks: [
          {
            name: 'extraction',
            ok: false,
            detail: err instanceof Error ? err.message : String(err),
          },
        ],
        ok: false,
        latencyMs: 0,
        costUsd: 0,
      });
    }
  }
  console.log(printTable(cases));
  return cases.every((c) => c.ok) ? 0 : 1;
}

if (process.argv[1] && /eval\.(ts|js)$/.test(process.argv[1])) {
  runEval().then(
    (code) => process.exit(code),
    (err) => {
      console.error(err);
      process.exit(1);
    },
  );
}
