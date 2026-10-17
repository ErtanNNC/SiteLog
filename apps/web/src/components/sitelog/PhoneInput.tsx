import { Check, ChevronDown, TriangleAlert } from 'lucide-react';
import { useId, useMemo, useRef, useState, type KeyboardEvent } from 'react';
import { formatPhone } from '@sitelog/shared/format.ts';
import {
  DEFAULT_PHONE_REGION,
  foreignNumberRegion,
  parsePhoneIn,
  phoneRegion,
  phoneRegionFor,
  phoneRegionName,
  phoneRegions,
  searchPhoneRegions,
  type PhoneRegion,
} from '@sitelog/shared/phone-regions.ts';
import { useCopy } from '@/i18n/useCopy';
import { cn } from '@/lib/utils';
import { Input } from '../ui/Input';
import { Label } from '../ui/Label';
import { Popover, PopoverContent, PopoverTrigger } from '../ui/Popover';

/**
 * Phone numbers in the panel (spec §4.6, F2, W4-01): a searchable picker over every region
 * libphonenumber knows (`@sitelog/shared/phone-regions.ts`), the org's pack country first, and the
 * number field. A new country pack needs no code here.
 */
export interface PhoneValue {
  /** The picked region (ISO 3166-1 alpha-2, one libphonenumber knows). */
  country: string;
  raw: string;
  /** Normalised E.164 or null while invalid. */
  e164: string | null;
}

export function phoneValue(country: string, raw: string): PhoneValue {
  return { country, raw, e164: raw.trim() ? parsePhoneIn(raw, country) : null };
}

export function emptyPhone(country: string = DEFAULT_PHONE_REGION): PhoneValue {
  return { country, raw: '', e164: null };
}

/**
 * The picker's region for an org's or the wizard's country (`countries.code`): that country when
 * libphonenumber knows it, otherwise `fallback` (a synthetic pack row).
 */
export function phoneCountryFor(
  country: string | null | undefined,
  fallback: string = DEFAULT_PHONE_REGION,
): string {
  return phoneRegionFor(country, fallback);
}

export interface PhoneInputProps {
  label: string;
  value: PhoneValue;
  onChange: (next: PhoneValue) => void;
  /**
   * The org's (or, before it exists, the wizard's) pack country: listed first, and a valid number
   * from another region says so under the field (spec §19 Q23, never blocking).
   */
  packCountry?: string | null;
  error?: string | null;
  required?: boolean;
  className?: string;
  autoComplete?: string;
  /** Test id for the number input. */
  'data-testid'?: string;
}

/** Country picker + number input; shows the E.164 result under the field (§F2 validation). */
export function PhoneInput({
  label,
  value,
  onChange,
  packCountry,
  error,
  required,
  className,
  autoComplete = 'tel',
  ...rest
}: PhoneInputProps) {
  const id = useId();
  const { t, language } = useCopy();
  const [touched, setTouched] = useState(false);
  const regions = useMemo(() => phoneRegions(language, packCountry), [language, packCountry]);
  const region =
    regions.find((r) => r.code === value.country) ??
    phoneRegion(phoneRegionFor(value.country), language)!;
  const showError =
    error ?? (touched && value.raw.trim() && !value.e164 ? t('phone.invalid') : null);
  const foreign = value.e164 ? foreignNumberRegion(value.e164, packCountry, value.country) : null;
  const testId = rest['data-testid'];
  return (
    <div className={cn('grid gap-1.5', className)}>
      <Label htmlFor={`${id}-number`}>
        {label}
        {required ? <span className="sr-only"> ({t('common.required')})</span> : null}
      </Label>
      <div className="grid grid-cols-[112px_minmax(0,1fr)] gap-2">
        <CountryPicker
          regions={regions}
          region={region}
          onSelect={(code) => onChange(phoneValue(code, value.raw))}
          testId={testId ? `${testId}-country` : undefined}
        />
        <Input
          id={`${id}-number`}
          type="tel"
          inputMode="tel"
          autoComplete={autoComplete}
          value={value.raw}
          placeholder={region.nationalExample ?? undefined}
          onChange={(e) => onChange(phoneValue(value.country, e.target.value))}
          onBlur={() => setTouched(true)}
          aria-invalid={!!showError}
          aria-describedby={cn(`${id}-hint`, foreign && `${id}-foreign`)}
          required={required}
          className="font-mono"
          data-testid={testId}
        />
      </div>
      <p id={`${id}-hint`} className="font-mono text-[12px] text-dust">
        {value.e164 ? formatPhone(value.e164) : t('phone.hint', { example: region.example })}
      </p>
      {foreign ? (
        <p
          id={`${id}-foreign`}
          className="flex items-start gap-1.5 text-caption text-asphalt"
          data-testid={testId ? `${testId}-foreign` : undefined}
        >
          <TriangleAlert className="mt-0.5 size-4 shrink-0 text-chip-await-fg" aria-hidden="true" />
          <span>
            {t('phone.foreign', {
              country: phoneRegionName(foreign, language),
              pack: phoneRegionName(packCountry!, language),
            })}
          </span>
        </p>
      ) : null}
      {showError ? (
        <p role="alert" className="text-caption font-medium text-missing">
          {showError}
        </p>
      ) : null}
    </div>
  );
}

/**
 * The country-code picker: a button that opens a search field (a combobox) over a listbox. Type a
 * name, an ISO code or a calling code; arrows, Home and End move, Enter picks, Escape closes and
 * returns to the button. Modal, so it scrolls and keeps focus inside a dialog (Team's invite).
 */
function CountryPicker({
  regions,
  region,
  onSelect,
  testId,
}: {
  regions: readonly PhoneRegion[];
  region: PhoneRegion;
  onSelect: (code: string) => void;
  testId?: string;
}) {
  const { t } = useCopy();
  const listId = useId();
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [active, setActive] = useState(0);
  const list = useRef<HTMLUListElement>(null);
  const matches = useMemo(() => searchPhoneRegions(regions, query), [regions, query]);
  const optionId = (code: string) => `${listId}-${code}`;

  const show = (index: number) => {
    setActive(index);
    const code = matches[index]?.code;
    if (code) document.getElementById(optionId(code))?.scrollIntoView?.({ block: 'nearest' });
  };

  const openChange = (next: boolean) => {
    setOpen(next);
    if (next) {
      setQuery('');
      setActive(Math.max(0, regions.indexOf(region)));
    }
  };

  const pick = (code: string) => {
    onSelect(code);
    setOpen(false);
  };

  const onKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    const last = matches.length - 1;
    if (e.key === 'ArrowDown') show(Math.min(active + 1, last));
    else if (e.key === 'ArrowUp') show(Math.max(active - 1, 0));
    else if (e.key === 'Home' && e.ctrlKey) show(0);
    else if (e.key === 'End' && e.ctrlKey) show(last);
    else if (e.key === 'PageDown') show(Math.min(active + 8, last));
    else if (e.key === 'PageUp') show(Math.max(active - 8, 0));
    else if (e.key === 'Enter') {
      const hit = matches[active];
      if (hit) pick(hit.code);
    } else return;
    e.preventDefault();
  };

  const current = matches[active];
  return (
    <Popover open={open} onOpenChange={openChange} modal>
      <PopoverTrigger asChild>
        <button
          type="button"
          aria-label={t('phone.countryButton', {
            country: region.name,
            region: region.code,
            code: region.callingCode,
          })}
          className="flex h-target w-full items-center justify-between gap-1 rounded-chip border border-rebar bg-chalk px-3 font-mono text-[15px] text-asphalt focus-visible:border-asphalt"
          data-testid={testId}
        >
          <span className="truncate">
            {region.code} +{region.callingCode}
          </span>
          <ChevronDown className="size-5 shrink-0 text-dust" aria-hidden="true" />
        </button>
      </PopoverTrigger>
      <PopoverContent align="start" className="w-[340px] max-w-[calc(100vw-32px)] p-0">
        <div className="border-b border-rebar p-2">
          <Input
            role="combobox"
            aria-label={t('phone.search')}
            aria-expanded="true"
            aria-controls={matches.length ? listId : undefined}
            aria-autocomplete="list"
            aria-activedescendant={current ? optionId(current.code) : undefined}
            placeholder={t('phone.searchPlaceholder')}
            value={query}
            onChange={(e) => {
              setQuery(e.target.value);
              setActive(0);
              list.current?.scrollTo?.({ top: 0 });
            }}
            onKeyDown={onKeyDown}
            autoComplete="off"
            spellCheck={false}
          />
        </div>
        {matches.length ? (
          <ul
            ref={list}
            id={listId}
            role="listbox"
            aria-label={t('phone.countryCode')}
            className="max-h-72 overflow-y-auto p-1 scrollbar-thin"
          >
            {matches.map((r, i) => {
              const selected = r.code === region.code;
              return (
                <li
                  key={r.code}
                  id={optionId(r.code)}
                  role="option"
                  aria-selected={selected}
                  data-active={i === active || undefined}
                  onMouseMove={() => i !== active && setActive(i)}
                  onMouseDown={(e) => e.preventDefault()}
                  onClick={() => pick(r.code)}
                  className="flex min-h-target cursor-pointer items-center gap-3 rounded-chip px-3 py-2 text-[15px] data-[active]:bg-concrete"
                >
                  <span className="w-[76px] shrink-0 font-mono text-[13px] text-dust">
                    {r.code} +{r.callingCode}
                  </span>
                  <span className="min-w-0 flex-1 truncate">{r.name}</span>
                  {selected ? <Check className="size-4 shrink-0" aria-hidden="true" /> : null}
                </li>
              );
            })}
          </ul>
        ) : (
          <p role="status" className="px-4 py-4 text-caption text-dust">
            {t('phone.noMatch', { query: query.trim() })}
          </p>
        )}
      </PopoverContent>
    </Popover>
  );
}
