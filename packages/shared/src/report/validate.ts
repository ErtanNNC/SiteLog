import { questionCopy } from '../copy/questions.ts';
import type { RequiredFieldKey } from '../enums.ts';
import type { AnswerValue } from '../schemas/ai.ts';
import type {
  DailyReportData,
  DailyReportDataV1,
  ManpowerEntry,
  ManpowerEntryV1,
  QuestionField,
  Source,
  SourceV1,
} from '../schemas/report.ts';
import { hoursFromEndTime, recomputeManpowerTotals, round2 } from './hours.ts';

/**
 * §10.5 validation, question selection and answers, in code. Every function reads report data of
 * either version: v2 (§10.3, what the web pipeline writes from W1-12) and v1 (the WhatsApp worker
 * until step 22). The fields they read are the same in both.
 */

export const LOW_CONFIDENCE_THRESHOLD = 0.7;

/** Report data of either version. */
export type AnyReportData = DailyReportData | DailyReportDataV1;

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

type AnyManpowerEntry = ManpowerEntry | ManpowerEntryV1;

/** §10.5 steps 2–3. Pure: never mutates `data`. */
export function validateReport(data: AnyReportData, ctx: ValidationContext): ValidationResult {
  const req = new Set(ctx.requiredFields);
  const gaps: ValidationGap[] = [];
  const missingRequired: string[] = [];
  const lowConfidence: Array<{ path: string; reason: string }> = [];
  const reviewReasons = new Set<string>();

  const manpowerRequired = req.has('manpower');
  const hoursRequired = req.has('hours');
  const manpower: readonly AnyManpowerEntry[] = data.manpower;

  if (manpowerRequired && manpower.length === 0) {
    gaps.push({ field: 'manpower.workers', path: 'manpower', reason: 'missing' });
    missingRequired.push('manpower');
  }

  manpower.forEach((m, i) => {
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
  m: AnyManpowerEntry,
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

/**
 * A tap-able answer (spec §6.3 `questions.options` `[{id,label}]`). `value` is what code applies
 * for a fallback option (D28: words such as "Full day", never a number code made up); a model's
 * option has none and is read with `parseQuickAnswer`. The field app gets `id` and `label` only;
 * _Other…_ is not an option (hidden until M6, added by the WhatsApp sender only).
 */
export interface QuestionOption {
  id: string;
  label: string;
  value?: AnswerValue;
}

export interface QuestionSpec {
  field: QuestionField;
  path: string;
  prompt: string;
  /**
   * ≤ 2 options. None for a headcount the model proposed no answers for (D28: the field app asks
   * for the number; code never proposes one).
   */
  options: QuestionOption[];
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
  /** The reporter's locale or language for the fallback questions (default English). */
  language?: string | null;
}

/** §10.5 step 4–5 — the single most important gap, with tap-able options. */
export function pickNextQuestion(
  data: AnyReportData,
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

type AnyProposedQuestion = {
  field: string;
  question: string;
  options: string[];
  target?: { companyNameHeard?: string; manpowerIndex?: number };
};

const fold = (s: string) => s.trim().toLocaleLowerCase('en-US');

/**
 * The model's question for a gap. v2 data (§10.3) has no `target`: the model names the gap by its
 * path ("manpower.workers:Delta Mechanical", the tool schema asks for it), else by its field, and
 * a crew's question is matched by the crew it names. v1 data matches on its `target`.
 */
export function proposedQuestionFor(
  data: Pick<AnyReportData, 'proposedQuestions'>,
  gap: ValidationGap,
): AnyProposedQuestion | null {
  const list: readonly AnyProposedQuestion[] = data.proposedQuestions;
  const byPath = list.find((q) => fold(q.field) === fold(gap.path));
  if (byPath) return byPath;
  const names = crewKeys(gap);
  return (
    list.find((q) => {
      if (q.field !== gap.field) return false;
      if (gap.manpowerIndex === undefined) return true;
      if (q.target) {
        return (
          q.target.manpowerIndex === gap.manpowerIndex ||
          (!!q.target.companyNameHeard && q.target.companyNameHeard === gap.companyNameHeard)
        );
      }
      const text = fold(q.question);
      return names.some((n) => text.includes(n));
    }) ?? null
  );
}

/** "the Delta guys", "Delta Mechanical" → "delta guys"… → ["delta", "delta mechanical"]. */
function crewKeys(gap: ValidationGap): string[] {
  const keys = new Set<string>();
  for (const raw of [gap.companyNameHeard, gap.companyName]) {
    if (!raw?.trim()) continue;
    const k = fold(raw)
      .replace(/^(?:the|los|las|el|la)\s+(?:de\s+)?/, '')
      .replace(/\s+(?:guys|crew|team|people|boys|men|ekibi|ekip)$/, '')
      .trim();
    if (k) keys.add(k);
    const first = k.split(/\s+/)[0] ?? '';
    if (first.length >= 4) keys.add(first);
  }
  return [...keys];
}

function option(i: number, label: string, value?: AnswerValue): QuestionOption {
  return value ? { id: `o${i + 1}`, label, value } : { id: `o${i + 1}`, label };
}

function buildQuestion(
  data: AnyReportData,
  gap: ValidationGap,
  ctx: QuestionContext,
): QuestionSpec {
  const c = questionCopy(ctx.language);
  const proposed = proposedQuestionFor(data, gap);
  const heard = gap.companyNameHeard ?? gap.companyName ?? c.theCrew;
  const name = gap.companyName ?? gap.companyNameHeard ?? c.thatCompany;
  const target: QuestionSpec['target'] = {
    manpowerIndex: gap.manpowerIndex,
    companyNameHeard: gap.companyNameHeard,
    companyName: gap.companyName,
    condition: gap.condition,
  };
  let prompt: string;
  let options: Array<[string, AnswerValue | undefined]>;
  switch (gap.field) {
    case 'manpower.workers': {
      const manpower: readonly AnyManpowerEntry[] = data.manpower;
      const area = gap.manpowerIndex !== undefined ? manpower[gap.manpowerIndex]?.area : undefined;
      prompt =
        gap.reason === 'low_confidence'
          ? c.workersLowConfidence(heard, area)
          : c.workersMissing(heard, area);
      // D28: no options; the reporter gives the number.
      options = [];
      break;
    }
    case 'manpower.hours':
      prompt = c.hours(name);
      options = [
        [c.fullDay, { fullDay: true }],
        // Spec §19 Q62: half of the org's default shift, applied in code (applyAnswer).
        [c.halfDay, { halfDay: true }],
      ];
      break;
    case 'company.unknown': {
      const closest = closestCompany(name, ctx.companies ?? []);
      prompt = c.unknownCompany(heard);
      options = [[c.addCompany(shortName(name)), { companyAction: 'add' }]];
      if (closest) {
        options.push([
          c.mapCompany(shortName(closest.name)),
          { companyAction: 'map', companyId: closest.id, companyName: closest.name },
        ]);
        target.closestCompanyId = closest.id;
        target.closestCompanyName = closest.name;
      }
      break;
    }
    case 'weather.impact': {
      const cond = (gap.condition ?? data.weather.conditionsText ?? c.weather).toLocaleLowerCase(
        ctx.language?.startsWith('tr') ? 'tr-TR' : 'en-US',
      );
      if (gap.path === 'weather.conditions') {
        prompt = c.weatherConditions;
        options = [[c.dryNoImpact, { lostHours: 0, text: c.dryNoImpact }]];
      } else {
        prompt = c.weatherImpact(cond || c.weather);
        options = [[c.noStoppage, { lostHours: 0 }]];
      }
      break;
    }
    case 'safety':
      prompt = c.safety;
      options = [
        [c.noIncidents, { noIncidentsStated: true }],
        [c.toolboxTalkHeld, { toolboxTalk: c.toolboxTalkHeld }],
      ];
      break;
    case 'photo':
      prompt = c.photo;
      options = [
        [c.sendingNow, { text: c.sendingNow }],
        [c.noPhotoToday, { text: c.noPhotoToday }],
      ];
      break;
  }
  if (proposed) {
    prompt = proposed.question;
    // The model's options are its own (§10.4 rule 11): read with parseQuickAnswer when tapped.
    if (proposed.options.length > 0)
      options = proposed.options.map((o): [string, AnswerValue | undefined] => [o, undefined]);
  }
  return {
    field: gap.field,
    path: gap.path,
    prompt,
    options: options.slice(0, 2).map(([label, value], i) => option(i, label, value)),
    target,
  };
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

const CREW_NOUN = String.raw`(?:guys?|workers?|men|people|hands|helpers?|personas?|hombres?|kişi|işçi|adam)`;
const LEAD = String.raw`(?:the |a |his |their )?(?:foreman|forman|super|superintendent|lead|leadman|boss|capataz|encargado)`;

/** Letters of any script (Turkish ç ğ ı ö ş ü), not only a–z. */
const NOT_LETTER_BEFORE = String.raw`(?<![\p{L}\p{N}])`;
const NOT_LETTER_AFTER = String.raw`(?![\p{L}\p{N}])`;

/** A whole phrase in Unicode text (JS `\b` only knows ASCII letters). */
function hasPhrase(text: string, phrases: string): boolean {
  return new RegExp(`${NOT_LETTER_BEFORE}(?:${phrases})${NOT_LETTER_AFTER}`, 'u').test(text);
}

/**
 * Headcounts said as a sum: "Jim plus his four guys" → 5, "4 guys and the foreman" → 5,
 * "3 plus 2" → 5. Numbers are already digits. Null when the answer is not phrased that way.
 */
function crewCount(t: string): number | null {
  const sum = new RegExp(
    String.raw`\b(\d+)\s*${CREW_NOUN}?\s*(?:plus|\+|and|y|más|mas|artı|ve)\s*(\d+)\b`,
    'u',
  ).exec(t);
  if (sum) return Number(sum[1]) + Number(sum[2]);
  const personPlusCrew = new RegExp(
    String.raw`\b(?:plus|\+|and|y|con|más|mas)\s+(?:his|her|their|sus?)\s+(\d+)\b`,
  ).exec(t);
  if (personPlusCrew) return Number(personPlusCrew[1]) + 1;
  const crewPlusLead = new RegExp(
    String.raw`\b(\d+)\s*${CREW_NOUN}?\s*(?:plus|\+|and|y|más|mas)\s+${LEAD}\b`,
    'u',
  ).exec(t);
  if (crewPlusLead) return Number(crewPlusLead[1]) + 1;
  return null;
}

const NUMBER_WORDS: Record<string, number> = {
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
  // Turkish (field language TR)
  sıfır: 0,
  bir: 1,
  iki: 2,
  üç: 3,
  dört: 4,
  beş: 5,
  altı: 6,
  yedi: 7,
  sekiz: 8,
  dokuz: 9,
  // "on" (10) is left out: it is also the English preposition ("five on level two").
};

const FULL_DAY = String.raw`full day|all day|whole day|todo el d[ií]a|d[ií]a completo|jornada completa|tam gün|bütün gün|tüm gün`;
const HALF_DAY = String.raw`half day|half a day|medio d[ií]a|media jornada|yarım gün`;

/**
 * Quick parser for button and text answers like "5 · full day", "4, till 3", "six guys 8h",
 * "beş kişi, tam gün" (no model call). EN, ES and TR words.
 */
export function parseQuickAnswer(field: QuestionField, text: string): AnswerValue | null {
  // Plain lower case (English "I" stays "i"); a Turkish "İ" becomes "i" + U+0307, which is dropped.
  const t = text
    .trim()
    .toLowerCase()
    .replace(/\u0307/g, '')
    .replace(/\s+/g, ' ');
  if (!t) return null;
  const normalized = t.replace(/[\p{L}]+/gu, (w) =>
    w in NUMBER_WORDS ? String(NUMBER_WORDS[w]) : w,
  );
  const fullDay = hasPhrase(normalized, FULL_DAY);
  const halfDay = hasPhrase(normalized, HALF_DAY);
  const hoursMatch = /(\d+(?:[.,]\d+)?)\s*(?:h|hr|hrs|hours?|horas?|saat|sa)(?![\p{L}])/u.exec(
    normalized,
  );
  const hoursValue = hoursMatch ? Number(hoursMatch[1]!.replace(',', '.')) : null;
  const tillMatch = /\b(?:till|until|to|hasta(?: las)?)\s*(\d{1,2})(?::(\d{2}))?\s*(am|pm)?\b/.exec(
    normalized,
  );
  switch (field) {
    case 'manpower.workers':
    case 'manpower.hours': {
      const value: AnswerValue = {};
      const headcount =
        /(\d+)\s*(?:·|,|x|×|workers?|guys?|people|men|hands|personas?|hombres?|kişi|işçi)?/u.exec(
          normalized
            .replace(/\d+(?:[.,]\d+)?\s*(?:h|hr|hrs|hours?|horas?|saat|sa)(?![\p{L}])/u, '')
            .replace(/\b(?:till|until|to|hasta(?: las)?)\s*\d{1,2}(?::\d{2})?\s*(?:am|pm)?\b/, ''),
        );
      if (field === 'manpower.workers') {
        // The question is the headcount: "they were here all day" leaves it unanswered (model / re-ask).
        const workers = crewCount(normalized) ?? (headcount ? Number(headcount[1]) : null);
        if (workers === null) return null;
        value.workers = workers;
      }
      if (fullDay) value.fullDay = true;
      else if (halfDay) value.halfDay = true;
      else if (hoursValue !== null) value.hoursPerWorker = hoursValue;
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
        hoursValue === null &&
        !tillMatch
      ) {
        // A bare number for an hours question means hours per worker.
        value.hoursPerWorker = Number(headcount[1]);
      }
      const has =
        value.workers !== undefined ||
        value.fullDay ||
        value.halfDay ||
        value.hoursPerWorker !== undefined ||
        value.endTime;
      return has ? value : null;
    }
    case 'weather.impact': {
      if (
        hasPhrase(
          normalized,
          String.raw`no stoppage|no impact|dry|didn'?t stop|nothing stopped|no delay|sin paro|sin impacto|seco|duruş yok|etkisi yok|kuru`,
        )
      )
        return { lostHours: 0 };
      if (hoursValue !== null) return { lostHours: hoursValue };
      return null;
    }
    case 'safety': {
      if (
        hasPhrase(
          normalized,
          String.raw`no incidents?|nothing happened|all good|sin incidentes|olay yok|kaza yok`,
        )
      )
        return { noIncidentsStated: true };
      if (/\btoolbox\b|charla|konuşma/u.test(normalized))
        return {
          toolboxTalk: 'Toolbox talk held',
          noIncidentsStated: /\bno incidents?\b/.test(normalized),
        };
      return null;
    }
    case 'company.unknown': {
      if (/^add\b|^agregar\b|\bekle$/.test(normalized)) return { companyAction: 'add' };
      if (/^it'?s\b|^its\b|^map\b|^es\b|^bu\b/.test(normalized)) return { companyAction: 'map' };
      return null;
    }
    case 'photo':
      return { text: t };
  }
}

/**
 * The numbers a spoken or typed answer states, in EN, ES and TR words or digits, plus a crew said
 * as a sum ("four and the foreman" → 5, `crewCount`). Pure.
 */
export function statedNumbers(text: string): Set<number> {
  const t = text
    .trim()
    .toLowerCase()
    .replace(/\u0307/g, '')
    .replace(/\s+/g, ' ');
  const normalized = t.replace(/[\p{L}]+/gu, (w) =>
    w in NUMBER_WORDS ? String(NUMBER_WORDS[w]) : w,
  );
  const out = new Set<number>();
  for (const m of normalized.matchAll(/\d+(?:[.,]\d+)?/g)) out.add(Number(m[0].replace(',', '.')));
  const sum = crewCount(normalized);
  if (sum !== null) out.add(sum);
  return out;
}

/**
 * "Never invent numbers" for a parsed answer (W2-09, §10.7): every number the model put in the
 * value must be one the answer states (`statedNumbers`), except what code derives from words it
 * did say ("full day", "half day": hours from the org's shift; "no stoppage": 0 lost hours). An
 * end time must name its hour. Null when the value only carries stated numbers, else the first
 * key that does not (the caller treats the answer as unclear). Pure.
 */
export function unstatedAnswerNumber(value: AnswerValue, text: string): string | null {
  const stated = statedNumbers(text);
  const said = (n: number) => stated.has(n) || stated.has(round2(n));
  if (value.workers != null && !said(value.workers)) return 'workers';
  if (
    value.hoursPerWorker != null &&
    !value.fullDay &&
    !value.halfDay &&
    !said(value.hoursPerWorker)
  )
    return 'hoursPerWorker';
  if (value.totalHours != null && !said(value.totalHours)) return 'totalHours';
  if (value.lostHours != null && value.lostHours !== 0 && !said(value.lostHours))
    return 'lostHours';
  if (value.endTime) {
    const h = Number(value.endTime.slice(0, 2));
    if (!said(h) && !said(h > 12 ? h - 12 : h)) return 'endTime';
  }
  return null;
}

/**
 * D28: an answer given as a number (the field app's number input for a question with no options).
 * Headcount: `workers` (and the hours the reporter set: a number, or 'full_day'); hours:
 * hours per worker; weather: lost hours. Other questions are answered with an option, so a number
 * means nothing for them (null). Code only carries the number the reporter typed.
 */
export function numberAnswer(
  field: QuestionField,
  value: number,
  hours?: number | 'full_day',
): AnswerValue | null {
  if (!Number.isFinite(value) || value < 0) return null;
  switch (field) {
    case 'manpower.workers': {
      if (!Number.isInteger(value)) return null;
      const out: AnswerValue = { workers: value };
      if (hours === 'full_day') out.fullDay = true;
      else if (typeof hours === 'number') out.hoursPerWorker = hours;
      return out;
    }
    case 'manpower.hours':
      if (hours !== undefined) return null;
      return value <= 24 ? { hoursPerWorker: value } : null;
    case 'weather.impact':
      if (hours !== undefined) return null;
      return value <= 24 ? { lostHours: value } : null;
    default:
      return null;
  }
}

/** The answer a tapped option stands for: its value (code's options), else its label parsed. */
export function optionAnswer(
  field: QuestionField,
  option: Pick<QuestionOption, 'label' | 'value'>,
): AnswerValue | null {
  return option.value ?? parseQuickAnswer(field, option.label);
}

/** The source type an answer carries in data of each version. */
export type AnswerSourceOf<D extends AnyReportData> = D extends DailyReportData ? Source : SourceV1;

export interface ApplyAnswerContext<S extends Source | SourceV1 = Source | SourceV1> {
  defaultShiftHours: number;
  workingHours?: string | null;
  /**
   * Where the answer came from: `{type:'answer', questionId}` (§10.3, v2 data), or the WhatsApp
   * reply `{type:'reply', messageId}` for v1 data until step 22.
   */
  source: S;
  /**
   * More sources of the value (W2-09): a spoken answer's clip, `{type:'voice_note', uploadId,
   * start, end}`, after the answer itself.
   */
  extraSources?: readonly S[];
  confidence?: number;
  companies?: ReadonlyArray<{ id: string; name: string }>;
}

/** Loose shapes for applying an answer to either version (both have these fields). */
type LooseSource = Source | SourceV1;
interface LooseEntry {
  companyId: string | null;
  companyNameHeard: string;
  companyName: string;
  trade?: string;
  area?: string;
  workers: number | null;
  hoursPerWorker: number | null;
  totalHours: number | null;
  hoursBasis: string;
  confidence: number;
  source: LooseSource[];
}
interface LooseData {
  manpower: LooseEntry[];
  weather: {
    conditionsText: string;
    periods: Array<{
      start?: string;
      end?: string;
      condition: string;
      impact?: string;
      lostHours: number;
      fullDay?: boolean;
      source: LooseSource[];
    }>;
  };
  safety: { toolboxTalk?: string; noIncidentsStated: boolean; source: LooseSource[] };
}

/** Apply a parsed answer to the draft (§F6 step 5, F7). Pure. Totals are recomputed in code. */
export function applyAnswer<D extends AnyReportData>(
  data: D,
  question: Pick<QuestionSpec, 'field' | 'target'>,
  answer: AnswerValue,
  ctx: ApplyAnswerContext<AnswerSourceOf<D>>,
): { data: D; ackText: string | null } {
  const next = structuredClone(data) as unknown as LooseData;
  const done = (ackText: string | null) => ({ data: next as unknown as D, ackText });
  const src = ctx.source as Source | SourceV1;
  const srcs = [src, ...((ctx.extraSources ?? []) as ReadonlyArray<Source | SourceV1>)];
  // v2 calls a value from an answer 'answer' (§10.3); v1 called it 'reply'.
  const answered = data.schemaVersion === 2 ? 'answer' : 'reply';
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
              : answer.halfDay
                ? ctx.defaultShiftHours / 2
                : (answer.hoursPerWorker ?? null),
            totalHours: null,
            hoursBasis: answer.fullDay
              ? 'full_day_default'
              : answer.halfDay || answer.hoursPerWorker != null
                ? answered
                : 'unknown',
            confidence: conf,
            source: [...srcs],
          });
        } else {
          return done(null);
        }
      } else {
        if (answer.workers !== undefined && answer.workers !== null) entry.workers = answer.workers;
        if (answer.fullDay) {
          entry.hoursPerWorker = ctx.defaultShiftHours;
          entry.hoursBasis = 'full_day_default';
        } else if (answer.halfDay) {
          // Spec §19 Q62: "Half day" is half of the org's default shift (4 h of the default 8 h).
          entry.hoursPerWorker = ctx.defaultShiftHours / 2;
          entry.hoursBasis = answered;
        } else if (answer.hoursPerWorker !== undefined && answer.hoursPerWorker !== null) {
          entry.hoursPerWorker = answer.hoursPerWorker;
          entry.hoursBasis = answered;
        } else if (answer.endTime && ctx.workingHours) {
          const h = hoursFromEndTime(ctx.workingHours, answer.endTime);
          if (h !== null) {
            entry.hoursPerWorker = h;
            entry.hoursBasis = answered;
          }
        } else if (answer.totalHours !== undefined && answer.totalHours !== null) {
          entry.totalHours = answer.totalHours;
          entry.hoursBasis = answered;
        }
        entry.confidence = Math.max(entry.confidence, conf);
        entry.source = [...entry.source, ...srcs];
      }
      const { entries } = recomputeManpowerTotals(next.manpower);
      next.manpower = entries;
      const e = idx !== undefined ? next.manpower[idx] : next.manpower[next.manpower.length - 1];
      if (e && e.workers !== null && e.hoursPerWorker !== null && e.totalHours !== null) {
        return done(
          `Thanks — ${e.companyName}: ${e.workers} workers × ${trimNum(e.hoursPerWorker)} h = ${trimNum(e.totalHours)} h.`,
        );
      }
      if (e && e.workers !== null) return done(`Thanks — ${e.companyName}: ${e.workers} workers.`);
      return done('Thanks.');
    }
    case 'company.unknown': {
      const idx = question.target.manpowerIndex;
      const entry = idx !== undefined ? next.manpower[idx] : undefined;
      if (!entry) return done(null);
      if (answer.companyAction === 'map') {
        const id = answer.companyId ?? question.target.closestCompanyId;
        const name =
          ctx.companies?.find((c) => c.id === id)?.name ??
          answer.companyName ??
          question.target.closestCompanyName;
        if (id && name) {
          entry.companyId = id;
          entry.companyName = name;
          entry.source = [...entry.source, ...srcs];
          return done(`Thanks — logged as ${name}.`);
        }
      }
      if (answer.companyAction === 'add' || answer.companyName) {
        entry.companyName = answer.companyName ?? entry.companyName;
        entry.source = [...entry.source, ...srcs];
        return done(`Thanks — I've added ${entry.companyName} for the office to confirm.`);
      }
      return done(null);
    }
    case 'weather.impact': {
      const lost = answer.lostHours ?? null;
      const period = next.weather.periods.find((p) => !p.impact) ?? next.weather.periods[0];
      if (period) {
        if (lost !== null) period.lostHours = round2(lost);
        if (answer.impact) period.impact = answer.impact;
        if (answer.start) period.start = answer.start;
        if (answer.end) period.end = answer.end;
        period.source = [...period.source, ...srcs];
      } else if (lost === 0 && !answer.impact && answer.text && !next.weather.conditionsText) {
        // "Dry, no impact" to "What was the weather like?": the conditions, no stoppage period.
        next.weather.conditionsText = answer.text;
      } else if (lost !== null || answer.impact) {
        next.weather.periods.push({
          condition: question.target.condition ?? next.weather.conditionsText ?? 'Weather',
          impact: answer.impact,
          lostHours: round2(lost ?? 0),
          start: answer.start,
          end: answer.end,
          source: [...srcs],
        });
      } else if (answer.text && !next.weather.conditionsText) {
        next.weather.conditionsText = answer.text;
      }
      if (!next.weather.conditionsText && answer.impact)
        next.weather.conditionsText = answer.impact;
      const l = lost ?? 0;
      return done(
        l > 0
          ? `Thanks — ${trimNum(l)} h lost to weather logged.`
          : 'Thanks — no weather stoppage logged.',
      );
    }
    case 'safety': {
      if (answer.noIncidentsStated !== undefined)
        next.safety.noIncidentsStated = answer.noIncidentsStated;
      if (answer.toolboxTalk) next.safety.toolboxTalk = answer.toolboxTalk;
      next.safety.source = [...next.safety.source, ...srcs];
      return done('Thanks — safety noted.');
    }
    case 'photo':
      return done(null);
  }
}

function trimNum(n: number): string {
  return Number.isInteger(n) ? String(n) : String(round2(n));
}
