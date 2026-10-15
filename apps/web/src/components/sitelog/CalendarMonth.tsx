import {
  CloudRain,
  ChevronLeft,
  ChevronRight,
  Keyboard,
  Link2,
  Phone,
  type LucideIcon,
} from 'lucide-react';
import { useNavigate } from 'react-router';
import {
  formatDate,
  formatMonthYearIn,
  parseIsoDate,
  weekdaysShortIn,
} from '@sitelog/shared/format.ts';
import type { ChipVariant } from '@sitelog/shared/status.ts';
import type { CalendarCell, CalendarChannel } from '@/data/types';
import { useCopy } from '@/i18n/useCopy';
import { addMonths } from '@/lib/format';
import { cn } from '@/lib/utils';
import { Button } from '../ui/Button';

const CELL_TONE: Record<ChipVariant, string> = {
  filed: 'bg-chip-filed-bg text-chip-filed-fg',
  signed_off: 'bg-chip-filed-bg text-chip-filed-fg',
  awaiting: 'bg-chip-await-bg text-chip-await-fg',
  pending: 'bg-chalk text-dust',
  missing: 'bg-chip-miss-bg text-chip-miss-fg',
  needs_review: 'bg-chip-review-bg text-chip-review-fg',
  weather_day: 'bg-chip-wx-bg text-chip-wx-fg',
  no_work: 'bg-chip-wx-bg text-chip-wx-fg',
};

/** Web-Site: a late filed day is drawn in the awaiting tone with "LATE". */
const LATE_TONE = 'bg-chip-await-bg text-chip-await-fg';

/** P5 "channel dot per day" (W1-18): an icon, so the channel never rests on colour alone. */
const CHANNEL_ICON: Record<CalendarChannel, LucideIcon> = {
  link: Link2,
  call: Phone,
  office: Keyboard,
};

export interface CalendarMonthProps {
  month: string;
  cells: CalendarCell[];
  onMonthChange?: (month: string) => void;
  onSelect?: (cell: CalendarCell) => void;
  className?: string;
}

/**
 * Mon–Sun grid; workday cells show status colour, crew count, a weather icon and the channel the
 * report came in by; today outlined; weekends grey (§11.4, P5). Words in the panel's language.
 */
export function CalendarMonth({
  month,
  cells,
  onMonthChange,
  onSelect,
  className,
}: CalendarMonthProps) {
  const navigate = useNavigate();
  const { t, language } = useCopy();
  const first = cells[0]?.date ?? `${month}-01`;
  const lead = (parseIsoDate(first).dow + 6) % 7; // Monday-first offset
  const monthLabel = formatMonthYearIn(month, language);
  const dayLabel = (date: string) => formatDate(date, 'monthDay', language);
  const channels = new Set(cells.map((c) => c.channel).filter((c) => c !== null));
  const open = (cell: CalendarCell) => {
    if (onSelect) onSelect(cell);
    else if (cell.reportId) void navigate(`/reports/${cell.reportId}`);
  };
  return (
    <div className={cn('rounded-card border border-rebar bg-chalk', className)}>
      <div className="flex items-center justify-between border-b border-rebar px-4 py-3">
        <h3 className="font-h2 text-h2">{monthLabel}</h3>
        {onMonthChange ? (
          <div className="flex gap-1">
            <Button
              variant="subtle"
              size="iconDense"
              aria-label={t('calendar.previousMonth')}
              onClick={() => onMonthChange(addMonths(month, -1))}
            >
              <ChevronLeft aria-hidden="true" />
            </Button>
            <Button
              variant="subtle"
              size="iconDense"
              aria-label={t('calendar.nextMonth')}
              onClick={() => onMonthChange(addMonths(month, 1))}
            >
              <ChevronRight aria-hidden="true" />
            </Button>
          </div>
        ) : null}
      </div>
      {/* Rows use `display: contents` so the 7-column CSS grid lays out their cells directly. */}
      <div className="grid grid-cols-7 gap-1 p-3" role="grid" aria-label={monthLabel}>
        <div role="row" className="contents">
          {weekdaysShortIn(language).map((d) => (
            <div key={d} role="columnheader" className="eyebrow py-1 text-center text-dust">
              {d}
            </div>
          ))}
        </div>
        {weeks(lead, cells).map((week) => (
          <div key={week.key} role="row" className="contents">
            {Array.from({ length: week.lead }, (_, i) => (
              <div key={`lead-${i}`} aria-hidden="true" />
            ))}
            {week.cells.map((cell) => {
              const day = Number(cell.date.slice(8, 10));
              const filed = cell.reportId !== null;
              const tone = !cell.isWorkday
                ? 'bg-concrete text-dust'
                : cell.isFuture || !cell.chip
                  ? 'bg-chalk text-dust'
                  : filed && cell.isLate
                    ? LATE_TONE
                    : CELL_TONE[cell.chip.variant];
              const chipLabel = cell.chip ? t(`chips.${cell.chip.variant}`) : null;
              const ChannelIcon = cell.channel ? CHANNEL_ICON[cell.channel] : null;
              const details = [
                chipLabel ?? (cell.isWorkday ? t('calendar.noReport') : t('calendar.weekend')),
                filed && cell.isLate ? t('calendar.late') : null,
                cell.crew !== null ? t('calendar.crew', { count: cell.crew }) : null,
                cell.weatherAffected ? t('calendar.weatherAffected') : null,
                cell.channel ? t(`calendar.channel.${cell.channel}`) : null,
              ]
                .filter(Boolean)
                .join(', ');
              const label = `${dayLabel(cell.date)}: ${details}`;
              const content = (
                <>
                  <span className="flex items-start justify-between gap-1">
                    <span
                      className={cn(
                        'font-mono text-[12px] font-medium',
                        cell.isToday && 'underline underline-offset-2',
                      )}
                    >
                      {day}
                    </span>
                    <span className="inline-flex items-center gap-0.5">
                      {filed && cell.isLate ? (
                        <span className="hidden font-mono text-[10px] font-bold uppercase sm:inline">
                          {t('calendar.late')}
                        </span>
                      ) : null}
                      {cell.weatherAffected ? (
                        <CloudRain className="size-4" aria-hidden="true" />
                      ) : null}
                    </span>
                  </span>
                  <span className="mt-auto flex items-end justify-between gap-1">
                    {cell.crew !== null ? (
                      <span className="font-mono text-[12px] tabular">
                        {cell.crew}
                        <span className="hidden lg:inline"> {t('calendar.crewUnit')}</span>
                      </span>
                    ) : cell.chip &&
                      cell.chip.variant !== 'filed' &&
                      cell.chip.variant !== 'signed_off' ? (
                      <span className="text-[11px] leading-4">{chipLabel}</span>
                    ) : (
                      <span />
                    )}
                    {ChannelIcon ? (
                      <ChannelIcon
                        className="size-3.5 shrink-0"
                        aria-hidden="true"
                        data-channel={cell.channel}
                      />
                    ) : null}
                  </span>
                </>
              );
              const base = cn(
                'flex min-h-14 flex-col rounded-chip border p-1.5 text-left md:min-h-[72px] md:p-2',
                tone,
                cell.isToday ? 'border-asphalt' : 'border-transparent',
              );
              return cell.reportId ? (
                <button
                  key={cell.date}
                  type="button"
                  role="gridcell"
                  aria-label={`${t('calendar.openReport', { date: dayLabel(cell.date) })} · ${details}`}
                  title={label}
                  className={cn(base, 'hover:border-iron')}
                  onClick={() => open(cell)}
                  data-date={cell.date}
                >
                  {content}
                </button>
              ) : (
                <div
                  key={cell.date}
                  role="gridcell"
                  aria-label={label}
                  className={base}
                  data-date={cell.date}
                >
                  {content}
                </div>
              );
            })}
          </div>
        ))}
      </div>
      <div className="flex flex-col gap-1 border-t border-rebar px-4 py-3 text-[12px] text-dust">
        <p>{t('calendar.legend')}</p>
        {channels.size ? (
          <ul
            className="flex flex-wrap items-center gap-x-4 gap-y-1"
            aria-label={t('calendar.channelLegend')}
          >
            {(['link', 'call', 'office'] as const)
              .filter((c) => channels.has(c))
              .map((c) => {
                const Icon = CHANNEL_ICON[c];
                return (
                  <li key={c} className="inline-flex items-center gap-1.5">
                    <Icon className="size-3.5" aria-hidden="true" />
                    {t(`calendar.channel.${c}`)}
                  </li>
                );
              })}
          </ul>
        ) : null}
      </div>
    </div>
  );
}

/** Splits the month into Monday-first week rows; the first row starts after `lead` blanks. */
function weeks(lead: number, cells: CalendarCell[]) {
  const out: Array<{ key: string; lead: number; cells: CalendarCell[] }> = [];
  let i = 0;
  for (let size = 7 - lead; i < cells.length; size = 7) {
    const chunk = cells.slice(i, i + size);
    out.push({ key: chunk[0]!.date, lead: out.length === 0 ? lead : 0, cells: chunk });
    i += size;
  }
  return out;
}
