import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { z } from 'zod';
import { UTTERANCE_INTENTS, UtteranceClassificationSchema } from '@sitelog/shared';
import { FIXTURES_DIR } from './eval';

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

export const UTTERANCES_DIR = join(FIXTURES_DIR, 'utterances');

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
