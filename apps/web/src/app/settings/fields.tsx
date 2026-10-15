import type { ReactNode } from 'react';
import { Switch } from '@/components/ui/Checkbox';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/Card';
import { cn } from '@/lib/utils';

/** Settings section card: title, optional hint, body. */
export function SettingsCard({
  title,
  hint,
  children,
  className,
  'data-testid': testId,
}: {
  title: string;
  hint?: string;
  children: ReactNode;
  className?: string;
  'data-testid'?: string;
}) {
  return (
    <Card className={className} data-testid={testId}>
      <CardHeader className="flex-col gap-0.5">
        <CardTitle>{title}</CardTitle>
        {hint ? <p className="text-caption text-dust">{hint}</p> : null}
      </CardHeader>
      <CardContent className="pt-4">{children}</CardContent>
    </Card>
  );
}

/** Label + hint + switch on one row (44 px target). */
export function SwitchRow({
  id,
  label,
  hint,
  checked,
  onCheckedChange,
  className,
}: {
  id: string;
  label: string;
  hint?: string;
  checked: boolean;
  onCheckedChange: (v: boolean) => void;
  className?: string;
}) {
  return (
    <div className={cn('flex min-h-target items-center justify-between gap-4', className)}>
      <label htmlFor={id} className="cursor-pointer">
        <span className="block text-[15px] font-medium">{label}</span>
        {hint ? <span className="block text-caption text-dust">{hint}</span> : null}
      </label>
      <Switch id={id} checked={checked} onCheckedChange={onCheckedChange} aria-label={label} />
    </div>
  );
}

/** Toggle chip used for working days (status conveyed by text + border, not colour alone). */
export function ToggleChip({
  label,
  pressed,
  onPressedChange,
  ariaLabel,
}: {
  label: string;
  pressed: boolean;
  onPressedChange: (v: boolean) => void;
  ariaLabel?: string;
}) {
  return (
    <button
      type="button"
      aria-pressed={pressed}
      aria-label={ariaLabel}
      onClick={() => onPressedChange(!pressed)}
      className={cn(
        'h-target min-w-12 rounded-chip border px-3 font-mono text-[13px] font-medium uppercase tracking-[0.08em]',
        pressed
          ? 'border-asphalt bg-asphalt text-chalk'
          : 'border-rebar bg-chalk text-dust hover:bg-concrete',
      )}
    >
      {label}
    </button>
  );
}
