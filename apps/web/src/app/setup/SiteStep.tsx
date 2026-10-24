import { ArrowLeft, MapPin, Plus, Send, UserPlus, X } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import type { BillingPrice } from '@sitelog/shared/billing.ts';
import type { CountryPack } from '@sitelog/shared/countries.ts';
import type { ContactPref } from '@sitelog/shared/enums.ts';
import { firstName, formatMoneyCents } from '@sitelog/shared/format.ts';
import { inviteLineCheck } from '@sitelog/shared/line-check.ts';
import type { OrgLocale, ReporterLocale } from '@sitelog/shared/locale.ts';
import { PhoneInput, phoneValue, type PhoneValue } from '@/components/sitelog/PhoneInput';
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
import { useCopy } from '@/i18n/useCopy';
import { cn } from '@/lib/utils';
import { sitePriceFor } from '../sites/price';
import { LANGUAGES, languageLabel } from '../team/labels';
import { PreferenceField } from '../team/PreferenceField';
import { SmsAttestField } from '../team/SmsAttestField';
import { reportLanguageName } from './countries';
import { Field, TimezoneSelect } from './fields';
import { geocodeAddress, type GeocodeResult } from './geocode';
import type { SiteDraft } from './state';
import { welcomePreview } from './welcome';

export interface SiteSubmit {
  draft: SiteDraft;
  lat: number | null;
  lng: number | null;
}

type GeoState =
  | { status: 'idle' }
  | { status: 'loading' }
  | { status: 'found'; result: GeocodeResult }
  | { status: 'failed' };

/**
 * F2 step 2 · First site & manager (W4-02 on v1.2): the site, then its manager with the language
 * TalkOlog uses with them (the pack's field locales, the first preselected) beside the languages
 * they speak, and their preferred channel (Team's `PreferenceField`; a call preference in a pack
 * without a voice number uses Talk now, §19 Q33); the backup reporter likewise. Beside the form,
 * the §9.2 `welcome` as the manager will receive it by SMS (§19 Q25) and the org's price (§19
 * Q234). The line check (§19 Q229) refuses a known landline for a text link, and for a call where
 * TalkOlog cannot reach it by phone (`reachable`).
 */
export function SiteStep({
  draft,
  onChange,
  onBack,
  onSubmit,
  busy,
  companyName,
  existingCodes,
  createdCount,
  canGeocode,
  siteCount,
  orgLocale,
  packCountry,
  pack,
  reachable,
  price,
}: {
  draft: SiteDraft;
  onChange: (next: SiteDraft) => void;
  onBack: () => void;
  /** `another` = "Add another site" (stay on the step), otherwise continue. */
  onSubmit: (input: SiteSubmit, another: boolean) => void;
  busy: boolean;
  companyName: string;
  existingCodes: string[];
  createdCount: number;
  /** False in demo mode (no network): the manual coordinates fallback is offered right away. */
  canGeocode: boolean;
  siteCount: number;
  /** The org's locale: its report language (§9.6), named under "Speaks". */
  orgLocale: OrgLocale | undefined;
  /** The org's pack country (`orgs.country`): its numbers first, another country's warned (Q23). */
  packCountry: string;
  /** The org's country pack: field locales, the welcome's variant, the voice number. */
  pack: CountryPack | undefined;
  /** TalkOlog can reach a reporter by phone in this org (`reachableByPhone`, F2, §19 Q229). */
  reachable: boolean;
  /** The org's price per active site and month (W4-10); null while TalkOlog set none. */
  price: BillingPrice | null | undefined;
}) {
  const { t, language } = useCopy();
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [geo, setGeo] = useState<GeoState>({ status: 'idle' });
  const [manual, setManual] = useState(!canGeocode || !!(draft.lat || draft.lng));
  const abort = useRef<AbortController | null>(null);
  const set = (patch: Partial<SiteDraft>) => onChange({ ...draft, ...patch });

  const locales: readonly ReporterLocale[] = pack?.fieldLocales.length
    ? pack.fieldLocales
    : [draft.locale];
  // Progress saved under another pack (or before W4-02) reads as the pack's first locale.
  const localeOf = (l: ReporterLocale) => (locales.includes(l) ? l : locales[0]!);
  const managerLocale = localeOf(draft.locale);
  const backupLocale = localeOf(draft.backupLocale);

  const manager = phoneValue(draft.managerCountry, draft.managerPhone);
  const backup = phoneValue(draft.backupCountry, draft.backupPhone);

  useEffect(() => () => abort.current?.abort(), []);

  const lookup = () => {
    if (!canGeocode || !draft.address.trim()) return;
    abort.current?.abort();
    const ctl = new AbortController();
    abort.current = ctl;
    setGeo({ status: 'loading' });
    geocodeAddress(draft.address, ctl.signal).then(
      (r) => {
        if (ctl.signal.aborted) return;
        setGeo(r ? { status: 'found', result: r } : { status: 'failed' });
        if (!r) setManual(true);
      },
      () => {
        if (ctl.signal.aborted) return;
        setGeo({ status: 'failed' });
        setManual(true);
      },
    );
  };

  const coords = (): { lat: number | null; lng: number | null; error?: string } => {
    if (manual && (draft.lat.trim() || draft.lng.trim())) {
      const lat = Number(draft.lat);
      const lng = Number(draft.lng);
      if (
        !Number.isFinite(lat) ||
        !Number.isFinite(lng) ||
        Math.abs(lat) > 90 ||
        Math.abs(lng) > 180
      )
        return { lat: null, lng: null, error: t('setup.site.coordsInvalid') };
      return { lat, lng };
    }
    if (geo.status === 'found') return { lat: geo.result.lat, lng: geo.result.lng };
    return { lat: null, lng: null };
  };

  /** §19 Q229: the phone's error, or the line check's on a valid number. */
  const phoneError = (phone: PhoneValue, pref: ContactPref): string | null => {
    if (!phone.e164) return t('phone.invalid');
    const check = inviteLineCheck(phone.e164, pref, { reachable });
    return check.ok ? null : t(`setup.site.lineCheck.${check.problem}`);
  };

  const submit = (another: boolean) => {
    const next: Record<string, string> = {};
    if (!draft.name.trim()) next.name = t('setup.site.nameRequired');
    const code = draft.projectCode.trim();
    if (!code) next.projectCode = t('setup.site.projectCodeRequired');
    else if (existingCodes.some((x) => x.toLowerCase() === code.toLowerCase()))
      next.projectCode = t('setup.site.projectCodeTaken');
    const co = coords();
    if (co.error) next.coords = co.error;
    if (!draft.address.trim() && co.lat === null) next.address = t('setup.site.addressRequired');
    if (!draft.managerName.trim()) next.managerName = t('setup.site.managerNameRequired');
    const managerError = phoneError(manager, draft.contactPref);
    if (managerError) next.managerPhone = managerError;
    if (!draft.smsAttested) next.smsAttest = t('team.invite.attestation_required');
    if (draft.hasBackup && draft.backupPhone.trim()) {
      const backupError = phoneError(backup, draft.backupContactPref);
      if (backupError) next.backupPhone = backupError;
    }
    // The backup is invited only with a name and a number (Page's submitSite): then the box too.
    if (
      draft.hasBackup &&
      draft.backupName.trim() &&
      draft.backupPhone.trim() &&
      !draft.backupSmsAttested
    )
      next.backupSmsAttest = t('team.invite.attestation_required');
    setErrors(next);
    if (Object.keys(next).length) return;
    onSubmit(
      { draft: { ...draft, locale: managerLocale, backupLocale }, lat: co.lat, lng: co.lng },
      another,
    );
  };

  const previewName = draft.managerName.trim()
    ? firstName(draft.managerName)
    : t('setup.site.preview.placeholderName');
  const preview = pack
    ? welcomePreview(pack, managerLocale, {
        first: previewName,
        company: companyName || t('app.name'),
        site: draft.name.trim() || t('setup.site.preview.placeholderSite'),
        deadline: draft.deadline || '17:30',
      })
    : null;

  const locationHint =
    geo.status === 'loading'
      ? t('setup.site.geocoding')
      : geo.status === 'found'
        ? t('setup.site.geocoded', {
            lat: geo.result.lat.toFixed(4),
            lng: geo.result.lng.toFixed(4),
          })
        : t('setup.site.addressHint');

  /** Q33: a call preference where the pack has no number to call uses Talk now. */
  const preferenceHint = (pref: ContactPref) =>
    pref === 'call' && pack && !pack.voiceNumber
      ? t('team.invite.callTalkNow')
      : t('team.invite.preferenceHint');

  const priceText = sitePriceFor(price, language);
  const zero = formatMoneyCents(0, price?.currency ?? pack?.currency ?? 'USD', language);
  const previewTitle = t('setup.site.preview.title', { name: previewName });

  return (
    <div className="grid gap-6 xl:grid-cols-[minmax(0,1fr)_360px]">
      <Card>
        <CardContent className="p-6 md:p-8">
          <form
            className="grid gap-8"
            noValidate
            onSubmit={(e) => {
              e.preventDefault();
              submit(false);
            }}
          >
            <section className="grid gap-5" aria-labelledby="site-section">
              <h2 id="site-section" className="font-h2 text-h2">
                {t('setup.site.sectionSite')}
                {createdCount > 0 ? (
                  <span className="ml-2 font-mono text-[13px] font-medium text-dust">
                    {t('setup.site.another', { count: createdCount })}
                  </span>
                ) : null}
              </h2>
              <div className="grid gap-5 md:grid-cols-[minmax(0,1fr)_200px]">
                <Field id="site-name" label={t('setup.site.name')} error={errors.name}>
                  <Input
                    id="site-name"
                    value={draft.name}
                    onChange={(e) => set({ name: e.target.value })}
                    placeholder={t('setup.site.namePlaceholder')}
                    aria-invalid={!!errors.name}
                  />
                </Field>
                <Field
                  id="site-code"
                  label={t('setup.site.projectCode')}
                  error={errors.projectCode}
                >
                  <Input
                    id="site-code"
                    value={draft.projectCode}
                    onChange={(e) => set({ projectCode: e.target.value.toUpperCase() })}
                    placeholder={t('setup.site.projectCodePlaceholder')}
                    className="font-mono"
                    aria-invalid={!!errors.projectCode}
                  />
                </Field>
              </div>
              <Field
                id="site-address"
                label={t('setup.site.address')}
                error={errors.address}
                hint={
                  <span
                    className={cn(
                      'inline-flex items-center gap-1',
                      geo.status === 'found' && 'text-filed',
                    )}
                    data-testid="geo-hint"
                  >
                    <MapPin className="size-3.5" aria-hidden="true" />
                    {locationHint}
                  </span>
                }
              >
                <Input
                  id="site-address"
                  value={draft.address}
                  onChange={(e) => {
                    set({ address: e.target.value });
                    if (geo.status !== 'idle') setGeo({ status: 'idle' });
                  }}
                  onBlur={lookup}
                  placeholder={t('setup.site.addressPlaceholder')}
                  autoComplete="street-address"
                  aria-invalid={!!errors.address}
                />
              </Field>
              {geo.status === 'failed' ||
              (!canGeocode && !(draft.lat.trim() && draft.lng.trim())) ? (
                <div
                  role="status"
                  className="rounded-card border border-signal-deep/50 bg-signal-tint/40 p-3 text-caption text-asphalt"
                  data-testid="geo-warning"
                >
                  {t('setup.site.notGeocoded')}
                </div>
              ) : null}
              {manual ? (
                <div className="grid gap-5 sm:grid-cols-2">
                  <Field id="site-lat" label={t('setup.site.lat')} error={errors.coords}>
                    <Input
                      id="site-lat"
                      inputMode="decimal"
                      value={draft.lat}
                      onChange={(e) => set({ lat: e.target.value })}
                      className="font-mono"
                      aria-invalid={!!errors.coords}
                    />
                  </Field>
                  <Field id="site-lng" label={t('setup.site.lng')}>
                    <Input
                      id="site-lng"
                      inputMode="decimal"
                      value={draft.lng}
                      onChange={(e) => set({ lng: e.target.value })}
                      className="font-mono"
                      aria-invalid={!!errors.coords}
                    />
                  </Field>
                </div>
              ) : (
                <Button
                  variant="link"
                  size="sm"
                  className="justify-self-start"
                  onClick={() => setManual(true)}
                >
                  {t('setup.site.manualCoords')}
                </Button>
              )}
              <div className="grid gap-5 md:grid-cols-2">
                <Field id="site-tz" label={t('setup.site.timezone')}>
                  <TimezoneSelect
                    id="site-tz"
                    value={draft.timezone}
                    onChange={(tz) => set({ timezone: tz })}
                  />
                </Field>
                <Field
                  id="site-deadline"
                  label={t('setup.site.deadline')}
                  hint={t('setup.site.deadlineHint')}
                >
                  <Input
                    id="site-deadline"
                    type="time"
                    value={draft.deadline}
                    onChange={(e) => set({ deadline: e.target.value })}
                    className="font-mono"
                  />
                </Field>
              </div>
            </section>

            <section
              className="grid gap-5 border-t border-rebar pt-6"
              aria-labelledby="manager-section"
            >
              <h2 id="manager-section" className="font-h2 text-h2">
                {t('setup.site.sectionManager')}
              </h2>
              <Field id="mgr-name" label={t('setup.site.managerName')} error={errors.managerName}>
                <Input
                  id="mgr-name"
                  value={draft.managerName}
                  onChange={(e) => set({ managerName: e.target.value })}
                  placeholder={t('setup.site.managerNamePlaceholder')}
                  autoComplete="name"
                  aria-invalid={!!errors.managerName}
                />
              </Field>
              <PhoneInput
                label={t('setup.site.phone')}
                value={manager}
                onChange={(v) => set({ managerCountry: v.country, managerPhone: v.raw })}
                packCountry={packCountry}
                error={errors.managerPhone ?? null}
                required
                data-testid="manager-phone"
              />
              <div className="grid gap-5 md:grid-cols-2">
                <LocaleSelect
                  id="mgr-locale"
                  label={t('team.invite.language')}
                  value={managerLocale}
                  locales={locales}
                  onChange={(locale) => set({ locale })}
                />
                <PreferenceField
                  idPrefix="mgr"
                  legend={t('team.invite.preference')}
                  value={draft.contactPref}
                  onChange={(contactPref) => set({ contactPref })}
                  hint={preferenceHint(draft.contactPref)}
                />
              </div>
              <fieldset className="grid gap-2">
                <legend className="text-caption font-medium">{t('setup.site.languages')}</legend>
                <div className="flex flex-wrap gap-2">
                  {LANGUAGES.map((l) => {
                    const on = draft.languages.includes(l);
                    return (
                      <button
                        key={l}
                        type="button"
                        role="checkbox"
                        aria-checked={on}
                        onClick={() =>
                          set({
                            languages: on
                              ? draft.languages.filter((x) => x !== l)
                              : [...draft.languages, l],
                          })
                        }
                        className={cn(
                          'h-target rounded-chip border px-3 text-[15px] font-medium',
                          on
                            ? 'border-asphalt bg-asphalt text-chalk'
                            : 'border-rebar bg-chalk text-asphalt hover:bg-concrete',
                        )}
                      >
                        {languageLabel(t, l)}
                      </button>
                    );
                  })}
                </div>
                <p className="text-caption text-dust">
                  {t('team.invite.languagesHint', {
                    language: reportLanguageName(t, orgLocale ?? pack?.defaultLocale),
                  })}
                </p>
              </fieldset>
              <SmsAttestField
                id="mgr-sms-attest"
                name={draft.managerName}
                checked={draft.smsAttested}
                onCheckedChange={(smsAttested) => set({ smsAttested })}
                error={errors.smsAttest}
              />

              {draft.hasBackup ? (
                <div className="grid gap-5 rounded-card border border-rebar p-4">
                  <div className="flex items-center justify-between">
                    <h3 className="text-[15px] font-semibold">{t('setup.site.backup')}</h3>
                    <Button
                      variant="subtle"
                      size="dense"
                      onClick={() =>
                        set({
                          hasBackup: false,
                          backupName: '',
                          backupPhone: '',
                          backupSmsAttested: false,
                        })
                      }
                    >
                      <X aria-hidden="true" />
                      {t('setup.site.removeBackup')}
                    </Button>
                  </div>
                  <Field id="bk-name" label={t('setup.site.backupName')}>
                    <Input
                      id="bk-name"
                      value={draft.backupName}
                      onChange={(e) => set({ backupName: e.target.value })}
                      placeholder={t('setup.site.managerNamePlaceholder')}
                    />
                  </Field>
                  <PhoneInput
                    label={t('setup.site.backupPhone')}
                    value={backup}
                    onChange={(v) => set({ backupCountry: v.country, backupPhone: v.raw })}
                    packCountry={packCountry}
                    error={errors.backupPhone ?? null}
                    data-testid="backup-phone"
                  />
                  <div className="grid gap-5 md:grid-cols-2">
                    <LocaleSelect
                      id="bk-locale"
                      label={t('setup.site.backupLanguage')}
                      value={backupLocale}
                      locales={locales}
                      onChange={(l) => set({ backupLocale: l })}
                    />
                    <PreferenceField
                      idPrefix="bk"
                      legend={t('setup.site.backupPreference')}
                      value={draft.backupContactPref}
                      onChange={(backupContactPref) => set({ backupContactPref })}
                      hint={preferenceHint(draft.backupContactPref)}
                    />
                  </div>
                  <SmsAttestField
                    id="bk-sms-attest"
                    name={draft.backupName}
                    checked={draft.backupSmsAttested}
                    onCheckedChange={(backupSmsAttested) => set({ backupSmsAttested })}
                    error={errors.backupSmsAttest}
                  />
                </div>
              ) : (
                <div>
                  <Button variant="ghost" size="dense" onClick={() => set({ hasBackup: true })}>
                    <UserPlus aria-hidden="true" />
                    {t('setup.site.addBackup')}
                  </Button>
                  <p className="mt-1 text-caption text-dust">{t('setup.site.backupHint')}</p>
                </div>
              )}
            </section>

            <div className="flex flex-col-reverse gap-2 border-t border-rebar pt-5 sm:flex-row sm:items-center sm:justify-between">
              <Button variant="ghost" onClick={onBack}>
                <ArrowLeft aria-hidden="true" />
                {t('common.back')}
              </Button>
              <div className="flex flex-col-reverse gap-2 sm:flex-row">
                <Button variant="ghost" disabled={busy} onClick={() => submit(true)}>
                  <Plus aria-hidden="true" />
                  {t('setup.site.addAnother')}
                </Button>
                <Button type="submit" variant="primary" loading={busy}>
                  <Send aria-hidden="true" />
                  {t('setup.site.send')}
                </Button>
              </div>
            </div>
          </form>
        </CardContent>
      </Card>

      <aside className="grid content-start gap-4" aria-label={previewTitle}>
        <Card>
          <CardContent className="p-5">
            {/* Not an uppercase eyebrow: a Turkish name would lose its dotted İ. */}
            <h2 className="text-caption font-semibold text-dust">{previewTitle}</h2>
            <div className="mt-4 grid gap-3" data-testid="welcome-preview">
              {preview ? (
                <>
                  <SmsBubble
                    from={t('setup.site.preview.from')}
                    text={preview.text}
                    lang={preview.language}
                  />
                  <p className="text-caption text-dust">{t('setup.site.preview.sampleLink')}</p>
                  {preview.number ? (
                    <p className="text-caption text-asphalt" data-testid="welcome-call-note">
                      {t('setup.site.preview.callAnyTime', { number: preview.number })}
                    </p>
                  ) : null}
                </>
              ) : (
                <p className="text-caption text-dust">{t('setup.site.preview.unavailable')}</p>
              )}
            </div>
          </CardContent>
        </Card>
        <PricingCard priceText={priceText} zero={zero} siteCount={siteCount} />
      </aside>
    </div>
  );
}

/** "Language TalkOlog uses": the pack's field locales, named in the panel's language (Team's copy). */
function LocaleSelect({
  id,
  label,
  value,
  locales,
  onChange,
}: {
  id: string;
  label: string;
  value: ReporterLocale;
  locales: readonly ReporterLocale[];
  onChange: (next: ReporterLocale) => void;
}) {
  const { t } = useCopy();
  return (
    <Field id={id} label={label}>
      <Select value={value} onValueChange={(v) => v && onChange(v as ReporterLocale)}>
        <SelectTrigger id={id} data-testid={id}>
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          {locales.map((l) => (
            <SelectItem key={l} value={l}>
              {t(`team.locales.${l}`)}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </Field>
  );
}

/**
 * §14.6: a message preview is a Chalk bubble with a Rebar border, never a messaging app's look.
 * The text keeps its own language (`lang`), which may differ from the panel's.
 */
function SmsBubble({ from, text, lang }: { from: string; text: string; lang: string }) {
  return (
    <div className="max-w-[320px]">
      <div className="rounded-[14px] rounded-tl-[4px] border border-rebar bg-chalk px-3.5 py-2.5 text-[14px] leading-[20px]">
        <div className="mb-1 text-caption font-medium text-dust">{from}</div>
        <p lang={lang} className="[overflow-wrap:anywhere]" data-testid="welcome-text">
          {text}
        </p>
      </div>
    </div>
  );
}

/**
 * The pricing card (F2, §19 Q234): the org's own price per active site and month (W4-10), "$0
 * setup · billed per active site"; without a price, Billing's line that TalkOlog sets it.
 */
function PricingCard({
  priceText,
  zero,
  siteCount,
}: {
  priceText: string | null;
  zero: string;
  siteCount: number;
}) {
  const { t } = useCopy();
  return (
    <Card dark data-testid="pricing-card">
      <CardContent className="p-5">
        {priceText ? (
          <div className="flex flex-wrap items-baseline gap-2">
            <span className="font-display text-[36px] leading-10">{priceText}</span>
            <span className="font-mono text-data text-dust-light">
              {t('setup.site.pricing.perSiteMonth')}
            </span>
          </div>
        ) : (
          <p className="text-[15px]">{t('billing.noPrice')}</p>
        )}
        <div className="mt-1 font-mono text-[12px] text-dust-light">
          {t('setup.site.pricing.setupBilled', { zero })}
        </div>
        <ul className="mt-4 space-y-1.5 border-t border-iron pt-3 text-caption text-dust-light">
          <li>{t('setup.site.pricing.pointPause')}</li>
          <li>{t('setup.site.pricing.pointInvoice')}</li>
        </ul>
        {priceText && siteCount > 0 ? (
          <p className="mt-3 font-mono text-[12px] text-dust-light">
            {t('setup.site.pricing.sitesTimes', { count: siteCount, price: priceText })}
          </p>
        ) : null}
      </CardContent>
    </Card>
  );
}
