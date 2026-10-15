import { useId, useState, type ReactNode } from 'react';
import { useNavigate } from 'react-router';
import type { ReportView } from '@sitelog/shared/field-contract.ts';
import { formatDate, formatHoursIn } from '@sitelog/shared/format.ts';
import { upperIn } from '@sitelog/shared/locale.ts';
import { deriveTotals } from '@sitelog/shared/report/hours.ts';
import type { DailyReportData } from '@sitelog/shared/schemas/report.ts';
import { apiErrorCode, isOfflineError } from '@/api/field';
import { useApi } from '@/api/useApi';
import { PrimaryButton } from '@/components/Buttons';
import { Header } from '@/components/Header';
import { OfflineBanner } from '@/components/OfflineBanner';
import { ActionBar, Screen } from '@/components/Screen';
import { useFieldCopy } from '@/i18n/useFieldCopy';
import {
  answeredEntry,
  crewValue,
  crewValueSpoken,
  deliveriesLine,
  formatNumberIn,
  nextLine,
  safetyLine,
  weatherLines,
  workLine,
} from './lines';
import type { ConfirmedDraft } from './phase';
import { RELINK } from './useReportPoll';

/**
 * The draft (F8, Field-06; W1-13): the crew with each company's workers × hours and the day's
 * total, then weather, work done, deliveries, safety, next workday and photos, and a sticky
 * **Confirm & send** (`reports/:id/confirm` with the version and draft revision shown, so a newer
 * draft is never filed unseen). The numbers are the draft's (computed in code). The steppers are
 * shown read-only and _Fix by voice_ is not offered: editing comes in M6.
 */
export function Draft({
  code,
  view,
  data,
  notice,
  onConfirmed,
  onStale,
}: {
  code: string;
  view: ReportView;
  data: DailyReportData;
  notice?: ReactNode;
  onConfirmed: (draft: ConfirmedDraft) => void;
  onStale: (message: string) => void;
}) {
  const api = useApi();
  const navigate = useNavigate();
  const { t, language } = useFieldCopy();
  const crewId = useId();
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const totals = deriveTotals(data);
  const upper = (s: string) => upperIn(language, s);

  async function confirm() {
    if (sending) return;
    setSending(true);
    setError(null);
    try {
      // The draft shown, by version and revision: a draft is overwritten in place (a late photo
      // re-extracts it), so the version alone cannot tell a newer one (`draft_changed`).
      const draft = { version: view.currentVersion, draftRev: view.draftRev };
      if (draft.draftRev === null) {
        onStale(t('draft.errors.draft_changed'));
        return;
      }
      await api.confirm(code, view.id, { version: draft.version, draftRev: draft.draftRev });
      onConfirmed(draft);
    } catch (err) {
      const apiCode = apiErrorCode(err);
      if (apiCode && RELINK.has(apiCode)) {
        navigate(`/r/${code}`, { replace: true });
        return;
      }
      if (apiCode === 'draft_changed' || apiCode === 'wrong_state') {
        onStale(t(`draft.errors.${apiCode}`));
        return;
      }
      setError(isOfflineError(err) ? t('draft.errors.offline') : t('draft.errors.generic'));
    } finally {
      setSending(false);
    }
  }

  const weather = weatherLines(data, t, language);
  const rows: { key: string; label: string; value: ReactNode }[] = [
    {
      key: 'weather',
      label: t('draft.weather'),
      value: weather
        ? weather.map((w, i) => (
            <span key={i} className="block">
              {w.text}
              {w.lost ? (
                <>
                  {' '}
                  <b>{w.lost}</b>
                </>
              ) : null}
            </span>
          ))
        : t('draft.notStated'),
    },
    {
      key: 'done',
      label: t('draft.done'),
      value: workLine(data.workPerformed, t) ?? t('draft.notStated'),
    },
  ];
  const delivered = deliveriesLine(data);
  if (delivered) rows.push({ key: 'delivered', label: t('draft.delivered'), value: delivered });
  rows.push({
    key: 'safety',
    label: t('draft.safety'),
    value: safetyLine(data, t) ?? t('draft.notStated'),
  });
  const next = nextLine(data);
  if (next) rows.push({ key: 'next', label: t('draft.next'), value: next });
  rows.push({
    key: 'photos',
    label: t('draft.photos'),
    value: data.photos.length
      ? t('draft.photosCount', { count: data.photos.length })
      : t('draft.none'),
  });

  const crewTotal =
    data.manpower.length > 0
      ? `${totals.headcountKnown ? formatNumberIn(totals.crewOnSite, language) : '—'} · ${
          totals.hoursKnown ? formatHoursIn(totals.totalHours, language) : '—'
        }`
      : null;

  return (
    <Screen title={t('draft.title')} dateLine={false} header={<Header siteName={view.siteName} />}>
      <OfflineBanner />
      {notice}
      <div className="flex flex-col gap-0.5">
        <span className="font-mono text-[12px] leading-[18px] tracking-[0.08em] text-signal-deep">
          {upper(
            t('draft.eyebrow', {
              date: formatDate(view.date || data.reportDate, 'short', language),
            }),
          )}
        </span>
        <h1
          tabIndex={-1}
          className="m-0 text-[24px] leading-7 font-extrabold [overflow-wrap:anywhere] [font-stretch:118%]"
        >
          {t('draft.title')}
        </h1>
      </div>

      <section aria-labelledby={crewId} className="rounded-card border border-rebar bg-white">
        <div className="flex items-center justify-between gap-3 border-b border-rebar px-3.5 py-2.5">
          <h2
            id={crewId}
            className="m-0 font-mono text-[12px] leading-[18px] font-normal tracking-[0.08em] text-dust"
          >
            {upper(t('draft.crew'))}
          </h2>
          {crewTotal ? <b className="font-mono text-[14px] leading-5">{crewTotal}</b> : null}
        </div>
        {data.manpower.length > 0 ? (
          <ul className="m-0 list-none px-3.5 py-1 text-[15px] leading-[22px]">
            {data.manpower.map((entry, i) => (
              <li
                key={`${entry.companyName}:${i}`}
                className="flex min-h-10 items-center justify-between gap-3 border-b border-concrete py-1 last:border-b-0"
              >
                <span className="flex min-w-0 flex-wrap items-center gap-1.5 [overflow-wrap:anywhere]">
                  {entry.companyName}
                  {answeredEntry(entry) ? (
                    <span className="rounded-[3px] bg-chip-review-bg px-[5px] py-px text-[10px] leading-4 font-bold text-chip-review-fg">
                      {upper(t('draft.answered'))}
                    </span>
                  ) : null}
                </span>
                {/* Read-only until M6 (the stepper): the value, read out in words. */}
                <span className="flex h-8 flex-none items-center rounded-btn border border-rebar bg-chalk px-2.5 font-mono text-[14px] font-medium">
                  <span aria-hidden="true">{crewValue(entry, language)}</span>
                  <span className="sr-only">{crewValueSpoken(entry, t, language)}</span>
                </span>
              </li>
            ))}
          </ul>
        ) : (
          <p className="m-0 px-3.5 py-2.5 text-[15px] leading-[22px] text-dust">
            {t('draft.noCrew')}
          </p>
        )}
      </section>

      <dl className="m-0 grid grid-cols-[96px_minmax(0,1fr)] gap-x-2.5 gap-y-2.5 px-0.5 py-1 text-[15px] leading-[21px]">
        {rows.map((row) => (
          <div key={row.key} className="contents">
            <dt className="pt-0.5 font-mono text-[12px] leading-[18px] text-dust [overflow-wrap:anywhere]">
              {upper(row.label)}
            </dt>
            <dd className="m-0 [overflow-wrap:anywhere]">{row.value}</dd>
          </div>
        ))}
      </dl>

      {error ? (
        <p role="alert" className="m-0 text-[15px] leading-5 text-missing">
          {error}
        </p>
      ) : null}
      <ActionBar>
        <PrimaryButton disabled={sending} onClick={() => void confirm()}>
          {sending ? t('draft.confirming') : t('draft.confirm')}
        </PrimaryButton>
      </ActionBar>
    </Screen>
  );
}
