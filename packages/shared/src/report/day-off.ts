import type { DayOffClassification } from '../schemas/ai.ts';
import { emptyReportDataV1, type DailyReportDataV1, type SourceV1 } from '../schemas/report.ts';
import { hoursBetween, splitWorkingHours } from './hours.ts';

/**
 * §F10 step 3 — the report data of a weather day (partial: crew released at a time; full: never
 * started). Used by the worker's weather-day flow and the in-browser simulator.
 */

function cap(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

export function weatherDayData(
  date: string,
  cls: DayOffClassification,
  opts: { defaultShiftHours: number; workingHours: string | null; source: SourceV1 },
): DailyReportDataV1 {
  const cause = cls.cause ?? 'weather';
  const [start, end] = splitWorkingHours(opts.workingHours);
  const released = cls.releasedAt;
  let lost = opts.defaultShiftHours;
  let worked: number | null = null;
  if (released && start && end) {
    lost = Math.max(0, hoursBetween(released, end) ?? opts.defaultShiftHours);
    worked = hoursBetween(start, released);
  } else if (released && !cls.fullDay) {
    lost = opts.defaultShiftHours / 2;
  }
  const fullDay = cls.fullDay || !released;
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
