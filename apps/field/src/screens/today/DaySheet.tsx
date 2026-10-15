import { useId, useState } from 'react';
import type { DayStatusRequest } from '@sitelog/shared/field-api.ts';
import { QuietButton, SolidButton } from '@/components/Buttons';
import { Sheet } from '@/components/Sheet';
import { useFieldCopy } from '@/i18n/useFieldCopy';
import type { CopyError } from '@/lib/errors';

export type DayKind = 'no_work' | 'weather_day';

/** F12's time chips for "Since when?" and "Never started". */
const SINCE = ['07:00', '09:00', '11:00'] as const;

/**
 * The confirm sheet behind *No work today* and *Site closed: weather* (F12): what the office will
 * see for the site; for weather, since when and how many were on site before. What it writes is
 * the site-day status only (`day-status`, W1-07; spec §19 Q41).
 */
export function DaySheet({
  kind,
  siteName,
  busy,
  error,
  onConfirm,
  onClose,
}: {
  kind: DayKind | null;
  siteName: string;
  busy: boolean;
  error: CopyError | null;
  onConfirm: (details: NonNullable<DayStatusRequest['details']>) => void;
  onClose: () => void;
}) {
  const { t } = useFieldCopy();
  const titleId = useId();
  const workersId = useId();
  const sinceId = useId();
  const [since, setSince] = useState<string | null>(null);
  const [workers, setWorkers] = useState('');
  const weather = kind === 'weather_day';

  function confirm() {
    const details: NonNullable<DayStatusRequest['details']> = {};
    if (weather) {
      if (since === 'never_started') details.since = 'never_started';
      else if (since) details.since = since;
      const n = Number.parseInt(workers, 10);
      if (Number.isInteger(n) && n >= 0) details.workersBefore = Math.min(n, 9999);
    }
    onConfirm(details);
  }

  return (
    <Sheet open={kind !== null} titleId={titleId} onClose={onClose}>
      <h2 id={titleId} className="m-0 text-[22px] leading-7 font-extrabold [font-stretch:118%]">
        {t(weather ? 'today.daySheet.weatherTitle' : 'today.daySheet.noWorkTitle')}
      </h2>
      <p className="m-0 text-[16px] leading-6 text-steel">
        {t(weather ? 'today.daySheet.weatherBody' : 'today.daySheet.noWorkBody', {
          site: siteName,
        })}
      </p>
      {weather ? (
        <>
          <div role="radiogroup" aria-labelledby={sinceId} className="flex flex-col gap-2">
            <span id={sinceId} className="text-[15px] font-semibold">
              {t('today.daySheet.since')}
            </span>
            <div className="grid grid-cols-2 gap-2">
              {[...SINCE, 'never_started'].map((value) => {
                const on = since === value;
                return (
                  <button
                    key={value}
                    type="button"
                    role="radio"
                    aria-checked={on}
                    onClick={() => setSince(value)}
                    className={`h-target rounded-btn font-mono text-[16px] font-medium ${
                      on
                        ? 'border-0 bg-asphalt text-chalk'
                        : 'border border-rebar bg-white text-asphalt'
                    }`}
                  >
                    {value === 'never_started' ? t('today.daySheet.never') : value}
                  </button>
                );
              })}
            </div>
          </div>
          <label htmlFor={workersId} className="text-[15px] font-semibold">
            {t('today.daySheet.workersBefore')}
          </label>
          <input
            id={workersId}
            type="text"
            inputMode="numeric"
            pattern="[0-9]*"
            value={workers}
            onChange={(e) => setWorkers(e.target.value.replace(/\D/g, '').slice(0, 4))}
            className="h-target w-full rounded-card border border-rebar bg-white px-4 font-mono text-[20px] text-asphalt"
          />
        </>
      ) : null}
      {error ? (
        <p role="alert" className="m-0 text-[15px] leading-5 text-missing">
          {t(`today.daySheet.errors.${error.key}` as never, error.vars)}
        </p>
      ) : null}
      <div className="flex gap-3">
        <QuietButton onClick={onClose} disabled={busy} className="flex-1">
          {t('today.daySheet.cancel')}
        </QuietButton>
        <SolidButton onClick={confirm} disabled={busy} className="flex-1">
          {busy ? t('today.daySheet.saving') : t('today.daySheet.confirm')}
        </SolidButton>
      </div>
    </Sheet>
  );
}
