import { firstName } from '@sitelog/shared/format.ts';
import { Checkbox } from '@/components/ui/Checkbox';
import { useCopy } from '@/i18n/useCopy';

/**
 * The office's SMS attestation when it adds a person (owner decision 2026-10-20, Twilio toll-free
 * verification, opt-in "Verbal"): required in Team's invite and the setup wizard. The version
 * (`INVITE_MESSAGES_ATTESTATION`) is logged with the office user's name by api-invite-reporter.
 */
export function SmsAttestField({
  id,
  name,
  checked,
  onCheckedChange,
  error,
}: {
  id: string;
  /** The person's name as typed so far; the sentence names their first name. */
  name: string;
  checked: boolean;
  onCheckedChange: (checked: boolean) => void;
  error?: string | null;
}) {
  const { t } = useCopy();
  const first = name.trim() ? firstName(name.trim()) : '';
  const hintId = `${id}-hint`;
  const errorId = `${id}-error`;
  return (
    <div className="grid gap-1 rounded-card border border-rebar bg-concrete/60 p-3">
      <label className="flex min-h-target items-center gap-3 text-[15px] font-medium">
        <Checkbox
          id={id}
          checked={checked}
          onCheckedChange={(v) => onCheckedChange(v === true)}
          aria-describedby={error ? `${hintId} ${errorId}` : hintId}
          aria-invalid={!!error}
          aria-required
          data-testid={id}
        />
        {first ? t('team.invite.smsAttest', { first }) : t('team.invite.smsAttestNoName')}
      </label>
      <p id={hintId} className="text-caption text-dust">
        {t('team.invite.smsAttestHint')}
      </p>
      {error ? (
        <p id={errorId} role="alert" className="text-caption font-medium text-missing">
          {error}
        </p>
      ) : null}
    </div>
  );
}
