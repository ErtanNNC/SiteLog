import {
  PARSE_ANSWER_MIN_CONFIDENCE,
  ParsedAnswerSchema,
  toolInputSchema,
  unstatedAnswerNumber,
  type ParsedAnswer,
  type QuestionField,
} from '@sitelog/shared';
import type { Logger } from '../log';
import { callTool, type MessagesClient, type ToolCallResult } from './claude';
import {
  ANSWER_SYSTEM_PROMPT,
  buildAnswerUserMessage,
  type AnswerPromptInput,
} from './prompts/answer';

/**
 * §10.7 `parse_answer` (channel-neutral since W2-09): the web recorder's spoken *Other…* answer
 * (`jobs/parse_answer.ts`) and, until step 22, the WhatsApp worker's replies
 * (`router/handlers/question.ts`) call it. Below `PARSE_ANSWER_MIN_CONFIDENCE` (0.7) the caller
 * asks once more. `callTool` takes phone numbers out of every text block first (§10.12).
 */
export const ANSWER_TOOL = {
  name: 'parse_answer',
  description:
    'Interpret the answer to the open question about the daily report and return the structured value with a confidence.',
} as const;

export type AnswerRequest = AnswerPromptInput;

export async function parseAnswerWithModel(
  client: MessagesClient,
  model: string,
  req: AnswerRequest,
  log?: Logger,
): Promise<ToolCallResult<ParsedAnswer>> {
  return callTool(
    client,
    {
      model,
      system: [{ text: ANSWER_SYSTEM_PROMPT, cache: true }],
      messages: [{ role: 'user', content: buildAnswerUserMessage(req) }],
      tool: { ...ANSWER_TOOL, inputSchema: toolInputSchema(ParsedAnswerSchema) },
      schema: ParsedAnswerSchema,
      maxTokens: 1024,
      effort: 'low',
    },
    log,
  );
}

/** Why code does not apply a parsed answer to the question (W2-09, F7), or null to apply it. */
export type AnswerRefusal = 'low_confidence' | 'number_not_stated' | 'other_field';

/**
 * Code's rule for a parsed answer (§10.7, CLAUDE.md "never invent numbers"): below 0.7 it is
 * asked once more; an answer for another field, a headcount without a number, a weather stoppage
 * without its lost hours, or a number (or a full day, half day, no stoppage) the answer does not
 * state (`unstatedAnswerNumber`) is treated the same way. Pure.
 */
export function answerRefusal(
  field: QuestionField,
  parsed: ParsedAnswer,
  transcript: string,
): AnswerRefusal | null {
  if (parsed.confidence < PARSE_ANSWER_MIN_CONFIDENCE) return 'low_confidence';
  if (parsed.field !== field) return 'other_field';
  if (field === 'manpower.workers' && parsed.value.workers == null) return 'low_confidence';
  // A stoppage with no lost hours would be logged as 0 h lost (applyAnswer): a number nobody said.
  if (field === 'weather.impact' && parsed.value.impact && parsed.value.lostHours == null)
    return 'number_not_stated';
  if (unstatedAnswerNumber(parsed.value, transcript) !== null) return 'number_not_stated';
  return null;
}
