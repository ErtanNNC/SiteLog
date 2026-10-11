import { CorrectionResultSchema, toolInputSchema, type CorrectionResult, type DailyReportData } from '@sitelog/shared';
import type { Logger } from '../log';
import { callTool, type MessagesClient, type ToolCallResult } from './claude';
import { buildCorrectionUserMessage, CORRECTION_SYSTEM_PROMPT } from './prompts/replies';

/** §10.6 — `apply_correction` tool. The patch is applied by code (shared applyPatch). */
export const CORRECTION_TOOL = {
  name: 'apply_correction',
  description: 'Return the RFC 6902 operations that apply the manager\'s correction to the report data, plus a one-line change note.',
} as const;

export interface CorrectionRequest {
  data: DailyReportData;
  correctionText: string;
  messageId: string;
  defaultShiftHours: number;
  companies: Array<{ id: string; name: string; aliases: string[] }>;
}

export async function parseCorrection(client: MessagesClient, model: string, req: CorrectionRequest, log?: Logger): Promise<ToolCallResult<CorrectionResult>> {
  return callTool(
    client,
    {
      model,
      system: [{ text: CORRECTION_SYSTEM_PROMPT, cache: true }],
      messages: [{ role: 'user', content: buildCorrectionUserMessage(req) }],
      tool: { ...CORRECTION_TOOL, inputSchema: toolInputSchema(CorrectionResultSchema) },
      schema: CorrectionResultSchema,
      maxTokens: 4096,
      effort: 'low',
    },
    log,
  );
}
