import type { ReactNode } from 'react';
import { Link } from 'react-router';
import { copy } from '@/copy/en';
import { cn } from '@/lib/utils';

export interface KpiSegment {
  key: string;
  label: string;
  value: number;
  tone: 'filed' | 'weather' | 'missing' | 'awaiting';
}

export interface KpiTileProps {
  label: string;
  value: ReactNode;
  unit?: string;
  hint?: ReactNode;
  segments?: KpiSegment[];
  dark?: boolean;
  link?: { to: string; label: string };
  className?: string;
}

const SEGMENT_BG: Record<KpiSegment['tone'], string> = {
  filed: 'bg-filed',
  weather: 'bg-iron',
  missing: 'bg-missing',
  awaiting: 'bg-signal',
};

/** §11.3 KPI tile: label, big number (Archivo Expanded 800), unit, optional segmented bar; dark variant. */
export function KpiTile({
  label,
  value,
  unit,
  hint,
  segments,
  dark,
  link,
  className,
}: KpiTileProps) {
  const total = segments?.reduce((a, s) => a + s.value, 0) ?? 0;
  const visible = segments?.filter((s) => s.value > 0) ?? [];
  return (
    <div
      className={cn(
        'flex min-h-[132px] flex-col justify-between rounded-card border p-5',
        dark ? 'on-dark border-steel bg-asphalt text-chalk' : 'border-rebar bg-chalk text-asphalt',
        className,
      )}
    >
      <div className={cn('eyebrow', dark ? 'text-dust-light' : 'text-dust')}>{label}</div>
      <div className="mt-2 flex items-baseline gap-2">
        <div className="font-display text-[40px] leading-[44px] tabular">{value}</div>
        {unit ? (
          <div className={cn('font-mono text-data', dark ? 'text-dust-light' : 'text-dust')}>
            {unit}
          </div>
        ) : null}
      </div>
      {segments && total > 0 ? (
        <div className="mt-3">
          <div
            className="flex h-2 w-full gap-0.5 overflow-hidden rounded-chip"
            role="img"
            aria-label={copy.a11y.kpiBar(segments.map((s) => `${s.label} ${s.value}`).join(', '))}
          >
            {visible.map((s) => (
              <span
                key={s.key}
                className={cn('h-full', SEGMENT_BG[s.tone])}
                style={{ width: `${(s.value / total) * 100}%` }}
              />
            ))}
          </div>
          <div className="mt-2 flex flex-wrap gap-x-3 gap-y-1 text-[12px] text-dust">
            {visible.map((s) => (
              <span key={s.key} className="inline-flex items-center gap-1">
                <span
                  aria-hidden="true"
                  className={cn('size-2 rounded-full', SEGMENT_BG[s.tone])}
                />
                {s.label} <span className="font-mono">{s.value}</span>
              </span>
            ))}
          </div>
        </div>
      ) : hint ? (
        <div className={cn('mt-3 text-caption', dark ? 'text-dust-light' : 'text-dust')}>
          {hint}
        </div>
      ) : link ? (
        <Link
          to={link.to}
          className={cn(
            'mt-3 inline-flex text-caption font-medium underline-offset-4 hover:underline',
            dark ? 'text-signal' : 'text-level',
          )}
        >
          {link.label} →
        </Link>
      ) : null}
    </div>
  );
}
