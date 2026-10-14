import { useId, useState } from 'react';
import { formatPhone, normalizeE164 } from '@sitelog/shared/format.ts';
import { copy } from '@/copy/en';
import { cn } from '@/lib/utils';
import { Input } from '../ui/Input';
import { Label } from '../ui/Label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '../ui/Select';

/** Country picker for phone numbers (dial code → E.164). Extend as pilots need. */
export const PHONE_COUNTRIES = [
  { code: 'US', dial: '1', name: 'United States', example: '+1 555 014 3378' },
  // The §18.2 demo range (packages/shared/src/demo/demir.ts).
  { code: 'TR', dial: '90', name: 'Türkiye', example: '+90 532 000 0512' },
  { code: 'CA', dial: '1', name: 'Canada', example: '+1 416 555 0134' },
  { code: 'MX', dial: '52', name: 'Mexico', example: '+52 55 1234 5678' },
  { code: 'GB', dial: '44', name: 'United Kingdom', example: '+44 7700 900123' },
  { code: 'IE', dial: '353', name: 'Ireland', example: '+353 85 123 4567' },
  { code: 'ES', dial: '34', name: 'Spain', example: '+34 612 345 678' },
  { code: 'PL', dial: '48', name: 'Poland', example: '+48 512 345 678' },
  { code: 'DE', dial: '49', name: 'Germany', example: '+49 151 2345 6789' },
  { code: 'FR', dial: '33', name: 'France', example: '+33 6 12 34 56 78' },
  { code: 'BR', dial: '55', name: 'Brazil', example: '+55 11 91234 5678' },
  { code: 'IN', dial: '91', name: 'India', example: '+91 98765 43210' },
] as const;

export type PhoneCountryCode = (typeof PHONE_COUNTRIES)[number]['code'];

export interface PhoneValue {
  country: PhoneCountryCode;
  raw: string;
  /** Normalised E.164 or null while invalid. */
  e164: string | null;
}

export function phoneValue(country: PhoneCountryCode, raw: string): PhoneValue {
  const c = PHONE_COUNTRIES.find((x) => x.code === country) ?? PHONE_COUNTRIES[0];
  return { country, raw, e164: raw.trim() ? normalizeE164(raw, c.dial) : null };
}

export function emptyPhone(country: PhoneCountryCode = 'US'): PhoneValue {
  return { country, raw: '', e164: null };
}

/**
 * The picker's country for an org's or the wizard's country (`countries.code`): that country
 * when the picker lists it, otherwise `fallback`.
 */
export function phoneCountryFor(
  country: string | null | undefined,
  fallback: PhoneCountryCode = 'US',
): PhoneCountryCode {
  return PHONE_COUNTRIES.find((c) => c.code === country)?.code ?? fallback;
}

export interface PhoneInputProps {
  label: string;
  value: PhoneValue;
  onChange: (next: PhoneValue) => void;
  error?: string | null;
  required?: boolean;
  className?: string;
  autoComplete?: string;
  /** Test id for the number input. */
  'data-testid'?: string;
}

/** Country select + number input; shows the E.164 result under the field (§F2 validation). */
export function PhoneInput({
  label,
  value,
  onChange,
  error,
  required,
  className,
  autoComplete = 'tel',
  ...rest
}: PhoneInputProps) {
  const id = useId();
  const [touched, setTouched] = useState(false);
  const country = PHONE_COUNTRIES.find((c) => c.code === value.country) ?? PHONE_COUNTRIES[0];
  const showError =
    error ?? (touched && value.raw.trim() && !value.e164 ? copy.team.invite.phoneInvalid : null);
  return (
    <div className={cn('grid gap-1.5', className)}>
      <Label htmlFor={`${id}-number`}>
        {label}
        {required ? <span className="sr-only"> ({copy.common.required})</span> : null}
      </Label>
      <div className="grid grid-cols-[132px_minmax(0,1fr)] gap-2">
        <Select
          value={value.country}
          onValueChange={(c) => onChange(phoneValue(c as PhoneCountryCode, value.raw))}
        >
          <SelectTrigger aria-label={copy.team.invite.country} className="font-mono">
            <SelectValue>
              {country.code} +{country.dial}
            </SelectValue>
          </SelectTrigger>
          <SelectContent>
            {PHONE_COUNTRIES.map((c) => (
              <SelectItem key={c.code} value={c.code} textValue={`${c.code} +${c.dial}`}>
                <span className="font-mono">
                  {c.code} +{c.dial}
                </span>
                <span className="ml-2 text-dust">{c.name}</span>
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <Input
          id={`${id}-number`}
          type="tel"
          inputMode="tel"
          autoComplete={autoComplete}
          value={value.raw}
          placeholder={copy.team.invite.phonePlaceholder}
          onChange={(e) => onChange(phoneValue(value.country, e.target.value))}
          onBlur={() => setTouched(true)}
          aria-invalid={!!showError}
          aria-describedby={`${id}-hint`}
          required={required}
          className="font-mono"
          data-testid={rest['data-testid']}
        />
      </div>
      <p id={`${id}-hint`} className="font-mono text-[12px] text-dust">
        {value.e164 ? formatPhone(value.e164) : copy.team.invite.phoneHint(country.example)}
      </p>
      {showError ? (
        <p role="alert" className="text-caption font-medium text-missing">
          {showError}
        </p>
      ) : null}
    </div>
  );
}
