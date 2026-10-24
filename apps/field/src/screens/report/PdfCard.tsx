import type { ReportView } from '@sitelog/shared/field-contract.ts';
import { pdfFileName } from '@sitelog/shared/report/numbering.ts';
import { useFieldCopy } from '@/i18n/useFieldCopy';

/**
 * A filed report's PDF (Field-07; W1-15): a card that opens the view's freshly signed URL in a new
 * tab, named by the file (`{report_no}_{date}_v{n}.pdf`). Until render_pdf stored the file it is
 * not a link and says so in words ("Preparing the PDF…", or with `late` that the PDF is on its
 * way). The Filed screen and the Past reports view (W2-03) both show it.
 */
export function PdfCard({ view, late = false }: { view: ReportView; late?: boolean }) {
  const { t } = useFieldCopy();
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
          {view.pdfUrl ? fileName : t(late ? 'filed.pdfLate' : 'filed.pdfPreparing')}
        </span>
      </span>
    </>
  );
  return view.pdfUrl ? (
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
  );
}
