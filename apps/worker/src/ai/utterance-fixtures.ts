import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import {
  UTTERANCE_INTENTS,
  UtteranceClassificationSchema,
  type UtteranceClassification,
} from '@sitelog/shared';
import type { MessagesClient } from './claude';
import type { TokenUsage } from './cost';
import type { EvalOutcome } from './eval-summary';
import { classifyUtterance } from './utterance';

/**
 * The golden set of `classify_utterance` (W2-12, §10.8, §10.13): fixtures/utterances/<id>.json,
 * one inbound text per file with its recorded tool output and what the model must return. The
 * recorded outputs are NOT model recordings (no ANTHROPIC_API_KEY when they were written): the fake
 * Claude (`EXTRACT_PROVIDER=fake`) answers with them, matching the text.
 */
export const UtteranceCaseSchema = z.strictObject({
  id: z.string().regex(/^[a-z0-9-]+$/),
  description: z.string().min(1),
  channel: z.enum(['sms', 'call']),
  language: z.enum(['en', 'es', 'tr']),
  text: z.string().min(1),
  recorded: UtteranceClassificationSchema,
  expected: z.strictObject({
    intent: z.enum(UTTERANCE_INTENTS),
    dayReference: z.string().nullable(),
    correctionText: z.string().nullable(),
  }),
});
export type UtteranceCase = z.infer<typeof UtteranceCaseSchema>;

/** fixtures/utterances (as eval.ts finds the fixtures; no import of eval.ts, which imports this). */
export const UTTERANCES_DIR = join(
  dirname(fileURLToPath(import.meta.url)),
  '..',
  '..',
  '..',
  '..',
  'fixtures',
  'utterances',
);

export function loadUtteranceCases(dir: string = UTTERANCES_DIR): UtteranceCase[] {
  return readdirSync(dir)
    .filter((f) => f.endsWith('.json'))
    .sort()
    .map((f) => {
      const parsed = UtteranceCaseSchema.parse(JSON.parse(readFileSync(join(dir, f), 'utf8')));
      if (`${parsed.id}.json` !== f) throw new Error(`${f}: id ${parsed.id} does not match`);
      return parsed;
    });
}

export interface UtteranceCheck {
  name: 'intent' | 'dayReference' | 'correctionText' | 'call';
  ok: boolean;
  detail?: string;
}

/** The day as the worker reads it (sms_keyword: trimmed, dotted capital I folded), compared case-blind. */
function dayKey(v: string | null | undefined): string | null {
  const t = v?.trim().replace(/İ/gu, 'I').toLowerCase();
  return t ? t : null;
}

/** The words of a change, compared without case, punctuation or spacing differences. */
export function correctionKey(v: string | null | undefined): string | null {
  const t = v
    ?.normalize('NFC')
    .toLocaleLowerCase('tr')
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim();
  return t ? t : null;
}

/**
 * A classification (recorded or live) against the case's expected intent, day as written and words
 * of the change. Pure. The intent is exact; the day case-blind; the change without punctuation.
 */
export function scoreUtterance(c: UtteranceCase, got: UtteranceClassification): UtteranceCheck[] {
  const day = got.entities?.dayReference ?? null;
  const text = got.correctionText ?? null;
  return [
    {
      name: 'intent',
      ok: got.intent === c.expected.intent,
      detail: `${got.intent}, expected ${c.expected.intent}`,
    },
    {
      name: 'dayReference',
      ok: dayKey(day) === dayKey(c.expected.dayReference),
      detail: `${JSON.stringify(day)}, expected ${JSON.stringify(c.expected.dayReference)}`,
    },
    {
      name: 'correctionText',
      ok: correctionKey(text) === correctionKey(c.expected.correctionText),
      detail: `${JSON.stringify(text)}, expected ${JSON.stringify(c.expected.correctionText)}`,
    },
  ];
}

/**
 * `pnpm eval -- --utterances`: every case through the live fast model, as the sms_keyword job calls
 * it (an SMS EDIT: channel sms, keyword EDIT, the whole text), or its recorded output with
 * `recorded`. Prints one line per case and returns the outcomes. A failed call fails its case only.
 */
export async function runUtteranceEval(opts: {
  recorded: boolean;
  client: MessagesClient | null;
  model: string;
  filter: string[];
  dir?: string;
}): Promise<EvalOutcome[]> {
  const cases = loadUtteranceCases(opts.dir).filter(
    (c) => opts.filter.length === 0 || opts.filter.some((f) => c.id.includes(f)),
  );
  const outcomes: EvalOutcome[] = [];
  for (const c of cases) {
    let checks: UtteranceCheck[];
    let usage: TokenUsage | undefined;
    try {
      let got: UtteranceClassification;
      if (opts.recorded || !opts.client) {
        got = c.recorded;
      } else {
        const res = await classifyUtterance(opts.client, opts.model, {
          channel: c.channel,
          // The SMS cases are EDIT texts (the only SMS the worker classifies); a call turn has none.
          keyword: c.channel === 'sms' ? 'EDIT' : null,
          text: c.text,
        });
        got = res.data;
        usage = res.usage;
      }
      checks = scoreUtterance(c, got);
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
  console.log(`${passed}/${cases.length} classify_utterance cases passed`);
  return outcomes;
}
