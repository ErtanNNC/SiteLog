import { Fragment, useEffect, type ReactNode } from 'react';
import { Link } from 'react-router';
import type { ReportView } from '@sitelog/shared/field-contract.ts';
import { firstName } from '@sitelog/shared/format.ts';
import { pdfFileName } from '@sitelog/shared/report/numbering.ts';
import { buttonClasses } from '@/components/buttonStyles';
import { Header } from '@/components/Header';
import { OfflineBanner } from '@/components/OfflineBanner';
import { Screen } from '@/components/Screen';
import { useFieldCopy } from '@/i18n/useFieldCopy';

/**
 * field-api signs a filed report's PDF for 10 minutes (`reports/:id` `pdfUrl`): the screen fetches
 * the view again a minute before, so the link it shows always opens.
 */
export const PDF_URL_REFRESH_MS = 9 * 60_000;

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

/**
 * Filed (F8, Field-07; W1-15): the check, "Filed.", one line of thanks with the report number,
 * and the PDF, which opens through the view's freshly signed URL (also the target of the `filed`
 * text's link, `/r/{code}/report/{id}`). Confetti-free. While render_pdf has not stored the file
 * the card says so and `ReportScreen` keeps checking; `onRefresh` renews the signed URL before it
 * expires.
 *
 * Week 1 (spec §19 Q67): no *Add photos* and no *Past reports* with the edit hint. A filed report
 * takes no more uploads until F9's new version, and Past reports with its edits is M6; until then
 * the screen's way on is *Back to Today*. The PDF card shows the file's name (the artboard's
 * "2 pages · also sent by text" needs a page count field-api does not have, and the text is sent
 * only with consent).
 */
export function Filed({
  view,
  reporterName,
  onRefresh,
  notice,
}: {
  view: ReportView;
  reporterName: string;
  onRefresh: () => void;
  notice?: ReactNode;
}) {
  const { t } = useFieldCopy();

  useEffect(() => {
    if (!view.pdfUrl) return;
    const timer = setTimeout(onRefresh, PDF_URL_REFRESH_MS);
    return () => clearTimeout(timer);
  }, [view.pdfUrl, onRefresh]);

  const body = withNodes(t('filed.body', { no: SLOT, name: firstName(reporterName) }), [
    <b key="no" className="font-mono font-semibold">
      {view.reportNo}
    </b>,
  ]);
  const fileName = pdfFileName(view.reportNo, view.date, view.currentVersion);
  const card = (
    <>
      <span
        aria-hidden="true"
        className="box-border flex h-12 w-10 flex-none items-end justify-center rounded-chip bg-signal pb-1.5 font-mono text-[11px] font-semibold text-asphalt"
      >
        {t('filed.pdfBadge')}
      </span>
      <span className="flex min-w-0 flex-col gap-0.5">
        <b className="text-[15px]">{t('filed.pdf')}</b>{' '}
        <span className="font-mono text-[13px] text-dust [overflow-wrap:anywhere]">
          {view.pdfUrl ? fileName : t('filed.pdfPreparing')}
        </span>
      </span>
    </>
  );

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

      {view.pdfUrl ? (
        <a
          href={view.pdfUrl}
          target="_blank"
          rel="noopener noreferrer"
          className="mt-1.5 flex min-h-target items-center gap-3.5 rounded-card border border-rebar bg-white p-3.5 text-asphalt no-underline"
        >
          {card} <span className="sr-only">{t('filed.opensNewTab')}</span>
          <svg
            width="18"
            height="18"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
            aria-hidden="true"
            focusable="false"
            className="ml-auto flex-none"
          >
            <path d="M9 6l6 6-6 6" />
          </svg>
        </a>
      ) : (
        // Not a link until the file exists; the status is said in words, not by a missing chevron.
        <div
          role="status"
          className="mt-1.5 flex min-h-target items-center gap-3.5 rounded-card border border-rebar bg-white p-3.5 text-asphalt"
        >
          {card}
        </div>
      )}

      <div className="sticky bottom-0 mt-auto bg-chalk pt-3">
        <Link to="/today" className={buttonClasses('outline')}>
          {t('sending.backToToday')}
        </Link>
      </div>
    </Screen>
  );
}
