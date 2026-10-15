import type { ChipVariant } from '@sitelog/shared/status.ts';
import type { HTMLAttributes } from 'react';
import { useCopy } from '@/i18n/useCopy';
import { cn } from '@/lib/utils';

/**
 * §7.1 / §11.3 status chip: dot + label, status never by colour alone.
 * filed green · awaiting orange · missing red · needs_review blue · weather_day grey ·
 * no_work grey · signed_off green outline · pending grey outline.
 */
const STYLES: Record<ChipVariant, { box: string; dot: string }> = {
  filed: { box: 'bg-chip-filed-bg text-chip-filed-fg border-chip-filed-bg', dot: 'bg-filed' },
  awaiting: { box: 'bg-chip-await-bg text-chip-await-fg border-chip-await-bg', dot: 'bg-signal' },
  missing: { box: 'bg-chip-miss-bg text-chip-miss-fg border-chip-miss-bg', dot: 'bg-missing' },
  needs_review: {
    box: 'bg-chip-review-bg text-chip-review-fg border-chip-review-bg',
    dot: 'bg-level',
  },
  weather_day: { box: 'bg-chip-wx-bg text-chip-wx-fg border-chip-wx-bg', dot: 'bg-iron' },
  no_work: { box: 'bg-chip-wx-bg text-chip-wx-fg border-chip-wx-bg', dot: 'bg-dust-light' },
  signed_off: { box: 'bg-transparent text-chip-filed-fg border-filed', dot: 'bg-filed' },
  pending: { box: 'bg-transparent text-dust border-rebar', dot: 'bg-dust-light' },
};

export interface StatusChipProps extends HTMLAttributes<HTMLSpanElement> {
  variant: ChipVariant;
  label?: string;
  size?: 'sm' | 'md';
}

export function StatusChip({ variant, label, size = 'md', className, ...props }: StatusChipProps) {
  const { t } = useCopy();
  const s = STYLES[variant];
  const text = label ?? t(`chips.${variant}`);
  return (
    <span
      data-variant={variant}
      className={cn(
        'inline-flex shrink-0 items-center gap-1.5 whitespace-nowrap rounded-chip border font-medium',
        size === 'sm' ? 'h-6 px-2 text-[12px]' : 'h-7 px-2.5 text-caption',
        s.box,
        className,
      )}
      aria-label={t('a11y.statusChipLabel', { label: text })}
      {...props}
    >
      <span aria-hidden="true" className={cn('size-2 rounded-full', s.dot)} />
      {text}
    </span>
  );
}

/** Small "Late" / "Late 18:12" badge next to a chip (§7.1). */
export function LateBadge({ time, className }: { time?: string | null; className?: string }) {
  const { t } = useCopy();
  return (
    <span
      className={cn(
        'inline-flex h-6 items-center rounded-chip border border-missing/40 bg-transparent px-1.5 font-mono text-[11px] font-medium uppercase tracking-[0.08em] text-missing',
        className,
      )}
      title={t('a11y.lateBadge')}
    >
      {time ? t('chips.lateAtTime', { time }) : t('chips.late')}
    </span>
  );
}
