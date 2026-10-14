import { Check, Mail, Plus, X } from 'lucide-react';
import { useState, type ReactNode } from 'react';
import { Button } from '@/components/ui/Button';
import { Input } from '@/components/ui/Input';
import { Label } from '@/components/ui/Label';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/Select';
import { copy } from '@/copy/en';
import { cn } from '@/lib/utils';
import { SETUP_STEPS, type SetupStep } from './state';
import { timezoneLabel, timezoneOptions } from './timezones';

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/** 3-step stepper: done = green check, current = dark card with orange number, upcoming = outlined. */
export function Stepper({
  current,
  done,
}: {
  current: SetupStep;
  done: Partial<Record<SetupStep, boolean>>;
}) {
  return (
    <ol className="grid gap-3 md:grid-cols-3" aria-label={copy.setup.title}>
      {SETUP_STEPS.map((step, i) => {
        const isDone = !!done[step] && step !== current;
        const isCurrent = step === current;
        const state = isDone ? 'done' : isCurrent ? 'current' : 'upcoming';
        return (
          <li
            key={step}
            aria-current={isCurrent ? 'step' : undefined}
            data-state={state}
            className={cn(
              'flex min-h-[64px] items-center gap-3 rounded-card border px-4 py-3',
              isCurrent && 'on-dark border-asphalt bg-asphalt text-chalk',
              isDone && 'border-filed/40 bg-chalk text-asphalt',
              !isCurrent && !isDone && 'border-rebar bg-transparent text-dust',
            )}
          >
            <span
              aria-hidden="true"
              className={cn(
                'flex size-8 shrink-0 items-center justify-center rounded-full font-mono text-[13px] font-semibold',
                isCurrent && 'bg-signal text-asphalt',
                isDone && 'bg-chip-filed-bg text-chip-filed-fg',
                !isCurrent && !isDone && 'border border-rebar text-dust',
              )}
            >
              {isDone ? <Check className="size-4 stroke-[3]" /> : i + 1}
            </span>
            <span className="min-w-0">
              <span className={cn('eyebrow block', isCurrent ? 'text-dust-light' : 'text-dust')}>
                {copy.setup.stepOf(i + 1, SETUP_STEPS.length)}
              </span>
              <span className="block truncate text-[15px] font-semibold">
                {copy.setup.steps[step]}
              </span>
              <span className="sr-only">{copy.setup.stepState[state]}</span>
            </span>
          </li>
        );
      })}
    </ol>
  );
}

export function Field({
  id,
  label,
  hint,
  error,
  optional,
  children,
  className,
}: {
  id: string;
  label: string;
  hint?: ReactNode;
  error?: string | null;
  optional?: boolean;
  children: ReactNode;
  className?: string;
}) {
  return (
    // content-start: side by side with a taller field (one with a hint), the control stays level.
    <div className={cn('grid content-start gap-1.5', className)}>
      <Label htmlFor={id}>
        {label}
        {optional ? (
          <span className="ml-1 font-normal text-dust">· {copy.common.optional}</span>
        ) : null}
      </Label>
      {children}
      {hint ? (
        <p id={`${id}-hint`} className="text-caption text-dust">
          {hint}
        </p>
      ) : null}
      {error ? (
        <p role="alert" className="text-caption font-medium text-missing">
          {error}
        </p>
      ) : null}
    </div>
  );
}

export function TimezoneSelect({
  id,
  value,
  onChange,
}: {
  id: string;
  value: string;
  onChange: (tz: string) => void;
}) {
  return (
    // Radix's hidden native select reports "" when the value's option is not mounted yet (a zone
    // outside TIMEZONES, set by choosing a country): that is no choice, so it is ignored.
    <Select value={value} onValueChange={(tz) => tz && onChange(tz)}>
      <SelectTrigger id={id} className="font-mono text-[13px]">
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        {timezoneOptions(value).map((tz) => (
          <SelectItem key={tz} value={tz} textValue={tz}>
            <span className="font-mono text-[13px]">{timezoneLabel(tz)}</span>
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}

/** Email chips with an add box (used for recipients in step 3). */
export function EmailChips({
  id,
  emails,
  onChange,
  label,
}: {
  id: string;
  emails: string[];
  onChange: (next: string[]) => void;
  label: string;
}) {
  const c = copy.settings.recipients;
  const [value, setValue] = useState('');
  const [error, setError] = useState<string | null>(null);
  const add = () => {
    const e = value.trim().toLowerCase();
    if (!e) return;
    if (!EMAIL.test(e)) {
      setError(c.invalid);
      return;
    }
    setError(null);
    setValue('');
    if (!emails.includes(e)) onChange([...emails, e]);
  };
  return (
    <div className="grid gap-2">
      <ul className="flex flex-wrap gap-2" aria-label={label}>
        {emails.length === 0 ? (
          <li className="text-caption text-dust">{c.none}</li>
        ) : (
          emails.map((e) => (
            <li
              key={e}
              className="inline-flex h-9 items-center gap-1 rounded-chip border border-rebar bg-concrete/60 pl-2.5 pr-1 font-mono text-[12px]"
            >
              <Mail className="size-3.5 text-dust" aria-hidden="true" />
              {e}
              <button
                type="button"
                className="ml-1 flex size-7 items-center justify-center rounded-chip text-dust hover:bg-rebar hover:text-asphalt"
                aria-label={c.remove(e)}
                onClick={() => onChange(emails.filter((x) => x !== e))}
              >
                <X className="size-4" aria-hidden="true" />
              </button>
            </li>
          ))
        )}
      </ul>
      <div className="flex gap-2">
        <Label htmlFor={id} className="sr-only">
          {c.add}
        </Label>
        <Input
          id={id}
          type="email"
          value={value}
          onChange={(e) => setValue(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              e.preventDefault();
              add();
            }
          }}
          placeholder={c.placeholder}
          aria-invalid={!!error}
        />
        <Button variant="ghost" onClick={add} aria-label={c.add}>
          <Plus aria-hidden="true" />
          {c.add}
        </Button>
      </div>
      {error ? (
        <p role="alert" className="text-caption font-medium text-missing">
          {error}
        </p>
      ) : null}
    </div>
  );
}
