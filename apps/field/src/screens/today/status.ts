import type { TodayResponse } from '@sitelog/shared/field-contract.ts';

/** The Today status chip (Field-03): one of `field.today.status.*`. */
export type TodayStatusKey = 'notSent' | 'inProgress' | 'sent' | 'weatherDay' | 'noWork';

type Day = Pick<TodayResponse, 'dayStatus' | 'report'>;

export function todayStatus(day: Day): TodayStatusKey {
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
 * (`day_closed`). An in-progress report still takes more clips and photos (F5 "multiple clips").
 */
export function dayClosed(day: Day): boolean {
  if (day.report) return day.report.status === 'filed' || day.report.status === 'signed_off';
  return (
    day.dayStatus === 'filed' || day.dayStatus === 'weather_day' || day.dayStatus === 'no_work'
  );
}
