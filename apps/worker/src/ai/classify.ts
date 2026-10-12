import { ClassifiedReplySchema, toolInputSchema, type ClassifiedReply } from '@sitelog/shared';
import type { Logger } from '../log';
import { callTool, type MessagesClient, type ToolCallResult } from './claude';
import { buildClassifyUserMessage, CLASSIFY_SYSTEM_PROMPT } from './prompts/replies';

/** §10.8 — `classify_reply` (fast model). Button replies never reach this. */
export const CLASSIFY_TOOL = {
  name: 'classify_reply',
  description:
    "Classify the site manager's reply into one intent and extract day references, numbers, times.",
} as const;

export interface ClassifyRequest {
  state: string;
  lastOutbound: string | null;
  text: string;
  isVoice: boolean;
}

/** §9.5 deterministic pre-pass; lives in @sitelog/shared so the web simulator runs the same code. */
export { quickClassify, stripDayReference } from '@sitelog/shared';

export async function classifyWithModel(
  client: MessagesClient,
  model: string,
  req: ClassifyRequest,
  log?: Logger,
): Promise<ToolCallResult<ClassifiedReply>> {
  return callTool(
    client,
    {
      model,
      system: [{ text: CLASSIFY_SYSTEM_PROMPT, cache: true }],
      messages: [{ role: 'user', content: buildClassifyUserMessage(req) }],
      tool: { ...CLASSIFY_TOOL, inputSchema: toolInputSchema(ClassifiedReplySchema) },
      schema: ClassifiedReplySchema,
      maxTokens: 512,
      effort: 'low',
    },
    log,
  );
}
