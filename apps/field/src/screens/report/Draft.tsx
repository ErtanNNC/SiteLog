import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import { useNavigate } from 'react-router';
import type { CorrectionView, ReportView } from '@sitelog/shared/field-contract.ts';
import { formatDate } from '@sitelog/shared/format.ts';
import { upperIn } from '@sitelog/shared/locale.ts';
import type { DailyReportData } from '@sitelog/shared/schemas/report.ts';
import { apiErrorCode, isOfflineError } from '@/api/field';
import { useApi } from '@/api/useApi';
import { OutlineButton, PrimaryButton, QuietButton, SolidButton } from '@/components/Buttons';
import { Header } from '@/components/Header';
import { OfflineBanner } from '@/components/OfflineBanner';
import { ActionBar, Screen } from '@/components/Screen';
import { useFieldCopy } from '@/i18n/useFieldCopy';
import { useQueue } from '@/queue/useQueue';
import type { Clip, RecorderDeps } from '@/recorder/recorder';
import { FixSheet } from './FixSheet';
import { fixFromView, type Fix } from './fix';
import { correctionLine } from './lines';
import type { ConfirmedDraft } from './phase';
import { ReportSections } from './ReportSections';
import { StepperSheet, type CrewNumbers } from './StepperSheet';
import { RELINK } from './useReportPoll';

/** How often the screen asks for a fix's preview while the worker listens (W2-10). */
export const FIX_POLL_MS = 2_000;

/**
 * The draft (F8, Field-06; W1-13, W2-10): the crew with each company's workers × hours and the
 * day's total, then weather, work done, deliveries, safety, next workday and photos, and a sticky
 * bar with **Fix by voice** and **Confirm & send** (`reports/:id/confirm` with the version and
 * draft revision shown, so a newer draft is never filed unseen). The numbers are the draft's
 * (computed in code).
 *
 * W2-10: a crew line opens its stepper (workers and hours, tapped or typed; `reports/:id/edit`,
 * the line citing `reporter_edit`, spec §19 Q80). **Fix by voice** opens `FixSheet` (a clip of at
 * most 30 seconds through the upload queue, or typed words), then `reports/:id/correction`; while
 * the worker listens the card says so, then shows the preview's lines (code's numbers: "Apex
 * Concrete 6 → 7 workers, 48 → 56 h") with **Save change** and *Try again*. Saving (or a
 * stepper) moves the report to processing; `onChanged` polls until the draft is shown again with
 * its new revision.
 */
export function Draft({
  code,
  view,
  data,
  notice,
  onConfirmed,
  onStale,
  onChanged,
  recorderDeps,
}: {
  code: string;
  view: ReportView;
  data: DailyReportData;
  notice?: ReactNode;
  onConfirmed: (draft: ConfirmedDraft) => void;
  onStale: (message: string) => void;
  /** A fix or a stepper was saved: the report is processing; poll for the draft again. */
  onChanged?: (message: string) => void;
  /** Tests: a fake MediaRecorder for *Fix by voice*. */
  recorderDeps?: RecorderDeps;
}) {
  const api = useApi();
  const queue = useQueue();
  const navigate = useNavigate();
  const { t, language } = useFieldCopy();
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [fix, setFix] = useState<Fix>(() => fixFromView(view.correction ?? null));
  const [fixError, setFixError] = useState<string | null>(null);
  const [sheetOpen, setSheetOpen] = useState(false);
  const [stepper, setStepper] = useState<number | null>(null);
  const [stepperSaving, setStepperSaving] = useState(false);
  const [stepperError, setStepperError] = useState<string | null>(null);
  const upper = (s: string) => upperIn(language, s);
  const mounted = useRef(true);
  useEffect(
    () => () => {
      mounted.current = false;
    },
    [],
  );

  /** A refusal that sends the screen back to the link check; true when it did. */
  const relinked = useCallback(
    (err: unknown) => {
      const apiCode = apiErrorCode(err);
      if (apiCode && RELINK.has(apiCode)) {
        navigate(`/r/${code}`, { replace: true });
        return true;
      }
      return false;
    },
    [code, navigate],
  );

  const fixFailed = useCallback(
    (err: unknown) => {
      if (relinked(err)) return;
      const apiCode = apiErrorCode(err);
      if (apiCode === 'draft_changed' || apiCode === 'wrong_state') {
        setFix({ kind: 'idle' });
        onStale(t(`draft.errors.${apiCode}`));
        return;
      }
      setFix({ kind: 'idle' });
      setFixError(
        apiCode === 'correction_pending'
          ? t('draft.fix.errors.correction_pending')
          : isOfflineError(err)
            ? t('draft.fix.errors.offline')
            : t('draft.fix.errors.generic'),
      );
    },
    [onStale, relinked, t],
  );

  const settle = useCallback((c: CorrectionView) => {
    if (c.status === 'ready' && c.changes) setFix({ kind: 'ready', view: c });
    else if (c.status === 'unclear') setFix({ kind: 'unclear', view: c });
    else if (c.status === 'stale') setFix({ kind: 'stale' });
    else if (c.status === 'listening') setFix({ kind: 'listening', id: c.id });
    else setFix({ kind: 'idle' });
  }, []);

  // The worker is listening: ask for the preview until it is there.
  const listeningId = fix.kind === 'listening' ? fix.id : null;
  useEffect(() => {
    if (!listeningId) return;
    const ctl = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const tick = async () => {
      try {
        const c = await api.correctionView(code, view.id, listeningId, ctl.signal);
        if (ctl.signal.aborted) return;
        if (c.status === 'listening') timer = setTimeout(() => void tick(), FIX_POLL_MS);
        else settle(c);
      } catch (err) {
        if (ctl.signal.aborted) return;
        if (relinked(err)) return;
        if (apiErrorCode(err) === 'not_found') {
          setFix({ kind: 'idle' });
          return;
        }
        // No signal for a moment: keep asking.
        timer = setTimeout(() => void tick(), FIX_POLL_MS * 2);
      }
    };
    timer = setTimeout(() => void tick(), FIX_POLL_MS);
    return () => {
      ctl.abort();
      if (timer) clearTimeout(timer);
    };
  }, [api, code, listeningId, relinked, settle, view.id]);

  const request = useCallback(
    async (body: { uploadId: string } | { text: string }) => {
      const c = await api.correction(code, view.id, body);
      if (mounted.current) settle(c);
    },
    [api, code, settle, view.id],
  );

  const say = useCallback(
    (clip: Clip) => {
      setSheetOpen(false);
      setFixError(null);
      setFix({ kind: 'sending' });
      void (async () => {
        try {
          const item = await queue.enqueue({
            code,
            kind: 'audio',
            mime: clip.mime,
            blob: clip.blob,
            siteId: view.siteId,
            date: view.date,
            recordedAt: clip.startedAt,
            fixTo: { reportId: view.id },
          });
          const done = await queue.waitFor(item.id);
          if (done.status === 'failed' || !done.uploadId) {
            setFix({ kind: 'idle' });
            setFixError(t('draft.fix.errors.generic'));
            return;
          }
          await request({ uploadId: done.uploadId });
        } catch (err) {
          if (apiErrorCode(err) || isOfflineError(err)) {
            fixFailed(err);
            return;
          }
          console.error('[field] could not queue the fix', err);
          setFix({ kind: 'idle' });
          setFixError(t('draft.fix.errors.queue'));
        }
      })();
    },
    [code, fixFailed, queue, request, t, view.date, view.id, view.siteId],
  );

  const type = useCallback(
    (text: string) => {
      setSheetOpen(false);
      setFixError(null);
      setFix({ kind: 'sending' });
      void request({ text }).catch(fixFailed);
    },
    [fixFailed, request],
  );

  async function save(c: CorrectionView) {
    setFix({ kind: 'saving', view: c });
    setFixError(null);
    try {
      await api.applyCorrection(code, view.id, c.id);
      setFix({ kind: 'idle' });
      onChanged?.(t('draft.fix.saved'));
    } catch (err) {
      if (apiErrorCode(err) === 'draft_changed') {
        setFix({ kind: 'idle' });
        onStale(t('draft.fix.stale'));
        return;
      }
      if (apiErrorCode(err) === 'correction_not_ready') {
        setFix({ kind: 'stale' });
        return;
      }
      if (relinked(err)) return;
      setFix({ kind: 'ready', view: c });
      setFixError(
        isOfflineError(err) ? t('draft.fix.errors.offline') : t('draft.fix.errors.generic'),
      );
    }
  }

  function tryAgain() {
    setFix({ kind: 'idle' });
    setFixError(null);
    setSheetOpen(true);
  }

  async function saveCrew(index: number, numbers: CrewNumbers) {
    if (view.draftRev === null) {
      onStale(t('draft.errors.draft_changed'));
      return;
    }
    const entry = data.manpower[index];
    if (
      entry &&
      entry.workers === numbers.workers &&
      entry.hoursPerWorker === numbers.hoursPerWorker
    ) {
      setStepper(null);
      return;
    }
    setStepperSaving(true);
    setStepperError(null);
    try {
      await api.edit(code, view.id, {
        version: view.currentVersion,
        draftRev: view.draftRev,
        index,
        ...numbers,
      });
      setStepper(null);
      onChanged?.(t('draft.fix.saved'));
    } catch (err) {
      if (relinked(err)) return;
      const apiCode = apiErrorCode(err);
      if (apiCode === 'draft_changed' || apiCode === 'wrong_state') {
        setStepper(null);
        onStale(t(`draft.errors.${apiCode}`));
        return;
      }
      setStepperError(
        apiCode === 'edit_not_accepted' || apiCode === 'invalid_request'
          ? t('draft.stepper.invalid')
          : isOfflineError(err)
            ? t('draft.errors.offline')
            : t('draft.stepper.error'),
      );
    } finally {
      if (mounted.current) setStepperSaving(false);
    }
  }

  async function confirm() {
    if (sending) return;
    setSending(true);
    setError(null);
    try {
      // The draft shown, by version and revision: a draft is overwritten in place (a late photo
      // re-extracts it, a fix is saved), so the version alone cannot tell a newer one.
      const draft = { version: view.currentVersion, draftRev: view.draftRev };
      if (draft.draftRev === null) {
        onStale(t('draft.errors.draft_changed'));
        return;
      }
      await api.confirm(code, view.id, { version: draft.version, draftRev: draft.draftRev });
      onConfirmed(draft);
    } catch (err) {
      if (relinked(err)) return;
      const apiCode = apiErrorCode(err);
      if (apiCode === 'draft_changed' || apiCode === 'wrong_state') {
        onStale(t(`draft.errors.${apiCode}`));
        return;
      }
      setError(isOfflineError(err) ? t('draft.errors.offline') : t('draft.errors.generic'));
    } finally {
      setSending(false);
    }
  }

  // A fix in progress or waiting for a decision holds Confirm & send: the draft is about to change.
  const fixBusy = fix.kind === 'sending' || fix.kind === 'listening' || fix.kind === 'saving';
  const holdConfirm = fixBusy || fix.kind === 'ready';
  const editing = stepper !== null ? (data.manpower[stepper] ?? null) : null;

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

      <FixCard
        fix={fix}
        error={fixError}
        onSave={(c) => void save(c)}
        onTryAgain={tryAgain}
        onDiscard={() => {
          setFix({ kind: 'idle' });
          setFixError(null);
        }}
      />

      <ReportSections
        data={data}
        onEditCrew={
          // No stepper while a fix is busy or Confirm & send is on its way: the draft confirmed
          // is the one filed (W2-10 review; field_edit_draft() refuses `report_filing` too).
          fixBusy || sending
            ? undefined
            : (i) => {
                setStepperError(null);
                setStepper(i);
              }
        }
      />

      {error ? (
        <p role="alert" className="m-0 text-[15px] leading-5 text-missing">
          {error}
        </p>
      ) : null}
      <ActionBar>
        <div className="flex gap-2.5">
          <OutlineButton
            className="flex-1"
            disabled={fixBusy || sending}
            onClick={() => {
              setFixError(null);
              setSheetOpen(true);
            }}
          >
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
              <rect x="9" y="3" width="6" height="11" rx="3" />
              <path d="M5 11a7 7 0 0 0 14 0 M12 18v3" />
            </svg>
            {t('draft.fix.button')}
          </OutlineButton>
          <PrimaryButton
            className="flex-1"
            disabled={sending || holdConfirm}
            onClick={() => void confirm()}
          >
            {sending ? t('draft.confirming') : t('draft.confirm')}
          </PrimaryButton>
        </div>
      </ActionBar>

      <FixSheet
        open={sheetOpen}
        onSay={say}
        onType={type}
        onClose={() => setSheetOpen(false)}
        recorderDeps={recorderDeps}
      />
      <StepperSheet
        entry={editing}
        saving={stepperSaving}
        error={stepperError}
        onSave={(n) => void saveCrew(stepper!, n)}
        onClose={() => {
          if (!stepperSaving) setStepper(null);
        }}
      />
    </Screen>
  );
}

/**
 * The fix's card on the draft: listening, the preview with Save change / Try again, or why not.
 * W2-11: also a filed report's change (Past reports), with its own stale line.
 */
export function FixCard({
  fix,
  error,
  onSave,
  onTryAgain,
  onDiscard,
  staleMessage,
}: {
  fix: Fix;
  error: string | null;
  onSave: (c: CorrectionView) => void;
  onTryAgain: () => void;
  onDiscard: () => void;
  staleMessage?: string;
}) {
  const { t, language } = useFieldCopy();
  const errorLine = error ? (
    <p role="alert" className="m-0 text-[15px] leading-5 text-missing">
      {error}
    </p>
  ) : null;
  if (fix.kind === 'idle') return errorLine;
  const card = 'flex flex-col gap-3 rounded-[10px] border-2 border-asphalt bg-white px-4 py-4';
  if (fix.kind === 'sending' || fix.kind === 'listening') {
    return (
      <section className={card}>
        <p
          role="status"
          className="m-0 flex items-center gap-2.5 text-[17px] leading-6 font-semibold"
        >
          <span
            aria-hidden="true"
            className="size-2.5 flex-none rounded-full bg-signal shadow-[0_0_0_4px_var(--color-signal-tint)] motion-safe:animate-pulse"
          />
          {t('draft.fix.listening')}
        </p>
      </section>
    );
  }
  if (fix.kind === 'ready' || fix.kind === 'saving') {
    const lines = fix.view.changes ?? [];
    return (
      <section aria-labelledby="fix-preview" className={card}>
        <h2 id="fix-preview" className="m-0 text-[18px] leading-6 font-bold">
          {t('draft.fix.previewTitle')}
        </h2>
        <ul className="m-0 flex list-none flex-col gap-1.5 p-0 font-mono text-[15px] leading-[22px] font-medium">
          {lines.map((c, i) => (
            <li key={i} className="[overflow-wrap:anywhere]">
              {correctionLine(c, t, language)}
            </li>
          ))}
        </ul>
        {errorLine}
        <SolidButton disabled={fix.kind === 'saving'} onClick={() => onSave(fix.view)}>
          {fix.kind === 'saving' ? t('draft.fix.saving') : t('draft.fix.save')}
        </SolidButton>
        <div className="flex gap-2.5">
          <QuietButton className="flex-1" disabled={fix.kind === 'saving'} onClick={onTryAgain}>
            {t('draft.fix.tryAgain')}
          </QuietButton>
          <QuietButton className="flex-1" disabled={fix.kind === 'saving'} onClick={onDiscard}>
            {t('draft.fix.discard')}
          </QuietButton>
        </div>
      </section>
    );
  }
  const unclear = fix.kind === 'unclear' ? fix.view : null;
  const message =
    fix.kind === 'stale'
      ? (staleMessage ?? t('draft.fix.stale'))
      : unclear?.reason === 'timeout'
        ? t('draft.fix.errors.timeout')
        : t('draft.fix.unclear');
  return (
    <section className={card}>
      <p role="status" className="m-0 text-[17px] leading-6 font-semibold">
        {message}
      </p>
      {unclear?.clarification ? (
        <p className="m-0 text-[16px] leading-6 [overflow-wrap:anywhere]">
          {unclear.clarification}
        </p>
      ) : fix.kind === 'unclear' && unclear?.reason !== 'timeout' ? (
        <p className="m-0 text-[15px] leading-[21px] text-steel">{t('draft.fix.unclearHint')}</p>
      ) : null}
      <div className="flex gap-2.5">
        <SolidButton className="flex-1" onClick={onTryAgain}>
          {t('draft.fix.tryAgain')}
        </SolidButton>
        <QuietButton className="flex-1" onClick={onDiscard}>
          {t('draft.fix.cancel')}
        </QuietButton>
      </div>
    </section>
  );
}
