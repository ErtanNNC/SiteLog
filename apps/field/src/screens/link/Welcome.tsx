import { useId, useRef, useState } from 'react';
import type { FormEvent } from 'react';
import { Link } from 'react-router';
import type { ConsentType, ContactPref } from '@sitelog/shared/enums.ts';
import {
  FIELD_CONSENT_TEXT_VERSION,
  type ConsentResponse,
} from '@sitelog/shared/field-contract.ts';
import { languageOf, type ReporterLocale } from '@sitelog/shared/locale.ts';
import { useApi } from '@/api/useApi';
import { PrimaryButton } from '@/components/Buttons';
import { Screen, ScreenTitle, ActionBar } from '@/components/Screen';
import { i18n } from '@/i18n/i18n';
import { fieldLanguageOf, type FieldLanguage } from '@/i18n/language';
import { useFieldCopy } from '@/i18n/useFieldCopy';
import { placesAutomatedCalls } from '@/lib/features';
import { privacyNoticeHref } from '@/lib/legal';
import { currentSite, type FieldSession } from '@/session/session';

/**
 * F4 step 3 (Field-02), first open only: the notice, the required consent, the SMS box where the
 * pack sends texts, the automated-call consent only where TalkOlog places automated calls
 * (`resolve`'s `placesCalls`, W3-17: spec §19 Q33, Q51), the preference, the language from the
 * pack's field locales, then `POST consent` with the wording's version (`FIELD_CONSENT_TEXT_VERSION`,
 * or the pack's consent key when it names one, spec §19 Q28). WhatsApp has no box (§19 Q376,
 * 2026-10-23): where the pack lists WhatsApp, one sentence above Continue says that continuing
 * gives it, and Continue sends the `whatsapp` consent with the others; where it does not, neither
 * the sentence nor the consent. Push has its own toggle in Settings, and Settings keeps the
 * WhatsApp toggle to turn it off. The optional 20-second test recording of F4 is M6.
 */
export function Welcome({
  session,
  onDone,
}: {
  session: FieldSession;
  onDone: (res: ConsentResponse) => void;
}) {
  const api = useApi();
  const { t, tc, language } = useFieldCopy();
  const { reporter, org, country } = session;
  const offersSms = country.messageChannels.includes('sms');
  // §19 Q376: no box; where the pack lists WhatsApp, Continue gives it under the visible sentence.
  const offersWhatsapp = country.messageChannels.includes('whatsapp');
  const offersCalls = placesAutomatedCalls(session);
  const [required, setRequired] = useState(false);
  const [sms, setSms] = useState(true);
  const [autoCall, setAutoCall] = useState(reporter.contactPref === 'call');
  const [pref, setPref] = useState<ContactPref>(reporter.contactPref);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<'required' | 'failed' | null>(null);
  const requiredBox = useRef<HTMLInputElement>(null);
  const ids = {
    required: useId(),
    hint: useId(),
    pref: useId(),
    lang: useId(),
    title: useId(),
    whatsapp: useId(),
  };

  const locales = country.fieldLocales;
  const chosen: ReporterLocale =
    locales.find((l) => fieldLanguageOf(l) === language) ?? locales[0] ?? reporter.locale;

  function pickLanguage(locale: ReporterLocale) {
    const lang = fieldLanguageOf(locale);
    if (lang && i18n.resolvedLanguage !== lang) void i18n.changeLanguage(lang);
  }

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (!required) {
      setError('required');
      requiredBox.current?.focus();
      return;
    }
    setBusy(true);
    setError(null);
    const types: ConsentType[] = ['recording', 'data_processing'];
    if (offersSms && sms) types.push('sms');
    if (offersWhatsapp) types.push('whatsapp');
    if (offersCalls && autoCall) types.push('auto_call');
    try {
      const res = await api.consent(session.code, {
        types,
        textVersion: country.legalKeys.consent ?? FIELD_CONSENT_TEXT_VERSION,
        contactPref: pref,
        locale: chosen,
      });
      onDone(res);
    } catch {
      setError('failed');
      setBusy(false);
    }
  }

  const site = currentSite(session) ?? session.sites[0] ?? null;
  const eyebrow = [org.name, site?.name].filter(Boolean).join(' · ');
  const privacyKey = country.legalKeys.privacyNotice;
  const check =
    'size-6 flex-none accent-asphalt m-0 mt-0.5 rounded-chip border border-rebar bg-white';
  const row = 'flex min-h-target items-start gap-3 py-2 text-[16px] leading-6';

  return (
    <Screen title={t('welcome.title', { name: reporter.firstName })} dateLine={false}>
      <form onSubmit={submit} className="flex flex-1 flex-col gap-4" noValidate>
        <div className="flex flex-col gap-1">
          <span className="font-mono text-[12px] leading-[18px] tracking-[0.08em] text-dust uppercase">
            {eyebrow}
          </span>
          <ScreenTitle id={ids.title}>
            {t('welcome.title', { name: reporter.firstName })}
          </ScreenTitle>
        </div>

        <p className="m-0 rounded-card bg-concrete px-3.5 py-3 text-[15px] leading-[21px] text-steel">
          {t('welcome.notice', { company: org.name })}{' '}
          {privacyKey ? (
            // W4-06 (§19 Q50): the app's own page, in the app (it works offline; Back returns here).
            <Link to={privacyNoticeHref(privacyKey)} className="text-level underline">
              {t('welcome.privacy')}
            </Link>
          ) : null}
        </p>

        <div className="flex flex-col">
          <label htmlFor={ids.required} className={row}>
            <input
              ref={requiredBox}
              id={ids.required}
              type="checkbox"
              checked={required}
              onChange={(e) => {
                setRequired(e.target.checked);
                if (e.target.checked && error === 'required') setError(null);
              }}
              aria-required="true"
              aria-describedby={error === 'required' ? ids.hint : undefined}
              aria-invalid={error === 'required' ? true : undefined}
              className={check}
            />
            <span>{t('welcome.consentRequired')}</span>
          </label>
          {error === 'required' ? (
            <p id={ids.hint} role="alert" className="m-0 pl-9 text-[15px] leading-5 text-missing">
              {t('welcome.requiredHint')}
            </p>
          ) : null}
          {offersSms ? (
            <label className={row}>
              <input
                type="checkbox"
                checked={sms}
                onChange={(e) => setSms(e.target.checked)}
                className={check}
              />
              <span>{t('welcome.consentSms')}</span>
            </label>
          ) : null}
          {offersCalls ? (
            <label className={row}>
              <input
                type="checkbox"
                checked={autoCall}
                onChange={(e) => setAutoCall(e.target.checked)}
                className={check}
              />
              <span>{t('welcome.consentCall')}</span>
            </label>
          ) : null}
        </div>

        <fieldset className="m-0 flex flex-col gap-2.5 border-0 p-0" aria-labelledby={ids.pref}>
          <legend id={ids.pref} className="mb-2.5 p-0 text-[16px] font-bold">
            {t('welcome.prefLegend')}
          </legend>
          {(['link', 'call'] as const).map((value) => (
            <label
              key={value}
              className={`flex min-h-target items-center gap-3.5 rounded-card bg-white p-3.5 ${
                pref === value ? 'border-2 border-asphalt' : 'border border-rebar'
              }`}
            >
              <input
                type="radio"
                name="pref"
                value={value}
                checked={pref === value}
                onChange={() => setPref(value)}
                className="size-6 flex-none accent-asphalt m-0"
              />
              <span className="flex flex-col gap-0.5">
                <b className="text-[16px]">
                  {t(value === 'link' ? 'welcome.prefLink' : 'welcome.prefCall')}
                </b>
                <span className="text-[14px] text-dust">
                  {t(value === 'link' ? 'welcome.prefLinkHint' : 'welcome.prefCallHint')}
                </span>
              </span>
            </label>
          ))}
          <span className="text-[13px] text-dust">{t('welcome.prefNote')}</span>
        </fieldset>

        {locales.length > 1 ? (
          <div role="radiogroup" aria-label={tc('language')} className="flex gap-2">
            {locales.map((locale) => {
              const lang = (fieldLanguageOf(locale) ?? languageOf(locale)) as FieldLanguage;
              const on = locale === chosen;
              return (
                <button
                  key={locale}
                  type="button"
                  role="radio"
                  aria-checked={on}
                  lang={lang}
                  onClick={() => pickLanguage(locale)}
                  className={`h-target flex-1 rounded-btn text-[15px] font-semibold ${
                    on
                      ? 'border-0 bg-asphalt text-chalk'
                      : 'border border-rebar bg-white text-asphalt'
                  }`}
                >
                  {tc(`languageNames.${lang}`)}
                </button>
              );
            })}
          </div>
        ) : null}

        {error === 'failed' ? (
          <p role="alert" className="m-0 text-[15px] leading-5 text-missing">
            {t('welcome.failed')}
          </p>
        ) : null}

        <ActionBar>
          <div className="flex w-full flex-col gap-2">
            {offersWhatsapp ? (
              // §19 Q376: in the sticky bar, directly above Continue, so it is seen with the button.
              <p id={ids.whatsapp} className="m-0 text-[15px] leading-[21px] text-steel">
                {t('welcome.whatsappNotice')}
              </p>
            ) : null}
            <PrimaryButton
              type="submit"
              disabled={busy}
              aria-describedby={offersWhatsapp ? ids.whatsapp : undefined}
            >
              {busy ? t('welcome.saving') : t('welcome.continue')}
            </PrimaryButton>
          </div>
        </ActionBar>
      </form>
    </Screen>
  );
}
