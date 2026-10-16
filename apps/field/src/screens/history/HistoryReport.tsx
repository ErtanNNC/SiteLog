import { useCallback, useEffect, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router';
import type { ReportView } from '@sitelog/shared/field-contract.ts';
import { formatDate } from '@sitelog/shared/format.ts';
import { upperIn } from '@sitelog/shared/locale.ts';
import { apiErrorCode } from '@/api/field';
import { useApi } from '@/api/useApi';
import { SolidButton } from '@/components/Buttons';
import { buttonClasses } from '@/components/buttonStyles';
import { Header } from '@/components/Header';
import { OfflineBanner } from '@/components/OfflineBanner';
import { Screen, ScreenTitle } from '@/components/Screen';
import { useFieldCopy } from '@/i18n/useFieldCopy';
import { NoLink } from '@/screens/NoLink';
import { PDF_URL_REFRESH_MS } from '@/screens/report/Filed';
import { PdfCard } from '@/screens/report/PdfCard';
import { ReportSections } from '@/screens/report/ReportSections';
import { useSession } from '@/session/useSession';
import { RELINK } from './History';
import { inProgress, statusChip } from './status';

/**
 * One past report, read-only (F10 "pick a day → see the report", §9.3 Past reports; W2-03): the
 * date, the report number, the status in words, the Draft's sections (Field-06, W1-13) and, once
 * filed, the PDF card (Field-07, W1-15), whose signed URL is fetched again before it expires. A
 * report not filed yet offers *Continue this report* (its `/report/:id` flow). _Change something_
 * (F10) is W2-11: until then the view has no edit action.
 */
export function HistoryReport() {
  const { id = '' } = useParams();
  const { session } = useSession();
  if (!session) return <NoLink />;
  return <HistoryReportLoaded key={id} code={session.code} id={id} />;
}

function HistoryReportLoaded({ code, id }: { code: string; id: string }) {
  const api = useApi();
  const navigate = useNavigate();
  const { t, tc, language } = useFieldCopy();
  const [view, setView] = useState<ReportView | null>(null);
  const [failed, setFailed] = useState(false);

  const load = useCallback(
    (signal?: AbortSignal) =>
      api.report(code, id, signal).then(
        (res) => {
          if (signal?.aborted) return;
          setFailed(false);
          setView(res);
        },
        (err: unknown) => {
          if (signal?.aborted) return;
          const apiCode = apiErrorCode(err);
          if (apiCode && RELINK.has(apiCode)) {
            navigate(`/r/${code}`, { replace: true });
            return;
          }
          if (apiCode === 'not_found') {
            navigate('/history', { replace: true });
            return;
          }
          setFailed(true);
        },
      ),
    [api, code, id, navigate],
  );

  useEffect(() => {
    const controller = new AbortController();
    void load(controller.signal);
    return () => controller.abort();
  }, [load]);

  // The PDF's signed URL lives 10 minutes: fetch the view again before it expires.
  useEffect(() => {
    if (!view?.pdfUrl) return;
    const timer = setTimeout(() => void load(), PDF_URL_REFRESH_MS);
    return () => clearTimeout(timer);
  }, [view?.pdfUrl, load]);

  const back = (
    <div className="sticky bottom-0 mt-auto bg-chalk pt-3">
      <Link to="/history" className={buttonClasses('outline')}>
        {t('history.back')}
      </Link>
    </div>
  );

  if (!view) {
    return (
      <Screen title={t('routes.history')} dateLine={false}>
        <OfflineBanner />
        <ScreenTitle>{t('routes.history')}</ScreenTitle>
        {failed ? (
          <>
            <p role="alert" className="m-0 text-dust">
              {t('history.reportFailed')}
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
        {back}
      </Screen>
    );
  }

  const filed = view.status === 'filed' || view.status === 'signed_off';
  const { chip, dot } = statusChip(view.status);
  return (
    <Screen title={view.reportNo} dateLine={false} header={<Header siteName={view.siteName} />}>
      <OfflineBanner />
      <div className="flex flex-col gap-1.5">
        <span className="font-mono text-[12px] leading-[18px] tracking-[0.08em] text-signal-deep">
          {upperIn(
            language,
            t('history.eyebrow', { date: formatDate(view.date, 'weekdayMonthDay', language) }),
          )}
        </span>
        <h1
          tabIndex={-1}
          className="m-0 font-mono text-[24px] leading-7 font-semibold [overflow-wrap:anywhere]"
        >
          {view.reportNo}
        </h1>
        <div className="flex flex-wrap items-center gap-2">
          <span
            className={`inline-flex items-center gap-1.5 rounded-chip px-2.5 py-1 text-[13px] leading-[18px] font-semibold whitespace-nowrap ${chip}`}
          >
            <span aria-hidden="true" className={`size-[7px] rounded-full ${dot}`} />
            {t(`history.status.${view.status}`)}
          </span>
          {view.currentVersion > 1 ? (
            <span className="font-mono text-[13px] text-steel">
              {t('history.version', { version: view.currentVersion })}
            </span>
          ) : null}
        </div>
      </div>

      {filed ? <PdfCard view={view} /> : null}
      {inProgress(view.status) ? (
        <Link to={`/report/${encodeURIComponent(view.id)}`} className={buttonClasses('solid')}>
          {t('history.continue')}
        </Link>
      ) : null}
      {view.data ? (
        <ReportSections data={view.data} />
      ) : (
        <p className="m-0 text-[16px] leading-6 text-steel">{t('history.noData')}</p>
      )}
      {back}
    </Screen>
  );
}
