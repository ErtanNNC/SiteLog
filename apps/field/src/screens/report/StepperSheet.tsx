import { useId, useState, type FormEvent } from 'react';
import { formatHoursIn } from '@sitelog/shared/format.ts';
import type { ManpowerEntry } from '@sitelog/shared/schemas/report.ts';
import { QuietButton, SolidButton } from '@/components/Buttons';
import { Sheet } from '@/components/Sheet';
import { useFieldCopy } from '@/i18n/useFieldCopy';
import { parseTypedNumber } from './lines';

/** What the stepper saves: the crew line's workers and hours per worker (null = not stated). */
export interface CrewNumbers {
  workers: number | null;
  hoursPerWorker: number | null;
}

/**
 * F8's stepper (W2-10, Field-06 "tap a number for a stepper"): one crew line's workers (±1) and
 * hours per worker (±0.5), tapped or typed. The total shown is the product of the two, as code
 * computes it again on the server (`applyCrewEdit`); the saved line cites `reporter_edit` (§19
 * Q80). Steps and inputs are 56 px.
 */
export function StepperSheet({
  entry,
  saving,
  error,
  onSave,
  onClose,
}: {
  /** The crew line being changed; null closes the sheet. */
  entry: Pick<ManpowerEntry, 'companyName' | 'workers' | 'hoursPerWorker'> | null;
  saving: boolean;
  error: string | null;
  onSave: (numbers: CrewNumbers) => void;
  onClose: () => void;
}) {
  const titleId = useId();
  return (
    <Sheet open={entry !== null} titleId={titleId} onClose={onClose}>
      {entry ? (
        <StepperBody
          titleId={titleId}
          entry={entry}
          saving={saving}
          error={error}
          onSave={onSave}
          onClose={onClose}
        />
      ) : null}
    </Sheet>
  );
}

const text = (n: number | null) => (n === null ? '' : String(n));

function StepperBody({
  titleId,
  entry,
  saving,
  error,
  onSave,
  onClose,
}: {
  titleId: string;
  entry: Pick<ManpowerEntry, 'companyName' | 'workers' | 'hoursPerWorker'>;
  saving: boolean;
  error: string | null;
  onSave: (numbers: CrewNumbers) => void;
  onClose: () => void;
}) {
  const { t, language } = useFieldCopy();
  const ids = useId();
  const [workers, setWorkers] = useState(text(entry.workers));
  const [hours, setHours] = useState(text(entry.hoursPerWorker));
  const [invalid, setInvalid] = useState(false);

  const parsedWorkers = workers.trim()
    ? parseTypedNumber(workers, { integer: true, max: 9999 })
    : null;
  const parsedHours = hours.trim() ? parseTypedNumber(hours, { integer: false, max: 24 }) : null;
  const total =
    parsedWorkers !== null && parsedHours !== null
      ? Math.round(parsedWorkers * parsedHours * 100) / 100
      : null;

  const step = (value: string, by: number, opts: { min: number; max: number }) => {
    const current = Number(value.replace(',', '.'));
    const base = value.trim() && Number.isFinite(current) ? current : 0;
    return String(Math.min(opts.max, Math.max(opts.min, Math.round((base + by) * 2) / 2)));
  };

  function submit(e: FormEvent) {
    e.preventDefault();
    const w = workers.trim() ? parseTypedNumber(workers, { integer: true, max: 9999 }) : null;
    const h = hours.trim() ? parseTypedNumber(hours, { integer: false, max: 24 }) : null;
    if ((workers.trim() && w === null) || (hours.trim() && h === null)) {
      setInvalid(true);
      return;
    }
    setInvalid(false);
    onSave({ workers: w, hoursPerWorker: h });
  }

  const inputClasses =
    'h-target w-0 min-w-0 flex-1 rounded-card border border-rebar bg-chalk px-3 text-center font-mono text-[20px] text-asphalt aria-[invalid=true]:border-missing';
  const stepClasses =
    'flex size-target flex-none items-center justify-center rounded-card border border-rebar bg-white font-mono text-[24px] font-bold text-asphalt disabled:opacity-60';

  function row(
    label: string,
    value: string,
    set: (v: string) => void,
    by: number,
    max: number,
    less: string,
    more: string,
    mode: 'numeric' | 'decimal',
  ) {
    const id = `${ids}-${mode}`;
    return (
      <div className="flex flex-col gap-1.5">
        <label htmlFor={id} className="text-[16px] leading-6 font-semibold">
          {label}
        </label>
        <div className="flex items-center gap-2.5">
          <button
            type="button"
            aria-label={less}
            aria-controls={id}
            disabled={saving}
            onClick={() => set(step(value, -by, { min: 0, max }))}
            className={stepClasses}
          >
            <span aria-hidden="true">−</span>
          </button>
          <input
            id={id}
            type="text"
            inputMode={mode}
            autoComplete="off"
            value={value}
            onChange={(e) => set(e.target.value)}
            aria-invalid={invalid}
            aria-describedby={invalid ? `${ids}-error` : undefined}
            className={inputClasses}
          />
          <button
            type="button"
            aria-label={more}
            aria-controls={id}
            disabled={saving}
            onClick={() => set(step(value, by, { min: 0, max }))}
            className={stepClasses}
          >
            <span aria-hidden="true">+</span>
          </button>
        </div>
      </div>
    );
  }

  return (
    <form noValidate onSubmit={submit} className="flex flex-col gap-4">
      <div className="flex flex-col gap-1">
        <h2
          id={titleId}
          className="m-0 text-[22px] leading-7 font-extrabold [overflow-wrap:anywhere] [font-stretch:118%]"
        >
          {entry.companyName}
        </h2>
        <p className="m-0 text-[15px] leading-[21px] text-steel">{t('draft.stepper.hint')}</p>
      </div>
      {row(
        t('draft.stepper.workers'),
        workers,
        setWorkers,
        1,
        9999,
        t('draft.stepper.fewerWorkers'),
        t('draft.stepper.moreWorkers'),
        'numeric',
      )}
      {row(
        t('draft.stepper.hours'),
        hours,
        setHours,
        0.5,
        24,
        t('draft.stepper.fewerHours'),
        t('draft.stepper.moreHours'),
        'decimal',
      )}
      <p role="status" className="m-0 font-mono text-[16px] leading-6 font-medium">
        {t('draft.stepper.total', {
          total: total === null ? '—' : formatHoursIn(total, language),
        })}
      </p>
      {invalid ? (
        <p id={`${ids}-error`} className="m-0 text-[15px] leading-5 text-missing">
          {t('draft.stepper.invalid')}
        </p>
      ) : null}
      {error ? (
        <p role="alert" className="m-0 text-[15px] leading-5 text-missing">
          {error}
        </p>
      ) : null}
      <SolidButton type="submit" disabled={saving}>
        {saving ? t('draft.stepper.saving') : t('draft.stepper.save')}
      </SolidButton>
      <QuietButton disabled={saving} onClick={onClose}>
        {t('draft.stepper.cancel')}
      </QuietButton>
    </form>
  );
}
