import { Fragment, useEffect, useRef, useState, type ChangeEvent, type ReactNode } from 'react';
import { Link } from 'react-router';
import type { ReportView } from '@sitelog/shared/field-contract.ts';
import { firstName, formatDate, formatDateInTz, formatTimeInTz } from '@sitelog/shared/format.ts';
import { OutlineButton } from '@/components/Buttons';
import { buttonClasses } from '@/components/buttonStyles';
import { Header } from '@/components/Header';
import { OfflineBanner } from '@/components/OfflineBanner';
import { Screen } from '@/components/Screen';
import { useFieldCopy } from '@/i18n/useFieldCopy';
import { sendingErrorKey } from '@/lib/sendingErrors';
import { useQueue, useQueueSnapshot } from '@/queue/useQueue';
import { photoMime } from '@/recorder/photos';
import type { Clip, RecorderDeps } from '@/recorder/recorder';
import { AddPhotosSheet } from './AddPhotosSheet';
import { PdfCard } from './PdfCard';

/**
 * field-api signs a filed report's PDF for 10 minutes (`reports/:id` `pdfUrl`): the screen fetches
 * the view again a minute before, so the link it shows always opens.
 */
export const PDF_URL_REFRESH_MS = 9 * 60_000;

/**
 * How long the screen checks for a PDF render_pdf has not stored: then it stops and says the PDF
 * is on its way (a render that died must not keep the phone polling forever).
 */
export const PDF_WAIT_MS = 3 * 60_000;

/** A placeholder no copy contains: where a bold value goes in a translated sentence. */
const SLOT = '\u0001';

/** `text` with each `SLOT` replaced by the next node (a value set in bold inside a sentence). */
function withNodes(text: string, nodes: ReactNode[]): ReactNode[] {
  return text.split(SLOT).map((part, i) => (
    <Fragment key={i}>
      {part}
      {i < nodes.length ? nodes[i] : null}
    </Fragment>
  ));
}

function CameraIcon() {
  return (
    <svg
      width="20"
      height="20"
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

function ClockIcon() {
  return (
    <svg
      width="20"
      height="20"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
    >
      <circle cx="12" cy="12" r="9" />
      <path d="M12 7v5l3 2" />
    </svg>
  );
}

/** A batch the reporter sent from this screen: its id and the version the report was at. */
interface SentBatch {
  id: string;
  fromVersion: number;
}

/**
 * Filed (F8, Field-07; W1-15, W2-04): the check, "Filed.", one line of thanks with the report
 * number, and the PDF, which opens through the view's freshly signed URL (also the target of the
 * `filed` text's link, `/r/{code}/report/{id}`). Confetti-free. While render_pdf has not stored the
 * file the card says so and `ReportScreen` keeps checking, for `PDF_WAIT_MS` at most (then the card
 * says the PDF is on its way and the office has the report); `onRefresh` renews the signed URL
 * before it expires.
 *
 * M6 (spec §19 Q67, W2-04): *Add more photos* (F9: shown while `addPhotos.canAdd`, the picker,
 * then `AddPhotosSheet` with an optional voice caption; the photos and the caption go through the
 * upload queue as one batch, which field-api makes the report's next version: the PDF card then
 * names `_v{n}`), *Past reports* (W2-03's list) and the edit hint. The PDF card shows the file's
 * name (the artboard's "2 pages · also sent by text" needs a page count field-api does not have).
 */
export function Filed({
  code,
  view,
  reporterName,
  timezone,
  onRefresh,
  notice,
  pdfLate = false,
  recorderDeps,
}: {
  code: string;
  view: ReportView;
  reporterName: string;
  /** The site's time zone (F9's window is said in it); the phone's own when unknown. */
  timezone?: string;
  onRefresh: () => void;
  notice?: ReactNode;
  /** No PDF (or no new version) after `PDF_WAIT_MS`: the screen stopped checking. */
  pdfLate?: boolean;
  /** Tests: a fake MediaRecorder for the caption. */
  recorderDeps?: RecorderDeps;
}) {
  const { t, language } = useFieldCopy();
  const queue = useQueue();
  const snapshot = useQueueSnapshot();
  const picker = useRef<HTMLInputElement>(null);
  const [picked, setPicked] = useState<{ files: File[]; dropped: number } | null>(null);
  const [sent, setSent] = useState<SentBatch | null>(null);
  const [sendError, setSendError] = useState<string | null>(null);

  useEffect(() => {
    if (!view.pdfUrl) return;
    const timer = setTimeout(onRefresh, PDF_URL_REFRESH_MS);
    return () => clearTimeout(timer);
  }, [view.pdfUrl, onRefresh]);

  // The batch's uploads: once every one is through, the report has its new version (or the
  // caption's transcription will make it): check the report again.
  const batchItems = sent ? snapshot.items.filter((i) => i.addTo?.batchId === sent.id) : [];
  const batchDone = batchItems.length > 0 && batchItems.every((i) => i.status === 'done');
  const batchFailed = batchItems.find((i) => i.status === 'failed') ?? null;
  useEffect(() => {
    if (batchDone) onRefresh();
  }, [batchDone, onRefresh]);

  const photos = view.addPhotos;
  const added = sent !== null && view.currentVersion > sent.fromVersion;
  const adding = sent !== null && !added && !batchFailed;
  const tz = timezone ?? Intl.DateTimeFormat().resolvedOptions().timeZone;
  const until = photos
    ? `${formatDate(formatDateInTz(photos.until, tz), 'weekdayMonthDay', language)} ${formatTimeInTz(
        photos.until,
        tz,
      )}`
    : '';

  function onPicked(e: ChangeEvent<HTMLInputElement>) {
    const files = Array.from(e.target.files ?? []);
    e.target.value = '';
    if (!photos || files.length === 0) return;
    const usable = files.filter((f) => photoMime(f) !== null);
    if (usable.length === 0) {
      setSendError('media_type_not_allowed');
      return;
    }
    setSendError(null);
    const kept = usable.slice(0, photos.remaining);
    setPicked({ files: kept, dropped: usable.length - kept.length });
  }

  async function send(caption: Clip | null) {
    if (!picked) return;
    const batchId = crypto.randomUUID();
    const addTo = {
      reportId: view.id,
      batchId,
      photos: picked.files.length,
      caption: caption !== null,
    };
    const common = { code, siteId: view.siteId, date: view.date, addTo };
    setPicked(null);
    setSendError(null);
    try {
      for (const file of picked.files) {
        await queue.enqueue({
          ...common,
          kind: 'photo',
          mime: photoMime(file)!,
          blob: file,
          recordedAt: file.lastModified ? new Date(file.lastModified).toISOString() : null,
        });
      }
      if (caption) {
        await queue.enqueue({
          ...common,
          kind: 'audio',
          mime: caption.mime,
          blob: caption.blob,
          recordedAt: caption.startedAt,
        });
      }
      setSent({ id: batchId, fromVersion: view.currentVersion });
    } catch (err) {
      console.error('[field] could not queue the photos', err);
      setSendError('generic');
    }
  }

  // W2-08: a weather-day or no-work record (F12) is not a daily report.
  const bodyKey =
    view.kind === 'weather_day'
      ? 'filed.bodyWeather'
      : view.kind === 'no_work'
        ? 'filed.bodyNoWork'
        : 'filed.body';
  const weather = view.kind === 'weather_day';
  const body = withNodes(t(bodyKey, { no: SLOT, name: firstName(reporterName) }), [
    <b key="no" className="font-mono font-semibold">
      {view.reportNo}
    </b>,
  ]);
  const hint = withNodes(t('filed.hint', { pastReports: SLOT }), [
    <b key="past">{t('filed.pastReports')}</b>,
  ]);
  const progress = added
    ? t('filed.photos.added', { version: view.currentVersion })
    : adding
      ? pdfLate
        ? t('filed.photos.late')
        : t((photos?.pending ?? 0) > 0 ? 'filed.photos.captioning' : 'filed.photos.adding')
      : null;
  const errorKey = batchFailed ? batchFailed.error : sendError;

  return (
    <Screen title={t('filed.title')} dateLine={false} header={<Header siteName={view.siteName} />}>
      <OfflineBanner />
      {notice}
      <div className="flex flex-col items-center gap-3.5 pt-[22px] text-center">
        <span className="flex size-[88px] items-center justify-center rounded-full bg-chip-filed-bg">
          <svg
            width="44"
            height="44"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2.6"
            strokeLinecap="round"
            strokeLinejoin="round"
            aria-hidden="true"
            focusable="false"
            className="text-filed"
          >
            <path d="M5 12l5 5 9-10" />
          </svg>
        </span>
        <h1
          tabIndex={-1}
          className="m-0 text-[34px] leading-[38px] font-extrabold tracking-[-0.02em] outline-none [font-stretch:122%]"
        >
          {t('filed.title')}
        </h1>
        <p className="m-0 text-[17px] leading-6 text-steel [overflow-wrap:anywhere]">{body}</p>
      </div>

      <PdfCard view={view} late={pdfLate && !adding} />

      {progress ? (
        <p role="status" className="m-0 text-[15px] leading-[21px] text-steel">
          {progress}
        </p>
      ) : null}
      {errorKey ? (
        <p role="alert" className="m-0 text-[15px] leading-[21px] text-missing">
          {t('filed.photos.failed')} {t(sendingErrorKey(errorKey))}
        </p>
      ) : null}

      {weather && photos?.canAdd && !adding && !added ? (
        <p className="m-0 text-[15px] leading-[21px] text-steel">{t('filed.weatherPhotoHint')}</p>
      ) : null}

      {/* The weather day's longer label takes the full width (one line at 390 px). */}
      <div
        className={`grid gap-2.5 ${photos?.canAdd && !adding && !weather ? 'grid-cols-2' : 'grid-cols-1'}`}
      >
        {photos?.canAdd && !adding ? (
          <>
            <input
              ref={picker}
              type="file"
              accept="image/*"
              multiple
              onChange={onPicked}
              className="sr-only"
              tabIndex={-1}
              aria-hidden="true"
            />
            <OutlineButton onClick={() => picker.current?.click()}>
              <CameraIcon />
              {t(weather ? 'filed.weatherPhoto' : 'filed.addPhotos')}
            </OutlineButton>
          </>
        ) : null}
        <Link to="/history" className={buttonClasses('outline')}>
          <ClockIcon />
          {t('filed.pastReports')}
        </Link>
      </div>
      <p className="m-0 rounded-card bg-concrete px-4 py-3.5 text-[14px] leading-5 text-steel">
        {hint}
      </p>

      <div className="sticky bottom-0 mt-auto bg-chalk pt-3">
        <Link to="/today" className={buttonClasses('outline')}>
          {t('sending.backToToday')}
        </Link>
      </div>

      <AddPhotosSheet
        open={picked !== null}
        reportNo={view.reportNo}
        files={picked?.files ?? []}
        dropped={picked?.dropped ?? 0}
        remaining={photos?.remaining ?? 0}
        until={until}
        onSend={(caption) => void send(caption)}
        onClose={() => setPicked(null)}
        recorderDeps={recorderDeps}
      />
    </Screen>
  );
}
