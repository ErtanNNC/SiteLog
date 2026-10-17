import { useCallback, useEffect, useId, useState } from 'react';
import { Link, useNavigate } from 'react-router';
import type { ConsentType, ContactPref, MessageChannel } from '@sitelog/shared/enums.ts';
import {
  FIELD_CONSENT_TEXT_VERSION,
  OFFICE_NOTIFIED_REVOCATIONS,
  type PreferencesResponse,
} from '@sitelog/shared/field-contract.ts';
import type { PreferencesRequest } from '@sitelog/shared/field-api.ts';
import { languageOf, type ReporterLocale } from '@sitelog/shared/locale.ts';
import { apiErrorCode } from '@/api/field';
import { useApi } from '@/api/useApi';
import { OutlineButton, QuietButton, SolidButton } from '@/components/Buttons';
import { OfflineBanner } from '@/components/OfflineBanner';
import { Screen, ScreenTitle } from '@/components/Screen';
import { Sheet } from '@/components/Sheet';
import { fieldLanguageOf, type FieldLanguage } from '@/i18n/language';
import { pushBlocked, pushSupported, subscribeBrowser, unsubscribeBrowser } from '@/lib/push';
import { useFieldCopy } from '@/i18n/useFieldCopy';
import { NoLink } from '@/screens/NoLink';
import type { FieldSession } from '@/session/session';
import { useSession } from '@/session/useSession';

/** Refusals the link flow handles or explains (as Today does): the phone goes back to `/r/:code`. */
const RELINK = new Set([
  'device_unverified',
  'link_expired',
  'link_revoked',
  'link_not_found',
  'reporter_disabled',
]);

/** Revoking one of these stops reporting: confirm first, then the Welcome & consent again. */
const STOPS_REPORTING = OFFICE_NOTIFIED_REVOCATIONS as readonly ConsentType[];

type Saving =
  'pref' | 'channel' | 'locale' | ConsentType | 'turnOn' | 'signOut' | 'notToday' | null;

/**
 * The consents Settings can turn back on (spec §19 Q86; WhatsApp W2-15, §19 Q25, Q40; automated
 * calls W3-17, §19 Q131, where SiteLog places them).
 */
type TurnOnType = 'sms' | 'whatsapp' | 'auto_call';

/** The wording each *Turn on* shows again (the Welcome screen's, Field-02). */
const TURN_ON_WORDING = {
  sms: 'welcome.consentSms',
  whatsapp: 'welcome.consentWhatsapp',
  auto_call: 'welcome.consentCall',
} as const;
const TURN_ON_TITLE = {
  sms: 'settings.turnOnSheet.title',
  whatsapp: 'settings.turnOnSheet.titleWhatsapp',
  auto_call: 'settings.turnOnSheet.titleCall',
} as const;

/**
 * Settings (F15, spec §9.3; W2-02): the report mode (*Text link* / *Phone call*, §19 Q33 allows a
 * call without a voice number), the message channel (only when the pack offers more than one built
 * channel, §19 Q21: hidden until W2-14 / W2-15), the language (the pack's field locales), the
 * consents given with their state and *Turn off* (recording and processing behind a confirm sheet:
 * reports stop and the office is told), *Turn on* for texts (spec §19 Q86: the Welcome wording again
 * in a sheet; a phone opted out by STOP gets a line instead, START on a two-way pack, the office on
 * a one-way pack, §19 Q94), *Notifications* (W2-14, web push: only in the installed app with the
 * Push API, when field-api offers it; the browser's permission is asked only when it is turned on;
 * on = this phone's subscription and the `push` consent, off = both revoked, spec §19 Q27, Q40),
 * *Automated calls at report time* and, for a reporter who prefers calls, "Don't call me today"
 * (W3-17, only where SiteLog places calls: `placesCalls`; spec §19 Q129, Q131: until the end of
 * today, the messages come instead; no undo, §19 Q217), and *Sign out this phone*. A change is
 * saved when it is made (`PATCH preferences`, `consent/revoke`, `consent/grant`,
 * `device/sign-out`), each audited by field-api. There is no artboard: built from §9.3 and the
 * Field-02 / Field-03 patterns (accepted by the owner, 2026-10-16).
 */
export function Settings() {
  const { session, patch } = useSession();
  if (!session) return <NoLink />;
  return <SettingsLoaded session={session} patch={patch} />;
}

function SettingsLoaded({
  session,
  patch,
}: {
  session: FieldSession;
  patch: (changes: Partial<FieldSession>) => void;
}) {
  const api = useApi();
  const navigate = useNavigate();
  const { t, tc } = useFieldCopy();
  const { code, country, org } = session;
  const [prefs, setPrefs] = useState<PreferencesResponse | null>(null);
  const [failed, setFailed] = useState(false);
  const [saving, setSaving] = useState<Saving>(null);
  // The radio just chosen, shown checked while it saves (a controlled radio would otherwise snap
  // back to the stored value until field-api answers); cleared with the answer, so a refusal
  // shows what is stored again.
  const [choosing, setChoosing] = useState<
    { pref: ContactPref } | { channel: MessageChannel | null } | null
  >(null);
  const [status, setStatus] = useState<'saved' | 'error' | null>(null);
  const [sheet, setSheet] = useState<ConsentType | 'turnOn' | 'signOut' | null>(null);
  const [turnOnType, setTurnOnType] = useState<TurnOnType>('sms');
  const [pushProblem, setPushProblem] = useState<'blocked' | 'failed' | null>(null);
  const [canPush] = useState(() => pushSupported());
  // W3-17: "Don't call me today" holds against the time the screen opened (no clock in render).
  const [openedAt] = useState(() => Date.now());
  const ids = {
    pref: useId(),
    channel: useId(),
    lang: useId(),
    consents: useId(),
    push: useId(),
    notToday: useId(),
    sheet: useId(),
  };

  const relinkOr = useCallback(
    (err: unknown): boolean => {
      const apiCode = apiErrorCode(err);
      if (apiCode && RELINK.has(apiCode)) {
        navigate(`/r/${code}`, { replace: true });
        return true;
      }
      return false;
    },
    [code, navigate],
  );

  const load = useCallback(
    (signal?: AbortSignal) =>
      api.preferences(code, signal).then(
        (res) => {
          if (signal?.aborted) return;
          setFailed(false);
          setPrefs(res);
        },
        (err: unknown) => {
          if (signal?.aborted || relinkOr(err)) return;
          setFailed(true);
        },
      ),
    [api, code, relinkOr],
  );

  useEffect(() => {
    const controller = new AbortController();
    void load(controller.signal);
    return () => controller.abort();
  }, [load]);

  /** Applies the answer: the session follows the reporter's locale and preference. */
  function applied(res: PreferencesResponse) {
    setPrefs(res);
    setStatus('saved');
    if (
      res.locale !== session.reporter.locale ||
      res.contactPref !== session.reporter.contactPref
    ) {
      patch({
        reporter: { ...session.reporter, locale: res.locale, contactPref: res.contactPref },
      });
    }
  }

  async function save(what: Saving, body: PreferencesRequest) {
    setSaving(what);
    setStatus(null);
    try {
      applied(await api.updatePreferences(code, body));
    } catch (err) {
      if (!relinkOr(err)) setStatus('error');
    } finally {
      setSaving(null);
      setChoosing(null);
    }
  }

  async function turnOff(type: ConsentType) {
    setSaving(type);
    setStatus(null);
    try {
      const res = await api.revokeConsent(code, { type });
      setSheet(null);
      if (STOPS_REPORTING.includes(type)) {
        // Reports stop: the link flow shows the Welcome & consent again (F15).
        patch({ needsConsent: true });
        navigate(`/r/${code}`, { replace: true });
        return;
      }
      applied(res);
    } catch (err) {
      if (!relinkOr(err)) setStatus('error');
    } finally {
      setSaving(null);
    }
  }

  /** Spec §19 Q86: texts (or WhatsApp, W2-15) on, with the wording the sheet shows again. */
  async function turnOn() {
    setSaving('turnOn');
    setStatus(null);
    try {
      const res = await api.grantConsent(code, {
        type: turnOnType,
        textVersion: country.legalKeys.consent ?? FIELD_CONSENT_TEXT_VERSION,
      });
      setSheet(null);
      applied(res);
    } catch (err) {
      if (relinkOr(err)) return;
      if (apiErrorCode(err) === 'texts_opted_out') {
        // STOP came in meanwhile: show the line that says how to undo it.
        setSheet(null);
        void load();
        return;
      }
      setStatus('error');
    } finally {
      setSaving(null);
    }
  }

  /** Notifications on: permission (asked now, never before), the subscription, the consent. */
  async function pushOn() {
    setSaving('push');
    setStatus(null);
    setPushProblem(null);
    try {
      const { publicKey } = await api.pushKey(code);
      if (!publicKey) {
        void load();
        return;
      }
      const result = await subscribeBrowser(publicKey);
      if (result.kind === 'blocked') {
        setPushProblem('blocked');
        return;
      }
      applied(
        await api.pushSubscribe(code, {
          subscription: result.subscription,
          textVersion: country.legalKeys.consent ?? FIELD_CONSENT_TEXT_VERSION,
        }),
      );
    } catch (err) {
      if (!relinkOr(err)) setPushProblem('failed');
    } finally {
      setSaving(null);
    }
  }

  /** Notifications off: field-api revokes the subscription and the consent, then the browser's. */
  async function pushOff() {
    setSaving('push');
    setStatus(null);
    setPushProblem(null);
    try {
      applied(await api.pushUnsubscribe(code));
      await unsubscribeBrowser();
    } catch (err) {
      if (!relinkOr(err)) setStatus('error');
    } finally {
      setSaving(null);
    }
  }

  async function signOut() {
    setSaving('signOut');
    setStatus(null);
    try {
      await api.signOut(code);
      setSheet(null);
      // The phone goes back through the device check (F4 step 2) with the same link.
      patch({ needsDeviceCheck: true });
      navigate(`/r/${code}`, { replace: true });
    } catch (err) {
      if (!relinkOr(err)) setStatus('error');
      setSaving(null);
    }
  }

  const title = t('routes.settings');
  if (!prefs) {
    return (
      <Screen title={title} dateLine={false}>
        <OfflineBanner />
        <ScreenTitle>{title}</ScreenTitle>
        {failed ? (
          <>
            <p role="alert" className="m-0 text-dust">
              {t('settings.failed')}
            </p>
            <SolidButton
              onClick={() => {
                setFailed(false);
                void load();
              }}
            >
              {tc('retry')}
            </SolidButton>
          </>
        ) : (
          <p role="status" className="m-0 text-dust">
            {tc('loading')}
          </p>
        )}
      </Screen>
    );
  }

  const busy = saving !== null;
  const shownPref = choosing && 'pref' in choosing ? choosing.pref : prefs.contactPref;
  const shownChannel = choosing && 'channel' in choosing ? choosing.channel : prefs.messageChannel;
  const locales = country.fieldLocales;
  const card = (on: boolean) =>
    `flex min-h-target items-center gap-3.5 rounded-card bg-white p-3.5 ${
      on ? 'border-2 border-asphalt' : 'border border-rebar'
    }`;
  const radio = 'size-6 flex-none accent-asphalt m-0';
  const h2 = 'm-0 mb-2.5 p-0 text-[17px] leading-6 font-bold';
  const sheetConsent = sheet !== null && sheet !== 'signOut' && sheet !== 'turnOn' ? sheet : null;
  const textsStopped = country.twoWaySms
    ? t('settings.textsStopped.start')
    : t('settings.textsStopped.office');
  // W3-17 (§19 Q129): "Don't call me today" holds until the end of today.
  const notToday = prefs.noCallsUntil !== null && Date.parse(prefs.noCallsUntil) > openedAt;

  return (
    <Screen title={title} dateLine={false}>
      <OfflineBanner />
      <ScreenTitle>{title}</ScreenTitle>

      <fieldset className="m-0 flex flex-col gap-2.5 border-0 p-0" aria-labelledby={ids.pref}>
        <legend id={ids.pref} className={h2}>
          {t('welcome.prefLegend')}
        </legend>
        {(['link', 'call'] as const).map((value: ContactPref) => (
          <label key={value} className={card(shownPref === value)}>
            <input
              type="radio"
              name="pref"
              value={value}
              checked={shownPref === value}
              disabled={busy}
              onChange={() => {
                setChoosing({ pref: value });
                void save('pref', { contactPref: value });
              }}
              className={radio}
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
      </fieldset>

      {prefs.messageChannels.length > 1 ? (
        <fieldset className="m-0 flex flex-col gap-2.5 border-0 p-0" aria-labelledby={ids.channel}>
          <legend id={ids.channel} className={h2}>
            {t('settings.channelTitle')}
          </legend>
          {([null, ...prefs.messageChannels] as (MessageChannel | null)[]).map((value) => (
            <label key={value ?? 'default'} className={card(shownChannel === value)}>
              <input
                type="radio"
                name="channel"
                value={value ?? ''}
                checked={shownChannel === value}
                disabled={busy}
                onChange={() => {
                  setChoosing({ channel: value });
                  void save('channel', { messageChannel: value });
                }}
                className={radio}
              />
              <span className="flex flex-col gap-0.5">
                <b className="text-[16px]">
                  {value ? t(`settings.channels.${value}`) : t('settings.channelDefault')}
                </b>
                {value ? null : (
                  <span className="text-[14px] text-dust">{t('settings.channelDefaultHint')}</span>
                )}
              </span>
            </label>
          ))}
        </fieldset>
      ) : null}

      {locales.length > 1 ? (
        <section aria-labelledby={ids.lang} className="flex flex-col">
          <h2 id={ids.lang} className={h2}>
            {tc('language')}
          </h2>
          <div role="radiogroup" aria-labelledby={ids.lang} className="flex gap-2">
            {locales.map((locale: ReporterLocale) => {
              const lang = (fieldLanguageOf(locale) ?? languageOf(locale)) as FieldLanguage;
              const on = locale === prefs.locale;
              return (
                <button
                  key={locale}
                  type="button"
                  role="radio"
                  aria-checked={on}
                  lang={lang}
                  disabled={busy}
                  onClick={() => (on ? undefined : void save('locale', { locale }))}
                  className={`h-target min-w-0 flex-1 rounded-btn text-[15px] font-semibold ${
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
        </section>
      ) : null}

      {prefs.consents.length > 0 ? (
        <section aria-labelledby={ids.consents} className="flex flex-col">
          <h2 id={ids.consents} className={h2}>
            {t('settings.consentsTitle')}
          </h2>
          <ul className="m-0 flex list-none flex-col gap-2 p-0">
            {prefs.consents.map(({ type, held }) => {
              const label = t(`settings.consents.${type}`, { company: org.name });
              return (
                <li
                  key={type}
                  className="flex min-h-target flex-wrap items-center gap-x-3 gap-y-2 rounded-card border border-rebar bg-white py-2 pr-2 pl-3.5"
                >
                  <span className="flex min-w-0 flex-1 basis-48 flex-col gap-0.5">
                    <span className="text-[16px] leading-[22px]">{label}</span>
                    {/* The state is text, never colour alone. */}
                    <span
                      className={`font-mono text-[13px] tracking-[0.06em] uppercase ${
                        held ? 'text-filed' : 'text-dust'
                      }`}
                    >
                      {held ? t('settings.on') : t('settings.off')}
                    </span>
                  </span>
                  {held ? (
                    <div className="w-32 flex-none">
                      <QuietButton
                        aria-label={t('settings.turnOffLabel', { consent: label })}
                        disabled={busy}
                        onClick={() =>
                          STOPS_REPORTING.includes(type) ? setSheet(type) : void turnOff(type)
                        }
                      >
                        {saving === type ? t('settings.saving') : t('settings.turnOff')}
                      </QuietButton>
                    </div>
                  ) : (type === 'sms' && !prefs.textsOptedOut) ||
                    type === 'whatsapp' ||
                    (type === 'auto_call' && prefs.placesCalls) ? (
                    <div className="w-32 flex-none">
                      <QuietButton
                        aria-label={t('settings.turnOnLabel', { consent: label })}
                        disabled={busy}
                        onClick={() => {
                          setStatus(null);
                          setTurnOnType(type);
                          setSheet('turnOn');
                        }}
                      >
                        {t('settings.turnOn')}
                      </QuietButton>
                    </div>
                  ) : null}
                  {type === 'sms' && prefs.textsOptedOut ? (
                    <p className="m-0 basis-full pb-1.5 text-[15px] leading-[21px] text-steel">
                      {textsStopped}
                    </p>
                  ) : null}
                </li>
              );
            })}
          </ul>
        </section>
      ) : null}

      {prefs.placesCalls && prefs.contactPref === 'call' ? (
        <section aria-labelledby={ids.notToday} className="flex flex-col">
          <h2 id={ids.notToday} className={h2}>
            {t('settings.notToday.title')}
          </h2>
          <div className="flex min-h-target flex-wrap items-center gap-x-3 gap-y-2 rounded-card border border-rebar bg-white py-2 pr-2 pl-3.5">
            <span className="flex min-w-0 flex-1 basis-48 flex-col gap-0.5">
              <span className="text-[16px] leading-[22px]">
                {notToday ? t('settings.notToday.on') : t('settings.notToday.label')}
              </span>
              <span className="text-[14px] leading-5 text-dust">
                {notToday ? t('settings.notToday.onHint') : t('settings.notToday.hint')}
              </span>
            </span>
            {notToday ? null : (
              <div className="w-44 flex-none">
                <QuietButton
                  disabled={busy}
                  onClick={() => void save('notToday', { noCallsToday: true })}
                >
                  {saving === 'notToday' ? t('settings.saving') : t('settings.notToday.button')}
                </QuietButton>
              </div>
            )}
          </div>
        </section>
      ) : null}

      {prefs.push.offered && canPush ? (
        <section aria-labelledby={ids.push} className="flex flex-col">
          <h2 id={ids.push} className={h2}>
            {t('settings.push.title')}
          </h2>
          <div className="flex min-h-target flex-wrap items-center gap-x-3 gap-y-2 rounded-card border border-rebar bg-white py-2 pr-2 pl-3.5">
            <span className="flex min-w-0 flex-1 basis-48 flex-col gap-0.5">
              <span className="text-[16px] leading-[22px]">{t('settings.push.label')}</span>
              {/* The state is text, never colour alone. */}
              <span
                className={`font-mono text-[13px] tracking-[0.06em] uppercase ${
                  prefs.push.on ? 'text-filed' : 'text-dust'
                }`}
              >
                {prefs.push.on ? t('settings.on') : t('settings.off')}
              </span>
            </span>
            <div className="w-32 flex-none">
              <QuietButton
                aria-label={t(prefs.push.on ? 'settings.turnOffLabel' : 'settings.turnOnLabel', {
                  consent: t('settings.push.label'),
                })}
                disabled={busy}
                onClick={() => void (prefs.push.on ? pushOff() : pushOn())}
              >
                {saving === 'push'
                  ? t('settings.saving')
                  : prefs.push.on
                    ? t('settings.turnOff')
                    : t('settings.turnOn')}
              </QuietButton>
            </div>
            <p className="m-0 basis-full pb-1.5 text-[15px] leading-[21px] text-steel">
              {t('settings.push.hint')}
            </p>
          </div>
          {pushProblem || (!prefs.push.on && pushBlocked()) ? (
            // An alert only answers the reporter's tap; a permission refused before is read as
            // the screen's state, not announced on arrival (WCAG 4.1.3).
            <p
              role={pushProblem ? 'alert' : 'status'}
              className="m-0 mt-2 text-[15px] leading-5 text-missing"
            >
              {pushProblem === 'failed' ? t('settings.push.failed') : t('settings.push.blocked')}
            </p>
          ) : null}
        </section>
      ) : null}

      <p role="status" className="m-0 min-h-6 text-[15px] leading-6 text-steel">
        {status === 'saved' ? t('settings.saved') : saving ? t('settings.saving') : ''}
      </p>
      {status === 'error' ? (
        <p role="alert" className="m-0 text-[15px] leading-5 text-missing">
          {t('settings.saveFailed')}
        </p>
      ) : null}

      <OutlineButton disabled={busy} onClick={() => setSheet('signOut')}>
        {t('settings.signOut')}
      </OutlineButton>
      <Link
        to="/today"
        className="flex h-target items-center justify-center rounded-card border-2 border-asphalt bg-white px-5 text-[16px] font-bold text-asphalt no-underline"
      >
        {t('settings.back')}
      </Link>

      <Sheet
        open={sheetConsent !== null}
        titleId={ids.sheet}
        onClose={() => (busy ? undefined : setSheet(null))}
      >
        <h2 id={ids.sheet} className="m-0 text-[22px] leading-7 font-extrabold [font-stretch:118%]">
          {t('settings.stopSheet.title')}
        </h2>
        <p className="m-0 text-[16px] leading-6 text-steel">{t('settings.stopSheet.body')}</p>
        {status === 'error' ? (
          <p role="alert" className="m-0 text-[15px] leading-5 text-missing">
            {t('settings.saveFailed')}
          </p>
        ) : null}
        <div className="flex gap-3">
          <QuietButton onClick={() => setSheet(null)} disabled={busy} className="flex-1">
            {t('settings.stopSheet.cancel')}
          </QuietButton>
          <SolidButton
            onClick={() => sheetConsent && void turnOff(sheetConsent)}
            disabled={busy}
            className="flex-1"
          >
            {busy ? t('settings.saving') : t('settings.stopSheet.confirm')}
          </SolidButton>
        </div>
      </Sheet>

      <Sheet
        open={sheet === 'turnOn'}
        titleId={`${ids.sheet}-on`}
        onClose={() => (busy ? undefined : setSheet(null))}
      >
        <h2
          id={`${ids.sheet}-on`}
          className="m-0 text-[22px] leading-7 font-extrabold [font-stretch:118%]"
        >
          {t(TURN_ON_TITLE[turnOnType])}
        </h2>
        <p className="m-0 text-[16px] leading-6 text-steel">{t('settings.turnOnSheet.body')}</p>
        {/* The wording the reporter agreed to on Welcome (Field-02), shown again (§19 Q86). */}
        <p className="m-0 rounded-card bg-concrete px-3.5 py-3 text-[16px] leading-6 font-semibold">
          {t(TURN_ON_WORDING[turnOnType])}
        </p>
        <p className="m-0 text-[15px] leading-[21px] text-steel">
          {t('settings.turnOnSheet.note')}
        </p>
        {status === 'error' ? (
          <p role="alert" className="m-0 text-[15px] leading-5 text-missing">
            {t('settings.saveFailed')}
          </p>
        ) : null}
        <div className="flex gap-3">
          <QuietButton onClick={() => setSheet(null)} disabled={busy} className="flex-1">
            {t('settings.turnOnSheet.cancel')}
          </QuietButton>
          <SolidButton onClick={() => void turnOn()} disabled={busy} className="flex-1">
            {busy ? t('settings.saving') : t('settings.turnOnSheet.confirm')}
          </SolidButton>
        </div>
      </Sheet>

      <Sheet
        open={sheet === 'signOut'}
        titleId={`${ids.sheet}-out`}
        onClose={() => (busy ? undefined : setSheet(null))}
      >
        <h2
          id={`${ids.sheet}-out`}
          className="m-0 text-[22px] leading-7 font-extrabold [font-stretch:118%]"
        >
          {t('settings.signOutSheet.title')}
        </h2>
        <p className="m-0 text-[16px] leading-6 text-steel">{t('settings.signOutSheet.body')}</p>
        {status === 'error' ? (
          <p role="alert" className="m-0 text-[15px] leading-5 text-missing">
            {t('settings.saveFailed')}
          </p>
        ) : null}
        <div className="flex gap-3">
          <QuietButton onClick={() => setSheet(null)} disabled={busy} className="flex-1">
            {t('settings.signOutSheet.cancel')}
          </QuietButton>
          <SolidButton onClick={() => void signOut()} disabled={busy} className="flex-1">
            {busy ? t('settings.saving') : t('settings.signOutSheet.confirm')}
          </SolidButton>
        </div>
      </Sheet>
    </Screen>
  );
}
