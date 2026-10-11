import { CloudRain, ChevronLeft, ChevronRight } from 'lucide-react';
import { useNavigate } from 'react-router';
import { formatMonthDay, parseIsoDate } from '@sitelog/shared/format.ts';
import type { ChipVariant } from '@sitelog/shared/status.ts';
import { copy } from '@/copy/en';
import type { CalendarCell } from '@/data/types';
import { addMonths, formatMonthLabel } from '@/lib/format';
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

export interface CalendarMonthProps {
  month: string;
  cells: CalendarCell[];
  onMonthChange?: (month: string) => void;
  onSelect?: (cell: CalendarCell) => void;
  className?: string;
}

/** Mon–Sun grid; workday cells show status colour + crew count + weather icon; today outlined; weekends grey. */
export function CalendarMonth({
  month,
  cells,
  onMonthChange,
  onSelect,
  className,
}: CalendarMonthProps) {
  const navigate = useNavigate();
  const first = cells[0]?.date ?? `${month}-01`;
  const lead = (parseIsoDate(first).dow + 6) % 7; // Monday-first offset
  const open = (cell: CalendarCell) => {
    if (onSelect) onSelect(cell);
    else if (cell.reportId) void navigate(`/reports/${cell.reportId}`);
  };
  return (
    <div className={cn('rounded-card border border-rebar bg-chalk', className)}>
      <div className="flex items-center justify-between border-b border-rebar px-4 py-3">
        <h3 className="font-h2 text-h2">{formatMonthLabel(month)}</h3>
        {onMonthChange ? (
          <div className="flex gap-1">
            <Button
              variant="subtle"
              size="iconDense"
              aria-label={copy.calendar.previousMonth}
              onClick={() => onMonthChange(addMonths(month, -1))}
            >
              <ChevronLeft aria-hidden="true" />
            </Button>
            <Button
              variant="subtle"
              size="iconDense"
              aria-label={copy.calendar.nextMonth}
              onClick={() => onMonthChange(addMonths(month, 1))}
            >
              <ChevronRight aria-hidden="true" />
            </Button>
          </div>
        ) : null}
      </div>
      <div className="grid grid-cols-7 gap-1 p-3" role="grid" aria-label={formatMonthLabel(month)}>
        {copy.calendar.weekdays.map((d) => (
          <div key={d} role="columnheader" className="eyebrow py-1 text-center text-dust">
            {d}
          </div>
        ))}
        {Array.from({ length: lead }, (_, i) => (
          <div key={`lead-${i}`} aria-hidden="true" />
        ))}
        {cells.map((cell) => {
          const day = Number(cell.date.slice(8, 10));
          const tone = !cell.isWorkday
            ? 'bg-concrete text-dust-light'
            : cell.isFuture || !cell.chip
              ? 'bg-chalk text-dust'
              : CELL_TONE[cell.chip.variant];
          const label = `${formatMonthDay(cell.date)}: ${cell.chip?.label ?? (cell.isWorkday ? copy.calendar.noReport : copy.calendar.weekend)}${cell.crew !== null ? `, ${copy.calendar.crew(cell.crew)}` : ''}${cell.weatherAffected ? `, ${copy.calendar.weatherAffected}` : ''}`;
          const content = (
            <>
              <span className="flex items-start justify-between">
                <span
                  className={cn(
                    'font-mono text-[12px] font-medium',
                    cell.isToday && 'underline underline-offset-2',
                  )}
                >
                  {day}
                </span>
                {cell.weatherAffected ? <CloudRain className="size-4" aria-hidden="true" /> : null}
              </span>
              {cell.crew !== null ? (
                <span className="mt-auto font-mono text-data tabular">{cell.crew}</span>
              ) : cell.chip &&
                cell.chip.variant !== 'filed' &&
                cell.chip.variant !== 'signed_off' ? (
                <span className="mt-auto text-[11px] leading-4">{cell.chip.label}</span>
              ) : null}
            </>
          );
          const base = cn(
            'flex min-h-14 flex-col rounded-chip border p-1.5 text-left',
            tone,
            cell.isToday ? 'border-asphalt' : 'border-transparent',
          );
          return cell.reportId ? (
            <button
              key={cell.date}
              type="button"
              role="gridcell"
              aria-label={copy.calendar.openReport(formatMonthDay(cell.date))}
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
    </div>
  );
}
