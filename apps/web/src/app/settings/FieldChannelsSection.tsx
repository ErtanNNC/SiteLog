import { MessageSquareText, PhoneCall } from 'lucide-react';
import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { toast } from 'sonner';
import { fieldLanguagesOf, recordingNoticeFor } from '@sitelog/shared/copy/legal/index.ts';
import type { CountryPack } from '@sitelog/shared/countries.ts';
import { formatPhone } from '@sitelog/shared/format.ts';
import { isDailyLinkTtlHours } from '@sitelog/shared/links.ts';
import type { Language } from '@sitelog/shared/locale.ts';
import { DEFAULT_CALL_WINDOW, DEFAULT_DAILY_LINK_TIME } from '@sitelog/shared/schedule/remind.ts';
import { placesCalls } from '@sitelog/shared/voice-outbound.ts';
import { PreferenceField } from '@/app/team/PreferenceField';
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
import { hhmm } from '@/data/assemble';
import { useCallMeNow, useSendTestMessage } from '@/data/hooks';
import type { SendTestMessageResult } from '@/data/source';
import type { SettingsData } from '@/data/types';
import { useCopy, type CopyT } from '@/i18n/useCopy';
import { errorCode } from '@/lib/utils';
import { SettingsCard, SwitchRow } from './fields';
import type { SectionProps } from './ReportsSection';

export interface FieldChannelsSectionProps extends SectionProps {
  org: SettingsData['org'];
  pack: CountryPack | null;
  /** True while a field holds text that cannot be saved (Save waits for it). */
  onInvalidChange: (invalid: boolean) => void;
}

/** "TR" → "Türkiye" / "Turkey" in the panel's language (the code when the browser has no name). */
function countryName(code: string, language: string): string {
  try {
    return new Intl.DisplayNames([language], { type: 'region' }).of(code) ?? code;
  } catch {
    return code;
  }
}

/**
 * P12 · Settings → Field channels (F22; W4-05): the org's country pack read-only ("Set by SiteLog
 * per country"), the daily link time and expiry (§19 Q231), the two call switches where the org
 * places calls and the call window (also the quiet hours of reminder texts, §19 Q30, Q77), the
 * default preference for new reporters (§19 Q231), the recording notice per field language with its
 * version, and _Send me a test message_ (§19 Q232). Every value but the test message is saved with
 * "Save changes" (org_settings, audited `settings.updated`).
 */
export function FieldChannelsSection({
  draft,
  update,
  org,
  pack,
  onInvalidChange,
}: FieldChannelsSectionProps) {
  const { t, language } = useCopy();
  const country = countryName(org.country, language);
  const callsPlaced = pack ? placesCalls({ isDemo: org.isDemo }, pack) : false;

  // The expiry is typed as text: an empty field is "SiteLog's default" (null), anything else must
  // be whole hours in range before it reaches the draft.
  const [ttlText, setTtlText] = useState(
    draft.daily_link_ttl_hours === null ? '' : String(draft.daily_link_ttl_hours),
  );
  const ttlInvalid = ttlText.trim() !== '' && !isDailyLinkTtlHours(Number(ttlText.trim()));
  useEffect(() => {
    onInvalidChange(ttlInvalid);
  }, [ttlInvalid, onInvalidChange]);
  // Leaving the tab drops the typed text (the draft keeps its last valid value).
  useEffect(() => () => onInvalidChange(false), [onInvalidChange]);
  const onTtl = (text: string) => {
    setTtlText(text);
    const v = text.trim();
    if (v === '') update({ daily_link_ttl_hours: null });
    else if (isDailyLinkTtlHours(Number(v))) update({ daily_link_ttl_hours: Number(v) });
  };

  const time = (value: string | null, fallback: string) => hhmm(value, fallback);
  // A cleared time field keeps the last time (the columns have defaults, never "no time").
  const setTime = (key: 'daily_link_time' | 'call_window_start' | 'call_window_end', v: string) => {
    if (v) update({ [key]: `${v}:00` });
  };

  return (
    <div className="grid gap-6" data-testid="field-channels">
      {pack ? (
        <PackCard pack={pack} country={country} />
      ) : (
        <SettingsCard title={t('settings.channels.pack')}>
          <p className="text-caption text-dust">{t('settings.channels.packMissing')}</p>
        </SettingsCard>
      )}

      <SettingsCard title={t('settings.channels.dailyLink')}>
        <div className="grid gap-5 md:grid-cols-2">
          <div className="grid content-start gap-1.5">
            <Label htmlFor="daily-link-time">{t('settings.channels.dailyLinkTime')}</Label>
            <Input
              id="daily-link-time"
              type="time"
              value={time(draft.daily_link_time, DEFAULT_DAILY_LINK_TIME)}
              onChange={(e) => setTime('daily_link_time', e.target.value)}
              className="w-40 font-mono"
              aria-describedby="daily-link-time-hint"
            />
            <p id="daily-link-time-hint" className="text-caption text-dust">
              {t('settings.channels.dailyLinkTimeHint')}
            </p>
          </div>
          <div className="grid content-start gap-1.5">
            <Label htmlFor="daily-link-ttl">{t('settings.channels.ttl')}</Label>
            <Input
              id="daily-link-ttl"
              inputMode="numeric"
              value={ttlText}
              onChange={(e) => onTtl(e.target.value)}
              className="w-40 font-mono tabular"
              aria-invalid={ttlInvalid}
              aria-describedby="daily-link-ttl-hint"
              data-testid="daily-link-ttl"
            />
            <p
              id="daily-link-ttl-hint"
              className={
                ttlInvalid ? 'text-caption font-medium text-missing' : 'text-caption text-dust'
              }
              role={ttlInvalid ? 'alert' : undefined}
            >
              {ttlInvalid ? t('settings.channels.ttlInvalid') : t('settings.channels.ttlHint')}
            </p>
          </div>
        </div>
      </SettingsCard>

      <SettingsCard title={t('settings.channels.calls')} data-testid="calls-card">
        {callsPlaced ? (
          <div className="grid gap-2">
            <SwitchRow
              id="auto-call"
              label={t('settings.channels.autoCall')}
              hint={t('settings.channels.autoCallHint')}
              checked={draft.auto_call_enabled ?? true}
              onCheckedChange={(v) => update({ auto_call_enabled: v })}
            />
            <SwitchRow
              id="second-call"
              label={t('settings.channels.secondCall')}
              hint={t('settings.channels.secondCallHint')}
              checked={draft.second_call_enabled ?? true}
              onCheckedChange={(v) => update({ second_call_enabled: v })}
            />
          </div>
        ) : (
          <p className="text-[15px]" data-testid="no-calls">
            {t('settings.channels.noCalls', { country })}
          </p>
        )}
        <fieldset className="mt-5 grid gap-2 border-t border-rebar pt-4">
          <legend className="text-[15px] font-medium">{t('settings.channels.callWindow')}</legend>
          <div className="flex flex-wrap items-end gap-4">
            <div className="grid gap-1.5">
              <Label htmlFor="call-window-start">{t('settings.channels.callWindowFrom')}</Label>
              <Input
                id="call-window-start"
                type="time"
                value={time(draft.call_window_start, DEFAULT_CALL_WINDOW.start)}
                onChange={(e) => setTime('call_window_start', e.target.value)}
                className="w-40 font-mono"
              />
            </div>
            <div className="grid gap-1.5">
              <Label htmlFor="call-window-end">{t('settings.channels.callWindowTo')}</Label>
              <Input
                id="call-window-end"
                type="time"
                value={time(draft.call_window_end, DEFAULT_CALL_WINDOW.end)}
                onChange={(e) => setTime('call_window_end', e.target.value)}
                className="w-40 font-mono"
              />
            </div>
          </div>
          <p className="text-caption text-dust">{t('settings.channels.callWindowHint')}</p>
        </fieldset>
      </SettingsCard>

      <SettingsCard title={t('settings.channels.newReporters')}>
        <PreferenceField
          idPrefix="settings-default"
          legend={t('settings.channels.defaultPref')}
          value={draft.default_contact_pref}
          onChange={(v) => update({ default_contact_pref: v })}
          hint={t('settings.channels.defaultPrefHint')}
        />
      </SettingsCard>

      {pack ? <RecordingNoticeCard pack={pack} /> : null}

      <TestCard org={org} pack={pack} country={country} callsPlaced={callsPlaced} />
    </div>
  );
}

function PackRow({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="grid gap-0.5 border-b border-rebar py-2.5 last:border-b-0 sm:grid-cols-[220px_minmax(0,1fr)] sm:gap-4">
      <dt className="text-caption font-medium text-dust">{label}</dt>
      <dd className="min-w-0 break-words text-[15px]">{children}</dd>
    </div>
  );
}

/** The pack as SiteLog set it, read-only (§4.6: a pack is a database row, never edited here). */
function PackCard({ pack, country }: { pack: CountryPack; country: string }) {
  const { t } = useCopy();
  const order = pack.messageChannels.map((c) => t(`team.channels.${c}`)).join(' → ');
  return (
    <SettingsCard
      title={t('settings.channels.pack')}
      hint={t('settings.channels.packHint')}
      data-testid="pack-card"
    >
      <dl data-testid="pack-details">
        <PackRow label={t('settings.channels.country')}>
          {country} <span className="font-mono text-[13px] text-dust">{pack.code}</span>
        </PackRow>
        <PackRow label={t('settings.channels.sender')}>
          {t(`settings.channels.senderTypes.${pack.smsSenderType}`)} ·{' '}
          {pack.smsSenderId ? (
            <span className="font-mono">
              {pack.smsSenderType === 'alphanumeric' || pack.smsSenderType === 'short_code'
                ? pack.smsSenderId
                : formatPhone(pack.smsSenderId)}
            </span>
          ) : (
            <span data-testid="sender-not-set">{t('settings.channels.senderNotSet')}</span>
          )}
        </PackRow>
        <PackRow label={t('settings.channels.voiceNumber')}>
          {pack.voiceNumber ? (
            <span className="font-mono">{formatPhone(pack.voiceNumber)}</span>
          ) : (
            t('settings.channels.talkNowOnly')
          )}
        </PackRow>
        <PackRow label={t('settings.channels.channelOrder')}>
          <span data-testid="channel-order">{order}</span>
        </PackRow>
        <PackRow label={t('settings.channels.twoWay')}>
          {pack.twoWaySms ? t('settings.channels.twoWayYes') : t('settings.channels.twoWayNo')}
        </PackRow>
        <PackRow label={t('settings.channels.links')}>
          {pack.smsLinksAllowed ? t('settings.channels.linksYes') : t('settings.channels.linksNo')}
        </PackRow>
      </dl>
    </SettingsCard>
  );
}

/**
 * The recording notice a call says in each of the pack's field languages, with its version: the
 * pack's `legal_keys.recording_notice` text when set, else `voice.recording_notice.v1` (W4-06,
 * `recordingNoticeFor`). Read-only: counsel's texts reach a pack by migration (§19 Q28).
 */
function RecordingNoticeCard({ pack }: { pack: CountryPack }) {
  const { t } = useCopy();
  const languages = fieldLanguagesOf(pack.fieldLocales);
  return (
    <SettingsCard
      title={t('settings.channels.notice')}
      hint={t('settings.channels.noticeHint')}
      data-testid="recording-notice"
    >
      <ul className="grid gap-3">
        {languages.map((lang) => {
          const notice = recordingNoticeFor(pack.legalKeys.recordingNotice, lang);
          return (
            <li key={lang} className="rounded-card border border-rebar p-3" data-language={lang}>
              <div className="flex flex-wrap items-baseline justify-between gap-2">
                <span className="text-[15px] font-medium">
                  {t(`team.invite.languageNames.${lang}`)}
                </span>
                <span className="font-mono text-[12px] text-dust">
                  {t('settings.channels.noticeVersion', { version: notice.version })}
                </span>
              </div>
              <p lang={lang} className="mt-1 text-[15px]">
                {notice.text}
              </p>
            </li>
          );
        })}
      </ul>
    </SettingsCard>
  );
}

function resultText(t: CopyT, r: SendTestMessageResult, country: string): string {
  if (r.outcome === 'sent') return t('settings.channels.testResults.sent');
  if (r.outcome === 'failed') return t('settings.channels.testResults.failed');
  return r.reason === 'demo'
    ? t('settings.channels.testResults.demo')
    : t('settings.channels.testResults.noSender', { country });
}

/** The pack's field languages (the test text's and call's language choices), English without one. */
function useFieldLanguages(pack: CountryPack | null): Language[] {
  return useMemo(() => {
    const own = pack ? fieldLanguagesOf(pack.fieldLocales) : [];
    return own.length ? own : ['en'];
  }, [pack]);
}

/**
 * §19 Q232: _Send me a test message_ to a number typed each time, which the admin attests is their
 * own (not stored); the pack's transport, five an hour. _Call me now_ (§19 Q350) only where the org
 * places calls: the same sheet, a short scripted call (the disclosure, one line, goodbye), nothing
 * recorded; elsewhere the Calls card already says why there is none.
 */
function TestCard({
  org,
  pack,
  country,
  callsPlaced,
}: {
  org: SettingsData['org'];
  pack: CountryPack | null;
  country: string;
  callsPlaced: boolean;
}) {
  const { t, language } = useCopy();
  const send = useSendTestMessage();
  const phoneCountry = phoneCountryFor(org.country);
  const languages = useFieldLanguages(pack);
  const [callOpen, setCallOpen] = useState(false);
  const [open, setOpen] = useState(false);
  const [phone, setPhone] = useState<PhoneValue>(emptyPhone(phoneCountry));
  const [textLanguage, setTextLanguage] = useState<Language>(
    languages.includes(language) ? language : languages[0]!,
  );
  const [attested, setAttested] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<string | null>(null);

  const reset = () => {
    setPhone(emptyPhone(phoneCountry));
    setAttested(false);
    setError(null);
    setResult(null);
  };

  const submit = async () => {
    setResult(null);
    if (!phone.e164) return setError(t('settings.channels.testResults.invalidPhone'));
    if (!attested) return setError(t('settings.channels.testDialog.attestRequired'));
    setError(null);
    try {
      const r = await send.mutateAsync({ phone: phone.e164, language: textLanguage });
      const text = resultText(t, r, country);
      setResult(text);
      if (r.outcome === 'failed') toast.error(text);
      else toast.success(text);
    } catch (err) {
      const code = errorCode(err);
      setError(
        code === 'rate_limited'
          ? t('settings.channels.testResults.rateLimited')
          : code === 'invalid_phone'
            ? t('settings.channels.testResults.invalidPhone')
            : t('errors.generic'),
      );
    }
  };

  return (
    <SettingsCard
      title={t('settings.channels.test')}
      hint={t('settings.channels.testHint')}
      data-testid="test-card"
    >
      <div className="flex flex-wrap gap-3">
        <Button
          variant="ghost"
          onClick={() => {
            reset();
            setOpen(true);
          }}
        >
          <MessageSquareText aria-hidden="true" />
          {t('settings.channels.testMessage')}
        </Button>
        {callsPlaced ? (
          <Button variant="ghost" onClick={() => setCallOpen(true)} data-testid="call-me-now">
            <PhoneCall aria-hidden="true" />
            {t('settings.channels.callMeNow')}
          </Button>
        ) : null}
      </div>
      {callsPlaced ? (
        <CallMeNowDialog
          open={callOpen}
          onOpenChange={setCallOpen}
          org={org}
          languages={languages}
          country={country}
        />
      ) : null}
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{t('settings.channels.testDialog.title')}</DialogTitle>
            <DialogDescription>{t('settings.channels.testDialog.body')}</DialogDescription>
          </DialogHeader>
          <form
            className="grid gap-4"
            noValidate
            onSubmit={(e) => {
              e.preventDefault();
              void submit();
            }}
          >
            <PhoneInput
              label={t('settings.channels.testDialog.phone')}
              value={phone}
              onChange={setPhone}
              packCountry={org.country}
              required
              data-testid="test-phone"
            />
            {languages.length > 1 ? (
              <div className="grid gap-1.5">
                <Label htmlFor="test-language">{t('settings.channels.testDialog.language')}</Label>
                <Select value={textLanguage} onValueChange={(v) => setTextLanguage(v as Language)}>
                  <SelectTrigger id="test-language">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {languages.map((l) => (
                      <SelectItem key={l} value={l}>
                        {t(`team.invite.languageNames.${l}`)}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            ) : null}
            <label
              htmlFor="test-attest"
              className="flex min-h-target cursor-pointer items-center gap-3 text-[15px]"
            >
              <Checkbox
                id="test-attest"
                checked={attested}
                onCheckedChange={(v) => setAttested(v === true)}
              />
              {t('settings.channels.testDialog.attest')}
            </label>
            {error ? (
              <p role="alert" className="text-caption font-medium text-missing">
                {error}
              </p>
            ) : null}
            {result ? (
              <p role="status" className="text-[15px]" data-testid="test-result">
                {result}
              </p>
            ) : null}
            <DialogFooter>
              <Button type="button" variant="ghost" onClick={() => setOpen(false)}>
                {t('common.close')}
              </Button>
              <Button type="submit" variant="primary" loading={send.isPending}>
                {t('settings.channels.testDialog.send')}
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>
    </SettingsCard>
  );
}

function callError(t: CopyT, code: string | null | undefined, country: string): string {
  switch (code) {
    case 'rate_limited':
      return t('settings.channels.callResults.rateLimited');
    case 'call_live':
      return t('settings.channels.callResults.callLive');
    case 'no_trunk':
      return t('settings.channels.callResults.noTrunk', { country });
    case 'invalid_phone':
      return t('settings.channels.callResults.invalidPhone');
    case 'attestation_required':
      return t('settings.channels.callDialog.attestRequired');
    default:
      return t('errors.generic');
  }
}

/**
 * §19 Q232, Q350: _Call me now_, a short scripted test call to the admin's own number (typed each
 * time, attested, never kept): the disclosure, one line, goodbye, nothing recorded. One at a time,
 * five an hour per org (settings_test_call_start()); a demo org's call is the console's.
 */
function CallMeNowDialog({
  open,
  onOpenChange,
  org,
  languages,
  country,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  org: SettingsData['org'];
  languages: Language[];
  country: string;
}) {
  const { t, language } = useCopy();
  const callMe = useCallMeNow();
  const phoneCountry = phoneCountryFor(org.country);
  const [phone, setPhone] = useState<PhoneValue>(emptyPhone(phoneCountry));
  const [callLanguage, setCallLanguage] = useState<Language>(
    languages.includes(language) ? language : languages[0]!,
  );
  const [attested, setAttested] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<string | null>(null);

  const change = (next: boolean) => {
    if (next) {
      setPhone(emptyPhone(phoneCountry));
      setAttested(false);
      setError(null);
      setResult(null);
    }
    onOpenChange(next);
  };

  const submit = async () => {
    setResult(null);
    if (!phone.e164) return setError(t('settings.channels.callResults.invalidPhone'));
    if (!attested) return setError(t('settings.channels.callDialog.attestRequired'));
    setError(null);
    try {
      const r = await callMe.mutateAsync({ phone: phone.e164, language: callLanguage });
      const text =
        r.telephony === 'console'
          ? t('settings.channels.callResults.demo')
          : t('settings.channels.callResults.requested');
      setResult(text);
      toast.success(text);
    } catch (err) {
      setError(callError(t, errorCode(err), country));
    }
  };

  return (
    <Dialog open={open} onOpenChange={change}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{t('settings.channels.callDialog.title')}</DialogTitle>
          <DialogDescription>{t('settings.channels.callDialog.body')}</DialogDescription>
        </DialogHeader>
        <form
          className="grid gap-4"
          noValidate
          onSubmit={(e) => {
            e.preventDefault();
            void submit();
          }}
        >
          <PhoneInput
            label={t('settings.channels.callDialog.phone')}
            value={phone}
            onChange={setPhone}
            packCountry={org.country}
            required
            data-testid="call-phone"
          />
          {languages.length > 1 ? (
            <div className="grid gap-1.5">
              <Label htmlFor="call-language">{t('settings.channels.callDialog.language')}</Label>
              <Select value={callLanguage} onValueChange={(v) => setCallLanguage(v as Language)}>
                <SelectTrigger id="call-language">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {languages.map((l) => (
                    <SelectItem key={l} value={l}>
                      {t(`team.invite.languageNames.${l}`)}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          ) : null}
          <label
            htmlFor="call-attest"
            className="flex min-h-target cursor-pointer items-center gap-3 text-[15px]"
          >
            <Checkbox
              id="call-attest"
              checked={attested}
              onCheckedChange={(v) => setAttested(v === true)}
            />
            {t('settings.channels.callDialog.attest')}
          </label>
          {error ? (
            <p role="alert" className="text-caption font-medium text-missing">
              {error}
            </p>
          ) : null}
          {result ? (
            <p role="status" className="text-[15px]" data-testid="call-result">
              {result}
            </p>
          ) : null}
          <DialogFooter>
            <Button type="button" variant="ghost" onClick={() => change(false)}>
              {t('common.close')}
            </Button>
            <Button type="submit" variant="primary" loading={callMe.isPending}>
              {t('settings.channels.callDialog.call')}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
