import { ArrowLeft, MapPin, Plus, Send, UserPlus, X } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { firstName } from '@sitelog/shared/format.ts';
import { renderTemplateText } from '@sitelog/shared/wa/templates.ts';
import { PhoneInput, phoneValue } from '@/components/sitelog/PhoneInput';
import { Button } from '@/components/ui/Button';
import { Card, CardContent } from '@/components/ui/Card';
import { Input } from '@/components/ui/Input';
import { copy } from '@/copy/en';
import { cn } from '@/lib/utils';
import { LANGUAGES } from '../team/InviteReporterDialog';
import { Field, TimezoneSelect } from './fields';
import { geocodeAddress, type GeocodeResult } from './geocode';
import type { SiteDraft } from './state';

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
  reportLanguage,
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
  /** The org's report language, named ("Turkish"): `reportLanguageName` of its locale. */
  reportLanguage: string;
}) {
  const c = copy.setup.site;
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [geo, setGeo] = useState<GeoState>({ status: 'idle' });
  const [manual, setManual] = useState(!canGeocode || !!(draft.lat || draft.lng));
  const abort = useRef<AbortController | null>(null);
  const set = (patch: Partial<SiteDraft>) => onChange({ ...draft, ...patch });

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
        return { lat: null, lng: null, error: c.coordsInvalid };
      return { lat, lng };
    }
    if (geo.status === 'found') return { lat: geo.result.lat, lng: geo.result.lng };
    return { lat: null, lng: null };
  };

  const submit = (another: boolean) => {
    const next: Record<string, string> = {};
    if (!draft.name.trim()) next.name = c.nameRequired;
    const code = draft.projectCode.trim();
    if (!code) next.projectCode = c.projectCodeRequired;
    else if (existingCodes.some((x) => x.toLowerCase() === code.toLowerCase()))
      next.projectCode = c.projectCodeTaken;
    const co = coords();
    if (co.error) next.coords = co.error;
    if (!draft.address.trim() && co.lat === null) next.address = c.addressRequired;
    if (!draft.managerName.trim()) next.managerName = c.managerNameRequired;
    if (!manager.e164) next.managerPhone = copy.team.invite.phoneInvalid;
    if (draft.hasBackup && draft.backupPhone.trim() && !backup.e164)
      next.backupPhone = copy.team.invite.phoneInvalid;
    setErrors(next);
    if (Object.keys(next).length) return;
    onSubmit({ draft, lat: co.lat, lng: co.lng }, another);
  };

  const previewName = draft.managerName.trim()
    ? firstName(draft.managerName)
    : c.preview.placeholderName;
  const welcome = renderTemplateText('sitelog_welcome', [
    previewName,
    companyName || copy.app.name,
    draft.name.trim() || c.preview.placeholderSite,
    draft.deadline || '17:30',
  ]);

  const locationHint =
    geo.status === 'loading'
      ? c.geocoding
      : geo.status === 'found'
        ? c.geocoded(geo.result.lat.toFixed(4), geo.result.lng.toFixed(4))
        : c.addressHint;

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
                {c.sectionSite}
                {createdCount > 0 ? (
                  <span className="ml-2 font-mono text-[13px] font-medium text-dust">
                    {c.another(createdCount)}
                  </span>
                ) : null}
              </h2>
              <div className="grid gap-5 md:grid-cols-[minmax(0,1fr)_200px]">
                <Field id="site-name" label={c.name} error={errors.name}>
                  <Input
                    id="site-name"
                    value={draft.name}
                    onChange={(e) => set({ name: e.target.value })}
                    placeholder={c.namePlaceholder}
                    aria-invalid={!!errors.name}
                  />
                </Field>
                <Field id="site-code" label={c.projectCode} error={errors.projectCode}>
                  <Input
                    id="site-code"
                    value={draft.projectCode}
                    onChange={(e) => set({ projectCode: e.target.value.toUpperCase() })}
                    placeholder={c.projectCodePlaceholder}
                    className="font-mono"
                    aria-invalid={!!errors.projectCode}
                  />
                </Field>
              </div>
              <Field
                id="site-address"
                label={c.address}
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
                  placeholder={c.addressPlaceholder}
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
                  {c.notGeocoded}
                </div>
              ) : null}
              {manual ? (
                <div className="grid gap-5 sm:grid-cols-2">
                  <Field id="site-lat" label={c.lat} error={errors.coords}>
                    <Input
                      id="site-lat"
                      inputMode="decimal"
                      value={draft.lat}
                      onChange={(e) => set({ lat: e.target.value })}
                      className="font-mono"
                      aria-invalid={!!errors.coords}
                    />
                  </Field>
                  <Field id="site-lng" label={c.lng}>
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
                  {c.manualCoords}
                </Button>
              )}
              <div className="grid gap-5 md:grid-cols-2">
                <Field id="site-tz" label={c.timezone}>
                  <TimezoneSelect
                    id="site-tz"
                    value={draft.timezone}
                    onChange={(tz) => set({ timezone: tz })}
                  />
                </Field>
                <Field id="site-deadline" label={c.deadline} hint={c.deadlineHint}>
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
                {c.sectionManager}
              </h2>
              <Field id="mgr-name" label={c.managerName} error={errors.managerName}>
                <Input
                  id="mgr-name"
                  value={draft.managerName}
                  onChange={(e) => set({ managerName: e.target.value })}
                  placeholder={c.managerNamePlaceholder}
                  autoComplete="name"
                  aria-invalid={!!errors.managerName}
                />
              </Field>
              <PhoneInput
                label={c.phone}
                value={manager}
                onChange={(v) => set({ managerCountry: v.country, managerPhone: v.raw })}
                error={errors.managerPhone ?? null}
                required
                data-testid="manager-phone"
              />
              <fieldset className="grid gap-2">
                <legend className="text-caption font-medium">{c.languages}</legend>
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
                          'h-10 rounded-chip border px-3 text-[15px] font-medium',
                          on
                            ? 'border-asphalt bg-asphalt text-chalk'
                            : 'border-rebar bg-chalk text-asphalt hover:bg-concrete',
                        )}
                      >
                        {copy.team.invite.languageNames[l]}
                      </button>
                    );
                  })}
                </div>
                <p className="text-caption text-dust">
                  {copy.team.invite.languagesHint(reportLanguage)}
                </p>
              </fieldset>

              {draft.hasBackup ? (
                <div className="grid gap-5 rounded-card border border-rebar p-4">
                  <div className="flex items-center justify-between">
                    <h3 className="text-[15px] font-semibold">{c.backup}</h3>
                    <Button
                      variant="subtle"
                      size="dense"
                      onClick={() => set({ hasBackup: false, backupName: '', backupPhone: '' })}
                    >
                      <X aria-hidden="true" />
                      {c.removeBackup}
                    </Button>
                  </div>
                  <Field id="bk-name" label={c.backupName}>
                    <Input
                      id="bk-name"
                      value={draft.backupName}
                      onChange={(e) => set({ backupName: e.target.value })}
                      placeholder={c.managerNamePlaceholder}
                    />
                  </Field>
                  <PhoneInput
                    label={c.backupPhone}
                    value={backup}
                    onChange={(v) => set({ backupCountry: v.country, backupPhone: v.raw })}
                    error={errors.backupPhone ?? null}
                  />
                </div>
              ) : (
                <div>
                  <Button variant="ghost" size="dense" onClick={() => set({ hasBackup: true })}>
                    <UserPlus aria-hidden="true" />
                    {c.addBackup}
                  </Button>
                  <p className="mt-1 text-caption text-dust">{c.backupHint}</p>
                </div>
              )}
            </section>

            <div className="flex flex-col-reverse gap-2 border-t border-rebar pt-5 sm:flex-row sm:items-center sm:justify-between">
              <Button variant="ghost" onClick={onBack}>
                <ArrowLeft aria-hidden="true" />
                {copy.common.back}
              </Button>
              <div className="flex flex-col-reverse gap-2 sm:flex-row">
                <Button variant="ghost" disabled={busy} onClick={() => submit(true)}>
                  <Plus aria-hidden="true" />
                  {c.addAnother}
                </Button>
                <Button type="submit" variant="primary" loading={busy}>
                  <Send aria-hidden="true" />
                  {c.send}
                </Button>
              </div>
            </div>
          </form>
        </CardContent>
      </Card>

      <aside className="grid content-start gap-4" aria-label={c.preview.title(previewName)}>
        <Card>
          <CardContent className="p-5">
            <div className="eyebrow text-dust">{c.preview.title(previewName)}</div>
            <div className="mt-4 grid gap-3" data-testid="welcome-preview">
              <ChatBubble from={c.preview.from} text={welcome} buttons={c.preview.buttons} />
              <ChatBubble from={c.preview.from} text={c.preview.followUp} />
            </div>
          </CardContent>
        </Card>
        <Card dark>
          <CardContent className="p-5">
            <div className="flex items-baseline gap-2">
              <span className="font-display text-[36px] leading-10">{c.pricing.price}</span>
              <span className="font-mono text-data text-dust-light">{c.pricing.perMonth}</span>
            </div>
            <div className="mt-1 font-mono text-[12px] uppercase tracking-[0.08em] text-dust-light">
              {c.pricing.setup} · {c.pricing.billed}
            </div>
            <ul className="mt-4 space-y-1.5 border-t border-iron pt-3 text-caption text-dust-light">
              {c.pricing.points.map((p) => (
                <li key={p}>{p}</li>
              ))}
            </ul>
            {siteCount > 0 ? (
              <p className="mt-3 font-mono text-[12px] text-dust-light">
                {copy.billing.sitesTimes(siteCount)}
              </p>
            ) : null}
          </CardContent>
        </Card>
      </aside>
    </div>
  );
}

function ChatBubble({
  from,
  text,
  buttons,
}: {
  from: string;
  text: string;
  buttons?: readonly string[];
}) {
  return (
    <div className="max-w-[320px]">
      <div className="rounded-[14px] rounded-tl-[4px] border border-rebar bg-concrete px-3.5 py-2.5 text-[14px] leading-[20px]">
        <div className="eyebrow mb-1 text-dust">{from}</div>
        {text}
      </div>
      {buttons?.length ? (
        <div className="mt-1.5 flex gap-1.5">
          {buttons.map((b) => (
            <span
              key={b}
              className="rounded-[14px] border border-rebar bg-chalk px-3 py-1 text-[13px] font-medium text-level"
            >
              {b}
            </span>
          ))}
        </div>
      ) : null}
    </div>
  );
}
