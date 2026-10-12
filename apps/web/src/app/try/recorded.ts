/**
 * Recorded model outputs (fixtures/tool-outputs/replies.json) standing in for the AI calls the
 * simulator cannot make. Each recording is tied to the phrasings it was recorded for; anything
 * else gets an honest "production uses the AI for this" note instead of a guess.
 */
import type {
  ClassifiedReply,
  CorrectionResult,
  DayOffClassification,
  ParsedAnswer,
} from '@sitelog/shared/schemas/ai.ts';
import replies from '../../../../../fixtures/tool-outputs/replies.json';

interface RepliesFixture {
  apply_correction: Record<string, CorrectionResult>;
  parse_answer: Record<string, ParsedAnswer>;
  classify_reply: Record<string, ClassifiedReply>;
  classify_day_off: Record<string, DayOffClassification>;
}

const R = replies as unknown as RepliesFixture;

/** classify_reply (§10.8): recorded intents and the phrasings they cover. */
const CLASSIFY: Array<{ key: string; match: RegExp }> = [
  {
    key: 'rained-out',
    match:
      /\b(rained out|rain(ed)? (out|off)|sent (everyone|everybody|the crew|the guys|them) home|called it for (rain|weather))\b/i,
  },
  { key: 'thanks', match: /^\s*(thanks|thank you|thx|gracias|cheers|ta)\b/i },
  // "Apex had 7 not 6": a headcount correction naming a crew.
  {
    key: 'fix-apex',
    match:
      /\b(had|has|was|were|is)\s+(\d+|[a-z]+)\s*(guys|workers|people|men)?,?\s+not\s+(\d+|[a-z]+)\b/i,
  },
];

export function recordedClassify(text: string): ClassifiedReply | null {
  const hit = CLASSIFY.find((c) => c.match.test(text));
  if (!hit) return null;
  const out = R.classify_reply[hit.key];
  if (!out) return null;
  // The recording's correction text is the phrase it was recorded with; use the reporter's own words.
  return out.intent === 'fix' ? { ...out, correctionText: text.trim() } : { ...out };
}

/** classify_day_off: the planned-closure recording ("site closed for the holiday"). */
export function recordedDayOff(text: string): DayOffClassification | null {
  if (/\b(holiday|feriado|d[ií]a festivo)\b/i.test(text)) return R.classify_day_off.holiday ?? null;
  return null;
}

/** parse_answer (§10.7): the low-confidence recording ("maybe later") that triggers a re-ask. */
export function recordedAnswer(text: string): ParsedAnswer | null {
  if (/^\s*(maybe later|later|not sure|no idea|i don'?t know|ni idea)\b/i.test(text))
    return R.parse_answer.unclear ?? null;
  return null;
}

/**
 * apply_correction (§10.6): the "which crew?" clarification, recorded for a draft whose named
 * subcontractors are exactly Apex Concrete and Ironclad Steel (Northgate) when the fix gives
 * numbers but no crew. Any other draft would get a different question from the model.
 */
export function recordedAmbiguousCorrection(
  text: string,
  subcontractorNames: string[],
): CorrectionResult | null {
  const rec = R.apply_correction.ambiguous;
  if (!rec?.needsClarification) return null;
  const subs = new Set(subcontractorNames);
  if (subs.size !== 2 || !subs.has('Apex Concrete') || !subs.has('Ironclad Steel')) return null;
  if (!/\d|\b(one|two|three|four|five|six|seven|eight|nine|ten)\b/i.test(text)) return null;
  return rec;
}
