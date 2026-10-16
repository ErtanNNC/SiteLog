import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import {
  CORRECTION_REFUSALS,
  CorrectionResultSchema,
  applyCorrectionOps,
  type CorrectionChange,
  type CorrectionResult,
  type DailyReportData,
} from '@sitelog/shared';
import type { MessagesClient } from './claude';
import type { TokenUsage } from './cost';
import type { EvalOutcome } from './eval-summary';
import { parseCorrectionV2 } from './correction';
import { FIXTURES_DIR, loadFixtures } from './eval';
import { loadVoiceFixtures } from './voice-fixtures';

/**
 * The golden set of `apply_correction` (W2-10, §10.6, §10.13): fixtures/corrections/<id>.json, one
 * fix of a draft per file. Each names the draft (a golden extraction case: its expected
 * `DailyReportData`), the fixtures/voice clip (kind `correction`) whose transcript is the fix, the
 * recorded tool output and what code must make of it.
 *
 * The recorded outputs are NOT model recordings: no ANTHROPIC_API_KEY was available when they were
 * written (W2-10), so they are the outputs the prompt asks for (one of them sets a total, which
 * code must ignore). The fake Claude (`EXTRACT_PROVIDER=fake`) answers apply_correction with them,
 * matching the transcript; `pnpm eval -- --corrections` runs the live model on every case (with
 * the key) and `--corrections --recorded` scores the recorded outputs offline.
 */

export const CORRECTIONS_DIR = join(
  dirname(fileURLToPath(import.meta.url)),
  '..',
  '..',
  '..',
  '..',
  'fixtures',
  'corrections',
);

const NumberPair = z.tuple([z.number().nullable(), z.number().nullable()]);
const ChangeSchema = z.union([
  z.strictObject({
    kind: z.literal('crew'),
    company: z.string(),
    change: z.enum(['changed', 'added', 'removed']),
    workers: NumberPair,
    hoursPerWorker: NumberPair,
    totalHours: NumberPair,
  }),
  z.strictObject({ kind: z.literal('lost_hours'), lostHours: NumberPair }),
  z.strictObject({ kind: z.literal('section'), section: z.string() }),
]);

export const CorrectionCaseSchema = z.strictObject({
  id: z.string().regex(/^[a-z0-9-]+$/),
  description: z.string().min(1),
  /** The fixtures/voice clip (kind `correction`) whose transcript is the fix. */
  voice: z.string().min(1),
  language: z.enum(['en', 'es', 'tr']),
  /** The golden extraction case whose expected data is the draft before the fix. */
  draft: z.string().min(1),
  recorded: CorrectionResultSchema,
  expected: z.discriminatedUnion('applies', [
    z.strictObject({
      applies: z.literal(true),
      crew: z.strictObject({
        company: z.string(),
        workers: z.number().int(),
        hoursPerWorker: z.number(),
        totalHours: z.number(),
      }),
      changes: z.array(ChangeSchema),
      droppedTotals: z.number().int().min(0),
      /**
       * A clarification question instead is also right (prompt rule 7): the words say something
       * the draft's fields cannot hold as said (a total, which only code computes).
       */
      clarificationOk: z.boolean().optional(),
    }),
    z.strictObject({
      applies: z.literal(false),
      reason: z.enum(['clarification', ...CORRECTION_REFUSALS]),
    }),
  ]),
});

export type CorrectionCase = z.infer<typeof CorrectionCaseSchema> & {
  transcript: string;
  /** The draft before the fix (the golden case's expected data). */
  base: DailyReportData;
  companies: Array<{ id: string; name: string; aliases: string[] }>;
  defaultShiftHours: number;
};

/** Every fixtures/corrections/*.json with its clip's transcript and draft; throws on a broken file. */
export function loadCorrectionCases(dir = CORRECTIONS_DIR): CorrectionCase[] {
  const voices = loadVoiceFixtures();
  const files = readdirSync(dir)
    .filter((f) => f.endsWith('.json'))
    .sort();
  const parsed = files.map((f) => {
    const res = CorrectionCaseSchema.safeParse(JSON.parse(readFileSync(join(dir, f), 'utf8')));
    if (!res.success)
      throw new Error(`fixtures/corrections/${f}: ${res.error.issues[0]?.message ?? 'invalid'}`);
    if (`${res.data.id}.json` !== f) throw new Error(`fixtures/corrections/${f}: id mismatch`);
    return res.data;
  });
  const drafts = new Map(
    loadFixtures(
      FIXTURES_DIR,
      parsed.map((c) => c.draft),
    ).map((f) => [f.id, f]),
  );
  return parsed.map((c) => {
    const voice = voices.find((v) => v.id === c.voice);
    if (!voice || voice.kind !== 'correction')
      throw new Error(`fixtures/corrections/${c.id}: no correction clip ${c.voice}`);
    const golden = drafts.get(c.draft);
    if (!golden) throw new Error(`fixtures/corrections/${c.id}: no golden case ${c.draft}`);
    return {
      ...c,
      transcript: voice.text,
      base: golden.expected,
      companies: golden.input.companies.map((x) => ({
        id: x.id,
        name: x.name,
        aliases: [...(x.aliases ?? [])],
      })),
      defaultShiftHours: golden.input.defaultShiftHours,
    };
  });
}

export interface CorrectionCheck {
  name: string;
  ok: boolean;
  detail?: string;
}

/** A correction of a case (recorded or live) against what code must make of it. Pure. */
export function scoreCorrection(c: CorrectionCase, result: CorrectionResult): CorrectionCheck[] {
  const checks: CorrectionCheck[] = [];
  if (result.needsClarification) {
    const want = c.expected.applies
      ? c.expected.clarificationOk === true
      : c.expected.reason === 'clarification';
    checks.push({ name: 'asks which line', ok: want, detail: result.needsClarification });
    return checks;
  }
  const applied = applyCorrectionOps(c.base, result.operations, {
    source: { type: 'voice_note', uploadId: 'clip', start: 0 },
    text: c.transcript,
    defaultShiftHours: c.defaultShiftHours,
    companies: c.companies,
  });
  if (!c.expected.applies) {
    checks.push({
      name: 'not applied',
      ok: !applied.ok && applied.reason === c.expected.reason,
      detail: applied.ok ? 'applied' : applied.reason,
    });
    return checks;
  }
  checks.push({ name: 'applied', ok: applied.ok, detail: applied.ok ? undefined : applied.reason });
  if (!applied.ok) return checks;
  const want = c.expected.crew;
  const entry = applied.data.manpower.find((m) => m.companyName === want.company);
  checks.push({
    name: 'crew in code',
    ok:
      entry?.workers === want.workers &&
      entry.hoursPerWorker === want.hoursPerWorker &&
      entry.totalHours === want.totalHours,
    detail: entry ? `${entry.workers} × ${entry.hoursPerWorker} = ${entry.totalHours}` : 'no line',
  });
  checks.push({
    name: 'clip cited',
    ok: !!entry?.source.some((s) => s.type === 'voice_note' && s.uploadId === 'clip'),
  });
  checks.push({
    name: 'preview lines',
    ok:
      JSON.stringify(applied.changes) === JSON.stringify(c.expected.changes as CorrectionChange[]),
    detail: JSON.stringify(applied.changes),
  });
  checks.push({
    name: 'totals dropped',
    ok: applied.droppedTotals === c.expected.droppedTotals,
    detail: String(applied.droppedTotals),
  });
  return checks;
}

/**
 * `pnpm eval -- --corrections`: every case through the live model (`CLAUDE_MODEL`), or its
 * recorded output with `recorded`. Prints one line per case and returns the outcomes (eval.ts
 * prints the summary and decides the exit code). A failed call fails its case only.
 */
export async function runCorrectionEval(opts: {
  recorded: boolean;
  client: MessagesClient | null;
  model: string;
  filter: string[];
}): Promise<EvalOutcome[]> {
  const cases = loadCorrectionCases().filter(
    (c) => opts.filter.length === 0 || opts.filter.some((f) => c.id.includes(f)),
  );
  const outcomes: EvalOutcome[] = [];
  for (const c of cases) {
    let checks: CorrectionCheck[];
    let usage: TokenUsage | undefined;
    try {
      let result: CorrectionResult;
      if (opts.recorded || !opts.client) {
        result = c.recorded;
      } else {
        const res = await parseCorrectionV2(opts.client, opts.model, {
          data: c.base,
          correctionText: c.transcript,
          via: 'voice',
          defaultShiftHours: c.defaultShiftHours,
          companies: c.companies,
          reporterLanguage: c.language,
        });
        result = res.data;
        usage = res.usage;
      }
      checks = scoreCorrection(c, result);
    } catch (err) {
      checks = [
        { name: 'call', ok: false, detail: err instanceof Error ? err.message : String(err) },
      ];
    }
    const ok = checks.every((x) => x.ok);
    outcomes.push({
      id: c.id,
      ok,
      failedChecks: checks.filter((x) => !x.ok).map((x) => x.name),
      usage,
    });
    console.log(`${ok ? 'PASS' : 'FAIL'}  ${c.id}`);
    for (const x of checks.filter((y) => !y.ok))
      console.log(`      - ${x.name}${x.detail ? ` (${x.detail})` : ''}`);
  }
  const passed = outcomes.filter((o) => o.ok).length;
  console.log(`${passed}/${cases.length} apply_correction cases passed`);
  return outcomes;
}
