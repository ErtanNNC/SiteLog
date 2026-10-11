import { DayOffClassificationSchema, toolInputSchema, type DayOffClassification } from '@sitelog/shared';
import type { Logger } from '../log';
import { callTool, type MessagesClient, type ToolCallResult } from './claude';
import { buildDayOffUserMessage, DAYOFF_SYSTEM_PROMPT } from './prompts/replies';

/** §F10 step 2 — weather day vs planned no-work, with the details that make the record claim-ready. */
export const DAYOFF_TOOL = {
  name: 'classify_day_off',
  description: 'Classify a message about a day without normal work as a weather day or a planned no-work day and extract the details.',
} as const;

export interface DayOffRequest {
  text: string;
  workingHours: string | null;
  defaultShiftHours: number;
}

const RAIN = /\b(rain|rained|raining|lluvia|llovi[oó]|llueve|storm|tormenta|lightning|rayos|snow|nieve|ice|hielo|wind|windy|viento|gust|too hot|heat|calor|flood|inundad|weather|clima|tiempo)\b/i;
const HOLIDAY = /\b(holiday|feriado|d[ií]a festivo|no crew|day off|scheduled|planned|closed for|cerrado por|no work|no trabajo)\b/i;
const TIME = /\b(?:at|a las?|about|around)\s+(\d{1,2})(?::(\d{2}))?\s*(am|pm)?\b/i;

/** Regex fallback used when no model client is configured (tests, offline). */
export function quickDayOff(text: string): DayOffClassification {
  const t = text.toLowerCase();
  const weather = RAIN.test(t);
  const kind: DayOffClassification['kind'] = weather ? 'weather_day' : 'no_work';
  const time = TIME.exec(t);
  let releasedAt: string | null = null;
  if (time) {
    let h = Number(time[1]);
    if (time[3] === 'pm' && h < 12) h += 12;
    if (!time[3] && h < 6) h += 12;
    releasedAt = `${String(h).padStart(2, '0')}:${time[2] ?? '00'}`;
  }
  const cause = weather ? (RAIN.exec(t)?.[1]?.toLowerCase() ?? 'weather') : HOLIDAY.test(t) ? 'planned' : null;
  const workers = /\b(\d{1,3})\s*(guys|people|workers|men|hands|personas|hombres|on site)\b/i.exec(t);
  return {
    kind,
    fullDay: !releasedAt,
    releasedAt,
    cause: normaliseCause(cause),
    workersThisMorning: workers ? Number(workers[1]) : null,
    confidence: weather ? 0.8 : 0.6,
  };
}

function normaliseCause(c: string | null): string | null {
  if (!c) return null;
  if (/rain|lluvia|llovi|llueve|storm|tormenta|flood|inundad/.test(c)) return 'rain';
  if (/wind|viento|gust/.test(c)) return 'high wind';
  if (/lightning|rayos/.test(c)) return 'lightning';
  if (/snow|nieve|ice|hielo/.test(c)) return 'snow and ice';
  if (/hot|heat|calor/.test(c)) return 'heat';
  return c;
}

export async function classifyDayOff(client: MessagesClient | null, model: string, req: DayOffRequest, log?: Logger): Promise<{ result: DayOffClassification; call: ToolCallResult<DayOffClassification> | null }> {
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
