import type { RequiredFieldKey } from '../enums.ts';
import type { AnswerValue } from '../schemas/ai.ts';
import type { DailyReportData, ManpowerEntry, QuestionField, Source } from '../schemas/report.ts';
import { hoursFromEndTime, recomputeManpowerTotals, round2 } from './hours.ts';

export const LOW_CONFIDENCE_THRESHOLD = 0.7;

/** §10.5 step 4 — question priority. */
export const QUESTION_PRIORITY: QuestionField[] = [
  'manpower.workers',
  'manpower.hours',
  'company.unknown',
  'weather.impact',
  'safety',
  'photo',
];

export type GapReason = 'missing' | 'low_confidence' | 'unknown_company';

export interface ValidationGap {
  field: QuestionField;
  /** Stable key, e.g. "manpower.workers:Delta Mechanical" — also used in questions.field + target. */
  path: string;
  reason: GapReason;
  manpowerIndex?: number;
  companyNameHeard?: string;
  companyName?: string;
  condition?: string;
}

export interface ValidationResult {
  gaps: ValidationGap[];
  /** Required values that are absent (mirrors DailyReportData.missingRequired, computed in code). */
  missingRequired: string[];
  lowConfidence: Array<{ path: string; reason: string }>;
  /** reports.review_reasons candidates, e.g. 'unknown_company:Ridgeway', 'low_confidence:manpower'. */
  reviewReasons: string[];
  /** true when every required field is satisfied (questions may still be pending for low confidence). */
  isComplete: boolean;
}

export interface ValidationContext {
  requiredFields: readonly RequiredFieldKey[] | RequiredFieldKey[];
  /** Photos attached to the site-day (data.photos is used when omitted). */
  photoCount?: number;
}

/** §10.5 steps 2–3. Pure: never mutates `data`. */
export function validateReport(data: DailyReportData, ctx: ValidationContext): ValidationResult {
  const req = new Set(ctx.requiredFields);
  const gaps: ValidationGap[] = [];
  const missingRequired: string[] = [];
  const lowConfidence: Array<{ path: string; reason: string }> = [];
  const reviewReasons = new Set<string>();

  const manpowerRequired = req.has('manpower');
  const hoursRequired = req.has('hours');

  if (manpowerRequired && data.manpower.length === 0) {
    gaps.push({ field: 'manpower.workers', path: 'manpower', reason: 'missing' });
    missingRequired.push('manpower');
  }

  data.manpower.forEach((m, i) => {
    const label = m.companyName || m.companyNameHeard;
    if (manpowerRequired && m.workers === null) {
      gaps.push(gapFor('manpower.workers', `manpower.workers:${label}`, 'missing', m, i));
      missingRequired.push(`manpower.workers:${label}`);
    } else if (manpowerRequired && m.confidence < LOW_CONFIDENCE_THRESHOLD) {
      gaps.push(gapFor('manpower.workers', `manpower.workers:${label}`, 'low_confidence', m, i));
      lowConfidence.push({
        path: `manpower[${i}]`,
        reason: `confidence ${m.confidence.toFixed(2)}`,
      });
      reviewReasons.add('low_confidence:manpower');
    }
    if (hoursRequired && m.totalHours === null) {
      gaps.push(gapFor('manpower.hours', `manpower.hours:${label}`, 'missing', m, i));
      missingRequired.push(`manpower.hours:${label}`);
    }
    if (m.companyId === null) {
      gaps.push(gapFor('company.unknown', `company.unknown:${label}`, 'unknown_company', m, i));
      reviewReasons.add(`unknown_company:${label}`);
    }
  });

  if (req.has('weather')) {
    if (!data.weather.conditionsText.trim()) {
      gaps.push({ field: 'weather.impact', path: 'weather.conditions', reason: 'missing' });
      missingRequired.push('weather.conditions');
    }
    data.weather.periods.forEach((p, i) => {
      // A stoppage without a duration cannot go into the delay record.
      if (p.lostHours === undefined || p.lostHours === null || Number.isNaN(p.lostHours)) {
        gaps.push({
          field: 'weather.impact',
          path: `weather.periods[${i}].lostHours`,
          reason: 'missing',
          condition: p.condition,
        });
        missingRequired.push(`weather.periods[${i}].lostHours`);
      }
    });
    for (const lc of data.lowConfidence) {
      if (lc.path.startsWith('weather')) {
        const cond = data.weather.periods[0]?.condition ?? data.weather.conditionsText;
        gaps.push({
          field: 'weather.impact',
          path: lc.path,
          reason: 'low_confidence',
          condition: cond,
        });
        lowConfidence.push(lc);
      }
    }
  }

  if (req.has('work_performed') && data.workPerformed.length === 0) {
    // Not asked as a question (§10.5 priority list) — flagged for the office instead.
    missingRequired.push('work_performed');
    reviewReasons.add('missing:work_performed');
  }

  if (req.has('safety')) {
    const ok =
      data.safety.noIncidentsStated ||
      data.safety.incidents.length > 0 ||
      !!data.safety.toolboxTalk;
    if (!ok) {
      gaps.push({ field: 'safety', path: 'safety', reason: 'missing' });
      missingRequired.push('safety');
    }
  }

  if (req.has('photo')) {
    const n = ctx.photoCount ?? data.photos.length;
    if (n < 1) {
      gaps.push({ field: 'photo', path: 'photo', reason: 'missing' });
      missingRequired.push('photo');
    }
  }

  const required = new Set<string>(missingRequired);
  const isComplete = required.size === 0;
  return {
    gaps,
    missingRequired: Array.from(required),
    lowConfidence,
    reviewReasons: Array.from(reviewReasons),
    isComplete,
  };
}

function gapFor(
  field: QuestionField,
  path: string,
  reason: GapReason,
  m: ManpowerEntry,
  i: number,
): ValidationGap {
  return {
    field,
    path,
    reason,
    manpowerIndex: i,
    companyNameHeard: m.companyNameHeard,
    companyName: m.companyName,
  };
}

export interface QuestionSpec {
  field: QuestionField;
  path: string;
  prompt: string;
  /** ≤ 2 options; an "Other…" button is added when sending. */
  options: string[];
  target: {
    manpowerIndex?: number;
    companyNameHeard?: string;
    companyName?: string;
    closestCompanyId?: string;
    closestCompanyName?: string;
    condition?: string;
  };
}

export interface QuestionContext {
  /** questions.field+target paths already asked for this report. */
  askedPaths: readonly string[];
  askedCount: number;
  maxQuestions: number;
  companies?: ReadonlyArray<{ id: string; name: string; aliases?: readonly string[] }>;
}

/** §10.5 step 4–5 — the single most important gap, with tap-able options. */
export function pickNextQuestion(
  data: DailyReportData,
  validation: ValidationResult,
  ctx: QuestionContext,
): QuestionSpec | null {
  if (ctx.askedCount >= ctx.maxQuestions) return null;
  const asked = new Set(ctx.askedPaths);
  for (const field of QUESTION_PRIORITY) {
    const gap = validation.gaps.find(
      (g) => g.field === field && !asked.has(g.path) && !coveredByEarlierQuestion(g, asked),
    );
    if (!gap) continue;
    return buildQuestion(data, gap, ctx);
  }
  return null;
}

/** "How many, and for how long?" answers both workers and hours for the same crew. */
function coveredByEarlierQuestion(gap: ValidationGap, asked: Set<string>): boolean {
  if (gap.field === 'manpower.hours' && gap.companyName) {
    return asked.has(`manpower.workers:${gap.companyName}`);
  }
  return false;
}

function buildQuestion(
  data: DailyReportData,
  gap: ValidationGap,
  ctx: QuestionContext,
): QuestionSpec {
  const proposed = data.proposedQuestions.find(
    (q) =>
      q.field === gap.field &&
      (gap.manpowerIndex === undefined ||
        q.target?.manpowerIndex === gap.manpowerIndex ||
        (q.target?.companyNameHeard && q.target.companyNameHeard === gap.companyNameHeard)),
  );
  const heard = gap.companyNameHeard ?? gap.companyName ?? 'the crew';
  const name = gap.companyName ?? gap.companyNameHeard ?? 'that company';
  const target: QuestionSpec['target'] = {
    manpowerIndex: gap.manpowerIndex,
    companyNameHeard: gap.companyNameHeard,
    companyName: gap.companyName,
    condition: gap.condition,
  };
  let prompt: string;
  let options: string[];
  switch (gap.field) {
    case 'manpower.workers': {
      const area =
        gap.manpowerIndex !== undefined ? data.manpower[gap.manpowerIndex]?.area : undefined;
      prompt =
        gap.reason === 'low_confidence'
          ? `Quick check: I heard "${heard}"${area ? ` on ${area}` : ''}. How many were there, and for how long?`
          : `Quick check: you said "${heard}"${area ? ` on ${area}` : ''}. How many, and for how long?`;
      options = [];
      break;
    }
    case 'manpower.hours':
      prompt = `How long was ${name} on site today?`;
      options = ['Full day', 'Half day'];
      break;
    case 'company.unknown': {
      const closest = closestCompany(name, ctx.companies ?? []);
      prompt = `I heard "${heard}" — is that a new subcontractor?`;
      options = [`Add "${shortName(name)}"`];
      if (closest) {
        options.push(`It's ${shortName(closest.name)}`);
        target.closestCompanyId = closest.id;
        target.closestCompanyName = closest.name;
      }
      break;
    }
    case 'weather.impact': {
      const cond = (gap.condition ?? data.weather.conditionsText ?? 'weather').toLowerCase();
      prompt =
        gap.path === 'weather.conditions'
          ? 'What was the weather like today, and did it stop any work?'
          : `You mentioned ${cond}. Did work stop, and for how long?`;
      options = gap.path === 'weather.conditions' ? ['Dry, no impact'] : ['No stoppage'];
      break;
    }
    case 'safety':
      prompt = 'Any incidents or a toolbox talk today?';
      options = ['No incidents', 'Toolbox talk held'];
      break;
    case 'photo':
      prompt = "A photo of today's work would complete the report. Can you send one?";
      options = ['Sending now', 'No photo today'];
      break;
  }
  if (proposed) {
    prompt = proposed.question;
    if (proposed.options.length > 0) options = proposed.options;
  }
  return { field: gap.field, path: gap.path, prompt, options: options.slice(0, 2), target };
}

function shortName(name: string): string {
  return name.length > 14 ? `${name.slice(0, 13).trimEnd()}…` : name;
}

/** Sørensen–Dice bigram similarity, used to offer "It's {closest match}". */
export function similarity(a: string, b: string): number {
  const bigrams = (s: string) => {
    const t = s
      .toLowerCase()
      .replace(/[^a-z0-9]/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
    const out = new Map<string, number>();
    for (let i = 0; i < t.length - 1; i++) {
      const bg = t.slice(i, i + 2);
      out.set(bg, (out.get(bg) ?? 0) + 1);
    }
    return out;
  };
  const A = bigrams(a);
  const B = bigrams(b);
  let inter = 0;
  for (const [k, v] of A) inter += Math.min(v, B.get(k) ?? 0);
  const sizeA = Array.from(A.values()).reduce((x, y) => x + y, 0);
  const sizeB = Array.from(B.values()).reduce((x, y) => x + y, 0);
  if (sizeA + sizeB === 0) return 0;
  return (2 * inter) / (sizeA + sizeB);
}

export function closestCompany<T extends { id: string; name: string; aliases?: readonly string[] }>(
  heard: string,
  companies: ReadonlyArray<T>,
  threshold = 0.45,
): T | null {
  let best: { c: T; score: number } | null = null;
  for (const c of companies) {
    const candidates = [c.name, ...(c.aliases ?? [])];
    const score = Math.max(...candidates.map((n) => similarity(heard, n)));
    if (score > (best?.score ?? -1)) best = { c, score };
  }
  return best && best.score >= threshold ? best.c : null;
}

const CREW_NOUN = String.raw`(?:guys?|workers?|men|people|hands|helpers?|personas?|hombres?)`;
const LEAD = String.raw`(?:the |a |his |their )?(?:foreman|forman|super|superintendent|lead|leadman|boss|capataz|encargado)`;

/**
 * Headcounts said as a sum: "Jim plus his four guys" → 5, "4 guys and the foreman" → 5,
 * "3 plus 2" → 5. Numbers are already digits. Null when the answer is not phrased that way.
 */
function crewCount(t: string): number | null {
  const sum = new RegExp(
    String.raw`\b(\d+)\s*${CREW_NOUN}?\s*(?:plus|\+|and|y|más|mas)\s*(\d+)\b`,
  ).exec(t);
  if (sum) return Number(sum[1]) + Number(sum[2]);
  const personPlusCrew = new RegExp(
    String.raw`\b(?:plus|\+|and|y|con|más|mas)\s+(?:his|her|their|sus?)\s+(\d+)\b`,
  ).exec(t);
  if (personPlusCrew) return Number(personPlusCrew[1]) + 1;
  const crewPlusLead = new RegExp(
    String.raw`\b(\d+)\s*${CREW_NOUN}?\s*(?:plus|\+|and|y|más|mas)\s+${LEAD}\b`,
  ).exec(t);
  if (crewPlusLead) return Number(crewPlusLead[1]) + 1;
  return null;
}

/** Quick parser for button/text answers like "5 · full day", "4, till 3", "six guys 8h" (no model call). */
export function parseQuickAnswer(field: QuestionField, text: string): AnswerValue | null {
  const t = text.trim().toLowerCase().replace(/\s+/g, ' ');
  if (!t) return null;
  const numberWords: Record<string, number> = {
    zero: 0,
    one: 1,
    two: 2,
    three: 3,
    four: 4,
    five: 5,
    six: 6,
    seven: 7,
    eight: 8,
    nine: 9,
    ten: 10,
    eleven: 11,
    twelve: 12,
    uno: 1,
    dos: 2,
    tres: 3,
    cuatro: 4,
    cinco: 5,
    seis: 6,
    siete: 7,
    ocho: 8,
    nueve: 9,
    diez: 10,
  };
  const normalized = t.replace(/\b([a-z]+)\b/g, (w) =>
    w in numberWords ? String(numberWords[w]) : w,
  );
  const fullDay =
    /\b(full day|all day|whole day|todo el d[ií]a|d[ií]a completo|jornada completa)\b/.test(
      normalized,
    );
  const halfDay = /\b(half day|half a day|medio d[ií]a|media jornada)\b/.test(normalized);
  const hoursMatch = /(\d+(?:\.\d+)?)\s*(?:h|hr|hrs|hours?|horas?)\b/.exec(normalized);
  const tillMatch = /\b(?:till|until|to|hasta(?: las)?)\s*(\d{1,2})(?::(\d{2}))?\s*(am|pm)?\b/.exec(
    normalized,
  );
  switch (field) {
    case 'manpower.workers':
    case 'manpower.hours': {
      const value: AnswerValue = {};
      const headcount =
        /(\d+)\s*(?:·|,|x|×|workers?|guys?|people|men|hands|personas?|hombres?)?/.exec(
          normalized
            .replace(/\d+(?:\.\d+)?\s*(?:h|hr|hrs|hours?|horas?)\b/, '')
            .replace(/\b(?:till|until|to|hasta(?: las)?)\s*\d{1,2}(?::\d{2})?\s*(?:am|pm)?\b/, ''),
        );
      if (field === 'manpower.workers') {
        // The question is the headcount: "they were here all day" leaves it unanswered (model / re-ask).
        const workers = crewCount(normalized) ?? (headcount ? Number(headcount[1]) : null);
        if (workers === null) return null;
        value.workers = workers;
      }
      if (fullDay) value.fullDay = true;
      else if (halfDay) value.hoursPerWorker = 4;
      else if (hoursMatch) value.hoursPerWorker = Number(hoursMatch[1]);
      else if (tillMatch) {
        let h = Number(tillMatch[1]);
        const m = tillMatch[2] ?? '00';
        if (tillMatch[3] === 'pm' && h < 12) h += 12;
        if (!tillMatch[3] && h < 7) h += 12; // "till 3" on a site means 15:00
        value.endTime = `${String(h).padStart(2, '0')}:${m}`;
      }
      if (
        field === 'manpower.hours' &&
        value.workers === undefined &&
        headcount &&
        !fullDay &&
        !halfDay &&
        !hoursMatch &&
        !tillMatch
      ) {
        // A bare number for an hours question means hours per worker.
        value.hoursPerWorker = Number(headcount[1]);
      }
      const has =
        value.workers !== undefined ||
        value.fullDay ||
        value.hoursPerWorker !== undefined ||
        value.endTime;
      return has ? value : null;
    }
    case 'weather.impact': {
      if (/\b(no stoppage|no impact|dry|didn'?t stop|nothing stopped|no delay)\b/.test(normalized))
        return { lostHours: 0 };
      if (hoursMatch) return { lostHours: Number(hoursMatch[1]) };
      return null;
    }
    case 'safety': {
      if (/\b(no incidents?|nothing happened|all good|sin incidentes)\b/.test(normalized))
        return { noIncidentsStated: true };
      if (/\btoolbox\b/.test(normalized))
        return {
          toolboxTalk: 'Toolbox talk held',
          noIncidentsStated: /\bno incidents?\b/.test(normalized),
        };
      return null;
    }
    case 'company.unknown': {
      if (/^add\b/.test(normalized)) return { companyAction: 'add' };
      if (/^it'?s\b|^its\b|^map\b/.test(normalized)) return { companyAction: 'map' };
      return null;
    }
    case 'photo':
      return { text: t };
  }
}

export interface ApplyAnswerContext {
  defaultShiftHours: number;
  workingHours?: string | null;
  messageId: string;
  confidence?: number;
  companies?: ReadonlyArray<{ id: string; name: string }>;
}

/** Apply a parsed answer to the draft (§F6 step 5). Pure. */
export function applyAnswer(
  data: DailyReportData,
  question: Pick<QuestionSpec, 'field' | 'target'>,
  answer: AnswerValue,
  ctx: ApplyAnswerContext,
): { data: DailyReportData; ackText: string | null } {
  const next: DailyReportData = structuredClone(data);
  const src: Source = { type: 'reply', messageId: ctx.messageId };
  const conf = ctx.confidence ?? 1;
  switch (question.field) {
    case 'manpower.workers':
    case 'manpower.hours': {
      const idx = question.target.manpowerIndex;
      const entry = idx !== undefined ? next.manpower[idx] : undefined;
      if (!entry) {
        if (answer.workers !== undefined && answer.workers !== null && next.manpower.length === 0) {
          next.manpower.push({
            companyId: null,
            companyNameHeard: question.target.companyNameHeard ?? 'crew',
            companyName: question.target.companyName ?? 'Crew',
            workers: answer.workers,
            hoursPerWorker: answer.fullDay
              ? ctx.defaultShiftHours
              : (answer.hoursPerWorker ?? null),
            totalHours: null,
            hoursBasis: answer.fullDay
              ? 'full_day_default'
              : answer.hoursPerWorker != null
                ? 'reply'
                : 'unknown',
            confidence: conf,
            source: [src],
          });
        } else {
          return { data: next, ackText: null };
        }
      } else {
        if (answer.workers !== undefined && answer.workers !== null) entry.workers = answer.workers;
        if (answer.fullDay) {
          entry.hoursPerWorker = ctx.defaultShiftHours;
          entry.hoursBasis = 'full_day_default';
        } else if (answer.hoursPerWorker !== undefined && answer.hoursPerWorker !== null) {
          entry.hoursPerWorker = answer.hoursPerWorker;
          entry.hoursBasis = 'reply';
        } else if (answer.endTime && ctx.workingHours) {
          const h = hoursFromEndTime(ctx.workingHours, answer.endTime);
          if (h !== null) {
            entry.hoursPerWorker = h;
            entry.hoursBasis = 'reply';
          }
        } else if (answer.totalHours !== undefined && answer.totalHours !== null) {
          entry.totalHours = answer.totalHours;
          entry.hoursBasis = 'reply';
        }
        entry.confidence = Math.max(entry.confidence, conf);
        entry.source = [...entry.source, src];
      }
      const { entries } = recomputeManpowerTotals(next.manpower);
      next.manpower = entries;
      const e = idx !== undefined ? next.manpower[idx] : next.manpower[next.manpower.length - 1];
      if (e && e.workers !== null && e.hoursPerWorker !== null && e.totalHours !== null) {
        return {
          data: next,
          ackText: `Thanks — ${e.companyName}: ${e.workers} workers × ${trimNum(e.hoursPerWorker)} h = ${trimNum(e.totalHours)} h.`,
        };
      }
      if (e && e.workers !== null)
        return { data: next, ackText: `Thanks — ${e.companyName}: ${e.workers} workers.` };
      return { data: next, ackText: 'Thanks.' };
    }
    case 'company.unknown': {
      const idx = question.target.manpowerIndex;
      const entry = idx !== undefined ? next.manpower[idx] : undefined;
      if (!entry) return { data: next, ackText: null };
      if (answer.companyAction === 'map') {
        const id = answer.companyId ?? question.target.closestCompanyId;
        const name =
          ctx.companies?.find((c) => c.id === id)?.name ??
          answer.companyName ??
          question.target.closestCompanyName;
        if (id && name) {
          entry.companyId = id;
          entry.companyName = name;
          entry.source = [...entry.source, src];
          return { data: next, ackText: `Thanks — logged as ${name}.` };
        }
      }
      if (answer.companyAction === 'add' || answer.companyName) {
        entry.companyName = answer.companyName ?? entry.companyName;
        entry.source = [...entry.source, src];
        return {
          data: next,
          ackText: `Thanks — I've added ${entry.companyName} for the office to confirm.`,
        };
      }
      return { data: next, ackText: null };
    }
    case 'weather.impact': {
      const lost = answer.lostHours ?? null;
      const period = next.weather.periods.find((p) => !p.impact) ?? next.weather.periods[0];
      if (period) {
        if (lost !== null) period.lostHours = round2(lost);
        if (answer.impact) period.impact = answer.impact;
        if (answer.start) period.start = answer.start;
        if (answer.end) period.end = answer.end;
        period.source = [...period.source, src];
      } else if (lost !== null || answer.impact) {
        next.weather.periods.push({
          condition: question.target.condition ?? next.weather.conditionsText ?? 'Weather',
          impact: answer.impact,
          lostHours: round2(lost ?? 0),
          start: answer.start,
          end: answer.end,
          source: [src],
        });
      } else if (answer.text && !next.weather.conditionsText) {
        next.weather.conditionsText = answer.text;
      }
      if (!next.weather.conditionsText && answer.impact)
        next.weather.conditionsText = answer.impact;
      const l = lost ?? 0;
      return {
        data: next,
        ackText:
          l > 0
            ? `Thanks — ${trimNum(l)} h lost to weather logged.`
            : 'Thanks — no weather stoppage logged.',
      };
    }
    case 'safety': {
      if (answer.noIncidentsStated !== undefined)
        next.safety.noIncidentsStated = answer.noIncidentsStated;
      if (answer.toolboxTalk) next.safety.toolboxTalk = answer.toolboxTalk;
      next.safety.source = [...next.safety.source, src];
      return { data: next, ackText: 'Thanks — safety noted.' };
    }
    case 'photo':
      return { data: next, ackText: null };
  }
}

function trimNum(n: number): string {
  return Number.isInteger(n) ? String(n) : String(round2(n));
}
