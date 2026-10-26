import type { ContactPref } from '@sitelog/shared/enums.ts';
import { RadioGroup, RadioGroupItem } from '@/components/ui/Checkbox';
import { useCopy } from '@/i18n/useCopy';
import { cn } from '@/lib/utils';

const PREFS: readonly ContactPref[] = ['link', 'call'];

/**
 * The preferred channel (§2.3 `contact_pref`): Text link or Call, as two 44 px radio options
 * side by side, with a hint under them (Invite, Edit).
 */
export function PreferenceField({
  idPrefix,
  legend,
  value,
  onChange,
  hint,
}: {
  idPrefix: string;
  legend: string;
  value: ContactPref;
  onChange: (next: ContactPref) => void;
  hint?: string;
}) {
  const { t } = useCopy();
  const hintId = `${idPrefix}-pref-hint`;
  return (
    <fieldset className="grid gap-2" aria-describedby={hint ? hintId : undefined}>
      <legend className="text-caption font-medium">{legend}</legend>
      <RadioGroup
        value={value}
        onValueChange={(v) => onChange(v as ContactPref)}
        className="grid grid-cols-2 gap-2"
        aria-label={legend}
      >
        {PREFS.map((p) => (
          <label
            key={p}
            htmlFor={`${idPrefix}-pref-${p}`}
            className={cn(
              'flex min-h-target cursor-pointer items-center gap-3 rounded-card border px-3 text-[15px] font-medium',
              value === p ? 'border-asphalt' : 'border-rebar',
            )}
          >
            <RadioGroupItem id={`${idPrefix}-pref-${p}`} value={p} />
            {t(`team.prefers.${p}`)}
          </label>
        ))}
      </RadioGroup>
      {hint ? (
        <p id={hintId} className="text-caption text-dust">
          {hint}
        </p>
      ) : null}
    </fieldset>
  );
}
