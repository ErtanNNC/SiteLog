import { useId, type ReactNode } from 'react';
import { formatHoursIn } from '@sitelog/shared/format.ts';
import { upperIn } from '@sitelog/shared/locale.ts';
import { deriveTotals } from '@sitelog/shared/report/hours.ts';
import type { DailyReportData } from '@sitelog/shared/schemas/report.ts';
import { useFieldCopy } from '@/i18n/useFieldCopy';
import {
  answeredEntry,
  crewValue,
  crewValueSpoken,
  deliveriesLine,
  formatNumberIn,
  nextLine,
  safetyLine,
  weatherLines,
  workLine,
} from './lines';

/**
 * A report's sections as the draft (F8, Field-06; W1-13) shows them: the crew with each company's
 * workers × hours and the day's total, then weather, work done, deliveries, safety, next workday
 * and photos. The numbers are the report's (computed in code). The Draft screen and the Past
 * reports view (W2-03) both show it; on the Draft each crew line opens its stepper (W2-10).
 */
export function ReportSections({
  data,
  onEditCrew,
}: {
  data: DailyReportData;
  /**
   * W2-10 (F8, Field-06 "tap a number for a stepper"): each crew line is a button opening the
   * stepper for it. Absent (read-only) on Past reports.
   */
  onEditCrew?: (index: number) => void;
}) {
  const { t, language } = useFieldCopy();
  const crewId = useId();
  const totals = deriveTotals(data);
  const upper = (s: string) => upperIn(language, s);

  const weather = weatherLines(data, t, language);
  const rows: { key: string; label: string; value: ReactNode }[] = [
    {
      key: 'weather',
      label: t('draft.weather'),
      value: weather
        ? weather.map((w, i) => (
            <span key={i} className="block">
              {w.text}
              {w.lost ? (
                <>
                  {' '}
                  <b>{w.lost}</b>
                </>
              ) : null}
            </span>
          ))
        : t('draft.notStated'),
    },
    {
      key: 'done',
      label: t('draft.done'),
      value: workLine(data.workPerformed, t) ?? t('draft.notStated'),
    },
  ];
  const delivered = deliveriesLine(data);
  if (delivered) rows.push({ key: 'delivered', label: t('draft.delivered'), value: delivered });
  rows.push({
    key: 'safety',
    label: t('draft.safety'),
    value: safetyLine(data, t) ?? t('draft.notStated'),
  });
  const next = nextLine(data);
  if (next) rows.push({ key: 'next', label: t('draft.next'), value: next });
  rows.push({
    key: 'photos',
    label: t('draft.photos'),
    value: data.photos.length
      ? t('draft.photosCount', { count: data.photos.length })
      : t('draft.none'),
  });

  const crewTotal =
    data.manpower.length > 0
      ? `${totals.headcountKnown ? formatNumberIn(totals.crewOnSite, language) : '—'} · ${
          totals.hoursKnown ? formatHoursIn(totals.totalHours, language) : '—'
        }`
      : null;

  return (
    <>
      <section aria-labelledby={crewId} className="rounded-card border border-rebar bg-white">
        <div className="flex items-center justify-between gap-3 border-b border-rebar px-3.5 py-2.5">
          <h2
            id={crewId}
            className="m-0 font-mono text-[12px] leading-[18px] font-normal tracking-[0.08em] text-dust"
          >
            {upper(t('draft.crew'))}
          </h2>
          {crewTotal ? <b className="font-mono text-[14px] leading-5">{crewTotal}</b> : null}
        </div>
        {data.manpower.length > 0 ? (
          <ul className="m-0 list-none px-3.5 py-1 text-[15px] leading-[22px]">
            {data.manpower.map((entry, i) => {
              const name = (
                <span className="flex min-w-0 flex-wrap items-center gap-1.5 text-left [overflow-wrap:anywhere]">
                  {entry.companyName}
                  {answeredEntry(entry) ? (
                    <span className="rounded-[3px] bg-chip-review-bg px-[5px] py-px text-[10px] leading-4 font-bold text-chip-review-fg">
                      {upper(t('draft.answered'))}
                    </span>
                  ) : null}
                </span>
              );
              const value = (
                <span className="flex h-8 flex-none items-center rounded-btn border border-rebar bg-chalk px-2.5 font-mono text-[14px] font-medium">
                  <span aria-hidden="true">{crewValue(entry, language)}</span>
                  {onEditCrew ? null : (
                    <span className="sr-only">{crewValueSpoken(entry, t, language)}</span>
                  )}
                </span>
              );
              return (
                <li
                  key={`${entry.companyName}:${i}`}
                  className="border-b border-concrete last:border-b-0"
                >
                  {onEditCrew ? (
                    // The whole line is the stepper's target (56 px, §14.6); it reads as
                    // Field-06's label: "Apex Concrete, 6 workers, 8 hours each — change".
                    <button
                      type="button"
                      onClick={() => onEditCrew(i)}
                      aria-label={t('draft.stepper.change', {
                        company: entry.companyName,
                        value: crewValueSpoken(entry, t, language),
                      })}
                      className="flex min-h-target w-full items-center justify-between gap-3 border-0 bg-transparent px-0 py-1 text-[15px] leading-[22px] text-asphalt"
                    >
                      {name}
                      {value}
                    </button>
                  ) : (
                    <div className="flex min-h-10 items-center justify-between gap-3 py-1">
                      {name}
                      {value}
                    </div>
                  )}
                </li>
              );
            })}
          </ul>
        ) : (
          <p className="m-0 px-3.5 py-2.5 text-[15px] leading-[22px] text-dust">
            {t('draft.noCrew')}
          </p>
        )}
      </section>

      <dl className="m-0 grid grid-cols-[96px_minmax(0,1fr)] gap-x-2.5 gap-y-2.5 px-0.5 py-1 text-[15px] leading-[21px]">
        {rows.map((row) => (
          <div key={row.key} className="contents">
            <dt className="pt-0.5 font-mono text-[12px] leading-[18px] text-dust [overflow-wrap:anywhere]">
              {upper(row.label)}
            </dt>
            <dd className="m-0 [overflow-wrap:anywhere]">{row.value}</dd>
          </div>
        ))}
      </dl>
    </>
  );
}
