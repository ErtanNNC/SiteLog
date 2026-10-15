import { useCallback, useEffect, useId, useRef, useState } from 'react';
import type { ChangeEvent } from 'react';
import { Link, useNavigate } from 'react-router';
import type { TodayResponse } from '@sitelog/shared/field-contract.ts';
import { formatDate, formatPhone, formatTimeInTz } from '@sitelog/shared/format.ts';
import { apiErrorCode } from '@/api/field';
import { useApi } from '@/api/useApi';
import { OutlineButton, QuietButton, SolidButton } from '@/components/Buttons';
import { DateLine } from '@/components/DateLine';
import { Header } from '@/components/Header';
import { OfflineBanner } from '@/components/OfflineBanner';
import { Screen } from '@/components/Screen';
import { useFieldCopy } from '@/i18n/useFieldCopy';
import { copyError, type CopyError } from '@/lib/errors';
import { TALK_NOW_ENABLED } from '@/lib/features';
import { useQueue, useQueueSnapshot } from '@/queue/useQueue';
import { photoMime } from '@/recorder/photos';
import { NoLink } from '@/screens/NoLink';
import { useSession } from '@/session/useSession';
import { DaySheet, type DayKind } from './DaySheet';
import { SiteSheet } from './SiteSheet';
import { dayClosed, todayStatus, type TodayStatusKey } from './status';

const PROMPTS = ['work', 'crew', 'hours', 'weather', 'deliveries', 'safety'] as const;
/** Refusals of `today` the link flow handles or explains (as Processing does). */
const RELINK = new Set([
  'device_unverified',
  'consent_required',
  'link_expired',
  'link_revoked',
  'link_not_found',
  'reporter_disabled',
]);
const DAY_ERRORS = [
  'report_in_progress',
  'report_filed',
  'wrong_state',
  'date_not_allowed',
] as const;

/** The chip's dot (status is always also text, never by colour alone). */
const DOT: Record<TodayStatusKey, string> = {
  notSent: 'bg-signal',
  inProgress: 'bg-level',
  sent: 'bg-filed',
  weatherDay: 'bg-steel',
  noWork: 'bg-steel',
};
const CHIP: Record<TodayStatusKey, string> = {
  notSent: 'bg-chip-await-bg text-chip-await-fg',
  inProgress: 'bg-chip-review-bg text-chip-review-fg',
  sent: 'bg-chip-filed-bg text-chip-filed-fg',
  weatherDay: 'bg-chip-wx-bg text-chip-wx-fg',
  noWork: 'bg-chip-wx-bg text-chip-wx-fg',
};

function MicIcon() {
  return (
    <svg
      width="60"
      height="60"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2.2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
    >
      <rect x="9" y="3" width="6" height="11" rx="3" />
      <path d="M5 11a7 7 0 0 0 14 0 M12 18v3" />
    </svg>
  );
}

function CameraIcon() {
  return (
    <svg
      width="22"
      height="22"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
    >
      <path d="M4 8h3l2-3h6l2 3h3v11H4z" />
      <circle cx="12" cy="13" r="3.5" />
    </svg>
  );
}

function HeadsetIcon() {
  return (
    <svg
      width="22"
      height="22"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
    >
      <path d="M4 15v-3a8 8 0 0 1 16 0v3" />
      <rect x="3" y="14" width="4" height="7" rx="1.5" />
      <rect x="17" y="14" width="4" height="7" rx="1.5" />
    </svg>
  );
}

/**
 * Today (F5 step 1; Field-03, Field-10): site, date and deadline in the site's time zone, the
 * status, the prompt list, the Record button (≥ 120 px), Add photos, No work / Weather through
 * `day-status`, Talk now behind `VITE_FEATURE_TALK_NOW`, and *Call {number}* only when the pack
 * has a voice number. Before 12:00 site time a personal link may report yesterday (F5, spec §19
 * Q43): `allowedDates` then offers the choice.
 */
export function Today() {
  const { session, patch } = useSession();
  if (!session) return <NoLink />;
  return (
    <TodayLoaded
      code={session.code}
      siteId={session.siteId}
      date={session.date}
      patch={patch}
      sites={session.sites}
      voiceNumber={session.country.voiceNumber}
    />
  );
}

function TodayLoaded({
  code,
  siteId,
  date,
  patch,
  sites,
  voiceNumber,
}: {
  code: string;
  siteId: string | null;
  date: string | null;
  patch: (changes: {
    siteId?: string | null;
    date?: string | null;
    sites?: TodayResponse['sites'];
  }) => void;
  sites: TodayResponse['sites'];
  voiceNumber: string | null;
}) {
  const api = useApi();
  const navigate = useNavigate();
  const queue = useQueue();
  const snapshot = useQueueSnapshot();
  const { t, tc, language } = useFieldCopy();
  const [today, setToday] = useState<TodayResponse | null>(null);
  const [failed, setFailed] = useState(false);
  const [sheet, setSheet] = useState<'site' | DayKind | null>(null);
  const [dayBusy, setDayBusy] = useState(false);
  const [dayError, setDayError] = useState<CopyError | null>(null);
  const [photoError, setPhotoError] = useState(false);
  const photoInput = useRef<HTMLInputElement>(null);
  /** The site the current `today` answers for: its own patch of `siteId` must not reload. */
  const loadedSite = useRef<string | null>(null);
  const dateLegendId = useId();
  const promptsId = useId();
  /** Items already sent when the screen opened, or since seen: only new ones reload the day. */
  const [seenDone] = useState(
    () => new Set(snapshot.items.filter((i) => i.status === 'done').map((i) => i.id)),
  );

  const load = useCallback(
    async (signal?: AbortSignal) => {
      try {
        const res = await api.today(code, siteId, signal);
        if (signal?.aborted) return;
        loadedSite.current = res.site.id;
        setFailed(false);
        setToday(res);
        const chosen = date && res.allowedDates.includes(date) ? date : res.allowedDates[0]!;
        const changes: Parameters<typeof patch>[0] = {};
        if (res.site.id !== siteId) changes.siteId = res.site.id;
        if (chosen !== date) changes.date = chosen;
        if (res.sites.length !== sites.length || res.sites.some((s, i) => s.id !== sites[i]?.id)) {
          changes.sites = res.sites;
        }
        if (Object.keys(changes).length > 0) patch(changes);
      } catch (err) {
        if (signal?.aborted) return;
        const apiCode = apiErrorCode(err);
        if (apiCode && RELINK.has(apiCode)) {
          // The phone must pass the link flow again (a new phone, a revoked device), or the link
          // flow explains why the link no longer works (expired, revoked, a paused reporter): no
          // "check your signal" for a refusal no retry can change.
          navigate(`/r/${code}`, { replace: true });
          return;
        }
        if (apiCode === 'not_found' && siteId) {
          // The chosen site is gone from the link's scope: fall back to the default.
          patch({ siteId: null });
          return;
        }
        setFailed(true);
      }
    },
    [api, code, siteId, date, sites, patch, navigate],
  );

  useEffect(() => {
    if (loadedSite.current !== null && loadedSite.current === siteId) return;
    const controller = new AbortController();
    void load(controller.signal);
    return () => controller.abort();
    // Reload when the link or the chosen site changes (not on every patch of the date).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [api, code, siteId]);

  // The latest `load` and `failed`, for the listeners below.
  const latest = useRef({ load, failed });
  useEffect(() => {
    latest.current = { load, failed };
  });

  // A clip queued offline went out in the background (`online`, the app back, the backoff): the
  // day now has a report, so Today must stop saying "Not sent yet".
  useEffect(() => {
    const site = loadedSite.current ?? siteId;
    const fresh = snapshot.items.filter((i) => i.status === 'done' && !seenDone.has(i.id));
    if (fresh.length === 0) return;
    fresh.forEach((i) => seenDone.add(i.id));
    if (fresh.some((i) => i.result && (site === null || i.siteId === site))) {
      void latest.current.load();
    }
  }, [snapshot.items, seenDone, siteId]);

  // The signal came back after a load that failed.
  useEffect(() => {
    const onOnline = () => {
      if (latest.current.failed) void latest.current.load();
    };
    window.addEventListener('online', onOnline);
    return () => window.removeEventListener('online', onOnline);
  }, []);

  const pendingPhotos = snapshot.items.filter(
    (i) => i.kind === 'photo' && (i.status === 'queued' || i.status === 'uploading'),
  ).length;

  async function onPhotos(e: ChangeEvent<HTMLInputElement>) {
    const files = Array.from(e.target.files ?? []);
    e.target.value = '';
    if (!today) return;
    setPhotoError(false);
    for (const file of files) {
      const mime = photoMime(file);
      if (!mime) {
        setPhotoError(true);
        continue;
      }
      try {
        await queue.enqueue({
          code,
          kind: 'photo',
          mime,
          blob: file,
          siteId: today.site.id,
          date: date ?? today.date,
          recordedAt: file.lastModified ? new Date(file.lastModified).toISOString() : null,
        });
      } catch (err) {
        console.error('[field] could not queue a photo', err);
        setPhotoError(true);
      }
    }
  }

  async function confirmDay(details: Parameters<typeof api.dayStatus>[1]['details']) {
    if (!today || !sheet || sheet === 'site') return;
    setDayBusy(true);
    setDayError(null);
    try {
      await api.dayStatus(code, {
        siteId: today.site.id,
        status: sheet,
        date: date ?? today.date,
        ...(details && Object.keys(details).length > 0 ? { details } : {}),
      });
      setSheet(null);
      await load();
    } catch (err) {
      // The sheet names the refusals it can explain; anything else (no signal included) is generic.
      const e = copyError(err, DAY_ERRORS);
      setDayError((DAY_ERRORS as readonly string[]).includes(e.key) ? e : { key: 'generic' });
    } finally {
      setDayBusy(false);
    }
  }

  const site = today?.site ?? sites.find((s) => s.id === siteId) ?? sites[0] ?? null;
  const header = (
    <Header
      siteName={site?.name}
      onChangeSite={sites.length > 1 ? () => setSheet('site') : undefined}
      settings
    />
  );

  if (failed || !today) {
    return (
      <Screen title={t('routes.today')} header={header} dateLine={false}>
        <OfflineBanner />
        <h1 className="sr-only">{t('routes.today')}</h1>
        {failed ? (
          <>
            <p role="alert" className="m-0 text-dust">
              {t('today.failed')}
            </p>
            <SolidButton
              onClick={() => {
                setFailed(false);
                void load();
              }}
            >
              {t('sending.retry')}
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

  const status = todayStatus(today);
  const closed = dayClosed(today);
  const chosenDate = date && today.allowedDates.includes(date) ? date : today.date;

  return (
    <Screen title={t('routes.today')} header={header} dateLine={false}>
      <OfflineBanner />
      {/* The page's name for screen readers; the site is in the top bar, as on Field-03. */}
      <h1 className="sr-only">{t('routes.today')}</h1>
      <div className="flex items-center justify-between gap-3">
        <DateLine
          date={chosenDate}
          timeZone={today.site.timezone}
          due={formatTimeInTz(today.deadlineAt, today.site.timezone)}
        />
        <span
          className={`inline-flex items-center gap-1.5 rounded-chip px-2.5 py-1 text-[13px] leading-[18px] font-semibold whitespace-nowrap ${CHIP[status]}`}
        >
          <span aria-hidden="true" className={`size-[7px] rounded-full ${DOT[status]}`} />
          {t(`today.status.${status}`)}
        </span>
      </div>

      {today.allowedDates.length > 1 && !closed ? (
        <div role="radiogroup" aria-labelledby={dateLegendId} className="flex flex-col gap-2">
          <span id={dateLegendId} className="text-[15px] font-semibold">
            {t('today.dateQuestion')}
          </span>
          <div className="grid grid-cols-2 gap-2">
            {today.allowedDates.map((d, i) => {
              const on = d === chosenDate;
              return (
                <button
                  key={d}
                  type="button"
                  role="radio"
                  aria-checked={on}
                  onClick={() => patch({ date: d })}
                  className={`h-target rounded-btn px-2 text-[15px] font-semibold ${
                    on
                      ? 'border-0 bg-asphalt text-chalk'
                      : 'border border-rebar bg-white text-asphalt'
                  }`}
                >
                  {i === 0
                    ? t('today.dateToday')
                    : t('today.dateYesterday', {
                        date: formatDate(d, 'weekdayMonthDay', language),
                      })}
                </button>
              );
            })}
          </div>
        </div>
      ) : null}

      <section
        aria-labelledby={promptsId}
        className="flex flex-col gap-2 rounded-card border border-rebar bg-white px-4 py-3.5"
      >
        <h2 id={promptsId} className="m-0 text-[17px] leading-6 font-bold">
          {t('today.promptsTitle')}
        </h2>
        <ol className="m-0 grid list-none grid-cols-2 gap-x-3 gap-y-1.5 p-0 text-[15px] leading-[21px]">
          {PROMPTS.map((p) => (
            <li key={p}>{t(`today.prompts.${p}`)}</li>
          ))}
        </ol>
      </section>

      {closed ? (
        <>
          <p className="m-0 text-[16px] leading-6 text-steel">{t('today.closed')}</p>
          {today.report ? (
            <Link
              to={`/report/${today.report.id}`}
              className="flex h-target items-center justify-center rounded-card border-2 border-asphalt bg-white px-5 text-[16px] font-bold text-asphalt no-underline"
            >
              {t('today.openReport', { no: today.report.reportNo })}
            </Link>
          ) : null}
        </>
      ) : (
        <>
          <div className="flex flex-1 flex-col items-center justify-center gap-3 py-4">
            <Link
              to="/record"
              aria-label={t('today.record')}
              className="flex size-[148px] items-center justify-center rounded-full bg-signal text-asphalt shadow-[0_0_0_10px_var(--color-signal-tint)]"
            >
              <MicIcon />
            </Link>
            <b className="text-[20px] [font-stretch:112%]">{t('today.tapToRecord')}</b>
            <span className="text-[14px] text-dust">{t('today.usually')}</span>
          </div>

          {today.report ? (
            <Link
              to={`/report/${today.report.id}`}
              className="flex h-target items-center justify-center rounded-card border-2 border-asphalt bg-white px-5 text-[16px] font-bold text-asphalt no-underline"
            >
              {t('today.openReport', { no: today.report.reportNo })}
            </Link>
          ) : null}

          <input
            ref={photoInput}
            type="file"
            accept="image/*"
            capture="environment"
            multiple
            onChange={(e) => void onPhotos(e)}
            className="sr-only"
            tabIndex={-1}
            aria-hidden="true"
          />
          <OutlineButton onClick={() => photoInput.current?.click()}>
            <CameraIcon />
            {t('today.addPhotos')}
          </OutlineButton>
          {pendingPhotos > 0 ? (
            <p role="status" className="m-0 text-center text-[14px] text-dust">
              {t('today.photosAdded', { count: pendingPhotos })}
            </p>
          ) : null}
          {photoError ? (
            <p role="alert" className="m-0 text-center text-[14px] text-missing">
              {t('sending.errors.media_type_not_allowed')}
            </p>
          ) : null}

          {/* A day with a report on its way cannot be a no-work or weather day (spec §19 Q41). */}
          {today.report ? null : (
            <div className="grid grid-cols-2 gap-2">
              <QuietButton onClick={() => setSheet('no_work')}>{t('today.noWork')}</QuietButton>
              <QuietButton onClick={() => setSheet('weather_day')}>
                {t('today.weather')}
              </QuietButton>
            </div>
          )}

          {TALK_NOW_ENABLED || voiceNumber ? (
            <div className="flex flex-col gap-0.5">
              {TALK_NOW_ENABLED ? (
                <>
                  {/* Week 2 (M7) wires it to `voice/token` and the browser call (Field-08); the
                      flag stays false until then. */}
                  <button
                    type="button"
                    className="flex h-target items-center justify-center gap-2.5 rounded-card border-2 border-asphalt bg-white text-[16px] font-bold text-asphalt"
                  >
                    <HeadsetIcon />
                    {t('today.talkNow')}
                  </button>
                  {/* Field-10: without a voice number the line under it says no number is needed. */}
                  {voiceNumber ? null : (
                    <span className="flex min-h-9 items-center justify-center text-center text-[14px] text-dust">
                      {t('today.talkNowHint')}
                    </span>
                  )}
                </>
              ) : null}
              {voiceNumber ? (
                <a
                  href={`tel:${voiceNumber}`}
                  className="flex h-target items-center justify-center text-[15px] font-semibold text-level no-underline"
                >
                  {t('today.call', { number: formatPhone(voiceNumber) })}
                </a>
              ) : null}
            </div>
          ) : null}
        </>
      )}

      <SiteSheet
        open={sheet === 'site'}
        sites={sites.filter((s) => s.status === 'active')}
        currentId={today.site.id}
        onPick={(id) => {
          setSheet(null);
          loadedSite.current = null;
          setToday(null);
          patch({ siteId: id, date: null });
        }}
        onClose={() => setSheet(null)}
      />
      <DaySheet
        kind={sheet === 'no_work' || sheet === 'weather_day' ? sheet : null}
        siteName={today.site.name}
        busy={dayBusy}
        error={dayError}
        onConfirm={(details) => void confirmDay(details)}
        onClose={() => {
          setSheet(null);
          setDayError(null);
        }}
      />
    </Screen>
  );
}
