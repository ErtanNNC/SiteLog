import { Link } from 'react-router';
import { REQUIRED_FIELD_KEYS, type FilingMode } from '@sitelog/shared/enums.ts';
import { DEFAULT_DAILY_LINK_TIME } from '@sitelog/shared/schedule/remind.ts';
import { Checkbox, RadioGroup, RadioGroupItem } from '@/components/ui/Checkbox';
import { Input } from '@/components/ui/Input';
import { Label } from '@/components/ui/Label';
import { addMinutesToHHMM, hhmm } from '@/data/assemble';
import type { OrgSettings } from '@/data/types';
import { useCopy } from '@/i18n/useCopy';
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

interface ReportsSectionProps extends SectionProps {
  /** Settings links the daily link card to Field channels; the setup wizard does not. */
  channelsLink?: boolean;
}

const WEEKDAYS = [1, 2, 3, 4, 5, 6, 7] as const;

/**
 * Reports & reminders (§F18, P12 on v1.2, W4-05): deadline, working days, the ladder with the
 * daily link (its time is set on Field channels), required fields, filing.
 */
export function ReportsSection({ draft, update, channelsLink = false }: ReportsSectionProps) {
  const { t } = useCopy();
  const deadline = hhmm(draft.default_deadline);
  const dailyLinkTime = hhmm(draft.daily_link_time, DEFAULT_DAILY_LINK_TIME);
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
      <SettingsCard title={t('settings.deadline')} hint={t('settings.deadlineHint')}>
        <div className="grid gap-5 md:grid-cols-[200px_minmax(0,1fr)]">
          <div className="grid gap-1.5">
            <Label htmlFor="set-deadline">{t('settings.deadline')}</Label>
            <Input
              id="set-deadline"
              type="time"
              value={deadline}
              onChange={(e) => update({ default_deadline: `${e.target.value}:00` })}
              className="font-mono"
            />
          </div>
          <fieldset className="grid gap-1.5">
            <legend className="text-caption font-medium">{t('settings.workingDays')}</legend>
            <div className="flex flex-wrap gap-2" data-testid="working-days">
              {WEEKDAYS.map((day) => (
                <ToggleChip
                  key={day}
                  label={t(`settings.weekdays.d${day}`)}
                  pressed={draft.working_days.includes(day)}
                  onPressedChange={(on) => toggleDay(day, on)}
                />
              ))}
            </div>
            <p className="text-caption text-dust">{t('settings.workingDaysHint')}</p>
          </fieldset>
        </div>
      </SettingsCard>

      <SettingsCard
        title={t('settings.ladder')}
        hint={t('settings.offsetHint', { deadline })}
        data-testid="ladder"
      >
        <div className="grid gap-3 md:grid-cols-2">
          {/* §7.4: the daily link at its own time (Field channels), before R1. */}
          <div
            className="rounded-card border border-rebar bg-chalk p-4"
            data-testid="stage-dailyLink"
          >
            <div className="flex min-h-target flex-col justify-center">
              <span className="block text-[15px] font-medium">
                {t('settings.stages.dailyLink')}
              </span>
              <span className="block text-caption text-dust">
                {t('settings.stageHints.dailyLink')}
              </span>
            </div>
            <div className="mt-3 flex flex-wrap items-center gap-x-3 gap-y-1">
              <span className="font-mono text-[13px] text-dust">
                {t('settings.stageTime', { time: dailyLinkTime })}
              </span>
              {channelsLink ? (
                <Link
                  to="/settings/channels"
                  className="inline-flex min-h-target items-center text-[15px] font-medium underline underline-offset-2"
                >
                  {t('settings.dailyLinkChange')}
                </Link>
              ) : null}
            </div>
          </div>
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
                  label={t(`settings.stages.${s.key}`)}
                  hint={t(`settings.stageHints.${s.key}`)}
                  checked={enabled}
                  onCheckedChange={(v) => update({ [s.enabled]: v } as Partial<OrgSettings>)}
                />
                <div className="mt-3 flex items-center gap-3">
                  <Label htmlFor={`offset-${s.key}`} className="sr-only">
                    {t('settings.offset')}
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
                    aria-label={`${t(`settings.stages.${s.key}`)} · ${t('settings.offset')}`}
                  />
                  <span className="font-mono text-[13px] text-dust">
                    {t('settings.offsetMinutes', { offset: offset >= 0 ? `+${offset}` : offset })} ·{' '}
                    {t('settings.stageTime', { time: addMinutesToHHMM(deadline, offset) })}
                  </span>
                </div>
              </div>
            );
          })}
        </div>
      </SettingsCard>

      <SettingsCard title={t('settings.required')} hint={t('settings.requiredHint')}>
        <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3" data-testid="required-fields">
          {REQUIRED_FIELD_KEYS.map((key) => (
            <label
              key={key}
              className="flex min-h-target cursor-pointer items-center gap-3 rounded-chip border border-rebar px-3 text-[15px] hover:bg-concrete/60"
            >
              <Checkbox
                checked={draft.required_fields.includes(key)}
                onCheckedChange={(v) => toggleField(key, v === true)}
                aria-label={t(`settings.requiredFields.${key}`)}
              />
              {t(`settings.requiredFields.${key}`)}
            </label>
          ))}
        </div>
      </SettingsCard>

      <SettingsCard title={t('settings.filing')}>
        <RadioGroup
          value={draft.filing_mode}
          onValueChange={(v) => update({ filing_mode: v as FilingMode })}
          aria-label={t('settings.filing')}
        >
          {(
            [
              ['confirm', t('settings.filingConfirm'), t('settings.filingConfirmHint')],
              ['auto_15min', t('settings.filingAuto'), t('settings.filingAutoHint')],
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
            label={t('settings.signoffRequired')}
            hint={t('settings.signoffRequiredHint')}
            checked={draft.signoff_required}
            onCheckedChange={(v) => update({ signoff_required: v })}
          />
          <SwitchRow
            id="set-email-pdf"
            label={t('settings.emailPdf')}
            hint={t('settings.emailPdfHint')}
            checked={draft.email_pdf_on_file}
            onCheckedChange={(v) => update({ email_pdf_on_file: v })}
          />
        </div>
      </SettingsCard>
    </div>
  );
}
