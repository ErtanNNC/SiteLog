import { REQUIRED_FIELD_KEYS, type FilingMode } from '@sitelog/shared/enums.ts';
import { Checkbox, RadioGroup, RadioGroupItem } from '@/components/ui/Checkbox';
import { Input } from '@/components/ui/Input';
import { Label } from '@/components/ui/Label';
import { copy } from '@/copy/en';
import { addMinutesToHHMM, hhmm } from '@/data/assemble';
import type { OrgSettings } from '@/data/types';
import { cn } from '@/lib/utils';
import { SettingsCard, SwitchRow, ToggleChip } from './fields';

type Stage = 'headsUp' | 'reminder1' | 'reminder2' | 'missing';
const STAGES: Array<{
  key: Stage;
  enabled: keyof OrgSettings;
  offset: keyof OrgSettings;
}> = [
  { key: 'headsUp', enabled: 'heads_up_enabled', offset: 'heads_up_offset_min' },
  { key: 'reminder1', enabled: 'reminder1_enabled', offset: 'reminder1_offset_min' },
  { key: 'reminder2', enabled: 'reminder2_enabled', offset: 'reminder2_offset_min' },
  { key: 'missing', enabled: 'missing_enabled', offset: 'missing_offset_min' },
];

export interface SectionProps {
  draft: OrgSettings;
  update: (patch: Partial<OrgSettings>) => void;
}

/** Reports & reminders: deadline, working days, ladder, required fields, filing (§F18). */
export function ReportsSection({ draft, update }: SectionProps) {
  const c = copy.settings;
  const deadline = hhmm(draft.default_deadline);
  const toggleDay = (day: number, on: boolean) => {
    const set = new Set(draft.working_days);
    if (on) set.add(day);
    else set.delete(day);
    update({ working_days: [...set].sort((a, b) => a - b) });
  };
  const toggleField = (key: string, on: boolean) => {
    const list = draft.required_fields.filter((k) => k !== key);
    update({ required_fields: on ? [...list, key] : list });
  };

  return (
    <div className="grid gap-6">
      <SettingsCard title={c.deadline} hint={c.deadlineHint}>
        <div className="grid gap-5 md:grid-cols-[200px_minmax(0,1fr)]">
          <div className="grid gap-1.5">
            <Label htmlFor="set-deadline">{c.deadline}</Label>
            <Input
              id="set-deadline"
              type="time"
              value={deadline}
              onChange={(e) => update({ default_deadline: `${e.target.value}:00` })}
              className="font-mono"
            />
          </div>
          <fieldset className="grid gap-1.5">
            <legend className="text-caption font-medium">{c.workingDays}</legend>
            <div className="flex flex-wrap gap-2" data-testid="working-days">
              {c.workingDayNames.map((name, i) => (
                <ToggleChip
                  key={name}
                  label={name}
                  pressed={draft.working_days.includes(i + 1)}
                  onPressedChange={(on) => toggleDay(i + 1, on)}
                />
              ))}
            </div>
            <p className="text-caption text-dust">{c.workingDaysHint}</p>
          </fieldset>
        </div>
      </SettingsCard>

      <SettingsCard title={c.ladder} hint={c.offsetHint(deadline)} data-testid="ladder">
        <div className="grid gap-3 md:grid-cols-2">
          {STAGES.map((s) => {
            const enabled = draft[s.enabled] as boolean;
            const offset = draft[s.offset] as number;
            return (
              <div
                key={s.key}
                className={cn(
                  'rounded-card border p-4',
                  enabled ? 'border-rebar bg-chalk' : 'border-dashed border-rebar bg-concrete/50',
                )}
                data-testid={`stage-${s.key}`}
              >
                <SwitchRow
                  id={`stage-${s.key}`}
                  label={c.stages[s.key]}
                  hint={c.stageHints[s.key]}
                  checked={enabled}
                  onCheckedChange={(v) => update({ [s.enabled]: v } as Partial<OrgSettings>)}
                />
                <div className="mt-3 flex items-center gap-3">
                  <Label htmlFor={`offset-${s.key}`} className="sr-only">
                    {c.offset}
                  </Label>
                  <Input
                    id={`offset-${s.key}`}
                    type="number"
                    step={5}
                    value={offset}
                    disabled={!enabled}
                    onChange={(e) =>
                      update({ [s.offset]: Number(e.target.value) } as Partial<OrgSettings>)
                    }
                    className="w-24 font-mono tabular"
                    aria-label={`${c.stages[s.key]} · ${c.offset}`}
                  />
                  <span className="font-mono text-[13px] text-dust">
                    {offset >= 0 ? `+${offset}` : offset} min ·{' '}
                    {c.stageTime(addMinutesToHHMM(deadline, offset))}
                  </span>
                </div>
              </div>
            );
          })}
        </div>
      </SettingsCard>

      <SettingsCard title={c.required} hint={c.requiredHint}>
        <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3" data-testid="required-fields">
          {REQUIRED_FIELD_KEYS.map((key) => (
            <label
              key={key}
              className="flex min-h-target cursor-pointer items-center gap-3 rounded-chip border border-rebar px-3 text-[15px] hover:bg-concrete/60"
            >
              <Checkbox
                checked={draft.required_fields.includes(key)}
                onCheckedChange={(v) => toggleField(key, v === true)}
                aria-label={c.requiredFields[key]}
              />
              {c.requiredFields[key]}
            </label>
          ))}
        </div>
      </SettingsCard>

      <SettingsCard title={c.filing}>
        <RadioGroup
          value={draft.filing_mode}
          onValueChange={(v) => update({ filing_mode: v as FilingMode })}
          aria-label={c.filing}
        >
          {(
            [
              ['confirm', c.filingConfirm, c.filingConfirmHint],
              ['auto_15min', c.filingAuto, c.filingAutoHint],
            ] as const
          ).map(([value, label, hint]) => (
            <label key={value} className="flex min-h-target cursor-pointer items-start gap-3">
              <RadioGroupItem value={value} className="mt-0.5" aria-label={label} />
              <span>
                <span className="block text-[15px] font-medium">{label}</span>
                <span className="block text-caption text-dust">{hint}</span>
              </span>
            </label>
          ))}
        </RadioGroup>
        <div className="mt-5 grid gap-2 border-t border-rebar pt-4">
          <SwitchRow
            id="set-signoff"
            label={c.signoffRequired}
            hint={c.signoffRequiredHint}
            checked={draft.signoff_required}
            onCheckedChange={(v) => update({ signoff_required: v })}
          />
          <SwitchRow
            id="set-email-pdf"
            label={c.emailPdf}
            hint={c.emailPdfHint}
            checked={draft.email_pdf_on_file}
            onCheckedChange={(v) => update({ email_pdf_on_file: v })}
          />
        </div>
      </SettingsCard>
    </div>
  );
}
