import { ClassifiedReplySchema, resolveDayReference, toolInputSchema, type ClassifiedReply } from '@sitelog/shared';
import type { Logger } from '../log';
import { callTool, type MessagesClient, type ToolCallResult } from './claude';
import { buildClassifyUserMessage, CLASSIFY_SYSTEM_PROMPT } from './prompts/replies';

/** §10.8 — `classify_reply` (fast model). Button replies never reach this. */
export const CLASSIFY_TOOL = {
  name: 'classify_reply',
  description: 'Classify the site manager\'s reply into one intent and extract day references, numbers, times.',
} as const;

export interface ClassifyRequest {
  state: string;
  lastOutbound: string | null;
  text: string;
  isVoice: boolean;
}

const CONFIRM_WORDS = /^(ok|okay|k|yes|yep|yeah|yup|sure|file it|looks good|good|fine|correct|confirm|confirmed|approved|go ahead|send it|dale|s[ií]|si|vale|listo|perfecto|bien|correcto|ok file it|all good)[.!]*$/i;
const HELP_WORDS = /^(help|ayuda|\?|how does this work|what do i do)[.!?]*$/i;
const STOP_WORDS = /^(stop|no more reminders|basta|alto|para|no me recuerdes)[.!]*$/i;
const NO_WORK = /^(no work( today)?|no work on site|site closed( today)?|no trabajo( hoy)?|hoy no hay trabajo|day off|holiday today|no crew today)[.!]*$/i;
const LANGUAGE = /^(language|idioma|lang)\s+([a-z]{2})\b/i;
const EDIT = /^(edit|change|fix|update|corrige|cambia|edita)\b\s*(.*)$/i;

/**
 * Deterministic pre-pass for the grammar in §9.5 (exact short replies). Everything ambiguous goes
 * to the model. Returns null when the model should decide.
 */
export function quickClassify(text: string, now: Date, tz: string): ClassifiedReply | null {
  const t = text.trim().replace(/\s+/g, ' ');
  if (!t) return { intent: 'other', confidence: 1 };
  if (CONFIRM_WORDS.test(t)) return { intent: 'confirm', confidence: 1 };
  if (HELP_WORDS.test(t)) return { intent: 'help', confidence: 1 };
  if (STOP_WORDS.test(t)) return { intent: 'stop', confidence: 1 };
  if (NO_WORK.test(t)) return { intent: 'no_work', confidence: 1 };
  const lang = LANGUAGE.exec(t);
  if (lang) return { intent: 'language', confidence: 1, entities: { language: lang[2]!.toLowerCase() } };
  const edit = EDIT.exec(t);
  if (edit && /^(edit|edita)\b/i.test(t)) {
    const rest = edit[2] ?? '';
    const day = resolveDayReference(rest, now, tz);
    if (day) {
      const correctionText = stripDayReference(rest);
      return { intent: 'edit_request', confidence: 1, entities: { dayReference: day }, correctionText: correctionText || null };
    }
  }
  return null;
}

/** Remove the leading day reference and separators: "Friday — Apex was 7" → "Apex was 7". */
export function stripDayReference(text: string): string {
  return text
    .replace(/^\s*(the\s+)?(report\s+(for|from)\s+)?(today|yesterday|hoy|ayer|monday|tuesday|wednesday|thursday|friday|saturday|sunday|mon|tue|tues|wed|thu|thur|thurs|fri|sat|sun|lunes|martes|mi[eé]rcoles|jueves|viernes|s[aá]bado|domingo|\d{4}-\d{2}-\d{2}|\d{1,2}\/\d{1,2}(\/\d{2,4})?|[a-z]{3,9}\.?\s+\d{1,2}(st|nd|rd|th)?|\d{1,2}(st|nd|rd|th)?\s+(of\s+)?[a-z]{3,9})('s)?(\s+report)?\s*/i, '')
    .replace(/^[\s,:;—–-]+/, '')
    .trim();
}

export async function classifyWithModel(client: MessagesClient, model: string, req: ClassifyRequest, log?: Logger): Promise<ToolCallResult<ClassifiedReply>> {
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
