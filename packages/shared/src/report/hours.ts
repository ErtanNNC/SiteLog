import type { DailyReportData, ManpowerEntry } from '../schemas/report.ts';

/** Round to 2 decimals to keep numeric(6,2) friendly values. */
export function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

export interface HoursDiscrepancy {
  index: number;
  companyName: string;
  modelTotal: number | null;
  computedTotal: number;
}

/**
 * §10.5 step 1 — totals are computed in code, never trusted from the model.
 * When workers and hoursPerWorker are both known the total is workers × hoursPerWorker;
 * a model total that disagrees is replaced and reported.
 */
export function recomputeManpowerTotals(entries: ManpowerEntry[]): {
  entries: ManpowerEntry[];
  discrepancies: HoursDiscrepancy[];
} {
  const discrepancies: HoursDiscrepancy[] = [];
  const out = entries.map((e, index) => {
    if (e.workers !== null && e.hoursPerWorker !== null) {
      const computed = round2(e.workers * e.hoursPerWorker);
      if (e.totalHours === null || Math.abs(e.totalHours - computed) > 0.01) {
        if (e.totalHours !== null) {
          discrepancies.push({
            index,
            companyName: e.companyName,
            modelTotal: e.totalHours,
            computedTotal: computed,
          });
        }
        return { ...e, totalHours: computed };
      }
      return e;
    }
    // Only a total is known (e.g. "forty hours between them") — keep it and derive the rate
    // when the headcount is known; that is arithmetic, not a guess.
    if (e.totalHours !== null && e.workers !== null && e.workers > 0 && e.hoursPerWorker === null) {
      return { ...e, hoursPerWorker: round2(e.totalHours / e.workers) };
    }
    if (e.totalHours !== null && (e.workers === null || e.hoursPerWorker === null)) return e;
    return { ...e, totalHours: null };
  });
  return { entries: out, discrepancies };
}

export interface ReportTotals {
  crewOnSite: number;
  companies: number;
  subcontractors: number;
  totalHours: number;
  hoursKnown: boolean;
  headcountKnown: boolean;
  lostHours: number;
  weatherAffected: boolean;
}

/** Derived numbers shown in the draft card, PDF and panel (§10.3 "computed in code"). */
export function deriveTotals(
  data: Pick<DailyReportData, 'manpower' | 'weather'>,
  opts: { selfPerformCompanyIds?: ReadonlySet<string> } = {},
): ReportTotals {
  const self = opts.selfPerformCompanyIds ?? new Set<string>();
  let crew = 0;
  let hours = 0;
  let hoursKnown = true;
  let headcountKnown = true;
  const companies = new Set<string>();
  const subs = new Set<string>();
  for (const m of data.manpower) {
    const key = m.companyId ?? `heard:${m.companyNameHeard.toLowerCase()}`;
    companies.add(key);
    if (!(m.companyId && self.has(m.companyId))) subs.add(key);
    if (m.workers === null) headcountKnown = false;
    else crew += m.workers;
    if (m.totalHours === null) hoursKnown = false;
    else hours += m.totalHours;
  }
  const lost = data.weather.periods.reduce((acc, p) => acc + (p.lostHours ?? 0), 0);
  return {
    crewOnSite: crew,
    companies: companies.size,
    subcontractors: subs.size,
    totalHours: round2(hours),
    hoursKnown,
    headcountKnown,
    lostHours: round2(lost),
    weatherAffected: lost > 0 || data.weather.periods.some((p) => p.fullDay === true),
  };
}

/** Hours between two HH:MM local times, e.g. working hours 07:00–15:30 → 8.5. */
export function hoursBetween(start: string, end: string): number | null {
  const a = parseHHMM(start);
  const b = parseHHMM(end);
  if (a === null || b === null) return null;
  const diff = (b - a) / 60;
  return diff >= 0 ? round2(diff) : null;
}

export function parseHHMM(s: string): number | null {
  const m = /^(\d{1,2}):(\d{2})/.exec(s.trim());
  if (!m) return null;
  const h = Number(m[1]);
  const min = Number(m[2]);
  if (h > 23 || min > 59) return null;
  return h * 60 + min;
}

/**
 * Hours a crew worked when the manager gives an end time ("till 3"),
 * computed from the site's working hours start (§10.4 rule 2).
 */
export function hoursFromEndTime(
  workingHours: string,
  endTime: string,
  breakHours = 0,
): number | null {
  const [startStr] = splitWorkingHours(workingHours);
  if (!startStr) return null;
  const h = hoursBetween(startStr, endTime);
  if (h === null) return null;
  return round2(Math.max(0, h - breakHours));
}

/** "07:00–15:30" | "07:00-15:30" | "7:00 - 15:30" → ["07:00","15:30"] */
export function splitWorkingHours(workingHours: string | null | undefined): [string, string] | [] {
  if (!workingHours) return [];
  const m = /(\d{1,2}:\d{2})\s*[–—-]\s*(\d{1,2}:\d{2})/.exec(workingHours);
  if (!m) return [];
  return [padHHMM(m[1]!), padHHMM(m[2]!)];
}

export function padHHMM(s: string): string {
  const [h, m] = s.split(':');
  return `${(h ?? '0').padStart(2, '0')}:${(m ?? '00').padStart(2, '0')}`;
}
