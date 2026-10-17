import { useState } from 'react';
import { toast } from 'sonner';
import type { ContactPref, MessageChannel, ReporterRole } from '@sitelog/shared/enums.ts';
import { firstName, formatPhone } from '@sitelog/shared/format.ts';
import { reportLanguageFor, type ReporterLocale } from '@sitelog/shared/locale.ts';
import { useAuth } from '@/auth/AuthProvider';
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
import { useUpdateReporter, useUpdateReporterContact } from '@/data/hooks';
import type { SiteOption, TeamPack, TeamReporter } from '@/data/types';
import { translate, useCopy } from '@/i18n/useCopy';
import { LANGUAGES, languageLabel } from './labels';
import { PreferenceField } from './PreferenceField';

interface Props {
  reporter: TeamReporter | null;
  onOpenChange: (open: boolean) => void;
  sites: SiteOption[];
  pack: TeamPack;
}

const sameSet = (a: readonly string[], b: readonly string[]) =>
  a.length === b.length && a.every((x) => b.includes(x));

/** The Select's value for "no preference" (null = the pack's order, §4.5). */
const DEFAULT_CHANNEL = 'default';

/**
 * Team row menu → Edit (P10, F15 "Office"; W4-03): name, role, sites and languages
 * (`update_reporter()`), and the preference, message channel and language SiteLog uses
 * (`update_reporter_contact()`). A preference or channel change needs "{first} asked for this
 * change" (§19 Q243); a channel without its consent is saved and Edit says it stays unreachable
 * until they turn it on. The phone is read-only: a new number means disable + invite again.
 */
export function EditReporterDialog({ reporter, onOpenChange, sites, pack }: Props) {
  const { t } = useCopy();
  const update = useUpdateReporter();
  const updateContact = useUpdateReporterContact();
  const { currentOrg } = useAuth();
  // The parent keys this dialog by reporter id, so state initialises per reporter.
  const [name, setName] = useState(reporter?.name ?? '');
  const [role, setRole] = useState<ReporterRole>(reporter?.role ?? 'site_manager');
  const [siteIds, setSiteIds] = useState<string[]>(() => reporter?.sites.map((s) => s.id) ?? []);
  const [languages, setLanguages] = useState<string[]>(() => reporter?.languages ?? ['en']);
  const [contactPref, setContactPref] = useState<ContactPref>(reporter?.contactPref ?? 'link');
  const [channel, setChannel] = useState<MessageChannel | null>(reporter?.messageChannel ?? null);
  const [locale, setLocale] = useState<ReporterLocale>(
    reporter?.locale ?? pack.fieldLocales[0] ?? 'en-US',
  );
  const [attested, setAttested] = useState(false);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const first = firstName(reporter?.name ?? '');

  // Keep languages outside the default list (e.g. set by an earlier import) visible and editable.
  const languageOptions = [
    ...LANGUAGES,
    ...(reporter?.languages ?? []).filter((l) => !(LANGUAGES as readonly string[]).includes(l)),
  ];
  const locales = [
    ...pack.fieldLocales,
    ...(reporter && !pack.fieldLocales.includes(reporter.locale) ? [reporter.locale] : []),
  ];
  const channels = [
    ...pack.settingsChannels,
    ...(reporter?.messageChannel && !pack.settingsChannels.includes(reporter.messageChannel)
      ? [reporter.messageChannel]
      : []),
  ];
  const toggle = (list: string[], id: string, on: boolean) =>
    on ? [...list, id] : list.filter((x) => x !== id);

  const basicsDirty =
    !!reporter &&
    (name.trim() !== reporter.name ||
      role !== reporter.role ||
      !sameSet(
        siteIds,
        reporter.sites.map((s) => s.id),
      ) ||
      languages.join() !== reporter.languages.join());
  const reachDirty =
    !!reporter && (contactPref !== reporter.contactPref || channel !== reporter.messageChannel);
  const contactDirty = reachDirty || (!!reporter && locale !== reporter.locale);
  const dirty = basicsDirty || contactDirty;
  // §19 Q243: a channel saved without its consent stays unreachable until they consent.
  const channelNotAgreed = channel !== null && !!reporter && !reporter.consents.includes(channel);

  const submit = async () => {
    if (!reporter) return;
    const next: Record<string, string> = {};
    if (!name.trim()) next.name = t('team.invite.nameRequired');
    if (siteIds.length === 0) next.sites = t('team.invite.sitesRequired');
    if (reachDirty && !attested) next.attest = t('team.edit.attestRequired', { first });
    setErrors(next);
    if (Object.keys(next).length) return;
    try {
      if (contactDirty) {
        await updateContact.mutateAsync({
          reporterId: reporter.id,
          contactPref,
          messageChannel: channel,
          locale,
          attested: reachDirty && attested,
        });
      }
      if (basicsDirty) {
        await update.mutateAsync({
          reporterId: reporter.id,
          name: name.trim(),
          role,
          siteIds,
          languages: languages.length ? languages : ['en'],
        });
      } else {
        toast.success(translate('team.toasts.updated', { name: reporter.name }));
      }
      onOpenChange(false);
    } catch {
      // The hooks toast the refusal; the dialog stays open.
    }
  };

  return (
    <Dialog open={!!reporter} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[calc(100dvh-32px)] max-w-xl overflow-y-auto">
        <DialogHeader>
          <DialogTitle>{t('team.edit.title', { name: reporter?.name ?? '' })}</DialogTitle>
          <DialogDescription>{t('team.edit.description')}</DialogDescription>
        </DialogHeader>
        <form
          className="mt-4 grid gap-4"
          noValidate
          onSubmit={(ev) => {
            ev.preventDefault();
            void submit();
          }}
        >
          <div className="grid gap-1.5">
            <Label htmlFor="edit-name">{t('team.invite.name')}</Label>
            <Input
              id="edit-name"
              value={name}
              onChange={(ev) => setName(ev.target.value)}
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
          <div className="grid gap-1.5">
            <Label htmlFor="edit-phone">{t('team.edit.phone')}</Label>
            <Input
              id="edit-phone"
              value={reporter ? formatPhone(reporter.phone) : ''}
              readOnly
              aria-readonly="true"
              aria-describedby="edit-phone-hint"
              className="bg-concrete font-mono text-dust"
              data-testid="edit-phone"
            />
            <p id="edit-phone-hint" className="text-caption text-dust">
              {t('team.edit.phoneHint')}
            </p>
          </div>
          <div className="grid gap-4 sm:grid-cols-2">
            <div className="grid gap-1.5">
              <Label htmlFor="edit-role">{t('team.invite.role')}</Label>
              <Select value={role} onValueChange={(v) => setRole(v as ReporterRole)}>
                <SelectTrigger id="edit-role">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="site_manager">{t('team.roles.site_manager')}</SelectItem>
                  <SelectItem value="backup">{t('team.roles.backup')}</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div className="grid gap-1.5">
              <Label htmlFor="edit-locale">{t('team.edit.language')}</Label>
              <Select value={locale} onValueChange={(v) => setLocale(v as ReporterLocale)}>
                <SelectTrigger id="edit-locale" aria-describedby="edit-locale-hint">
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
              <p id="edit-locale-hint" className="text-caption text-dust">
                {t('team.edit.languageHint')}
              </p>
            </div>
          </div>
          <PreferenceField
            idPrefix="edit"
            legend={t('team.edit.preference')}
            value={contactPref}
            onChange={setContactPref}
            hint={
              contactPref === 'call' && !pack.hasVoiceNumber
                ? t('team.invite.callTalkNow')
                : undefined
            }
          />
          <div className="grid gap-1.5">
            <Label htmlFor="edit-channel">{t('team.edit.messageChannel')}</Label>
            <Select
              value={channel ?? DEFAULT_CHANNEL}
              onValueChange={(v) =>
                setChannel(v === DEFAULT_CHANNEL ? null : (v as MessageChannel))
              }
            >
              <SelectTrigger id="edit-channel" data-testid="edit-channel">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value={DEFAULT_CHANNEL}>
                  {t('team.edit.channelDefault', {
                    order: pack.messageChannels.map((c) => t(`team.channels.${c}`)).join(' → '),
                  })}
                </SelectItem>
                {channels.map((c) => (
                  <SelectItem key={c} value={c}>
                    {t(`team.channels.${c}`)}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            {channelNotAgreed && channel ? (
              <p className="text-caption text-dust" data-testid="channel-not-agreed">
                {t('team.edit.channelNotAgreed', {
                  first,
                  channel: t(`team.channels.${channel}`),
                })}
              </p>
            ) : null}
          </div>
          {reachDirty ? (
            <div className="grid gap-1 rounded-card border border-rebar bg-concrete/60 p-3">
              <label className="flex min-h-target items-center gap-3 text-[15px] font-medium">
                <Checkbox
                  checked={attested}
                  onCheckedChange={(v) => setAttested(v === true)}
                  aria-describedby="edit-attest-hint"
                  aria-invalid={!!errors.attest}
                />
                {t('team.edit.attest', { first })}
              </label>
              <p id="edit-attest-hint" className="text-caption text-dust">
                {t('team.edit.attestHint')}
              </p>
              {errors.attest ? (
                <p role="alert" className="text-caption font-medium text-missing">
                  {errors.attest}
                </p>
              ) : null}
            </div>
          ) : null}
          <fieldset className="grid gap-2">
            <legend className="text-caption font-medium">{t('team.invite.sites')}</legend>
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
              {languageOptions.map((l) => {
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
          <DialogFooter className="mt-2">
            <DialogClose asChild>
              <Button variant="ghost">{t('common.cancel')}</Button>
            </DialogClose>
            <Button
              type="submit"
              variant="primary"
              disabled={!dirty}
              loading={update.isPending || updateContact.isPending}
            >
              {t('team.edit.save')}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
