import { dayOffText } from '../copy/report-notes.ts';
import type { ReportLanguage, UnitSystem } from '../locale.ts';
import type { DayOffClassification } from '../schemas/ai.ts';
import {
  emptyReportData,
  emptyReportDataV1,
  type DailyReportData,
  type DailyReportDataV1,
  type ManpowerEntry,
  type Source,
  type SourceV1,
  type WeatherPeriod,
} from '../schemas/report.ts';
import { hoursBetween, parseHHMM, round2, splitWorkingHours } from './hours.ts';

/**
 * §F10 step 3 — the report data of a weather day (partial: crew released at a time; full: never
 * started). Used by the worker's weather-day flow and the in-browser simulator.
 */

function cap(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

/**
 * The hours of a weather day, computed in code for every channel (the WhatsApp flow, the
 * recorder's *Site closed: weather*, W2-08): `lostHours` is the time work was stopped (§10.4: per
 * crew member, not crew-hours) and `workedHours` the time worked before the stop. With the site's
 * working hours, the stop splits them; a stop at or before the start loses the whole span. Without
 * working hours a full day loses the default shift and a partial one half of it (§19 Q62), and the
 * time worked is unknown (null). A full day (the crew never started) loses the default shift.
 */
export function weatherDayHours(input: {
  releasedAt: string | null;
  fullDay: boolean;
  workingHours: string | null;
  defaultShiftHours: number;
}): {
  start: string | undefined;
  end: string | undefined;
  lostHours: number;
  workedHours: number | null;
  fullDay: boolean;
} {
  const [start, end] = splitWorkingHours(input.workingHours);
  const released = input.releasedAt;
  let lost = input.defaultShiftHours;
  let worked: number | null = null;
  if (released && start && end) {
    const r = parseHHMM(released) ?? 0;
    if (r <= (parseHHMM(start) ?? 0)) {
      lost = hoursBetween(start, end) ?? input.defaultShiftHours;
      worked = 0;
    } else {
      const span = hoursBetween(start, end);
      lost = Math.max(0, hoursBetween(released, end) ?? 0);
      const before = hoursBetween(start, released);
      worked = before !== null && span !== null ? Math.min(before, span) : before;
    }
  } else if (released && !input.fullDay) {
    lost = input.defaultShiftHours / 2;
  }
  return {
    start,
    end,
    lostHours: round2(lost),
    workedHours: worked,
    fullDay: input.fullDay || !released,
  };
}

export function weatherDayData(
  date: string,
  cls: DayOffClassification,
  opts: { defaultShiftHours: number; workingHours: string | null; source: SourceV1 },
): DailyReportDataV1 {
  const cause = cls.cause ?? 'weather';
  const released = cls.releasedAt;
  const hours = weatherDayHours({
    releasedAt: released,
    fullDay: cls.fullDay,
    workingHours: opts.workingHours,
    defaultShiftHours: opts.defaultShiftHours,
  });
  const { start, end, fullDay } = hours;
  const lost = hours.lostHours;
  const worked = hours.workedHours;
  const data = emptyReportDataV1(date);
  data.summary = fullDay
    ? `Weather day: no work because of ${cause}. Site closed for the day.`
    : `Weather day: work stopped at ${released} because of ${cause}; crew released. ${lost} h lost.`;
  data.weather = {
    conditionsText: `${cap(cause)} — weather day`,
    periods: [
      {
        start: fullDay ? start : (released ?? undefined),
        end: end,
        condition: cap(cause),
        impact: fullDay
          ? 'Crew did not start; site closed for weather'
          : `Work stopped; crew released at ${released}`,
        lostHours: Math.round(lost * 100) / 100,
        fullDay,
        source: [opts.source],
      },
    ],
  };
  if (cls.workersThisMorning !== null && cls.workersThisMorning > 0) {
    data.manpower = [
      {
        companyId: null,
        companyNameHeard: 'crew on site this morning',
        companyName: 'Site crew',
        workers: cls.workersThisMorning,
        hoursPerWorker: worked,
        totalHours:
          worked !== null ? Math.round(worked * cls.workersThisMorning * 100) / 100 : null,
        hoursBasis: worked !== null ? 'stated' : 'unknown',
        confidence: cls.confidence,
        source: [opts.source],
      },
    ];
  }
  return data;
}

// ─────────────── v2: the recorder's No work / Weather (F12, spec §19 Q41; W2-08) ───────────────

/** F12's details as the recorder sends them (`POST day-status`). */
export interface DayOffDetails {
  /** "Since when?": the stop's time (`HH:MM`) or `never_started`. Required for a weather day. */
  since?: string;
  /** "How many were on site before?" */
  workersBefore?: number;
}

/** The `questions` rows a day-off writes for its details (answered at once, source of the values). */
export interface DayOffQuestionIds {
  since: string | null;
  workersBefore: string | null;
}

/**
 * Spec §19 Q79 (open) as a parameter: what *No work today* or *Site closed: weather* does when the
 * day's report has already started. `refuse` (the default, W1-07's rule): field-api answers 409
 * `report_in_progress` and the sheet asks the reporter to say it in the report; the voice note
 * keeps the stoppage with its sources. No other answer is built.
 */
export const DAY_OFF_POLICY = { liveReport: 'refuse' } as const satisfies {
  liveReport: 'refuse';
};

/**
 * The version data of a recorder day-off (F12, W2-08), v2: built in code from the reporter's
 * answers, each value sourced to its answered question (`{type: 'answer', questionId}`, §19 Q41):
 * - weather: one period (`start` = the stop, or the working day's start when the crew never
 *   started; `fullDay`), its `lostHours` from `weatherDayHours`; with a headcount a "site crew"
 *   line (workers × hours worked before the stop, computed here; 0 h when they never started,
 *   unknown without the working hours), and the crew-hours lost (workers × lost hours) in the
 *   summary. Nothing is invented: no headcount, no crew line.
 * - no work: an empty day with the summary only (no manpower, no weather period).
 * The texts are the report language's (`dayOffText`).
 */
export function dayOffReportData(input: {
  kind: 'weather_day' | 'no_work';
  date: string;
  siteName: string;
  org: { reportLanguage: ReportLanguage; units: UnitSystem };
  details: DayOffDetails;
  questionIds: DayOffQuestionIds;
  workingHours: string | null;
  defaultShiftHours: number;
}): DailyReportData {
  const text = dayOffText(input.org.reportLanguage);
  const data = emptyReportData(input.date, input.org);
  if (input.kind === 'no_work') {
    data.summary = text.noWorkSummary(input.siteName);
    data.weather.conditionsText = text.noWorkConditions;
    return data;
  }
  const since = input.details.since;
  if (!since) throw new Error('a weather day needs since (F12 "Since when?")');
  const neverStarted = since === 'never_started';
  const sinceSource: Source[] = input.questionIds.since
    ? [{ type: 'answer', questionId: input.questionIds.since }]
    : [];
  const hours = weatherDayHours({
    releasedAt: neverStarted ? null : since,
    fullDay: neverStarted,
    workingHours: input.workingHours,
    defaultShiftHours: input.defaultShiftHours,
  });
  if (hours.start && hours.end) data.workingHours = { start: hours.start, end: hours.end };
  const start = neverStarted ? hours.start : since;
  const period: WeatherPeriod = {
    ...(start ? { start } : {}),
    ...(hours.end ? { end: hours.end } : {}),
    condition: text.condition,
    impact: neverStarted ? text.impactFullDay : text.impactStopped(since),
    lostHours: hours.lostHours,
    fullDay: neverStarted,
    source: sinceSource,
  };
  data.weather = { conditionsText: text.conditions, periods: [period] };

  const workers = input.details.workersBefore;
  let crewHoursLost: number | null = null;
  if (workers !== undefined && workers > 0) {
    const worked = neverStarted ? 0 : hours.workedHours;
    const entry: ManpowerEntry = {
      companyId: null,
      companyNameHeard: text.crewHeard,
      companyName: text.crew,
      workers,
      hoursPerWorker: worked,
      totalHours: worked !== null ? round2(workers * worked) : null,
      hoursBasis: worked !== null ? 'answer' : 'unknown',
      confidence: 1,
      source: [
        ...(input.questionIds.workersBefore
          ? [{ type: 'answer' as const, questionId: input.questionIds.workersBefore }]
          : []),
        ...sinceSource,
      ],
    };
    data.manpower = [entry];
    crewHoursLost = round2(workers * hours.lostHours);
  }
  data.summary = neverStarted
    ? text.summaryFullDay(workers ?? null, crewHoursLost)
    : text.summaryStopped(since, hours.lostHours, workers ?? null, crewHoursLost);
  return data;
}
