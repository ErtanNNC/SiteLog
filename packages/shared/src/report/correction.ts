import type { PatchOperation } from '../schemas/ai.ts';
import {
  DailyReportDataSchema,
  type DailyReportData,
  type ManpowerEntry,
  type Source,
} from '../schemas/report.ts';
import { recomputeManpowerTotals, round2 } from './hours.ts';
import { applyPatch, parsePointer, PatchError } from './patch.ts';
import { statedNumbers, unstatedAnswerNumber } from './validate.ts';

/**
 * F8 *Fix by voice* and the draft's steppers (W2-10; spec §10.6, §10.3, §19 Q80): a correction is
 * applied by code, never by the model. `apply_correction` (§10.6) only proposes RFC 6902
 * operations; this module decides what they may touch, applies them, writes the sources, and
 * recomputes every total (`workers × hoursPerWorker`). A total the model sets is ignored, and with
 * the reporter's words in hand a number the correction does not state is refused (CLAUDE.md
 * "never invent numbers"). Pure; runs in Node, the browser and Deno (field-api's steppers).
 */

/** The parts of the report a correction may change (the rest is code's: dates, photos, flags). */
export const CORRECTION_ROOTS = [
  'summary',
  'workingHours',
  'weather',
  'manpower',
  'workPerformed',
  'deliveries',
  'equipment',
  'safety',
  'issues',
  'nextWorkday',
] as const;

/** Keys code writes itself: dropped from the model's operations and values. */
const CODE_KEYS = new Set(['totalHours', 'source', 'confidence']);

/** Why code does not apply a correction (the preview says "I didn't catch that"). */
export const CORRECTION_REFUSALS = [
  /** The operations change nothing (or there were none). */
  'no_change',
  /** An operation touches what a correction may not change (the date, photos, observed weather). */
  'path_not_allowed',
  /** The operations do not fit the report (a path that is not there, a value of the wrong shape). */
  'invalid_patch',
  /** A number the correction brings in is not one the reporter's words state. */
  'number_not_stated',
  /** The only change was a total: code computes totals, so there is nothing to apply. */
  'total_only',
] as const;
export type CorrectionRefusal = (typeof CORRECTION_REFUSALS)[number];

/** A numeric change in the preview: from → to (null = not stated). */
export type NumberChange = [from: number | null, to: number | null];

/** A section of the draft a correction changed, beyond the crew numbers. */
export type CorrectionSection =
  /** A crew line's words changed (area, trade, the name heard, the hours basis), not its numbers. */
  | 'crew'
  | 'summary'
  | 'workingHours'
  | 'weather'
  | 'work'
  | 'deliveries'
  | 'equipment'
  | 'safety'
  | 'issues'
  | 'next';

/**
 * One line of the preview (F8, F10: "Apex Concrete 6 → 7 workers, 48 → 56 h"), from code's numbers:
 * the field app words it in the reporter's language. `totalHours` is always code's (recomputed).
 */
export type CorrectionChange =
  | {
      kind: 'crew';
      company: string;
      change: 'changed' | 'added' | 'removed';
      workers: NumberChange;
      hoursPerWorker: NumberChange;
      totalHours: NumberChange;
    }
  | { kind: 'lost_hours'; lostHours: NumberChange }
  | { kind: 'section'; section: CorrectionSection };

export type CorrectionResultOf =
  | {
      ok: true;
      data: DailyReportData;
      changes: CorrectionChange[];
      /** Operations kept (the totals and sources the model wrote are dropped). */
      operations: PatchOperation[];
      /** How many operations set a total (ignored: code recomputes totals). */
      droppedTotals: number;
    }
  | { ok: false; reason: CorrectionRefusal; detail?: string };

export interface CorrectionOptions {
  /** The value's source: the clip (`voice_note` with its seconds) or `reporter_edit`. */
  source: Source;
  /**
   * The reporter's words (the clip's transcript, or the typed text): every number the correction
   * brings in must be one they state. Null for a stepper, whose numbers the reporter set.
   */
  text: string | null;
  defaultShiftHours: number;
  /** The org's companies: a company the correction names is matched by name or alias. */
  companies?: ReadonlyArray<{ id: string; name: string; aliases?: readonly string[] }>;
}

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/** A value without the keys code writes (totals, sources, confidence), at any depth. */
function stripCodeKeys(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(stripCodeKeys);
  if (!isObject(v)) return v;
  return Object.fromEntries(
    Object.entries(v)
      .filter(([k]) => !CODE_KEYS.has(k))
      .map(([k, x]) => [k, stripCodeKeys(x)]),
  );
}

/** Deep equality of JSON values (key order ignored). */
export function jsonEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (Array.isArray(a) || Array.isArray(b)) {
    if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false;
    return a.every((x, i) => jsonEqual(x, b[i]));
  }
  if (isObject(a) && isObject(b)) {
    const ka = Object.keys(a).filter((k) => a[k] !== undefined);
    const kb = Object.keys(b).filter((k) => b[k] !== undefined);
    if (ka.length !== kb.length) return false;
    return ka.every((k) => jsonEqual(a[k], b[k]));
  }
  return false;
}

/**
 * The model's operations as code takes them: an operation outside `CORRECTION_ROOTS` (or on the
 * observed weather) refuses the correction; an operation on a total, a source or a confidence is
 * dropped (code writes those), and so are those keys inside a value. Pure.
 */
export function sanitizeCorrectionOps(ops: readonly PatchOperation[]): {
  ops: PatchOperation[];
  droppedTotals: number;
  refusal: { reason: CorrectionRefusal; detail: string } | null;
} {
  const out: PatchOperation[] = [];
  let droppedTotals = 0;
  for (const op of ops) {
    let tokens: string[];
    try {
      tokens = parsePointer(op.path);
    } catch {
      return { ops: [], droppedTotals, refusal: { reason: 'invalid_patch', detail: op.path } };
    }
    const root = tokens[0] ?? '';
    if (
      !(CORRECTION_ROOTS as readonly string[]).includes(root) ||
      (root === 'weather' && tokens[1] === 'observed')
    ) {
      return { ops: [], droppedTotals, refusal: { reason: 'path_not_allowed', detail: op.path } };
    }
    const codeKey = tokens.find((t) => CODE_KEYS.has(t));
    if (codeKey) {
      if (codeKey === 'totalHours') droppedTotals++;
      continue;
    }
    if (isObject(op.value) && 'totalHours' in op.value && op.value.totalHours != null)
      droppedTotals++;
    out.push(op.op === 'remove' ? op : { ...op, value: stripCodeKeys(op.value) });
  }
  return { ops: out, droppedTotals, refusal: null };
}

function sameSource(a: Source, b: Source): boolean {
  return jsonEqual(a, b);
}

function withSource(sources: readonly Source[] | undefined, add: Source): Source[] {
  const list = [...(sources ?? [])];
  return list.some((s) => sameSource(s, add)) ? list : [...list, add];
}

/** Base crew entries matched to the corrected ones: by company name (and words heard), in order. */
function matchCrew(
  before: readonly ManpowerEntry[],
  after: readonly Partial<ManpowerEntry>[],
): Array<number | null> {
  const used = new Set<number>();
  const key = (e: Partial<ManpowerEntry>) =>
    `${(e.companyName ?? '').toLowerCase()}|${(e.companyNameHeard ?? '').toLowerCase()}`;
  const pick = (pred: (b: ManpowerEntry, j: number) => boolean) => {
    const j = before.findIndex((b, i) => !used.has(i) && pred(b, i));
    return j < 0 ? null : j;
  };
  return after.map((a, i) => {
    // Same place and name first (the usual "replace workers"), then the name anywhere, then the
    // words heard (a company renamed by the correction).
    const j =
      (before[i] && !used.has(i) && key(before[i]!) === key(a) ? i : null) ??
      pick((b) => key(b) === key(a)) ??
      pick(
        (b) =>
          (b.companyNameHeard ?? '').toLowerCase() === (a.companyNameHeard ?? '').toLowerCase(),
      );
    if (j !== null) used.add(j);
    return j;
  });
}

function resolveCompany(
  entry: Partial<ManpowerEntry>,
  companies: CorrectionOptions['companies'],
): Partial<ManpowerEntry> {
  if (!companies) return entry;
  const known = entry.companyId ? companies.find((c) => c.id === entry.companyId) : undefined;
  if (known) return { ...entry, companyName: known.name };
  const name = (entry.companyName ?? '').trim().toLowerCase();
  const byName = name
    ? companies.find(
        (c) =>
          c.name.toLowerCase() === name || (c.aliases ?? []).some((a) => a.toLowerCase() === name),
      )
    : undefined;
  return byName
    ? { ...entry, companyId: byName.id, companyName: byName.name }
    : { ...entry, companyId: null };
}

/** The digit runs of a text ("2 loads of 12 m" → 2, 12), as `statedNumbers` reads them. */
function digitRuns(text: string): number[] {
  return [...text.matchAll(/\d+(?:[.,]\d+)?/g)].map((m) => Number(m[0].replace(',', '.')));
}

/**
 * The numbers written inside the strings of a value (any depth), with their key: a quantity
 * ("3 loads"), a summary's figures. Times (`time`, `start`, `end`) are checked by their hour.
 */
function stringNumberLeaves(v: unknown, key = ''): Array<{ key: string; value: number }> {
  if (typeof v === 'string')
    return TIME_KEYS.has(key) ? [] : digitRuns(v).map((value) => ({ key, value }));
  if (Array.isArray(v)) return v.flatMap((x) => stringNumberLeaves(x, key));
  if (isObject(v))
    return Object.entries(v).flatMap(([k, x]) =>
      CODE_KEYS.has(k) ? [] : stringNumberLeaves(x, k),
    );
  return [];
}

const TIME_KEYS = new Set(['time', 'start', 'end']);

/** The numbers of a value (any depth), with their key, for the stated-numbers rule. */
function numberLeaves(v: unknown, key = ''): Array<{ key: string; value: number }> {
  if (typeof v === 'number') return [{ key, value: v }];
  if (Array.isArray(v)) return v.flatMap((x) => numberLeaves(x, key));
  if (isObject(v))
    return Object.entries(v).flatMap(([k, x]) => (CODE_KEYS.has(k) ? [] : numberLeaves(x, k)));
  return [];
}

const SECTION_OF: Record<string, CorrectionSection> = {
  summary: 'summary',
  workingHours: 'workingHours',
  workPerformed: 'work',
  deliveries: 'deliveries',
  equipment: 'equipment',
  safety: 'safety',
  issues: 'issues',
  nextWorkday: 'next',
};

/**
 * A list of items with sources after the patch: an item equal to a base item (sources aside)
 * keeps that item's sources; any other item is changed, and cites `source` (with the sources of
 * the base item in its place, when the list kept its length). Returns the changed items too.
 */
function sourceList<T extends { source: Source[] }>(
  before: readonly T[],
  after: readonly T[],
  source: Source,
): { items: T[]; changed: Array<{ item: T; base: T | undefined }> } {
  const used = new Set<number>();
  const changed: Array<{ item: T; base: T | undefined }> = [];
  const items = after.map((a, i) => {
    const plain = stripCodeKeys(a);
    const j = before.findIndex((b, k) => !used.has(k) && jsonEqual(stripCodeKeys(b), plain));
    if (j >= 0) {
      used.add(j);
      return { ...a, source: before[j]!.source };
    }
    const base = before.length === after.length ? before[i] : undefined;
    changed.push({ item: a, base });
    return { ...a, source: withSource(base?.source, source) };
  });
  return { items, changed };
}

/**
 * §10.6: a correction's operations applied in code. The model's totals, sources and confidences
 * are not taken; each changed value cites `opts.source`; totals are recomputed; with the
 * reporter's words (`opts.text`) every number the correction brings in must be stated in them.
 * The preview's lines (`changes`) are computed from the two drafts. Pure.
 */
export function applyCorrectionOps(
  base: DailyReportData,
  operations: readonly PatchOperation[],
  opts: CorrectionOptions,
): CorrectionResultOf {
  const clean = sanitizeCorrectionOps(operations);
  if (clean.refusal) return { ok: false, ...clean.refusal };
  if (clean.ops.length === 0)
    return { ok: false, reason: clean.droppedTotals > 0 ? 'total_only' : 'no_change' };

  let patched: DailyReportData;
  try {
    patched = applyPatch(base, clean.ops);
  } catch (err) {
    if (err instanceof PatchError)
      return { ok: false, reason: 'invalid_patch', detail: err.message };
    throw err;
  }
  if (!isObject(patched)) return { ok: false, reason: 'invalid_patch' };
  const text = opts.text;
  const stated = text === null ? null : statedNumbers(text);
  const said = (n: number) => stated === null || stated.has(n) || stated.has(round2(n));

  // ── Crew: totals from code, the source of each changed line, the hours basis ─────────────────
  const afterCrew = (
    Array.isArray(patched.manpower) ? patched.manpower : []
  ) as Partial<ManpowerEntry>[];
  const matches = matchCrew(base.manpower, afterCrew);
  const crewChanged: Array<{ entry: ManpowerEntry; base: ManpowerEntry | null }> = [];
  const manpower: ManpowerEntry[] = [];
  for (let i = 0; i < afterCrew.length; i++) {
    const j = matches[i] ?? null;
    const prev = j === null ? null : base.manpower[j]!;
    const raw = resolveCompany(afterCrew[i]!, opts.companies);
    const workers = raw.workers ?? null;
    const hoursPerWorker = raw.hoursPerWorker ?? null;
    const numbersChanged =
      !prev || prev.workers !== workers || prev.hoursPerWorker !== hoursPerWorker;
    const changed =
      numbersChanged ||
      !jsonEqual(
        stripCodeKeys({ ...raw, hoursBasis: undefined }),
        stripCodeKeys({ ...prev, hoursBasis: undefined }),
      );
    let hoursBasis = raw.hoursBasis ?? prev?.hoursBasis ?? 'unknown';
    if (!prev || prev.hoursPerWorker !== hoursPerWorker) {
      hoursBasis =
        hoursPerWorker === null
          ? 'unknown'
          : hoursBasis === 'full_day_default' && hoursPerWorker === opts.defaultShiftHours
            ? 'full_day_default'
            : 'stated';
    }
    const entry = {
      ...raw,
      companyId: raw.companyId ?? null,
      companyNameHeard: raw.companyNameHeard ?? raw.companyName ?? '',
      companyName: raw.companyName ?? raw.companyNameHeard ?? '',
      workers,
      hoursPerWorker,
      // A total is never the model's: the base's while the numbers stand, else code's.
      totalHours: numbersChanged ? null : (prev?.totalHours ?? null),
      hoursBasis,
      confidence: changed ? 1 : (prev?.confidence ?? 1),
      source: changed ? withSource(prev?.source, opts.source) : (prev?.source ?? []),
    } as ManpowerEntry;
    manpower.push(entry);
    if (changed) crewChanged.push({ entry, base: prev });
  }
  const recomputed = recomputeManpowerTotals(manpower).entries;

  // ── The other lists: sources of the changed items ────────────────────────────────────────────
  const p = patched as unknown as Record<string, unknown>;
  const list = <T extends { source: Source[] }>(k: keyof DailyReportData) =>
    sourceList(
      (base[k] ?? []) as unknown as T[],
      (Array.isArray(p[k]) ? p[k] : []) as T[],
      opts.source,
    );
  const work = list('workPerformed');
  const deliveries = list('deliveries');
  const equipment = list('equipment');
  const issues = list('issues');
  const next = list('nextWorkday');
  // The observed weather is the weather API's, never the correction's: a value for `/weather`
  // that carries one is not taken (the base's stays, or none).
  const { observed: _observed, ...weatherIn } = isObject(p.weather)
    ? (p.weather as Record<string, unknown>)
    : {};
  void _observed;
  const periods = sourceList(
    base.weather.periods,
    (Array.isArray(weatherIn.periods)
      ? weatherIn.periods
      : []) as DailyReportData['weather']['periods'],
    opts.source,
  );
  const safetyIn = isObject(p.safety) ? (p.safety as Record<string, unknown>) : {};
  const incidents = sourceList(
    base.safety.incidents,
    (Array.isArray(safetyIn.incidents)
      ? safetyIn.incidents
      : []) as DailyReportData['safety']['incidents'],
    opts.source,
  );
  const safetyChanged = !jsonEqual(stripCodeKeys(safetyIn), stripCodeKeys(base.safety));

  const candidate = {
    ...patched,
    manpower: recomputed,
    workPerformed: work.items,
    deliveries: deliveries.items,
    equipment: equipment.items,
    issues: issues.items,
    nextWorkday: next.items,
    weather: {
      ...weatherIn,
      ...(base.weather.observed ? { observed: base.weather.observed } : {}),
      periods: periods.items,
    },
    safety: {
      ...safetyIn,
      incidents: incidents.items,
      source: safetyChanged ? withSource(base.safety.source, opts.source) : base.safety.source,
    },
    // Code's own parts stay as they were.
    schemaVersion: 2,
    reportDate: base.reportDate,
    reportLanguage: base.reportLanguage,
    units: base.units,
    languageDetected: base.languageDetected,
    photos: base.photos,
    newTerms: base.newTerms,
    missingRequired: base.missingRequired,
    lowConfidence: base.lowConfidence,
    proposedQuestions: base.proposedQuestions,
  };
  const parsed = DailyReportDataSchema.safeParse(candidate);
  if (!parsed.success)
    return { ok: false, reason: 'invalid_patch', detail: parsed.error.issues[0]?.message };
  const data = parsed.data;
  if (jsonEqual(data, base)) return { ok: false, reason: 'no_change' };

  // ── Never invent numbers: each number the correction brings in is one the words state ────────
  if (text !== null) {
    for (const { entry, base: prev } of crewChanged) {
      const value: Parameters<typeof unstatedAnswerNumber>[0] = {};
      if (entry.workers !== null && entry.workers !== prev?.workers) value.workers = entry.workers;
      if (entry.hoursPerWorker !== null && entry.hoursPerWorker !== prev?.hoursPerWorker) {
        if (entry.hoursBasis === 'full_day_default') value.fullDay = true;
        else value.hoursPerWorker = entry.hoursPerWorker;
      }
      const problem = unstatedAnswerNumber(value, text);
      if (problem)
        return {
          ok: false,
          reason: 'number_not_stated',
          detail: `${entry.companyName}.${problem}`,
        };
    }
    for (const { item, base: prev } of periods.changed) {
      // Lost hours and the period's times: the ones the correction brings in are stated.
      const value: Parameters<typeof unstatedAnswerNumber>[0] = {};
      if (!prev || item.lostHours !== prev.lostHours) value.lostHours = item.lostHours;
      if (item.start && item.start !== prev?.start) value.start = item.start;
      if (item.end && item.end !== prev?.end) value.end = item.end;
      const problem = unstatedAnswerNumber(value, text);
      if (problem) return { ok: false, reason: 'number_not_stated', detail: `weather.${problem}` };
    }
    // The working hours: a changed start or end names its hour.
    for (const k of ['start', 'end'] as const) {
      const t = data.workingHours?.[k];
      if (t && t !== base.workingHours?.[k] && unstatedAnswerNumber({ [k]: t }, text))
        return { ok: false, reason: 'number_not_stated', detail: `workingHours.${k}` };
    }
    const others = [work, deliveries, equipment, issues, next, incidents].flatMap((l) => l.changed);
    for (const { item, base: prev } of others) {
      const kept = new Set(numberLeaves(prev).map((l) => `${l.key}:${l.value}`));
      const bad = numberLeaves(item).find(
        (l) => !kept.has(`${l.key}:${l.value}`) && !said(l.value),
      );
      if (bad) return { ok: false, reason: 'number_not_stated', detail: bad.key };
      // Figures written in its words (a delivery's "3 loads") too, and a delivery's time its hour.
      const keptText = new Set(stringNumberLeaves(prev).map((l) => `${l.key}:${l.value}`));
      const badText = stringNumberLeaves(item).find(
        (l) => !keptText.has(`${l.key}:${l.value}`) && !said(l.value),
      );
      if (badText) return { ok: false, reason: 'number_not_stated', detail: badText.key };
      const time = (item as { time?: string }).time;
      if (
        time &&
        time !== (prev as { time?: string } | undefined)?.time &&
        unstatedAnswerNumber({ start: time }, text)
      )
        return { ok: false, reason: 'number_not_stated', detail: 'time' };
    }
    // The summary's figures.
    const keptSummary = new Set(digitRuns(base.summary ?? ''));
    const badSummary = digitRuns(data.summary ?? '').find((n) => !keptSummary.has(n) && !said(n));
    if (badSummary !== undefined)
      return { ok: false, reason: 'number_not_stated', detail: 'summary' };
  }

  // Every preview names what it changes (Save change words its note from these lines, §19 Q100).
  const changes = correctionChanges(base, data);
  if (changes.length === 0) return { ok: false, reason: 'no_change' };
  return {
    ok: true,
    data,
    changes,
    operations: clean.ops,
    droppedTotals: clean.droppedTotals,
  };
}

/**
 * The preview's lines (F8, F10): what changed between two drafts, crew numbers first (code's
 * totals), then lost hours, then the other sections by name. Pure.
 */
export function correctionChanges(
  before: DailyReportData,
  after: DailyReportData,
): CorrectionChange[] {
  const out: CorrectionChange[] = [];
  const matches = matchCrew(before.manpower, after.manpower);
  const seen = new Set<number>();
  let crewWords = false;
  after.manpower.forEach((a, i) => {
    const j = matches[i] ?? null;
    if (j !== null) seen.add(j);
    const b = j === null ? null : before.manpower[j]!;
    if (
      b &&
      b.workers === a.workers &&
      b.hoursPerWorker === a.hoursPerWorker &&
      b.totalHours === a.totalHours &&
      b.companyName === a.companyName
    ) {
      // W2-11 review: the same numbers, other words (area, trade, name heard, hours basis).
      if (!jsonEqual(stripCodeKeys(b), stripCodeKeys(a))) crewWords = true;
      return;
    }
    out.push({
      kind: 'crew',
      company: a.companyName,
      change: b ? 'changed' : 'added',
      workers: [b?.workers ?? null, a.workers],
      hoursPerWorker: [b?.hoursPerWorker ?? null, a.hoursPerWorker],
      totalHours: [b?.totalHours ?? null, a.totalHours],
    });
  });
  before.manpower.forEach((b, j) => {
    if (seen.has(j)) return;
    out.push({
      kind: 'crew',
      company: b.companyName,
      change: 'removed',
      workers: [b.workers, null],
      hoursPerWorker: [b.hoursPerWorker, null],
      totalHours: [b.totalHours, null],
    });
  });
  if (crewWords) out.push({ kind: 'section', section: 'crew' });
  const lost = (d: DailyReportData) =>
    round2(d.weather.periods.reduce((n, p) => n + (p.lostHours ?? 0), 0));
  const weatherChanged = !jsonEqual(
    stripCodeKeys({ ...before.weather, observed: undefined }),
    stripCodeKeys({ ...after.weather, observed: undefined }),
  );
  if (lost(before) !== lost(after)) {
    out.push({ kind: 'lost_hours', lostHours: [lost(before), lost(after)] });
  } else if (weatherChanged) {
    out.push({ kind: 'section', section: 'weather' });
  }
  for (const [key, section] of Object.entries(SECTION_OF)) {
    const k = key as keyof DailyReportData;
    if (!jsonEqual(stripCodeKeys(before[k]), stripCodeKeys(after[k])))
      out.push({ kind: 'section', section });
  }
  return out;
}

/** A stepper's change of one crew line (F8: workers and hours per worker), as the reporter set it. */
export interface CrewEdit {
  index: number;
  workers: number | null;
  hoursPerWorker: number | null;
}

/**
 * The draft's steppers (F8, Q80): one crew line's workers and hours per worker set by the reporter,
 * the line citing `reporter_edit`, totals in code. The same rules as a spoken fix, without the
 * stated-numbers check (the reporter typed or tapped the numbers). Pure.
 */
export function applyCrewEdit(
  base: DailyReportData,
  edit: CrewEdit,
  opts: Omit<CorrectionOptions, 'text'>,
): CorrectionResultOf {
  if (!base.manpower[edit.index]) return { ok: false, reason: 'invalid_patch', detail: 'index' };
  return applyCorrectionOps(
    base,
    [
      { op: 'replace', path: `/manpower/${edit.index}/workers`, value: edit.workers },
      { op: 'replace', path: `/manpower/${edit.index}/hoursPerWorker`, value: edit.hoursPerWorker },
    ],
    { ...opts, text: null },
  );
}

/** A fix applied to the draft before (W2-10): its crew changes and the source it cited. */
export interface AppliedFix {
  changes: readonly CorrectionChange[];
  source: Source;
}

/**
 * Spec §19 Q96 (W2-10 default): after a re-extraction (a later clip or photo), the reporter's fixes
 * of crew numbers stand where the new draft brought back the number they replaced: the crew line
 * of the same company with the old workers (or hours) gets the fixed value again, citing the fix.
 * A crew line with a third value (a later clip said otherwise) is left as the clip has it. Totals in
 * code. Pure.
 */
export function reapplyCrewFixes(
  data: DailyReportData,
  fixes: readonly AppliedFix[],
): { data: DailyReportData; reapplied: number } {
  let reapplied = 0;
  const manpower = data.manpower.map((e) => ({ ...e }));
  for (const fix of fixes) {
    for (const c of fix.changes) {
      if (c.kind !== 'crew' || c.change !== 'changed') continue;
      const entry = manpower.find((e) => e.companyName.toLowerCase() === c.company.toLowerCase());
      if (!entry) continue;
      let hit = false;
      if (c.workers[0] !== c.workers[1] && entry.workers === c.workers[0]) {
        entry.workers = c.workers[1];
        hit = true;
      }
      if (
        c.hoursPerWorker[0] !== c.hoursPerWorker[1] &&
        entry.hoursPerWorker === c.hoursPerWorker[0]
      ) {
        entry.hoursPerWorker = c.hoursPerWorker[1];
        entry.hoursBasis = c.hoursPerWorker[1] === null ? 'unknown' : 'stated';
        hit = true;
      }
      if (hit) {
        entry.totalHours = null;
        entry.source = withSource(entry.source, fix.source);
        reapplied++;
      }
    }
  }
  if (reapplied === 0) return { data, reapplied };
  return { data: { ...data, manpower: recomputeManpowerTotals(manpower).entries }, reapplied };
}
