import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import {
  AnswerValueSchema,
  ParsedAnswerSchema,
  QUESTION_FIELDS,
  applyAnswer,
  emptyReportData,
  type DailyReportData,
  type ParsedAnswer,
  type QuestionSpec,
} from '@sitelog/shared';
import type { MessagesClient } from './claude';
import type { TokenUsage } from './cost';
import type { EvalOutcome } from './eval-summary';
import { answerRefusal, parseAnswerWithModel } from './answer';
import { loadVoiceFixtures } from './voice-fixtures';

/**
 * The golden set of `parse_answer` (W2-09, §10.7, §10.13): fixtures/answers/<id>.json, one spoken
 * answer per file. Each names its question (field, prompt, offered options, target), the crew the
 * draft has before the answer, the org's default shift, the companies, the fixtures/voice clip whose
 * transcript is the answer, the recorded tool output and what code must make of it.
 *
 * The recorded outputs are NOT model recordings: no ANTHROPIC_API_KEY was available when they were
 * written (W2-09), so they are the outputs the prompt asks for. The fake Claude
 * (`EXTRACT_PROVIDER=fake`) answers parse_answer with them, matching the answer's transcript, and
 * the worker tests apply them through the real job. `pnpm eval -- --answers` runs the live model on
 * every case (with the key) and `--answers --recorded` scores the recorded outputs offline.
 */

/** fixtures/answers (the repository's fixtures, as eval.ts finds them; no import of eval.ts). */
export const ANSWERS_DIR = join(
  dirname(fileURLToPath(import.meta.url)),
  '..',
  '..',
  '..',
  '..',
  'fixtures',
  'answers',
);

export const AnswerCaseSchema = z.strictObject({
  id: z.string().regex(/^[a-z0-9-]+$/),
  description: z.string().min(1),
  /** The fixtures/voice clip (kind `answer`) whose transcript is the answer. */
  voice: z.string().min(1),
  language: z.enum(['en', 'es', 'tr']),
  question: z.strictObject({
    field: z.enum(QUESTION_FIELDS),
    prompt: z.string().min(1),
    options: z.array(z.string()),
    target: z.record(z.string(), z.unknown()),
  }),
  companies: z.array(
    z.strictObject({ id: z.string(), name: z.string(), aliases: z.array(z.string()) }),
  ),
  defaultShiftHours: z.number().positive(),
  /** The crew the question is about, as the draft has it before the answer (no numbers). */
  crew: z.strictObject({
    companyName: z.string(),
    companyNameHeard: z.string(),
    area: z.string().optional(),
  }),
  recorded: ParsedAnswerSchema,
  expected: z.discriminatedUnion('applies', [
    z.strictObject({
      applies: z.literal(true),
      value: AnswerValueSchema,
      crew: z.strictObject({
        workers: z.number().int(),
        hoursPerWorker: z.number(),
        totalHours: z.number(),
      }),
    }),
    z.strictObject({
      applies: z.literal(false),
      reason: z.enum(['low_confidence', 'number_not_stated', 'other_field']),
    }),
  ]),
});
export type AnswerCase = z.infer<typeof AnswerCaseSchema> & { transcript: string };

/** Every fixtures/answers/*.json with its clip's transcript; throws on a broken file. */
export function loadAnswerCases(dir = ANSWERS_DIR): AnswerCase[] {
  const voices = loadVoiceFixtures();
  return readdirSync(dir)
    .filter((f) => f.endsWith('.json'))
    .sort()
    .map((f) => {
      const parsed = AnswerCaseSchema.safeParse(JSON.parse(readFileSync(join(dir, f), 'utf8')));
      if (!parsed.success)
        throw new Error(`fixtures/answers/${f}: ${parsed.error.issues[0]?.message ?? 'invalid'}`);
      if (`${parsed.data.id}.json` !== f) throw new Error(`fixtures/answers/${f}: id mismatch`);
      const voice = voices.find((v) => v.id === parsed.data.voice);
      if (!voice || voice.kind !== 'answer')
        throw new Error(`fixtures/answers/${f}: no answer clip ${parsed.data.voice}`);
      return { ...parsed.data, transcript: voice.text };
    });
}

/** The draft of a case before the answer: its one crew, without numbers. */
export function caseDraft(c: AnswerCase): DailyReportData {
  return {
    ...emptyReportData('2026-10-09', {
      reportLanguage: c.language === 'tr' ? 'tr' : 'en',
      units: c.language === 'tr' ? 'metric' : 'imperial',
    }),
    manpower: [
      {
        companyId: null,
        companyNameHeard: c.crew.companyNameHeard,
        companyName: c.crew.companyName,
        ...(c.crew.area ? { area: c.crew.area } : {}),
        workers: null,
        hoursPerWorker: null,
        totalHours: null,
        hoursBasis: 'unknown',
        confidence: 0.5,
        source: [],
      },
    ],
  };
}

export interface AnswerCheck {
  name: string;
  ok: boolean;
  detail?: string;
}

/** A parse of a case (recorded or live) against what code must make of it. Pure. */
export function scoreAnswer(c: AnswerCase, parsed: ParsedAnswer): AnswerCheck[] {
  const refusal = answerRefusal(c.question.field, parsed, c.transcript);
  const checks: AnswerCheck[] = [];
  if (!c.expected.applies) {
    checks.push({
      name: 'not applied',
      ok: refusal !== null,
      detail: `confidence ${parsed.confidence}, refusal ${refusal ?? 'none'}`,
    });
    return checks;
  }
  checks.push({ name: 'applied', ok: refusal === null, detail: refusal ?? undefined });
  checks.push({ name: 'field', ok: parsed.field === c.question.field, detail: parsed.field });
  for (const key of ['workers', 'hoursPerWorker', 'fullDay', 'halfDay', 'endTime'] as const) {
    const want = c.expected.value[key];
    const got = parsed.value[key];
    if (want === undefined && (got === undefined || got === null || got === false)) continue;
    checks.push({
      name: `value.${key}`,
      ok: want === got,
      detail: `${String(got)} ≠ ${String(want)}`,
    });
  }
  if (refusal === null) {
    const applied = applyAnswer(
      caseDraft(c),
      { field: c.question.field, target: c.question.target as QuestionSpec['target'] },
      parsed.value,
      {
        defaultShiftHours: c.defaultShiftHours,
        source: { type: 'answer', questionId: 'q' },
      },
    ).data.manpower[0]!;
    const crew = c.expected.crew;
    checks.push({
      name: 'crew in code',
      ok:
        applied.workers === crew.workers &&
        applied.hoursPerWorker === crew.hoursPerWorker &&
        applied.totalHours === crew.totalHours,
      detail: `${applied.workers} × ${applied.hoursPerWorker} = ${applied.totalHours}`,
    });
  }
  return checks;
}

/**
 * `pnpm eval -- --answers`: every case through the live model (`CLAUDE_MODEL_FAST`, else
 * `CLAUDE_MODEL`), or its recorded output with `recorded`. Prints one line per case and returns the
 * outcomes (eval.ts prints the summary and decides the exit code). A failed call fails its case only.
 */
export async function runAnswerEval(opts: {
  recorded: boolean;
  client: MessagesClient | null;
  model: string;
  filter: string[];
}): Promise<EvalOutcome[]> {
  const cases = loadAnswerCases().filter(
    (c) => opts.filter.length === 0 || opts.filter.some((f) => c.id.includes(f)),
  );
  const outcomes: EvalOutcome[] = [];
  for (const c of cases) {
    let checks: AnswerCheck[];
    let usage: TokenUsage | undefined;
    try {
      let parsed: ParsedAnswer;
      if (opts.recorded || !opts.client) {
        parsed = c.recorded;
      } else {
        const res = await parseAnswerWithModel(opts.client, opts.model, {
          question: c.question,
          replyText: c.transcript,
          companies: c.companies,
          defaultShiftHours: c.defaultShiftHours,
          via: 'voice',
        });
        parsed = res.data;
        usage = res.usage;
      }
      checks = scoreAnswer(c, parsed);
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
  console.log(`${passed}/${cases.length} parse_answer cases passed`);
  return outcomes;
}
