import { formatHours, formatMonthDay } from '@sitelog/shared/format.ts';
import { copy } from '@/copy/en';
import type { HeatmapCell, SiteOption } from '@/data/types';
import { useScrollRegion } from '@/lib/useScrollRegion';
import { cn } from '@/lib/utils';

const RAMP = [
  'bg-heat-0',
  'bg-heat-1',
  'bg-heat-2',
  'bg-heat-3',
  'bg-heat-4',
  'bg-heat-5',
  'bg-heat-6',
];

/** 0 → step 0; otherwise 1..6 scaled by hours lost (8 h = darkest). White text only on step 6. */
export function heatStep(hours: number, max = 8): number {
  if (hours <= 0) return 0;
  return Math.max(1, Math.min(6, Math.ceil((hours / Math.max(max, 1)) * 6)));
}

export interface HeatmapGridProps {
  sites: SiteOption[];
  days: string[];
  cells: HeatmapCell[];
  maxHours?: number;
  title?: string;
  className?: string;
}

/** Site × workday grid; orange ramp by hours lost; cell text shows the hours. */
export function HeatmapGrid({ sites, days, cells, maxHours, title, className }: HeatmapGridProps) {
  const lookup = new Map(cells.map((c) => [`${c.siteId}:${c.date}`, c.hours]));
  const max = Math.max(8, maxHours ?? 0);
  const scrollRegion = useScrollRegion(title);
  return (
    <div {...scrollRegion} className={cn('overflow-x-auto scrollbar-thin', className)}>
      <table className="w-full border-separate border-spacing-1 text-caption" aria-label={title}>
        <thead>
          <tr>
            <th scope="col" className="eyebrow sticky left-0 bg-chalk pr-2 text-left text-dust">
              {copy.hours.siteSelect}
            </th>
            {days.map((d) => (
              <th key={d} scope="col" className="eyebrow min-w-12 text-center text-dust">
                {formatMonthDay(d).replace(/^\w+ /, '')}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {sites.map((s) => (
            <tr key={s.id}>
              <th
                scope="row"
                className="sticky left-0 whitespace-nowrap bg-chalk pr-3 text-left font-medium text-asphalt"
              >
                {s.shortName}
              </th>
              {days.map((d) => {
                const h = lookup.get(`${s.id}:${d}`) ?? 0;
                const step = heatStep(h, max);
                return (
                  <td
                    key={d}
                    className={cn(
                      'h-10 min-w-12 rounded-chip text-center font-mono text-[12px] tabular',
                      RAMP[step],
                      step === 6 ? 'text-white' : h > 0 ? 'text-asphalt' : 'text-dust-light',
                    )}
                    title={copy.weather.heatmapCell(s.name, formatMonthDay(d), formatHours(h))}
                    aria-label={copy.weather.heatmapCell(s.name, formatMonthDay(d), formatHours(h))}
                  >
                    {h > 0 ? h : ''}
                  </td>
                );
              })}
            </tr>
          ))}
        </tbody>
      </table>
      <div
        className="mt-2 flex items-center gap-1 text-[12px] text-dust"
        aria-label={copy.a11y.heatmapLegend}
      >
        <span>0 h</span>
        {RAMP.map((c, i) => (
          <span
            key={c}
            aria-hidden="true"
            className={cn('h-3 w-5 rounded-[2px]', c, i === 0 && 'border border-rebar')}
          />
        ))}
        <span>{formatHours(max)}</span>
      </div>
    </div>
  );
}
