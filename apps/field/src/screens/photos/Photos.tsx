import { useCallback, useEffect, useRef, useState } from 'react';
import { Navigate, useNavigate } from 'react-router';
import type { ReportView } from '@sitelog/shared/field-contract.ts';
import { formatDate, formatDateInTz, formatTimeInTz } from '@sitelog/shared/format.ts';
import { apiErrorCode } from '@/api/field';
import { useApi } from '@/api/useApi';
import { PrimaryButton, SolidButton } from '@/components/Buttons';
import { Header } from '@/components/Header';
import { OfflineBanner } from '@/components/OfflineBanner';
import { Screen, ScreenTitle } from '@/components/Screen';
import { useFieldCopy } from '@/i18n/useFieldCopy';
import { sendingErrorKey } from '@/lib/sendingErrors';
import type { RecorderDeps } from '@/recorder/recorder';
import { NoLink } from '@/screens/NoLink';
import { AddPhotosSheet } from '@/screens/report/AddPhotosSheet';
import { usePhotoBatch } from '@/screens/report/usePhotoBatch';
import { useSession } from '@/session/useSession';

/** Refusals the link flow handles or explains (as Today does). */
const RELINK = new Set<string>([
  'device_unverified',
  'consent_required',
  'link_expired',
  'link_revoked',
  'link_not_found',
  'reporter_disabled',
]);

/** While the new version is on its way: how often the screen reads the report again. */
const REFRESH_MS = 3000;

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

type Load =
  | { kind: 'loading' }
  | { kind: 'failed' }
  | { kind: 'noReport' }
  | { kind: 'ready'; view: ReportView; timezone: string };

/**
 * F9's photo-only screen (W3-13): a photos link (`kind 'photos'`, texted after a call-filed
 * report; spec F9 step 2) opens this, not Today. It finds the link's day's report (`today` for
 * the link's site and date), then offers only photos: the report, how many it still takes and
 * until when, the picker, and W2-04's sheet (up to 4 photos after filing and an optional voice
 * caption) sent as one batch through the upload queue, which field-api makes the next version
 * ("Photos added. Version 2 is with the office."). No recording, no Talk now: a photos link takes
 * photos only (field-api refuses anything else). No artboard: built from F9 and the Filed screen.
 */
export function Photos({ recorderDeps }: { recorderDeps?: RecorderDeps } = {}) {
  const { session } = useSession();
  if (!session) return <NoLink />;
  if (session.link.kind !== 'photos') return <Navigate to="/today" replace />;
  return (
    <PhotosLoaded
      code={session.code}
      siteId={session.link.siteId}
      sites={session.sites}
      recorderDeps={recorderDeps}
    />
  );
}

function PhotosLoaded({
  code,
  siteId,
  sites,
  recorderDeps,
}: {
  code: string;
  siteId: string | null;
  sites: readonly { id: string; name: string; timezone: string }[];
  recorderDeps?: RecorderDeps;
}) {
  const api = useApi();
  const navigate = useNavigate();
  const { t, tc, language } = useFieldCopy();
  const [load, setLoad] = useState<Load>({ kind: 'loading' });
  const picker = useRef<HTMLInputElement>(null);

  /** The link's day's report as the screen shows it; null when the link flow takes over. */
  const fetchLoad = useCallback(
    async (signal?: AbortSignal): Promise<Load | null> => {
      try {
        const today = await api.today(code, siteId, signal);
        const report = today.report;
        if (!report || (report.status !== 'filed' && report.status !== 'signed_off')) {
          return { kind: 'noReport' };
        }
        const view = await api.report(code, report.id, signal);
        return { kind: 'ready', view, timezone: today.site.timezone };
      } catch (err) {
        if (signal?.aborted) return null;
        const apiCode = apiErrorCode(err);
        if (apiCode && RELINK.has(apiCode)) {
          navigate(`/r/${code}`, { replace: true });
          return null;
        }
        return { kind: 'failed' };
      }
    },
    [api, code, siteId, navigate],
  );

  const read = useCallback(
    (signal?: AbortSignal) =>
      fetchLoad(signal).then((next) => {
        if (next && !signal?.aborted) setLoad(next);
      }),
    [fetchLoad],
  );

  useEffect(() => {
    const controller = new AbortController();
    fetchLoad(controller.signal).then((next) => {
      if (next && !controller.signal.aborted) setLoad(next);
    });
    return () => controller.abort();
  }, [fetchLoad]);

  const view = load.kind === 'ready' ? load.view : null;
  const refresh = useCallback(() => void read(), [read]);
  const batch = usePhotoBatch({ code, view, onRefresh: refresh });

  // The batch is through but the version is not there yet (a caption being transcribed): read
  // the report again until it is.
  const waiting = batch.adding && view !== null;
  useEffect(() => {
    if (!waiting) return;
    const handle = setInterval(refresh, REFRESH_MS);
    return () => clearInterval(handle);
  }, [waiting, refresh]);

  const siteName = sites.find((s) => s.id === siteId)?.name;
  const header = <Header siteName={siteName} />;

  if (load.kind !== 'ready') {
    return (
      <Screen title={t('photosLink.title')} header={header} dateLine={false}>
        <OfflineBanner />
        <ScreenTitle>{t('photosLink.title')}</ScreenTitle>
        {load.kind === 'loading' ? (
          <p role="status" className="m-0 text-dust">
            {tc('loading')}
          </p>
        ) : load.kind === 'noReport' ? (
          <p className="m-0 text-[16px] leading-6 text-steel">{t('photosLink.noReport')}</p>
        ) : (
          <>
            <p role="alert" className="m-0 text-[16px] leading-6 text-dust">
              {t('photosLink.failed')}
            </p>
            <SolidButton
              onClick={() => {
                setLoad({ kind: 'loading' });
                void read();
              }}
            >
              {tc('retry')}
            </SolidButton>
          </>
        )}
      </Screen>
    );
  }

  const v = load.view;
  const photos = v.addPhotos;
  const tz = load.timezone;
  const until = photos
    ? `${formatDate(formatDateInTz(photos.until, tz), 'weekdayMonthDay', language)} ${formatTimeInTz(
        photos.until,
        tz,
      )}`
    : '';
  const progress = batch.added
    ? t('filed.photos.added', { version: v.currentVersion })
    : batch.adding
      ? t((photos?.pending ?? 0) > 0 ? 'filed.photos.captioning' : 'filed.photos.adding')
      : null;
  const canAdd = photos?.canAdd === true && !batch.adding;

  return (
    <Screen title={t('photosLink.title')} header={header} dateLine={false}>
      <OfflineBanner />
      <ScreenTitle>{t('photosLink.title')}</ScreenTitle>
      <p className="m-0 text-[17px] leading-6 text-steel [overflow-wrap:anywhere]">
        {t('photosLink.intro', {
          no: v.reportNo,
          site: v.siteName,
          date: formatDate(v.date, 'weekdayMonthDay', language),
        })}
      </p>
      {canAdd && photos ? (
        <p className="m-0 text-[16px] leading-6 text-steel">
          {t('filed.photos.window', { count: photos.remaining, until })}
        </p>
      ) : null}
      {progress ? (
        <p role="status" className="m-0 text-[16px] leading-6 text-steel">
          {progress}
        </p>
      ) : null}
      {batch.errorKey ? (
        <p role="alert" className="m-0 text-[15px] leading-[21px] text-missing">
          {t('filed.photos.failed')} {t(sendingErrorKey(batch.errorKey))}
        </p>
      ) : null}
      {!canAdd && !batch.adding && !batch.added ? (
        <p className="m-0 text-[16px] leading-6 text-steel">{t('photosLink.closed')}</p>
      ) : null}

      {canAdd ? (
        <div className="mt-auto flex flex-col gap-3 pb-2">
          <input
            ref={picker}
            type="file"
            accept="image/*"
            multiple
            onChange={batch.onPicked}
            className="sr-only"
            tabIndex={-1}
            aria-hidden="true"
          />
          <PrimaryButton onClick={() => picker.current?.click()}>
            <CameraIcon />
            {t('photosLink.pick')}
          </PrimaryButton>
        </div>
      ) : null}

      <AddPhotosSheet
        open={batch.picked !== null}
        reportNo={v.reportNo}
        files={batch.picked?.files ?? []}
        dropped={batch.picked?.dropped ?? 0}
        remaining={photos?.remaining ?? 0}
        until={until}
        onSend={(caption) => void batch.send(caption)}
        onClose={batch.closeSheet}
        recorderDeps={recorderDeps}
      />
    </Screen>
  );
}
