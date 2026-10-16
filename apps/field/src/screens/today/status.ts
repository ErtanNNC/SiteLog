import type { TodayResponse } from '@sitelog/shared/field-contract.ts';

/** The Today status chip (Field-03): one of `field.today.status.*`. */
export type TodayStatusKey = 'notSent' | 'inProgress' | 'sent' | 'weatherDay' | 'noWork';

type Day = Pick<TodayResponse, 'dayStatus' | 'report'>;

export function todayStatus(day: Day): TodayStatusKey {
  // W2-08: the record the F12 buttons made (spec §19 Q41) shows the day's kind, filed or not.
  if (day.report?.kind === 'weather_day') return 'weatherDay';
  if (day.report?.kind === 'no_work') return 'noWork';
  if (day.report) {
    return day.report.status === 'filed' || day.report.status === 'signed_off'
      ? 'sent'
      : 'inProgress';
  }
  switch (day.dayStatus) {
    case 'filed':
      return 'sent';
    case 'weather_day':
      return 'weatherDay';
    case 'no_work':
      return 'noWork';
    case 'processing':
      return 'inProgress';
    default:
      return 'notSent';
  }
}

/**
 * Nothing more can be recorded for the day from here: the report is filed (`report_filed` from
 * field-api), or the day is filed, a weather day or a no-work day with no live report
 * (`day_closed`), or the day's report is a weather-day or no-work record (W2-08: filed by the
 * worker; its photo of the conditions is added from the Filed screen). An in-progress daily report
 * still takes more clips and photos (F5 "multiple clips").
 */
export function dayClosed(day: Day): boolean {
  if (day.report && day.report.kind !== 'daily') return true;
  if (day.report) return day.report.status === 'filed' || day.report.status === 'signed_off';
  return (
    day.dayStatus === 'filed' || day.dayStatus === 'weather_day' || day.dayStatus === 'no_work'
  );
}
