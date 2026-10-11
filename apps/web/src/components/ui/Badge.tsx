import { cva, type VariantProps } from 'class-variance-authority';
import type { HTMLAttributes } from 'react';
import { cn } from '@/lib/utils';

export const badgeVariants = cva(
  'inline-flex items-center gap-1 whitespace-nowrap rounded-chip border px-2 py-0.5 font-mono text-[11px] font-medium uppercase leading-4 tracking-[0.08em]',
  {
    variants: {
      variant: {
        neutral: 'border-rebar bg-concrete text-dust',
        dark: 'border-steel bg-steel text-chalk',
        signal: 'border-signal bg-signal text-asphalt',
        tint: 'border-signal-tint bg-signal-tint text-chip-await-fg',
        level: 'border-chip-review-bg bg-chip-review-bg text-chip-review-fg',
        filed: 'border-chip-filed-bg bg-chip-filed-bg text-chip-filed-fg',
        missing: 'border-chip-miss-bg bg-chip-miss-bg text-chip-miss-fg',
        outline: 'border-rebar bg-transparent text-asphalt',
        dashed: 'border-dashed border-missing bg-transparent text-missing',
      },
    },
    defaultVariants: { variant: 'neutral' },
  },
);

export interface BadgeProps
  extends HTMLAttributes<HTMLSpanElement>, VariantProps<typeof badgeVariants> {}

export function Badge({ className, variant, ...props }: BadgeProps) {
  return <span className={cn(badgeVariants({ variant }), className)} {...props} />;
}

/** Count bubble for nav items: blue = reports to review, orange = unknown numbers / terms. */
export function CountBadge({
  count,
  tone,
  label,
  className,
}: {
  count: number;
  tone: 'level' | 'signal';
  label: string;
  className?: string;
}) {
  if (count <= 0) return null;
  return (
    <span
      className={cn(
        'inline-flex h-5 min-w-5 items-center justify-center rounded-full px-1.5 font-mono text-[11px] font-semibold leading-none',
        tone === 'level' ? 'bg-level text-white' : 'bg-signal text-asphalt',
        className,
      )}
      aria-label={label}
      title={label}
    >
      {count > 99 ? '99+' : count}
    </span>
  );
}
