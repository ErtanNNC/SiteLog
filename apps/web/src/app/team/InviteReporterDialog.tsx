import { useState } from 'react';
import { Link } from 'react-router';
import type { ContactPref, ReporterRole } from '@sitelog/shared/enums.ts';
import type { ReporterLocale } from '@sitelog/shared/locale.ts';
import { useAuth } from '@/auth/AuthProvider';
import { canAccess, ROUTE_ROLES } from '@/auth/guards';
import {
  emptyPhone,
  PhoneInput,
  phoneCountryFor,
  type PhoneValue,
} from '@/components/sitelog/PhoneInput';
import { Button } from '@/components/ui/Button';
import { Checkbox } from '@/components/ui/Checkbox';
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/Dialog';
import { Input } from '@/components/ui/Input';
import { Label } from '@/components/ui/Label';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/Select';
import { useInviteReporter, useSettings } from '@/data/hooks';
import type { SiteOption, TeamPack } from '@/data/types';
import { useCopy } from '@/i18n/useCopy';
import { reportLanguageFor } from '@sitelog/shared/locale.ts';
import { LANGUAGES, languageLabel } from './labels';
import { PreferenceField } from './PreferenceField';
import { SmsAttestField } from './SmsAttestField';

export { LANGUAGES } from './labels';

interface Props {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  sites: SiteOption[];
  /** The org's pack (W4-03): the languages TalkOlog uses and whether it has a number to call. */
  pack?: Pick<TeamPack, 'fieldLocales' | 'hasVoiceNumber'>;
  defaultSiteIds?: string[];
}

/**
 * P10 "Invite reporter": name, mobile (W4-01's picker and warning), role, sites, the languages they
 * speak, the language TalkOlog uses with them and the preferred channel (W4-03) → the welcome
 * text (F3, by SMS, §19 Q25). The office attests the person agreed to get daily report messages (text or WhatsApp)
 * (owner decision 2026-10-20); the invite cannot be sent without it.
 */
export function InviteReporterDialog({
  open,
  onOpenChange,
  sites,
  pack,
  defaultSiteIds = [],
}: Props) {
  const { t } = useCopy();
  const invite = useInviteReporter();
  const { role: memberRole, currentOrg } = useAuth();
  // The number's country starts as the org's (its country pack, spec §4.6); another country's
  // number is allowed, with Q23's warning (the org's pack still applies).
  const phoneCountry = phoneCountryFor(currentOrg?.country);
  const locales: ReporterLocale[] = pack?.fieldLocales.length ? pack.fieldLocales : ['en-US'];
  // A reporter reports for a site; with none yet the dialog explains how to get one.
  const noSites = sites.length === 0;
  const canAddSite = canAccess(memberRole, ROUTE_ROLES.setup!);
  const [name, setName] = useState('');
  const [phone, setPhone] = useState<PhoneValue>(emptyPhone(phoneCountry));
  const [role, setRole] = useState<ReporterRole>('site_manager');
  const [siteIds, setSiteIds] = useState<string[]>(defaultSiteIds);
  const [languages, setLanguages] = useState<string[]>(['en']);
  const [locale, setLocale] = useState<ReporterLocale>(locales[0]!);
  // W4-05 (§19 Q231): the org's default preference for new reporters.
  const orgDefaultPref = useSettings().data?.settings.default_contact_pref ?? 'link';
  // null until the user picks one: the default follows the settings once they load.
  const [chosenPref, setContactPref] = useState<ContactPref | null>(null);
  const contactPref = chosenPref ?? orgDefaultPref;
  const [smsAttested, setSmsAttested] = useState(false);
  const [errors, setErrors] = useState<Record<string, string>>({});

  const reset = () => {
    setName('');
    setPhone(emptyPhone(phoneCountry));
    setRole('site_manager');
    setSiteIds(defaultSiteIds);
    setLanguages(['en']);
    setLocale(locales[0]!);
    setContactPref(null);
    setSmsAttested(false);
    setErrors({});
  };

  const toggle = (list: string[], id: string, on: boolean) =>
    on ? [...list, id] : list.filter((x) => x !== id);

  const submit = () => {
    if (noSites) return;
    const next: Record<string, string> = {};
    if (!name.trim()) next.name = t('team.invite.nameRequired');
    if (!phone.e164) next.phone = t('phone.invalid');
    if (siteIds.length === 0) next.sites = t('team.invite.sitesRequired');
    if (!smsAttested) next.smsAttest = t('team.invite.attestation_required');
    setErrors(next);
    if (Object.keys(next).length) return;
    invite.mutate(
      {
        name: name.trim(),
        phone: phone.e164!,
        role,
        siteIds,
        languages: languages.length ? languages : ['en'],
        locale,
        contactPref,
        smsAttested,
      },
      {
        onSuccess: () => {
          onOpenChange(false);
          reset();
        },
      },
    );
  };

  return (
    <Dialog
      open={open}
      onOpenChange={(o) => {
        onOpenChange(o);
        if (!o) reset();
      }}
    >
      <DialogContent className="max-h-[calc(100dvh-32px)] max-w-xl overflow-y-auto">
        <DialogHeader>
          <DialogTitle>{t('team.invite.title')}</DialogTitle>
          <DialogDescription>{t('team.invite.description')}</DialogDescription>
        </DialogHeader>
        <form
          className="mt-4 grid gap-4"
          noValidate
          onSubmit={(e) => {
            e.preventDefault();
            submit();
          }}
        >
          <div className="grid gap-1.5">
            <Label htmlFor="inv-name">{t('team.invite.name')}</Label>
            <Input
              id="inv-name"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder={t('team.invite.namePlaceholder')}
              autoComplete="name"
              aria-invalid={!!errors.name}
            />
            {errors.name ? (
              <p role="alert" className="text-caption font-medium text-missing">
                {errors.name}
              </p>
            ) : null}
          </div>
          <PhoneInput
            label={t('team.invite.phone')}
            value={phone}
            onChange={setPhone}
            packCountry={currentOrg?.country}
            error={errors.phone ?? null}
            required
            data-testid="invite-phone"
          />
          <div className="grid gap-4 sm:grid-cols-2">
            <div className="grid gap-1.5">
              <Label htmlFor="inv-role">{t('team.invite.role')}</Label>
              <Select value={role} onValueChange={(v) => setRole(v as ReporterRole)}>
                <SelectTrigger id="inv-role">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="site_manager">{t('team.roles.site_manager')}</SelectItem>
                  <SelectItem value="backup">{t('team.roles.backup')}</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div className="grid gap-1.5">
              <Label htmlFor="inv-locale">{t('team.invite.language')}</Label>
              <Select value={locale} onValueChange={(v) => setLocale(v as ReporterLocale)}>
                <SelectTrigger id="inv-locale" data-testid="invite-locale">
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
            </div>
          </div>
          <PreferenceField
            idPrefix="inv"
            legend={t('team.invite.preference')}
            value={contactPref}
            onChange={setContactPref}
            hint={
              contactPref === 'call' && pack && !pack.hasVoiceNumber
                ? t('team.invite.callTalkNow')
                : t('team.invite.preferenceHint')
            }
          />
          <fieldset className="grid gap-2">
            <legend className="text-caption font-medium">{t('team.invite.sites')}</legend>
            {noSites ? (
              <div
                className="flex flex-wrap items-center justify-between gap-3 rounded-card border border-dashed border-rebar bg-concrete/60 p-3"
                data-testid="invite-no-sites"
              >
                <p className="text-[15px] text-dust">
                  {canAddSite ? t('team.invite.noSites') : t('team.invite.noSitesAskAdmin')}
                </p>
                {canAddSite ? (
                  <Button variant="secondary" asChild>
                    <Link to="/setup/site">{t('team.invite.addSite')}</Link>
                  </Button>
                ) : null}
              </div>
            ) : null}
            <div className="grid gap-1 sm:grid-cols-2">
              {sites.map((s) => (
                <label key={s.id} className="flex min-h-target items-center gap-3 text-[15px]">
                  <Checkbox
                    checked={siteIds.includes(s.id)}
                    onCheckedChange={(v) => setSiteIds((prev) => toggle(prev, s.id, v === true))}
                    aria-label={s.name}
                  />
                  <span className="truncate">{s.name}</span>
                </label>
              ))}
            </div>
            {errors.sites ? (
              <p role="alert" className="text-caption font-medium text-missing">
                {errors.sites}
              </p>
            ) : null}
          </fieldset>
          <fieldset className="grid gap-2">
            <legend className="text-caption font-medium">{t('team.invite.languages')}</legend>
            <div className="flex flex-wrap gap-2">
              {LANGUAGES.map((l) => {
                const on = languages.includes(l);
                return (
                  <button
                    key={l}
                    type="button"
                    role="checkbox"
                    aria-checked={on}
                    onClick={() => setLanguages((prev) => toggle(prev, l, !on))}
                    className={
                      on
                        ? 'h-target rounded-chip border border-asphalt bg-asphalt px-3 text-[15px] font-medium text-chalk'
                        : 'h-target rounded-chip border border-rebar bg-chalk px-3 text-[15px] font-medium text-asphalt hover:bg-concrete'
                    }
                  >
                    {languageLabel(t, l)}
                  </button>
                );
              })}
            </div>
            <p className="text-caption text-dust">
              {t('team.invite.languagesHint', {
                language: languageLabel(t, reportLanguageFor(currentOrg?.locale ?? 'en-US')),
              })}
            </p>
          </fieldset>
          <SmsAttestField
            id="invite-sms-attest"
            name={name}
            checked={smsAttested}
            onCheckedChange={setSmsAttested}
            error={errors.smsAttest}
          />
          <DialogFooter className="mt-2">
            <DialogClose asChild>
              <Button variant="ghost">{t('common.cancel')}</Button>
            </DialogClose>
            <Button type="submit" variant="primary" loading={invite.isPending} disabled={noSites}>
              {t('team.invite.send')}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
