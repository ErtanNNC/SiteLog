import type { DailyReportData, ManpowerEntry, Source, WeatherPeriod } from '../schemas/report.ts';

/**
 * §10.9 post-call reconciliation (W3-11; spec §19 Q123, Q152): what the call's recording says
 * (the batch transcript of the reporter lane, extracted again in batch mode) against the version
 * the reporter confirmed on the call. Pure: the worker's `post_call_reconcile` job calls it and
 * writes what it returns; the confirmed version is never changed (the reporter confirmed it).
 *
 * Q123's rules:
 * - crews are matched by company (the company id when both sides have one, else the company name,
 *   in order when a company has several crews); `workers` and `hoursPerWorker` must be equal
 *   (totals are code's, `workers × hoursPerWorker`, so they follow);
 * - weather periods are matched by time overlap (else by condition); `lostHours` may differ by
 *   at most `LOST_HOURS_TOLERANCE` (0.25 h);
 * - a crew, or a period with lost hours, on one side only is a mismatch. Q152: the side it is
 *   missing from is left empty (`call_mismatch:manpower[3]:Delta Mechanical 5:`), the path being
 *   that side's index.
 *
 * A number the recording does not state (`null` in the batch extraction) is not compared: the
 * recording says nothing against the report there (the reporter may have answered a question whose
 * words alone name no crew). A number the recording states and the report leaves empty is a
 * mismatch with the confirmed side empty.
 *
 * A crew or period that agrees gets its precise call seconds (the batch transcript's, from the
 * batch extraction's sources of this call): written beside the confirmed version as
 * `report_sources` rows (`value_path`, `start_s`, `end_s`), which P7 plays instead of the live
 * seconds.
 */

/** Q123: lost hours within this many hours of each other agree. */
export const LOST_HOURS_TOLERANCE = 0.25;

/** The review reason of a call whose reconcile could not run (Q123, Q153). */
export const CALL_UNRECONCILED = 'call_unreconciled';

export interface CallValueMismatch {
  /** The value's path, `manpower[2].workers`, `weather.periods[0].lostHours`, `manpower[3]`. */
  path: string;
  /** What the recording says ('' when the recording has no such crew or period). */
  heard: string;
  /** What the confirmed report says ('' when it has no such crew or period, or no number). */
  confirmed: string;
}

/** Precise call seconds of a value of the confirmed version (P7 plays them). */
export interface PreciseCallSeconds {
  /** `manpower[1]`, `weather.periods[0]`: the confirmed version's index. */
  path: string;
  start: number;
  end: number | null;
}

export interface CallReconcile {
  mismatches: CallValueMismatch[];
  precise: PreciseCallSeconds[];
  /** How many crews and periods were compared (both sides), for the audit row. */
  compared: { crews: number; periods: number };
}

export interface ReconcileOptions {
  lostHoursTolerance?: number;
}

const EPSILON = 1e-9;

/** Lower case, no punctuation, single spaces. */
function norm(s: string | null | undefined): string {
  return (s ?? '')
    .toLowerCase()
    .normalize('NFKC')
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim();
}

/** A value as the reason code carries it: no `:` (the code's separator), one line, ≤ 60 chars. */
export function reasonValue(value: string): string {
  return value
    .replace(/[:\s]+/g, ' ')
    .trim()
    .slice(0, 60)
    .trim();
}

function num(n: number): string {
  return String(Math.round(n * 100) / 100);
}

/** `call_mismatch:<path>:<heard>:<confirmed>` (§19 Q74, Q123). */
export function callMismatchReason(m: CallValueMismatch): string {
  return `call_mismatch:${m.path}:${reasonValue(m.heard)}:${reasonValue(m.confirmed)}`;
}

/** The call's seconds a value cites, earliest start to latest end; null when it cites none. */
function callSeconds(
  sources: readonly Source[],
  callId: string,
): { start: number; end: number | null } | null {
  const own = sources.filter(
    (s): s is Extract<Source, { type: 'call' }> => s.type === 'call' && s.callId === callId,
  );
  if (own.length === 0) return null;
  const start = Math.min(...own.map((s) => s.start));
  const ends = own.flatMap((s) => (s.end !== undefined ? [s.end] : []));
  return { start, end: ends.length ? Math.max(...ends) : null };
}

/** Pairs of indexes (heard, confirmed) of crews of the same company; the rest one-sided. */
function pairCrews(
  heard: readonly ManpowerEntry[],
  confirmed: readonly ManpowerEntry[],
): { pairs: Array<[number, number]>; heardOnly: number[]; confirmedOnly: number[] } {
  const usedH = new Set<number>();
  const usedC = new Set<number>();
  const pairs: Array<[number, number]> = [];
  const pass = (key: (m: ManpowerEntry) => string | null) => {
    confirmed.forEach((c, ci) => {
      if (usedC.has(ci)) return;
      const k = key(c);
      if (!k) return;
      const hi = heard.findIndex((h, i) => !usedH.has(i) && key(h) === k);
      if (hi < 0) return;
      usedH.add(hi);
      usedC.add(ci);
      pairs.push([hi, ci]);
    });
  };
  // The company id first (both sides know the company), then the name the extraction gave.
  pass((m) => m.companyId ?? null);
  pass((m) => norm(m.companyName) || norm(m.companyNameHeard) || null);
  pass((m) => norm(m.companyNameHeard) || null);
  return {
    pairs: pairs.sort((a, b) => a[1] - b[1]),
    heardOnly: heard.map((_, i) => i).filter((i) => !usedH.has(i)),
    confirmedOnly: confirmed.map((_, i) => i).filter((i) => !usedC.has(i)),
  };
}

function minutes(hhmm: string | undefined): number | null {
  if (!hhmm) return null;
  const [h, m] = hhmm.split(':').map(Number);
  return Number.isFinite(h) && Number.isFinite(m) ? h! * 60 + m! : null;
}

/** How well two periods match: their overlap in minutes, else 1 for the same condition, else 0. */
function periodScore(a: WeatherPeriod, b: WeatherPeriod): number {
  const [as, ae, bs, be] = [minutes(a.start), minutes(a.end), minutes(b.start), minutes(b.end)];
  if (as !== null && ae !== null && bs !== null && be !== null) {
    const overlap = Math.min(ae, be) - Math.max(as, bs);
    if (overlap > 0) return overlap + 1;
  }
  const ca = norm(a.condition);
  const cb = norm(b.condition);
  return ca && cb && (ca.includes(cb) || cb.includes(ca)) ? 1 : 0;
}

function pairPeriods(
  heard: readonly WeatherPeriod[],
  confirmed: readonly WeatherPeriod[],
): { pairs: Array<[number, number]>; heardOnly: number[]; confirmedOnly: number[] } {
  const candidates: Array<{ h: number; c: number; score: number }> = [];
  heard.forEach((h, hi) =>
    confirmed.forEach((c, ci) => {
      const score = periodScore(h, c);
      if (score > 0) candidates.push({ h: hi, c: ci, score });
    }),
  );
  candidates.sort((a, b) => b.score - a.score || a.c - b.c || a.h - b.h);
  const usedH = new Set<number>();
  const usedC = new Set<number>();
  const pairs: Array<[number, number]> = [];
  for (const x of candidates) {
    if (usedH.has(x.h) || usedC.has(x.c)) continue;
    usedH.add(x.h);
    usedC.add(x.c);
    pairs.push([x.h, x.c]);
  }
  return {
    pairs: pairs.sort((a, b) => a[1] - b[1]),
    heardOnly: heard.map((_, i) => i).filter((i) => !usedH.has(i)),
    confirmedOnly: confirmed.map((_, i) => i).filter((i) => !usedC.has(i)),
  };
}

function crewLabel(m: ManpowerEntry): string {
  const name = m.companyName || m.companyNameHeard;
  return m.workers !== null ? `${name} ${m.workers}` : name;
}

function periodLabel(p: WeatherPeriod): string {
  return `${p.condition} ${num(p.lostHours)}`;
}

const stopped = (p: WeatherPeriod) => p.lostHours > 0;

/** Q123 on the call's recording (`heard`) against the confirmed version. Pure. */
export function reconcileCall(
  heard: DailyReportData,
  confirmed: DailyReportData,
  callId: string,
  opts: ReconcileOptions = {},
): CallReconcile {
  const tolerance = opts.lostHoursTolerance ?? LOST_HOURS_TOLERANCE;
  const mismatches: CallValueMismatch[] = [];
  const precise: PreciseCallSeconds[] = [];

  const crews = pairCrews(heard.manpower, confirmed.manpower);
  for (const [hi, ci] of crews.pairs) {
    const h = heard.manpower[hi]!;
    const c = confirmed.manpower[ci]!;
    let agrees = true;
    for (const field of ['workers', 'hoursPerWorker'] as const) {
      const hv = h[field];
      const cv = c[field];
      if (hv === null) continue; // the recording does not state it
      if (cv !== null && Math.abs(hv - cv) < EPSILON) continue;
      agrees = false;
      mismatches.push({
        path: `manpower[${ci}].${field}`,
        heard: num(hv),
        confirmed: cv === null ? '' : num(cv),
      });
    }
    const secs = agrees ? callSeconds(h.source, callId) : null;
    if (secs) precise.push({ path: `manpower[${ci}]`, ...secs });
  }
  for (const hi of crews.heardOnly)
    mismatches.push({
      path: `manpower[${hi}]`,
      heard: crewLabel(heard.manpower[hi]!),
      confirmed: '',
    });
  for (const ci of crews.confirmedOnly)
    mismatches.push({
      path: `manpower[${ci}]`,
      heard: '',
      confirmed: crewLabel(confirmed.manpower[ci]!),
    });

  const periods = pairPeriods(heard.weather.periods, confirmed.weather.periods);
  for (const [hi, ci] of periods.pairs) {
    const h = heard.weather.periods[hi]!;
    const c = confirmed.weather.periods[ci]!;
    if (Math.abs(h.lostHours - c.lostHours) > tolerance + EPSILON) {
      mismatches.push({
        path: `weather.periods[${ci}].lostHours`,
        heard: num(h.lostHours),
        confirmed: num(c.lostHours),
      });
      continue;
    }
    const secs = callSeconds(h.source, callId);
    if (secs) precise.push({ path: `weather.periods[${ci}]`, ...secs });
  }
  // A period with no lost hours carries no number: on one side only it is no mismatch.
  for (const hi of periods.heardOnly) {
    const p = heard.weather.periods[hi]!;
    if (stopped(p))
      mismatches.push({ path: `weather.periods[${hi}]`, heard: periodLabel(p), confirmed: '' });
  }
  for (const ci of periods.confirmedOnly) {
    const p = confirmed.weather.periods[ci]!;
    if (stopped(p))
      mismatches.push({ path: `weather.periods[${ci}]`, heard: '', confirmed: periodLabel(p) });
  }

  return {
    mismatches,
    precise,
    compared: {
      crews: Math.max(heard.manpower.length, confirmed.manpower.length),
      periods: Math.max(heard.weather.periods.length, confirmed.weather.periods.length),
    },
  };
}

/**
 * §19 Q122: whether a draft holds any report value (a crew, work, a delivery, equipment, weather,
 * safety, an issue, the next workday). A call that ends before the yes with none is `abandoned`:
 * too little was said for a report. Pure.
 */
export function draftHasReportValue(data: DailyReportData): boolean {
  return (
    data.manpower.length > 0 ||
    data.workPerformed.length > 0 ||
    data.deliveries.length > 0 ||
    data.equipment.length > 0 ||
    data.weather.periods.length > 0 ||
    data.weather.conditionsText.trim() !== '' ||
    data.safety.incidents.length > 0 ||
    data.safety.noIncidentsStated ||
    data.safety.visitors.length > 0 ||
    data.issues.length > 0 ||
    data.nextWorkday.length > 0
  );
}

/** The keys of a value path: `manpower[2].workers` → manpower, 2, workers. */
function pathKeys(path: string): string[] {
  return path
    .replace(/\[(\d+)\]/g, '.$1')
    .split('.')
    .filter(Boolean);
}

/**
 * P7 (W3-11): the version's values with the precise call seconds written by the reconcile
 * (`report_sources.value_path`, `start_s`, `end_s`): the value at each path citing that call gets
 * those seconds instead of its live ones. A path whose value no longer cites the call (an office
 * edit since) is left alone. Pure; returns the same object when nothing applies.
 */
export function withPreciseCallSeconds(
  data: DailyReportData,
  rows: ReadonlyArray<{
    call_id: string | null;
    value_path?: string | null;
    start_s?: number | string | null;
    end_s?: number | string | null;
  }>,
): DailyReportData {
  const precise = rows.filter((r) => r.call_id && r.value_path && r.start_s !== null);
  if (precise.length === 0) return data;
  const out = structuredClone(data);
  let changed = false;
  for (const r of precise) {
    let node: unknown = out;
    for (const k of pathKeys(r.value_path!)) {
      if (!node || typeof node !== 'object') {
        node = null;
        break;
      }
      node = Array.isArray(node) ? node[Number(k)] : (node as Record<string, unknown>)[k];
    }
    const value = node as { source?: Source[] } | null;
    if (!value || !Array.isArray(value.source)) continue;
    const start = Number(r.start_s);
    const end = r.end_s === null || r.end_s === undefined ? null : Number(r.end_s);
    if (!Number.isFinite(start)) continue;
    let first = true;
    const next: Source[] = [];
    for (const s of value.source) {
      if (s.type !== 'call' || s.callId !== r.call_id) {
        next.push(s);
        continue;
      }
      // The live seconds of this call become the one precise span.
      if (first)
        next.push({
          type: 'call',
          callId: s.callId,
          start,
          ...(end !== null && Number.isFinite(end) ? { end } : {}),
        });
      first = false;
    }
    if (!first) {
      value.source = next;
      changed = true;
    }
  }
  return changed ? out : data;
}
