import { formatMonthDay } from '@sitelog/shared/format.ts';
import { copy } from '@/copy/en';
import type { StreakCell, StreakStatus } from '@/data/types';
import { cn } from '@/lib/utils';

const CELL: Record<StreakStatus, string> = {
  on_time: 'bg-filed',
  late: 'bg-signal',
  weather_day: 'bg-iron',
  missing: 'bg-missing',
  pending: 'bg-rebar',
};

/** 14 cells, one per workday; aria-label summarises ("13 of 14 on time"). */
export function StreakBar({ cells, className }: { cells: StreakCell[]; className?: string }) {
  const onTime = cells.filter((c) => c.status === 'on_time').length;
  return (
    <div
      className={cn('flex h-3 w-full gap-[3px]', className)}
      role="img"
      aria-label={copy.streak.summary(onTime, cells.length)}
      data-testid="streak-bar"
    >
      {cells.map((c) => (
        <span
          key={c.date}
          data-status={c.status}
          className={cn('h-full flex-1 rounded-[2px]', CELL[c.status])}
          title={copy.streak.cellLabel(formatMonthDay(c.date), copy.streak.legend[c.status])}
        />
      ))}
    </div>
  );
}

export function StreakLegend({ className }: { className?: string }) {
  const items: StreakStatus[] = ['on_time', 'late', 'weather_day', 'missing'];
  return (
    <ul
      className={cn('flex flex-wrap items-center gap-x-4 gap-y-1 text-[12px] text-dust', className)}
      aria-label={copy.sites.legend}
    >
      {items.map((s) => (
        <li key={s} className="inline-flex items-center gap-1.5">
          <span aria-hidden="true" className={cn('size-2.5 rounded-[2px]', CELL[s])} />
          {copy.streak.legend[s]}
        </li>
      ))}
    </ul>
  );
}
