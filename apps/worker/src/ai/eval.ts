import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type Anthropic from '@anthropic-ai/sdk';
import { z } from 'zod';
import {
  DailyReportDataSchema,
  ObservedWeatherV1Schema,
  PhotoSchema,
  QUESTION_FIELDS,
  REPORTER_LOCALES,
  REPORT_LANGUAGES,
  REQUIRED_FIELD_KEYS,
  ReportExtractionSchema,
  UNIT_SYSTEMS,
  pickNextQuestion,
  round2,
  toObservedIn,
  validateReport,
  type DailyReportData,
  type ReportExtraction,
  type QuestionField,
  type RequiredFieldKey,
} from '@sitelog/shared';
import { runAnswerEval } from './answer-fixtures';
import { createAnthropicClient, type MessagesClient } from './claude';
import { runReportExtraction, type ExtractionInputV2 } from './extract';
import { buildOrgContextBlock } from './prompts/extraction';
import { buildExtractionUserMessageV2 } from './prompts/extraction.v2';
import { loadDotenv } from '../dotenv';
import { createLogger } from '../log';

/**
 * §10.12 evaluation set: run extraction v2 (W1-12: prompt v2, report data v2, the web recorder's
 * input) on every fixtures/transcripts/*.json (directory scan) and compare with
 * fixtures/expected/<id>.json. EN, ES, EN + ES and TR cases; a TR case is written in Turkish
 * with metric units.
 *
 * Scored (see compareReport): manpower counts exact and hours exact per company, company resolution
 * (known vs unknown), weather lostHours ±0.5 and full-day flag, every non-null number has a source,
 * unknown companies flagged, incident severities, work quantities / percentages exact, languages,
 * the report language (the summary is written in REPORT_LANGUAGE), the required gaps code derives
 * (§10.5) and the question code would ask next, rejected glossary mappings unused. Not scored: wording (summary, activities, areas, impacts), deliveries,
 * equipment, next-workday items, the model's own missingRequired / proposedQuestions text.
 *
 * Every case also has fixtures/tool-outputs/<id>.json: a `submit_daily_report` input that the
 * worker tests replay without an API key (`--recorded` scores those offline). From W1-12 these are
 * NOT model recordings: no ANTHROPIC_API_KEY was available, so they are generated from the
 * expected data (`recordedFromExpected`: the expected data without what code adds, with the
 * `recordedNulls` a case names left null for code to derive) by `pnpm eval -- --write-recorded`,
 * and a test holds them to that. They prove the pipeline around the model, not the model; a live
 * `pnpm eval` with the key is the model's check.
 *
 *   pnpm eval                                 live run (skipped without ANTHROPIC_API_KEY; outside
 *                                             production the key may sit in the root .env)
 *   pnpm eval -- --case riverside --case pier9 cases whose id contains one of the filters
 *   pnpm eval -- --recorded                   score the recorded tool outputs (no API calls)
 *   pnpm eval -- --write-recorded             regenerate fixtures/tool-outputs from fixtures/expected
 *   pnpm eval -- --list                       list the cases
 *   pnpm eval -- --concurrency 4              parallel API calls (default 3)
 *   pnpm eval -- --answers                    the parse_answer golden set (fixtures/answers, W2-09)
 *                                             on the live fast model; with --recorded, offline
 *
 * Exit 1 when a case fails or a fixture is broken.
 */

const here = dirname(fileURLToPath(import.meta.url));
export const FIXTURES_DIR = join(here, '..', '..', '..', '..', 'fixtures');

// ───────────────────────────── Fixture format ─────────────────────────────

const DATE = /^\d{4}-\d{2}-\d{2}$/;

const SegmentSchema = z.strictObject({
  uploadId: z.string().min(1),
  start: z.number().min(0),
  end: z.number().min(0),
  text: z.string().min(1),
});

const SiteDayWeatherSchema = z.strictObject({
  date: z.string().regex(DATE),
  provider: z.literal('Open-Meteo'),
  fetchedAt: z.string().min(1),
  units: z.strictObject({ precip: z.literal('in'), temp: z.literal('F'), wind: z.literal('mph') }),
  hours: z.array(
    z.strictObject({
      time: z.string().regex(/^\d{2}:\d{2}$/),
      precipIn: z.number().min(0),
      tempF: z.number().nullable(),
      windMph: z.number().min(0).nullable(),
      gustMph: z.number().min(0).nullable(),
    }),
  ),
  summary: ObservedWeatherV1Schema.extend({
    precipWorkingHoursIn: z.number().min(0),
    maxGustWorkingHoursMph: z.number().min(0),
  }),
});

export const ExpectedQuestionSchema = z.strictObject({
  field: z.enum(QUESTION_FIELDS),
  path: z.string().min(1),
});
export type ExpectedQuestion = z.infer<typeof ExpectedQuestionSchema>;

/** fixtures/transcripts/<id>.json: the extraction input (§10.4 user message) plus case metadata. */
export const EvalTranscriptSchema = z.strictObject({
  id: z.string().min(1),
  description: z.string().min(1),
  /** The question code asks next for the expected data (§10.5 step 4); null when nothing is asked. */
  expectedQuestion: ExpectedQuestionSchema.nullable(),
  /**
   * The v1.0 case was a typed WhatsApp report: the web recorder has none, so its text is one
   * voice-note segment here; the WhatsApp worker's tests and the panel's simulator read it as text.
   */
  whatsappText: z.literal(true).optional(),
  /** Paths the recorded tool output leaves null for code to derive (`recordedFromExpected`). */
  recordedNulls: z.array(z.string().regex(/^manpower\[\d+\]\.hoursPerWorker$/)).optional(),
  reportLanguage: z.enum(REPORT_LANGUAGES),
  units: z.enum(UNIT_SYSTEMS),
  reporterLocale: z.enum(REPORTER_LOCALES),
  channel: z.enum(['web', 'call']),
  site: z.strictObject({
    name: z.string().min(1),
    projectCode: z.string().min(1),
    timezone: z.string().min(1),
    workingHours: z.string().nullable(),
  }),
  reportDate: z.string().regex(DATE),
  defaultShiftHours: z.number().positive(),
  requiredFields: z.array(z.enum(REQUIRED_FIELD_KEYS)),
  reporterFirstName: z.string().min(1),
  companies: z.array(
    z.strictObject({
      id: z.string().min(1),
      name: z.string().min(1),
      trade: z.string().nullable(),
      aliases: z.array(z.string()),
      isSelfPerform: z.boolean().optional(),
    }),
  ),
  glossary: z.array(
    z.strictObject({ heard: z.string().min(1), official: z.string().min(1), kind: z.string() }),
  ),
  rejectedMappings: z.array(
    z.strictObject({ heard: z.string().min(1), official: z.string().min(1) }),
  ),
  observedWeather: SiteDayWeatherSchema.nullable(),
  previousAnswers: z.array(
    z.strictObject({
      field: z.string().min(1),
      question: z.string(),
      answer: z.string(),
      questionId: z.string().min(1),
    }),
  ),
  previousDraft: DailyReportDataSchema.nullable(),
  photos: z.array(PhotoSchema),
  segments: z.array(SegmentSchema),
});
export type EvalTranscript = z.infer<typeof EvalTranscriptSchema>;

export interface EvalFixture {
  id: string;
  description: string;
  expectedQuestion: ExpectedQuestion | null;
  whatsappText: boolean;
  recordedNulls: string[];
  input: ExtractionInputV2;
  expected: DailyReportData;
  /** The `submit_daily_report` input the tests replay (fixtures/tool-outputs/<id>.json). */
  recorded: ReportExtraction | null;
  /** The JSON as stored, to spot keys the schemas would silently drop. */
  raw: { expected: unknown; recorded: unknown };
}

function readJson(path: string): unknown {
  try {
    return JSON.parse(readFileSync(path, 'utf8')) as unknown;
  } catch (err) {
    throw new Error(`${path}: ${err instanceof Error ? err.message : String(err)}`, {
      cause: err,
    });
  }
}

function issuesOf(err: z.ZodError): string {
  return err.issues
    .slice(0, 8)
    .map((i) => `${i.path.map(String).join('.') || '(root)'}: ${i.message}`)
    .join('; ');
}

/** Case ids = every fixtures/transcripts/*.json (no hard-coded list). */
export function listFixtureIds(dir = FIXTURES_DIR): string[] {
  return readdirSync(join(dir, 'transcripts'))
    .filter((f) => f.endsWith('.json'))
    .map((f) => f.replace(/\.json$/, ''))
    .sort();
}

/** Load and schema-check one case. Throws with the file and the Zod issues when a file is broken. */
export function loadFixture(
  id: string,
  dir = FIXTURES_DIR,
  opts: { skipRecorded?: boolean } = {},
): EvalFixture {
  const tPath = join(dir, 'transcripts', `${id}.json`);
  const t = EvalTranscriptSchema.safeParse(readJson(tPath));
  if (!t.success) throw new Error(`${tPath}: ${issuesOf(t.error)}`);
  const ePath = join(dir, 'expected', `${id}.json`);
  if (!existsSync(ePath)) throw new Error(`${ePath}: missing`);
  const rawExpected = readJson(ePath);
  const e = DailyReportDataSchema.safeParse(rawExpected);
  if (!e.success) throw new Error(`${ePath}: ${issuesOf(e.error)}`);
  const rPath = join(dir, 'tool-outputs', `${id}.json`);
  let recorded: ReportExtraction | null = null;
  let rawRecorded: unknown = null;
  if (!opts.skipRecorded && existsSync(rPath)) {
    rawRecorded = readJson(rPath);
    const r = ReportExtractionSchema.safeParse(rawRecorded);
    if (!r.success) throw new Error(`${rPath}: ${issuesOf(r.error)}`);
    recorded = r.data;
  }
  const {
    id: fileId,
    description,
    expectedQuestion,
    whatsappText,
    recordedNulls,
    ...input
  } = t.data;
  if (fileId !== id) throw new Error(`${tPath}: id "${fileId}" does not match the file name`);
  return {
    id,
    description,
    expectedQuestion,
    whatsappText: whatsappText ?? false,
    recordedNulls: recordedNulls ?? [],
    input,
    expected: e.data,
    recorded,
    raw: { expected: rawExpected, recorded: rawRecorded },
  };
}

/** All cases, optionally filtered (an id matches when it contains any filter string). */
export function loadFixtures(dir = FIXTURES_DIR, filters: string[] = []): EvalFixture[] {
  return listFixtureIds(dir)
    .filter((id) => matchesFilter(id, filters))
    .map((id) => loadFixture(id, dir));
}

export function matchesFilter(id: string, filters: string[]): boolean {
  return filters.length === 0 || filters.some((f) => id === f || id.includes(f));
}

// ───────────────────────────── Scoring ─────────────────────────────

export const EVAL_FIELDS = [
  'manpower.workers',
  'manpower.hours',
  'company',
  'unknown_company',
  'weather.lostHours',
  'weather.fullDay',
  'sources',
  'safety',
  'numbers',
  'language',
  'report_language',
  'required_gaps',
  'next_question',
  'glossary',
  'extraction',
] as const;
export type EvalField = (typeof EVAL_FIELDS)[number];

export interface EvalCheck {
  name: string;
  ok: boolean;
  detail?: string;
  /** Category for the per-field accuracy table. */
  field: EvalField;
}

export interface EvalCase {
  id: string;
  checks: EvalCheck[];
  ok: boolean;
  latencyMs: number;
  costUsd: number;
  tokens?: { input: number; output: number; cacheRead: number; cacheWrite: number };
}

/** Extra context for the checks that run code over the data (§10.5) or need the glossary. */
export interface CompareContext {
  requiredFields: readonly RequiredFieldKey[];
  photoCount: number;
  companies?: ReadonlyArray<{ id: string; name: string; aliases?: readonly string[] }>;
  rejectedMappings?: ReadonlyArray<{ heard: string; official: string }>;
  maxQuestions?: number;
}

export function compareContextOf(input: ExtractionInputV2): CompareContext {
  return {
    requiredFields: input.requiredFields.filter((f): f is RequiredFieldKey =>
      (REQUIRED_FIELD_KEYS as readonly string[]).includes(f),
    ),
    photoCount: input.photos.length,
    companies: input.companies,
    rejectedMappings: input.rejectedMappings,
  };
}

/** "the Ridgeway crew" / "Ridgeway" / "los de Ramírez" / "Ramirez" → one key. */
export function companyKey(name: string): string {
  return name
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/^(?:the|los|las|el|la)\s+(?:de\s+)?/, '')
    .replace(/\s+(?:guys|crew|team|people|boys|men)$/, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

/** "manpower.workers:Delta Mechanical" → "manpower.workers:delta mechanical"; other paths unchanged. */
function normPath(path: string): string {
  const i = path.indexOf(':');
  return i < 0 ? path : `${path.slice(0, i)}:${companyKey(path.slice(i + 1))}`;
}

function num(v: number | null | undefined): string {
  return v === null || v === undefined ? 'null' : String(v);
}

interface Crew {
  name: string;
  workers: number | null;
  totalHours: number | null;
  known: boolean;
  entries: number;
}

/** Crews per company; split entries ("Apex: 4 on the ramp, 2 on the columns") are summed. */
function crewsOf(data: DailyReportData): Map<string, Crew> {
  const out = new Map<string, Crew>();
  for (const m of data.manpower) {
    const k = companyKey(m.companyName) || companyKey(m.companyNameHeard);
    const prev = out.get(k);
    if (!prev) {
      out.set(k, {
        name: m.companyName || m.companyNameHeard,
        workers: m.workers,
        totalHours: m.totalHours,
        known: m.companyId !== null,
        entries: 1,
      });
      continue;
    }
    prev.workers = prev.workers === null || m.workers === null ? null : prev.workers + m.workers;
    prev.totalHours =
      prev.totalHours === null || m.totalHours === null
        ? null
        : round2(prev.totalHours + m.totalHours);
    prev.known = prev.known && m.companyId !== null;
    prev.entries++;
  }
  return out;
}

function sameSet(a: Iterable<string | number>, b: Iterable<string | number>): boolean {
  const x = new Set(a);
  const y = new Set(b);
  return x.size === y.size && [...x].every((v) => y.has(v));
}

function fmtSet(a: Iterable<string | number>): string {
  const xs = [...new Set(a)].map(String).sort();
  return xs.length ? xs.join(', ') : '∅';
}

/** Quantities and percentages said for the work (spoken numbers must come out exact). */
function workNumbers(data: DailyReportData): number[] {
  const out: number[] = [];
  for (const w of data.workPerformed) {
    if (w.quantity) out.push(w.quantity.value);
    if (w.percentComplete !== undefined) out.push(w.percentComplete);
  }
  return out;
}

function lang(code: string): string {
  return code.toLowerCase().slice(0, 2);
}

const LANGUAGE_MARKERS: Record<'en' | 'es' | 'tr', RegExp> = {
  en: /\b(?:the|and|was|were|on|of|with|by|for|completed|no)\b/g,
  es: /\b(?:el|los|las|del|con|fue|por|sin|para|se)\b/g,
  tr: /(?:[çğışöüİ]|\b(?:ve|ile|bir|yapıldı|tarafından|olmadı|arasında|devam)\b)/g,
};

/**
 * The language a report text is written in (en, es or tr), by its most frequent marker words and,
 * for Turkish, letters: enough to tell a Turkish summary from an English one, which is what the
 * report-language check needs (§10.13 "correct report language"). null for an empty text.
 */
export function textLanguage(text: string): 'en' | 'es' | 'tr' | null {
  const t = text.toLowerCase();
  if (!t.trim()) return null;
  let best: 'en' | 'es' | 'tr' | null = null;
  let score = 0;
  for (const [l, re] of Object.entries(LANGUAGE_MARKERS) as Array<['en' | 'es' | 'tr', RegExp]>) {
    const n = t.match(re)?.length ?? 0;
    if (n > score) {
      best = l;
      score = n;
    }
  }
  return best;
}

/** The question code would ask first for this data (§10.5 steps 2–5), as field + path. */
export function nextQuestionOf(
  data: DailyReportData,
  ctx: CompareContext,
): { field: QuestionField; path: string } | null {
  const v = validateReport(data, {
    requiredFields: ctx.requiredFields,
    photoCount: ctx.photoCount,
  });
  const q = pickNextQuestion(data, v, {
    askedPaths: [],
    askedCount: 0,
    maxQuestions: ctx.maxQuestions ?? 3,
    companies: ctx.companies,
  });
  return q ? { field: q.field, path: q.path } : null;
}

function requiredGapsOf(data: DailyReportData, ctx: CompareContext): string[] {
  return validateReport(data, {
    requiredFields: ctx.requiredFields,
    photoCount: ctx.photoCount,
  }).missingRequired.map(normPath);
}

/**
 * Pure comparison of a model result (after code post-processing) with the golden data.
 * With `ctx` it also runs §10.5 validation on both and compares the required gaps and the next
 * question, and checks that rejected glossary mappings were not used.
 */
export function compareReport(
  actual: DailyReportData,
  expected: DailyReportData,
  ctx?: CompareContext,
): EvalCheck[] {
  const checks: EvalCheck[] = [];
  const act = crewsOf(actual);
  const exp = crewsOf(expected);

  // Manpower counts and hours exact (per company) and no extra / missing crews.
  for (const [k, e] of exp) {
    const a = act.get(k);
    if (!a) {
      checks.push({
        name: `manpower ${e.name}: present`,
        ok: false,
        detail: 'missing',
        field: 'company',
      });
      continue;
    }
    checks.push({
      name: `manpower ${e.name}: workers`,
      ok: a.workers === e.workers,
      detail: `got ${num(a.workers)}, want ${num(e.workers)}`,
      field: 'manpower.workers',
    });
    checks.push({
      name: `manpower ${e.name}: hours`,
      ok:
        a.totalHours === e.totalHours ||
        (a.totalHours !== null &&
          e.totalHours !== null &&
          Math.abs(a.totalHours - e.totalHours) < 0.01),
      detail: `got ${num(a.totalHours)}, want ${num(e.totalHours)}`,
      field: 'manpower.hours',
    });
    checks.push({
      name: `manpower ${e.name}: company resolution`,
      ok: a.known === e.known,
      detail: `got ${a.known ? 'known' : 'unknown'}, want ${e.known ? 'known' : 'unknown'}`,
      field: 'company',
    });
  }
  for (const [k, a] of act) {
    if (exp.has(k)) continue;
    // A crew explicitly reported as absent ("Delta didn't come") with 0 workers is not an invention.
    if (a.workers === 0 && (a.totalHours === null || a.totalHours === 0)) continue;
    checks.push({
      name: `manpower ${k}: unexpected crew`,
      ok: false,
      detail: `${num(a.workers)} workers`,
      field: 'company',
    });
  }

  // Weather lostHours ±0.5 (total) and the full-day flag.
  const lostA = actual.weather.periods.reduce((s, p) => s + p.lostHours, 0);
  const lostE = expected.weather.periods.reduce((s, p) => s + p.lostHours, 0);
  checks.push({
    name: 'weather lostHours ±0.5',
    ok: Math.abs(lostA - lostE) <= 0.5,
    detail: `got ${lostA}, want ${lostE}`,
    field: 'weather.lostHours',
  });
  const fullA = actual.weather.periods.some((p) => p.fullDay === true);
  const fullE = expected.weather.periods.some((p) => p.fullDay === true);
  checks.push({
    name: 'weather fullDay',
    ok: fullA === fullE,
    detail: `got ${fullA}, want ${fullE}`,
    field: 'weather.fullDay',
  });

  // Every non-null number carries a source.
  const unsourced: string[] = [];
  actual.manpower.forEach((m, i) => {
    if ((m.workers !== null || m.totalHours !== null) && m.source.length === 0)
      unsourced.push(`manpower[${i}]`);
  });
  actual.weather.periods.forEach((p, i) => {
    if ((p.lostHours > 0 || p.fullDay) && p.source.length === 0)
      unsourced.push(`weather.periods[${i}]`);
  });
  actual.workPerformed.forEach((w, i) => {
    if ((w.percentComplete !== undefined || w.quantity) && w.source.length === 0)
      unsourced.push(`workPerformed[${i}]`);
  });
  checks.push({
    name: 'every non-null number has a source',
    ok: unsourced.length === 0,
    detail: unsourced.join(', '),
    field: 'sources',
  });

  // Unknown companies flagged (companyId null + newTerms company entry or proposed question).
  for (const [k, e] of exp) {
    if (e.known) continue;
    const a = act.get(k);
    const flagged =
      !!a &&
      !a.known &&
      (actual.newTerms.some((t) => t.kind === 'company') ||
        actual.proposedQuestions.some((q) => q.field === 'company.unknown'));
    checks.push({
      name: `unknown company flagged: ${e.name}`,
      ok: flagged,
      field: 'unknown_company',
    });
  }

  // Safety: an explicit "no incidents" must not be invented; incidents match by severity.
  if (!expected.safety.noIncidentsStated)
    checks.push({
      name: 'noIncidentsStated not invented',
      ok: !actual.safety.noIncidentsStated,
      field: 'safety',
    });
  const sevA = actual.safety.incidents.map((i) => i.severity).sort();
  const sevE = expected.safety.incidents.map((i) => i.severity).sort();
  checks.push({
    name: 'safety incidents (severity)',
    ok: sevA.join(',') === sevE.join(','),
    detail: `got [${sevA.join(', ')}], want [${sevE.join(', ')}]`,
    field: 'safety',
  });

  // Spoken quantities and percentages exact, none invented.
  const numsA = workNumbers(actual);
  const numsE = workNumbers(expected);
  checks.push({
    name: 'work quantities and percentages',
    ok: sameSet(numsA, numsE),
    detail: `got {${fmtSet(numsA)}}, want {${fmtSet(numsE)}}`,
    field: 'numbers',
  });

  const langA = actual.languageDetected.map(lang);
  const langE = expected.languageDetected.map(lang);
  checks.push({
    name: 'languages detected',
    ok: sameSet(langA, langE),
    detail: `got {${fmtSet(langA)}}, want {${fmtSet(langE)}}`,
    field: 'language',
  });

  // §10.13 "correct report language": REPORT_LANGUAGE, and the summary written in it.
  const written = textLanguage(actual.summary);
  checks.push({
    name: 'report language',
    ok:
      actual.reportLanguage === expected.reportLanguage &&
      (written === null || written === expected.reportLanguage),
    detail: `got ${actual.reportLanguage} (summary ${written ?? 'empty'}), want ${expected.reportLanguage}`,
    field: 'report_language',
  });

  if (ctx) {
    const gapsA = requiredGapsOf(actual, ctx);
    const gapsE = requiredGapsOf(expected, ctx);
    checks.push({
      name: 'required gaps (§10.5)',
      ok: sameSet(gapsA, gapsE),
      detail: `got {${fmtSet(gapsA)}}, want {${fmtSet(gapsE)}}`,
      field: 'required_gaps',
    });
    const qA = nextQuestionOf(actual, ctx);
    const qE = nextQuestionOf(expected, ctx);
    const fmtQ = (x: { path: string } | null) => (x ? x.path : 'none');
    checks.push({
      name: 'next question',
      ok:
        (qA === null && qE === null) ||
        (qA !== null &&
          qE !== null &&
          qA.field === qE.field &&
          normPath(qA.path) === normPath(qE.path)),
      detail: `got ${fmtQ(qA)}, want ${fmtQ(qE)}`,
      field: 'next_question',
    });
    const rejected = (ctx.rejectedMappings ?? []).filter((r) => r.official.trim());
    if (rejected.length > 0) {
      const text = JSON.stringify(actual).toLowerCase();
      const used = rejected.filter((r) => text.includes(r.official.toLowerCase()));
      checks.push({
        name: 'rejected glossary mappings not used',
        ok: used.length === 0,
        detail: used.map((r) => `"${r.heard}" → ${r.official}`).join(', '),
        field: 'glossary',
      });
    }
  }
  return checks;
}

// ───────────────────────────── Fixture integrity ─────────────────────────────

const UUID_RE = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi;

const ISO_DATE_RE = /\b\d{4}-\d{2}-\d{2}(?:T[\d:.]+Z?)?/g;

/** Phone-number-like runs (≥ 10 digits with spaces, dots, dashes or brackets); UUIDs and dates excluded. */
export function findPhoneNumbers(text: string): string[] {
  const cleaned = text.replace(UUID_RE, ' ').replace(ISO_DATE_RE, ' ');
  const hits: string[] = [];
  for (const m of cleaned.matchAll(/\+?\(?\d[\d \t().-]{6,}\d/g)) {
    if (m[0].replace(/\D/g, '').length >= 10) hits.push(m[0].trim());
  }
  return hits;
}

/** Keys present in the stored JSON that the schema dropped (typos such as "hourBasis"). */
function droppedKeys(raw: unknown, parsed: unknown, path = ''): string[] {
  if (Array.isArray(raw) && Array.isArray(parsed))
    return raw.flatMap((v, i) => droppedKeys(v, parsed[i], `${path}[${i}]`));
  if (raw && typeof raw === 'object' && parsed && typeof parsed === 'object') {
    const p = parsed as Record<string, unknown>;
    return Object.entries(raw as Record<string, unknown>).flatMap(([k, v]) =>
      k in p ? droppedKeys(v, p[k], path ? `${path}.${k}` : k) : [path ? `${path}.${k}` : k],
    );
  }
  return [];
}

type AnySource = {
  type: string;
  uploadId?: string;
  questionId?: string;
  start?: number;
  end?: number;
};

/** Every `source` array anywhere in the data, with its JSON path. */
function sourcesIn(value: unknown, path = ''): Array<{ path: string; source: AnySource }> {
  if (Array.isArray(value)) return value.flatMap((v, i) => sourcesIn(v, `${path}[${i}]`));
  if (!value || typeof value !== 'object') return [];
  return Object.entries(value as Record<string, unknown>).flatMap(([k, v]) => {
    const p = path ? `${path}.${k}` : k;
    if (k === 'source' && Array.isArray(v))
      return v.map((s, i) => ({ path: `${p}[${i}]`, source: s as AnySource }));
    return sourcesIn(v, p);
  });
}

function sourceProblems(label: string, data: unknown, input: ExtractionInputV2): string[] {
  const problems: string[] = [];
  const segs = new Map<string, Array<{ start: number; end: number }>>();
  for (const s of input.segments) segs.set(s.uploadId, [...(segs.get(s.uploadId) ?? []), s]);
  const answers = new Set(input.previousAnswers.map((a) => a.questionId));
  const near = (a: number, b: number) => Math.abs(a - b) < 0.051;
  for (const { path, source: s } of sourcesIn(data)) {
    const at = `${label} ${path}`;
    if (s.type === 'voice_note') {
      const list = segs.get(s.uploadId ?? '');
      if (!list) {
        problems.push(`${at}: voice_note uploadId ${s.uploadId} is not a voice note in the input`);
        continue;
      }
      if (!list.some((x) => near(x.start, s.start ?? -1)))
        problems.push(`${at}: start ${s.start} is not a segment start of ${s.uploadId}`);
      if (s.end !== undefined && !list.some((x) => near(x.end, s.end!)))
        problems.push(`${at}: end ${s.end} is not a segment end of ${s.uploadId}`);
      if (s.end !== undefined && s.start !== undefined && s.end < s.start)
        problems.push(`${at}: end before start`);
    } else if (s.type === 'answer') {
      if (!answers.has(s.questionId ?? ''))
        problems.push(`${at}: answer questionId ${s.questionId} is not a previous answer`);
    } else if (s.type !== 'weather_api') {
      problems.push(`${at}: a ${s.type} source has no place in a web recorder report`);
    }
  }
  return problems;
}

function wordCount(s: string): number {
  return s.split(/\s+/).filter(Boolean).length;
}

/**
 * Consistency checks for one case (used by the offline test and before a live run): sources point
 * at real segments, numbers add up, code-added fields match the input, no phone numbers reach the
 * prompt, the expected question annotation matches what code derives, nothing is silently dropped.
 */
export function fixtureProblems(f: EvalFixture): string[] {
  const problems: string[] = [];
  const { input, expected } = f;

  // Transcript
  if (input.segments.length === 0) problems.push('transcript: no segments');
  const byUpload = new Map<string, Array<{ start: number; end: number }>>();
  for (const s of input.segments) {
    if (!(s.end > s.start))
      problems.push(`transcript: segment ${s.uploadId}@${s.start} ends before it starts`);
    const list = byUpload.get(s.uploadId) ?? [];
    const prev = list[list.length - 1];
    if (prev && s.start < prev.end - 0.051)
      problems.push(`transcript: segment ${s.uploadId}@${s.start} overlaps the previous one`);
    list.push(s);
    byUpload.set(s.uploadId, list);
  }
  const prompt = `${buildOrgContextBlock(input)}\n${buildExtractionUserMessageV2(input)}`;
  for (const p of findPhoneNumbers(prompt)) problems.push(`prompt: phone-number-like text "${p}"`);
  const companyIds = new Set(input.companies.map((c) => c.id));

  // Expected
  for (const k of droppedKeys(f.raw.expected, expected))
    problems.push(`expected: unknown key ${k}`);
  if (expected.reportDate !== input.reportDate)
    problems.push(`expected: reportDate ${expected.reportDate} ≠ transcript ${input.reportDate}`);
  if (expected.reportLanguage !== input.reportLanguage || expected.units !== input.units)
    problems.push('expected: reportLanguage or units differ from the transcript (code sets them)');
  if (
    textLanguage(expected.summary) !== null &&
    textLanguage(expected.summary) !== input.reportLanguage
  )
    problems.push(`expected: the summary is not written in ${input.reportLanguage}`);
  if (JSON.stringify(expected.photos) !== JSON.stringify(input.photos))
    problems.push('expected: photos differ from the transcript photos (code copies them)');
  const obs = input.observedWeather ? toObservedIn(input.observedWeather, input.units) : undefined;
  if (JSON.stringify(expected.weather.observed) !== JSON.stringify(obs))
    problems.push('expected: weather.observed differs from the transcript observedWeather summary');
  expected.manpower.forEach((m, i) => {
    if (m.companyId !== null && !companyIds.has(m.companyId))
      problems.push(`expected: manpower[${i}].companyId ${m.companyId} is not in COMPANIES`);
    if (
      m.workers !== null &&
      m.hoursPerWorker !== null &&
      (m.totalHours === null ||
        Math.abs(m.totalHours - round2(m.workers * m.hoursPerWorker)) > 0.01)
    )
      problems.push(`expected: manpower[${i}] totalHours ≠ workers × hoursPerWorker`);
    if (m.hoursBasis === 'full_day_default' && m.hoursPerWorker !== input.defaultShiftHours)
      problems.push(`expected: manpower[${i}] full_day_default without DEFAULT_SHIFT_HOURS`);
    if (m.source.length === 0) problems.push(`expected: manpower[${i}] has no source`);
  });
  if (wordCount(expected.summary) > 80)
    problems.push(`expected: summary has ${wordCount(expected.summary)} words (≤ 80)`);
  problems.push(...sourceProblems('expected', expected, input));
  const derived = nextQuestionOf(expected, compareContextOf(input));
  const want = f.expectedQuestion;
  if (
    (derived === null) !== (want === null) ||
    (derived && want && (derived.field !== want.field || derived.path !== want.path))
  )
    problems.push(
      `transcript: expectedQuestion ${want ? want.path : 'null'} but code asks ${derived ? derived.path : 'nothing'} for the expected data`,
    );

  // Recorded tool output
  if (!f.recorded) {
    problems.push('tool-outputs: missing recorded tool output');
  } else {
    for (const k of droppedKeys(f.raw.recorded, f.recorded))
      problems.push(`tool-outputs: unknown key ${k}`);
    problems.push(...sourceProblems('tool-outputs', f.recorded, input));
    if (JSON.stringify(f.raw.recorded) !== JSON.stringify(recordedFromExpected(f)))
      problems.push(
        'tool-outputs: not what --write-recorded generates from the expected data (run pnpm eval -- --write-recorded)',
      );
  }
  return problems;
}

/**
 * The tool output the tests replay, generated from the expected data (W1-12: no model recording
 * without ANTHROPIC_API_KEY): the expected data without what code adds (`schemaVersion`,
 * `reportDate`, `reportLanguage`, `units`, `photos`, `weather.observed`), with the case's
 * `recordedNulls` left null so code has to derive them (a stated total, hours per worker from it).
 */
export function recordedFromExpected(
  f: Pick<EvalFixture, 'expected' | 'recordedNulls'>,
): ReportExtraction {
  const {
    schemaVersion: _v,
    reportDate: _d,
    reportLanguage: _l,
    units: _u,
    photos: _p,
    ...rest
  } = structuredClone(f.expected);
  const { observed: _o, ...weather } = rest.weather;
  const out: ReportExtraction = { ...rest, weather };
  for (const path of f.recordedNulls) {
    const i = Number(/^manpower\[(\d+)\]/.exec(path)?.[1]);
    const m = out.manpower[i];
    if (m) m.hoursPerWorker = null;
  }
  return out;
}

/** `pnpm eval -- --write-recorded`: fixtures/tool-outputs/<id>.json from the expected data. */
export function writeRecorded(fixtures: EvalFixture[], dir = FIXTURES_DIR): void {
  for (const f of fixtures) {
    writeFileSync(
      join(dir, 'tool-outputs', `${f.id}.json`),
      `${JSON.stringify(recordedFromExpected(f), null, 2)}\n`,
    );
  }
}

// ───────────────────────────── Runs ─────────────────────────────

/** A MessagesClient that answers with the recorded tool input (no network). */
export function replayClient(
  recorded: unknown,
): MessagesClient & { calls: Anthropic.MessageCreateParamsNonStreaming[] } {
  const calls: Anthropic.MessageCreateParamsNonStreaming[] = [];
  return {
    calls,
    messages: {
      async create(params) {
        calls.push(params);
        const name = (params.tools?.[0] as { name: string } | undefined)?.name ?? 'tool';
        return {
          id: `msg_replay_${calls.length}`,
          type: 'message',
          role: 'assistant',
          model: params.model,
          content: [
            {
              type: 'tool_use',
              id: `toolu_replay_${calls.length}`,
              name,
              input: recorded,
            },
          ],
          stop_reason: 'tool_use',
          stop_sequence: null,
          usage: {
            input_tokens: 0,
            output_tokens: 0,
            cache_creation_input_tokens: 0,
            cache_read_input_tokens: 0,
          },
        } as unknown as Anthropic.Message;
      },
    },
  };
}

function failedCase(id: string, err: unknown): EvalCase {
  return {
    id,
    checks: [
      {
        name: 'extraction',
        ok: false,
        detail: err instanceof Error ? err.message : String(err),
        field: 'extraction',
      },
    ],
    ok: false,
    latencyMs: 0,
    costUsd: 0,
  };
}

/** Score one case: extraction through `client` (live or replay), code post-processing, compare. */
export async function scoreCase(
  f: EvalFixture,
  client: MessagesClient,
  model: string,
): Promise<EvalCase> {
  try {
    const res = await runReportExtraction(
      client,
      model,
      f.input,
      createLogger({ eval: f.id }, { level: 'warn' }),
    );
    const checks = compareReport(res.data, f.expected, compareContextOf(f.input));
    return {
      id: f.id,
      checks,
      ok: checks.every((c) => c.ok),
      latencyMs: res.call.latencyMs,
      costUsd: res.call.estCostUsd,
      tokens: res.call.usage,
    };
  } catch (err) {
    return failedCase(f.id, err);
  }
}

/** Score the recorded tool output offline (what the worker tests replay). */
export async function scoreRecorded(f: EvalFixture): Promise<EvalCase> {
  if (!f.recorded) return failedCase(f.id, new Error('no recorded tool output'));
  const res = await scoreCase(f, replayClient(f.recorded), 'claude-sonnet-4-6');
  return { ...res, latencyMs: 0, costUsd: 0 };
}

// ───────────────────────────── Report ─────────────────────────────

function pct(n: number, d: number): string {
  return d === 0 ? '   -  ' : `${((100 * n) / d).toFixed(1).padStart(5)}%`;
}

function percentile(xs: number[], p: number): number {
  if (xs.length === 0) return 0;
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.max(0, Math.ceil((p / 100) * s.length) - 1))]!;
}

/** Per-case table, failed checks, per-field accuracy, totals (cost, latency, tokens). */
export function printTable(cases: EvalCase[]): string {
  const lines: string[] = [];
  const w = Math.max(...cases.map((c) => c.id.length), 4);
  lines.push(`${'case'.padEnd(w)}  result  checks   latency   cost`);
  for (const c of cases) {
    const passed = c.checks.filter((x) => x.ok).length;
    lines.push(
      `${c.id.padEnd(w)}  ${c.ok ? 'PASS ' : 'FAIL '}   ${String(passed).padStart(2)}/${String(c.checks.length).padEnd(3)}  ${String(c.latencyMs).padStart(6)} ms  $${c.costUsd.toFixed(4)}`,
    );
    for (const x of c.checks.filter((y) => !y.ok))
      lines.push(`${''.padEnd(w)}    - ${x.name}${x.detail ? ` (${x.detail})` : ''}`);
  }

  lines.push('');
  lines.push(`${'field'.padEnd(18)}  passed     accuracy`);
  for (const field of EVAL_FIELDS) {
    const all = cases.flatMap((c) => c.checks.filter((x) => x.field === field));
    if (all.length === 0) continue;
    const ok = all.filter((x) => x.ok).length;
    lines.push(`${field.padEnd(18)}  ${`${ok}/${all.length}`.padEnd(9)}  ${pct(ok, all.length)}`);
  }

  const latencies = cases.filter((c) => c.latencyMs > 0).map((c) => c.latencyMs);
  const cost = cases.reduce((s, c) => s + c.costUsd, 0);
  const tok = cases.reduce(
    (s, c) => ({
      input: s.input + (c.tokens?.input ?? 0),
      output: s.output + (c.tokens?.output ?? 0),
      cacheRead: s.cacheRead + (c.tokens?.cacheRead ?? 0),
    }),
    { input: 0, output: 0, cacheRead: 0 },
  );
  lines.push('');
  if (latencies.length > 0) {
    lines.push(
      `latency p50 ${percentile(latencies, 50)} ms · p90 ${percentile(latencies, 90)} ms · max ${Math.max(...latencies)} ms`,
    );
  }
  if (cost > 0 || tok.input > 0) {
    lines.push(
      `cost $${cost.toFixed(4)} total · $${(cost / Math.max(cases.length, 1)).toFixed(4)} per case · tokens in ${tok.input} / out ${tok.output} / cache read ${tok.cacheRead}`,
    );
  }
  const total = cases.filter((c) => c.ok).length;
  lines.push(`${total}/${cases.length} cases passed`);
  return lines.join('\n');
}

// ───────────────────────────── CLI ─────────────────────────────

export interface EvalOptions {
  cases: string[];
  recorded: boolean;
  writeRecorded: boolean;
  list: boolean;
  help: boolean;
  concurrency: number;
  /** W2-09: the parse_answer golden set (fixtures/answers) instead of the extraction cases. */
  answers: boolean;
}

export function parseArgs(argv: string[]): EvalOptions {
  const opts: EvalOptions = {
    cases: [],
    recorded: false,
    writeRecorded: false,
    list: false,
    help: false,
    concurrency: 3,
    answers: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    const [flag, inline] = arg.startsWith('--') && arg.includes('=') ? arg.split(/=(.*)/s) : [arg];
    const value = () => inline ?? argv[++i] ?? '';
    switch (flag) {
      case '--':
        break;
      case '--case':
      case '-c':
        opts.cases.push(
          ...value()
            .split(',')
            .map((s) => s.trim())
            .filter(Boolean),
        );
        break;
      case '--recorded':
        opts.recorded = true;
        break;
      case '--write-recorded':
        opts.writeRecorded = true;
        break;
      case '--list':
        opts.list = true;
        break;
      case '--answers':
        opts.answers = true;
        break;
      case '--concurrency': {
        const n = Number(value());
        if (Number.isInteger(n) && n > 0) opts.concurrency = Math.min(n, 16);
        break;
      }
      case '--help':
      case '-h':
        opts.help = true;
        break;
      default:
        throw new Error(`unknown argument: ${arg}`);
    }
  }
  return opts;
}

const USAGE = `usage: pnpm eval [-- options]
  --case <id|part>   only cases whose id contains it (repeatable, or comma-separated)
  --recorded         score the recorded tool outputs offline (no API key needed)
  --write-recorded   regenerate fixtures/tool-outputs from fixtures/expected (then prettier)
  --list             list the cases and exit
  --answers          the parse_answer golden set (fixtures/answers); with --recorded, offline
  --concurrency <n>  parallel API calls in a live run (default 3)`;

async function mapPool<T, R>(items: T[], n: number, fn: (t: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array<R>(items.length);
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(n, items.length) }, async () => {
      while (next < items.length) {
        const i = next++;
        out[i] = await fn(items[i]!);
      }
    }),
  );
  return out;
}

export async function runEval(
  argv: string[] = [],
  env: Record<string, string | undefined> = process.env,
  dir = FIXTURES_DIR,
): Promise<number> {
  const opts = parseArgs(argv);
  if (opts.help) {
    console.log(USAGE);
    return 0;
  }
  if (opts.answers) {
    const key = env.ANTHROPIC_API_KEY ?? '';
    if (!opts.recorded && !key) {
      console.log(
        'skipped: ANTHROPIC_API_KEY is not set (--answers --recorded scores the recorded parse_answer outputs offline)',
      );
      return 0;
    }
    return runAnswerEval({
      recorded: opts.recorded,
      client: opts.recorded ? null : createAnthropicClient(key),
      model: env.CLAUDE_MODEL_FAST || env.CLAUDE_MODEL || 'claude-sonnet-5-5',
      filter: opts.cases,
    });
  }
  const ids = listFixtureIds(dir).filter((id) => matchesFilter(id, opts.cases));
  if (ids.length === 0) {
    console.error(`no cases match ${opts.cases.join(', ')}`);
    return 1;
  }
  if (opts.list) {
    for (const id of ids) console.log(`${id}  ${loadFixture(id, dir).description}`);
    console.log(`${ids.length} cases`);
    return 0;
  }
  if (opts.writeRecorded) {
    const fixtures = ids.map((id) => loadFixture(id, dir, { skipRecorded: true }));
    writeRecorded(fixtures, dir);
    console.log(`wrote ${fixtures.length} tool outputs from fixtures/expected`);
    return 0;
  }
  const apiKey = env.ANTHROPIC_API_KEY ?? '';
  if (!opts.recorded && !apiKey) {
    console.log(
      `skipped: ANTHROPIC_API_KEY is not set (${ids.length} cases; --recorded scores the recorded tool outputs offline)`,
    );
    return 0;
  }

  const fixtures: EvalFixture[] = [];
  const broken: string[] = [];
  for (const id of ids) {
    try {
      const f = loadFixture(id, dir);
      const problems = fixtureProblems(f);
      if (problems.length) broken.push(...problems.map((p) => `${id}: ${p}`));
      else fixtures.push(f);
    } catch (err) {
      broken.push(`${id}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  if (broken.length) {
    console.error(
      `broken fixtures (fix them before scoring):\n${broken.map((b) => `  ${b}`).join('\n')}`,
    );
    return 1;
  }

  let cases: EvalCase[];
  if (opts.recorded) {
    console.log(`scoring ${fixtures.length} recorded tool outputs (offline)`);
    cases = await mapPool(fixtures, 8, scoreRecorded);
  } else {
    const model = env.CLAUDE_MODEL || 'claude-sonnet-5-5';
    const client = createAnthropicClient(apiKey)!;
    console.log(`running ${fixtures.length} cases on ${model} (concurrency ${opts.concurrency})`);
    cases = await mapPool(fixtures, opts.concurrency, (f) => scoreCase(f, client, model));
  }
  console.log(printTable(cases));
  return cases.every((c) => c.ok) ? 0 : 1;
}

/**
 * The `pnpm eval` entry. `pnpm eval` runs in apps/worker, so it loads the development `.env` files
 * first, as the worker does (`<cwd>/.env`, then the repository root's `.env`; src/dotenv.ts): a key
 * kept in the root `.env` reaches the live run, and the shell still wins over both files.
 */
export async function evalMain(
  argv: string[] = process.argv.slice(2),
  opts: { cwd?: string; env?: NodeJS.ProcessEnv; dir?: string } = {},
): Promise<number> {
  const env = opts.env ?? process.env;
  await loadDotenv({ cwd: opts.cwd, env });
  return runEval(argv, env, opts.dir);
}

if (process.argv[1] && /eval\.(ts|js)$/.test(process.argv[1]) && !process.env.VITEST) {
  evalMain().then(
    (code) => process.exit(code),
    (err) => {
      console.error(err instanceof Error ? err.message : err);
      process.exit(1);
    },
  );
}
