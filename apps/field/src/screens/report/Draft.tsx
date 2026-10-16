import { useState, type ReactNode } from 'react';
import { useNavigate } from 'react-router';
import type { ReportView } from '@sitelog/shared/field-contract.ts';
import { formatDate } from '@sitelog/shared/format.ts';
import { upperIn } from '@sitelog/shared/locale.ts';
import type { DailyReportData } from '@sitelog/shared/schemas/report.ts';
import { apiErrorCode, isOfflineError } from '@/api/field';
import { useApi } from '@/api/useApi';
import { PrimaryButton } from '@/components/Buttons';
import { Header } from '@/components/Header';
import { OfflineBanner } from '@/components/OfflineBanner';
import { ActionBar, Screen } from '@/components/Screen';
import { useFieldCopy } from '@/i18n/useFieldCopy';
import type { ConfirmedDraft } from './phase';
import { ReportSections } from './ReportSections';
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
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
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

      <ReportSections data={data} />

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
