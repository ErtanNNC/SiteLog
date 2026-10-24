import { useCallback, useEffect, useId, useState } from 'react';
import { Link, useNavigate } from 'react-router';
import type { HistoryResponse } from '@sitelog/shared/field-contract.ts';
import { formatDate } from '@sitelog/shared/format.ts';
import { upperIn } from '@sitelog/shared/locale.ts';
import { apiErrorCode } from '@/api/field';
import { useApi } from '@/api/useApi';
import { SolidButton } from '@/components/Buttons';
import { buttonClasses } from '@/components/buttonStyles';
import { OfflineBanner } from '@/components/OfflineBanner';
import { Screen, ScreenTitle } from '@/components/Screen';
import { useFieldCopy } from '@/i18n/useFieldCopy';
import { NoLink } from '@/screens/NoLink';
import { useSession } from '@/session/useSession';
import { groupBySite, statusChip, type HistoryRow } from './status';

/** Refusals the link flow handles or explains (as Today does): the phone goes back to `/r/:code`. */
export const RELINK = new Set([
  'device_unverified',
  'consent_required',
  'link_expired',
  'link_revoked',
  'link_not_found',
  'reporter_disabled',
]);

/**
 * Past reports (F10, F14, spec §9.3; W2-03): the reports of the last 14 days of the link's sites
 * (`GET history`, each site's own time zone), per site when there is more than one, newest first:
 * the date, the report number, the status as a chip with its words and a *Late* badge. A row opens
 * the read-only report (`/history/:id`). _Change something_ (F10) is W2-11. There is no artboard:
 * built from §9.3 and the Today (Field-03) and Draft (Field-06) patterns.
 */
export function History() {
  const { session } = useSession();
  if (!session) return <NoLink />;
  return <HistoryLoaded code={session.code} />;
}

function HistoryLoaded({ code }: { code: string }) {
  const api = useApi();
  const navigate = useNavigate();
  const { t, tc } = useFieldCopy();
  const [history, setHistory] = useState<HistoryResponse | null>(null);
  const [failed, setFailed] = useState(false);

  const load = useCallback(
    (signal?: AbortSignal) =>
      api.history(code, signal).then(
        (res) => {
          if (signal?.aborted) return;
          setFailed(false);
          setHistory(res);
        },
        (err: unknown) => {
          if (signal?.aborted) return;
          const apiCode = apiErrorCode(err);
          if (apiCode && RELINK.has(apiCode)) {
            navigate(`/r/${code}`, { replace: true });
            return;
          }
          setFailed(true);
        },
      ),
    [api, code, navigate],
  );

  useEffect(() => {
    const controller = new AbortController();
    void load(controller.signal);
    return () => controller.abort();
  }, [load]);

  const title = t('routes.history');
  const groups = history ? groupBySite(history.reports) : [];

  return (
    <Screen title={title} dateLine={false} settings>
      <OfflineBanner />
      <div className="flex flex-col gap-1">
        <ScreenTitle>{title}</ScreenTitle>
        <p className="m-0 text-[15px] leading-[21px] text-dust">{t('history.intro')}</p>
      </div>
      {failed ? (
        <>
          <p role="alert" className="m-0 text-dust">
            {t('history.failed')}
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
      ) : !history ? (
        <p role="status" className="m-0 text-dust">
          {tc('loading')}
        </p>
      ) : groups.length === 0 ? (
        <p className="m-0 text-[16px] leading-6 text-steel">{t('history.empty')}</p>
      ) : (
        groups.map((g) => (
          <SiteGroup key={g.siteId} name={g.siteName} rows={g.rows} titled={groups.length > 1} />
        ))
      )}
      <div className="sticky bottom-0 mt-auto bg-chalk pt-3">
        <Link to="/today" className={buttonClasses('outline')}>
          {t('sending.backToToday')}
        </Link>
      </div>
    </Screen>
  );
}

function SiteGroup({ name, rows, titled }: { name: string; rows: HistoryRow[]; titled: boolean }) {
  const { language } = useFieldCopy();
  const id = useId();
  return (
    <section aria-labelledby={titled ? id : undefined} className="flex flex-col gap-2">
      {titled ? (
        <h2
          id={id}
          className="m-0 font-mono text-[12px] leading-[18px] font-normal tracking-[0.08em] text-dust [overflow-wrap:anywhere]"
        >
          {upperIn(language, name)}
        </h2>
      ) : null}
      <ul className="m-0 flex list-none flex-col gap-2 p-0">
        {rows.map((r) => (
          <li key={r.id}>
            <HistoryItem row={r} />
          </li>
        ))}
      </ul>
    </section>
  );
}

function HistoryItem({ row }: { row: HistoryRow }) {
  const { t, language } = useFieldCopy();
  const { chip, dot } = statusChip(row.status);
  return (
    <Link
      to={`/history/${encodeURIComponent(row.id)}`}
      className="flex min-h-target items-center gap-3 rounded-card border border-rebar bg-white px-3.5 py-2.5 text-asphalt no-underline"
    >
      <span className="flex min-w-0 flex-1 flex-col gap-0.5">
        <b className="text-[16px] leading-[22px] [overflow-wrap:anywhere]">
          {formatDate(row.date, 'weekdayMonthDay', language)}
        </b>
        <span className="font-mono text-[13px] leading-[18px] text-steel [overflow-wrap:anywhere]">
          {row.reportNo}
        </span>
      </span>
      <span className="flex flex-none flex-col items-end gap-1">
        <span
          className={`inline-flex items-center gap-1.5 rounded-chip px-2.5 py-1 text-[13px] leading-[18px] font-semibold whitespace-nowrap ${chip}`}
        >
          <span aria-hidden="true" className={`size-[7px] rounded-full ${dot}`} />
          {t(`history.status.${row.status}`)}
        </span>
        {row.isLate ? (
          <span className="rounded-chip bg-chip-miss-bg px-2 py-0.5 text-[12px] leading-4 font-bold text-chip-miss-fg">
            {t('history.late')}
          </span>
        ) : null}
      </span>
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
        className="flex-none text-dust"
      >
        <path d="M9 6l6 6-6 6" />
      </svg>
    </Link>
  );
}
