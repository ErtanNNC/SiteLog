import type { ClassifiedReply, DayOffClassification } from '../schemas/ai.ts';
import type { DailyReportDataV1 } from '../schemas/report.ts';
import { resolveDayReference } from '../schedule/day.ts';

/**
 * Deterministic reply handling shared by the worker (no-model paths, pre-pass before the model)
 * and the in-browser field simulator: §9.5 short-reply grammar, the §F10 day-off fallback and the
 * "this note describes a day off" check. Pure; no model calls.
 */

const CONFIRM_WORDS =
  /^(ok|okay|k|yes|yep|yeah|yup|sure|file it|looks good|good|fine|correct|confirm|confirmed|approved|go ahead|send it|dale|s[ií]|si|vale|listo|perfecto|bien|correcto|ok file it|all good)[.!]*$/i;
const HELP_WORDS = /^(help|ayuda|\?|how does this work|what do i do)[.!?]*$/i;
const STOP_WORDS = /^(stop|no more reminders|basta|alto|para|no me recuerdes)[.!]*$/i;
const NO_WORK =
  /^(no work( today)?|no work on site|site closed( today)?|no trabajo( hoy)?|hoy no hay trabajo|day off|holiday today|no crew today)[.!]*$/i;
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
  if (lang)
    return { intent: 'language', confidence: 1, entities: { language: lang[2]!.toLowerCase() } };
  const edit = EDIT.exec(t);
  if (edit && /^(edit|edita)\b/i.test(t)) {
    const rest = edit[2] ?? '';
    const day = resolveDayReference(rest, now, tz);
    if (day) {
      const correctionText = stripDayReference(rest);
      return {
        intent: 'edit_request',
        confidence: 1,
        entities: { dayReference: day },
        correctionText: correctionText || null,
      };
    }
  }
  return null;
}

/** Remove the leading day reference and separators: "Friday — Apex was 7" → "Apex was 7". */
export function stripDayReference(text: string): string {
  return text
    .replace(
      /^\s*(the\s+)?(report\s+(for|from)\s+)?(today|yesterday|hoy|ayer|monday|tuesday|wednesday|thursday|friday|saturday|sunday|mon|tue|tues|wed|thu|thur|thurs|fri|sat|sun|lunes|martes|mi[eé]rcoles|jueves|viernes|s[aá]bado|domingo|\d{4}-\d{2}-\d{2}|\d{1,2}\/\d{1,2}(\/\d{2,4})?|[a-z]{3,9}\.?\s+\d{1,2}(st|nd|rd|th)?|\d{1,2}(st|nd|rd|th)?\s+(of\s+)?[a-z]{3,9})('s)?(\s+report)?\s*/i,
      '',
    )
    .replace(/^[\s,:;—–-]+/, '')
    .trim();
}

const RAIN =
  /\b(rain|rained|raining|lluvia|llovi[oó]|llueve|storm|tormenta|lightning|rayos|snow|nieve|ice|hielo|wind|windy|viento|gust|too hot|heat|calor|flood|inundad|weather|clima|tiempo)\b/i;
const HOLIDAY =
  /\b(holiday|feriado|d[ií]a festivo|no crew|day off|scheduled|planned|closed for|cerrado por|no work|no trabajo)\b/i;
const TIME = /\b(?:at|a las?|about|around)\s+(\d{1,2})(?::(\d{2}))?\s*(am|pm)?\b/i;

/** §F10 regex fallback used when no model client is configured (tests, offline, the simulator). */
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
  const cause = weather
    ? (RAIN.exec(t)?.[1]?.toLowerCase() ?? 'weather')
    : HOLIDAY.test(t)
      ? 'planned'
      : null;
  const workers = /\b(\d{1,3})\s*(guys|people|workers|men|hands|personas|hombres|on site)\b/i.exec(
    t,
  );
  return {
    kind,
    fullDay: !releasedAt,
    releasedAt,
    cause: normaliseDayOffCause(cause),
    workersThisMorning: workers ? Number(workers[1]) : null,
    confidence: weather ? 0.8 : 0.6,
  };
}

export function normaliseDayOffCause(c: string | null): string | null {
  if (!c) return null;
  if (/rain|lluvia|llovi|llueve|storm|tormenta|flood|inundad/.test(c)) return 'rain';
  if (/wind|viento|gust/.test(c)) return 'high wind';
  if (/lightning|rayos/.test(c)) return 'lightning';
  if (/snow|nieve|ice|hielo/.test(c)) return 'snow and ice';
  if (/hot|heat|calor/.test(c)) return 'heat';
  return c;
}

/** Said in the note itself: an empty draft alone is not evidence (a transcript may be missing). */
const DAY_OFF_WORDS =
  /\b(no work|nobody (worked|came|was on site|on site|showed)|no one (worked|came|on site)|no crew|(site|street|road) (was |is )?closed|rained out|weather day|stay(ed)? home|sent (everyone|everybody|the crew|the guys|them) home|no (hubo )?trabajo|nadie (trabaj|vino|en la obra))/i;

/** The note described a day off: no crew and no work in the draft, and the speaker said so. */
export function looksLikeDayOff(
  data: Pick<DailyReportDataV1, 'workPerformed' | 'manpower'>,
  text: string,
): boolean {
  return (
    data.workPerformed.length === 0 &&
    data.manpower.every((m) => m.workers === 0) &&
    DAY_OFF_WORDS.test(text)
  );
}
