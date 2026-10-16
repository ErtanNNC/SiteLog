import {
  UtteranceClassificationSchema,
  toolInputSchema,
  type UtteranceClassification,
} from '@sitelog/shared';
import type { Logger } from '../log';
import { callTool, type MessagesClient, type ToolCallResult } from './claude';
import {
  UTTERANCE_SYSTEM_PROMPT,
  buildUtteranceUserMessage,
  type UtterancePromptInput,
} from './prompts/utterance';

/**
 * §10.8 `classify_utterance` (fast model, `CLAUDE_MODEL_FAST`; W2-12): the intent of a message
 * outside the main report, with the day as written and the words of a change. Used by the
 * `sms_keyword` job for an SMS EDIT on a two-way pack (and by the call agent from M7). The model
 * never resolves a date, finds a report or applies anything: code does (`readSmsEdit`,
 * `resolveDayReference`, apply_correction and the reporter's Save change).
 */
export const UTTERANCE_TOOL = {
  name: 'classify_utterance',
  description:
    "Classify the site manager's message into one intent and extract the day as written, numbers and the words of a change.",
} as const;

export type UtteranceRequest = UtterancePromptInput;

export async function classifyUtterance(
  client: MessagesClient,
  model: string,
  req: UtteranceRequest,
  log?: Logger,
): Promise<ToolCallResult<UtteranceClassification>> {
  return callTool(
    client,
    {
      model,
      system: [{ text: UTTERANCE_SYSTEM_PROMPT, cache: true }],
      messages: [{ role: 'user', content: buildUtteranceUserMessage(req) }],
      tool: { ...UTTERANCE_TOOL, inputSchema: toolInputSchema(UtteranceClassificationSchema) },
      schema: UtteranceClassificationSchema,
      maxTokens: 512,
      effort: 'low',
    },
    log,
  );
}
