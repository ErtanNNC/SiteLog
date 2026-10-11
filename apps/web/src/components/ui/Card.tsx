import { forwardRef, type HTMLAttributes } from 'react';
import { cn } from '@/lib/utils';

/** §14.3: cards are Chalk with a 1 px Rebar border, radius 8. Borders over shadows. */
export const Card = forwardRef<
  HTMLDivElement,
  HTMLAttributes<HTMLDivElement> & { dark?: boolean; tone?: 'default' | 'attention' | 'dashed' }
>(({ className, dark, tone = 'default', ...props }, ref) => (
  <div
    ref={ref}
    className={cn(
      'rounded-card border',
      dark ? 'on-dark border-steel bg-asphalt text-chalk' : 'border-rebar bg-chalk text-asphalt',
      tone === 'attention' && 'border-missing/60 bg-chip-miss-bg/30',
      tone === 'dashed' && 'border-dashed bg-transparent',
      className,
    )}
    {...props}
  />
));
Card.displayName = 'Card';

export function CardHeader({ className, ...props }: HTMLAttributes<HTMLDivElement>) {
  return (
    <div className={cn('flex items-start justify-between gap-4 px-5 pt-5', className)} {...props} />
  );
}

export function CardTitle({ className, ...props }: HTMLAttributes<HTMLHeadingElement>) {
  return <h2 className={cn('font-h2 text-h2', className)} {...props} />;
}

export function CardContent({ className, ...props }: HTMLAttributes<HTMLDivElement>) {
  return <div className={cn('px-5 py-5', className)} {...props} />;
}

export function CardFooter({ className, ...props }: HTMLAttributes<HTMLDivElement>) {
  return (
    <div
      className={cn('flex items-center gap-3 border-t border-rebar px-5 py-3', className)}
      {...props}
    />
  );
}
