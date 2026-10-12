import {
  DayOffClassificationSchema,
  quickDayOff,
  toolInputSchema,
  type DayOffClassification,
} from '@sitelog/shared';
import type { Logger } from '../log';
import { callTool, type MessagesClient, type ToolCallResult } from './claude';
import { buildDayOffUserMessage, DAYOFF_SYSTEM_PROMPT } from './prompts/replies';

/** §F10 step 2 — weather day vs planned no-work, with the details that make the record claim-ready. */
export const DAYOFF_TOOL = {
  name: 'classify_day_off',
  description:
    'Classify a message about a day without normal work as a weather day or a planned no-work day and extract the details.',
} as const;

export interface DayOffRequest {
  text: string;
  workingHours: string | null;
  defaultShiftHours: number;
}

/** Regex fallback used when no model client is configured; shared with the web simulator. */
export { quickDayOff };

export async function classifyDayOff(
  client: MessagesClient | null,
  model: string,
  req: DayOffRequest,
  log?: Logger,
): Promise<{ result: DayOffClassification; call: ToolCallResult<DayOffClassification> | null }> {
  if (!client) return { result: quickDayOff(req.text), call: null };
  const call = await callTool(
    client,
    {
      model,
      system: [{ text: DAYOFF_SYSTEM_PROMPT, cache: true }],
      messages: [{ role: 'user', content: buildDayOffUserMessage(req) }],
      tool: { ...DAYOFF_TOOL, inputSchema: toolInputSchema(DayOffClassificationSchema) },
      schema: DayOffClassificationSchema,
      maxTokens: 512,
      effort: 'low',
    },
    log,
  );
  return { result: call.data, call };
}
