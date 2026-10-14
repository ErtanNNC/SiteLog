import { ArrowRight, ImagePlus } from 'lucide-react';
import { useRef, useState } from 'react';
import type { CountryPack } from '@sitelog/shared/countries.ts';
import { Button } from '@/components/ui/Button';
import { Card, CardContent } from '@/components/ui/Card';
import { Input } from '@/components/ui/Input';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/Select';
import { copy } from '@/copy/en';
import { LOGO_ACCEPT, logoFileError } from '@/lib/logo';
import { countryName, packFor, reportLanguageName } from './countries';
import { Field, TimezoneSelect } from './fields';
import type { CompanyDraft } from './state';

/**
 * F2 step 1 · Company (spec §4.6): the country is one of the country packs, and picking it
 * presets the time zone select (until the user picks a zone) and, at create_org, the report
 * language, units, paper and currency shown under it. An existing org's country is locked:
 * `update_org` cannot change it (spec §19 Q31). Countries are listed by their English name (the
 * browser's), each with its code.
 */
export function CompanyStep({
  draft,
  onChange,
  onContinue,
  busy,
  logoUrl,
  onLogoChange,
  packs,
  countryLocked = false,
}: {
  draft: CompanyDraft;
  onChange: (next: CompanyDraft) => void;
  onContinue: () => void;
  busy: boolean;
  logoUrl: string | null;
  onLogoChange: (file: File | null) => string | null;
  /** The country packs (`useCountryPacks`), one option each. */
  packs: readonly CountryPack[];
  /** The org exists: its country is shown, not chosen. */
  countryLocked?: boolean;
}) {
  const c = copy.setup.company;
  const fileRef = useRef<HTMLInputElement>(null);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const set = (patch: Partial<CompanyDraft>) => onChange({ ...draft, ...patch });
  const pack = packFor(packs, draft.country);
  // By name, as the user reads them (the packs come by code). An existing org's country is always
  // shown, even if this build could not read its pack; a new org's saved choice that is no pack
  // any more shows as no choice.
  const codes = packs
    .map((p) => p.code)
    .sort((a, b) => countryName(a).localeCompare(countryName(b), 'en'));
  if (countryLocked && draft.country && !codes.includes(draft.country)) codes.push(draft.country);
  const shown = codes.includes(draft.country) ? draft.country : '';

  const chooseCountry = (code: string) => {
    if (!code) return; // Radix's hidden native select before its options mount: no choice
    const next = packFor(packs, code);
    set({
      country: code,
      ...(next && !draft.timezoneTouched ? { timezone: next.defaultTimezone } : {}),
    });
    setErrors(({ country: _c, ...rest }) => rest);
  };

  const submit = () => {
    const next: Record<string, string> = {};
    if (!draft.name.trim()) next.name = c.nameRequired;
    if (!countryLocked && !pack) next.country = c.countryRequired;
    setErrors(next);
    if (Object.keys(next).length) return;
    onContinue();
  };

  return (
    <Card>
      <CardContent className="p-6 md:p-8">
        <h2 className="font-h2 text-h2">{c.title}</h2>
        <p className="mt-1 text-[15px] text-dust">{c.subtitle}</p>
        <form
          className="mt-6 grid gap-5"
          noValidate
          onSubmit={(e) => {
            e.preventDefault();
            submit();
          }}
        >
          <Field id="co-name" label={c.name} error={errors.name}>
            <Input
              id="co-name"
              value={draft.name}
              onChange={(e) => set({ name: e.target.value })}
              placeholder={c.namePlaceholder}
              autoComplete="organization"
              aria-invalid={!!errors.name}
            />
          </Field>
          <div className="grid gap-5 md:grid-cols-2">
            <Field
              id="co-country"
              label={c.country}
              hint={countryLocked ? c.countryLocked : c.countryHint}
              error={errors.country}
            >
              <Select value={shown} onValueChange={chooseCountry} disabled={countryLocked} required>
                <SelectTrigger
                  id="co-country"
                  aria-describedby="co-country-hint"
                  aria-invalid={!!errors.country}
                >
                  <SelectValue placeholder={c.countryPlaceholder}>
                    {shown ? <CountryLabel code={shown} /> : null}
                  </SelectValue>
                </SelectTrigger>
                <SelectContent>
                  {codes.map((code) => (
                    <SelectItem key={code} value={code} textValue={countryName(code)}>
                      <CountryLabel code={code} />
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </Field>
            <Field id="co-tz" label={c.timezone}>
              <TimezoneSelect
                id="co-tz"
                value={draft.timezone}
                onChange={(tz) => set({ timezone: tz, timezoneTouched: true })}
              />
            </Field>
          </div>
          {!countryLocked && pack ? <CountryPresets pack={pack} /> : null}
          <div className="grid gap-5 md:grid-cols-2">
            <Field id="co-address" label={c.address} optional>
              <Input
                id="co-address"
                value={draft.address}
                onChange={(e) => set({ address: e.target.value })}
                placeholder={c.addressPlaceholder}
                autoComplete="street-address"
              />
            </Field>
            <Field id="co-license" label={c.licenseNo} optional>
              <Input
                id="co-license"
                value={draft.licenseNo}
                onChange={(e) => set({ licenseNo: e.target.value })}
                className="font-mono"
              />
            </Field>
          </div>
          <div className="grid gap-5 md:grid-cols-2">
            <Field id="co-logo" label={c.logo} hint={c.logoHint} error={errors.logo} optional>
              <div className="flex items-center gap-4">
                <div className="flex size-16 shrink-0 items-center justify-center overflow-hidden rounded-card border border-rebar bg-concrete">
                  {logoUrl ? (
                    <img
                      src={logoUrl}
                      alt={c.logo}
                      className="max-h-full max-w-full object-contain"
                    />
                  ) : (
                    <ImagePlus className="size-6 text-dust" aria-hidden="true" />
                  )}
                </div>
                <input
                  ref={fileRef}
                  id="co-logo"
                  type="file"
                  accept={LOGO_ACCEPT}
                  className="sr-only"
                  onChange={(e) => {
                    const f = e.target.files?.[0] ?? null;
                    e.target.value = '';
                    if (!f) return;
                    const error = logoFileError(f);
                    if (error) {
                      setErrors((er) => ({ ...er, logo: error }));
                      return;
                    }
                    setErrors(({ logo: _l, ...rest }) => rest);
                    onLogoChange(f);
                  }}
                />
                <div className="flex flex-wrap gap-2">
                  <Button variant="ghost" size="dense" onClick={() => fileRef.current?.click()}>
                    {logoUrl ? c.replace : c.upload}
                  </Button>
                  {logoUrl ? (
                    <Button variant="destructive" size="dense" onClick={() => onLogoChange(null)}>
                      {c.removeLogo}
                    </Button>
                  ) : null}
                </div>
              </div>
            </Field>
          </div>
          <div className="flex justify-end border-t border-rebar pt-5">
            <Button type="submit" variant="primary" loading={busy}>
              {c.next}
              <ArrowRight aria-hidden="true" />
            </Button>
          </div>
        </form>
      </CardContent>
    </Card>
  );
}

/** "Türkiye TR": the browser's name for the country, then its code (the name varies by ICU). */
function CountryLabel({ code }: { code: string }) {
  return (
    <>
      {countryName(code)} <span className="ml-1 font-mono text-[12px] text-dust">{code}</span>
    </>
  );
}

/**
 * What create_org takes from the chosen pack (read-only; the org can change most later). The
 * time zone is not repeated here: the select beside the country shows it, preset by the pack
 * until the user picks another.
 */
function CountryPresets({ pack }: { pack: CountryPack }) {
  const c = copy.setup.company;
  const items: Array<{ label: string; value: string; mono?: boolean }> = [
    { label: c.presets.reportLanguage, value: reportLanguageName(pack.defaultLocale) },
    { label: c.presets.units, value: c.unitNames[pack.units] },
    { label: c.presets.paper, value: c.paperNames[pack.paper] },
    { label: c.presets.currency, value: pack.currency, mono: true },
  ];
  return (
    <section
      aria-labelledby="co-presets-title"
      aria-live="polite"
      className="rounded-card border border-rebar p-4"
      data-testid="country-presets"
    >
      {/* Not an uppercase eyebrow: on an English page "Türkiye" would lose its dotted İ. */}
      <h3 id="co-presets-title" className="text-[15px] font-semibold">
        {c.presets.title(countryName(pack.code))}
      </h3>
      <dl className="mt-3 grid grid-cols-2 gap-x-6 gap-y-3 sm:grid-cols-4">
        {items.map((item) => (
          <div key={item.label} className="min-w-0">
            <dt className="text-caption text-dust">{item.label}</dt>
            <dd
              className={
                item.mono
                  ? 'font-mono text-[13px] font-medium [overflow-wrap:anywhere]'
                  : 'text-[15px] font-medium'
              }
            >
              {item.value}
            </dd>
          </div>
        ))}
      </dl>
    </section>
  );
}
