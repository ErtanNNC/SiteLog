import { ParsedAnswerSchema, toolInputSchema, type ParsedAnswer } from '@sitelog/shared';
import type { Logger } from '../log';
import { callTool, type MessagesClient, type ToolCallResult } from './claude';
import { ANSWER_SYSTEM_PROMPT, buildAnswerUserMessage } from './prompts/replies';

/** §10.7 — `parse_answer` tool. Below 0.7 confidence the caller re-asks once. */
export const ANSWER_TOOL = {
  name: 'parse_answer',
  description:
    'Interpret the reply to the open clarifying question and return the structured answer with a confidence.',
} as const;

export interface AnswerRequest {
  question: { field: string; prompt: string; options: string[]; target: unknown };
  replyText: string;
  companies: Array<{ id: string; name: string; aliases: string[] }>;
  defaultShiftHours: number;
}

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
