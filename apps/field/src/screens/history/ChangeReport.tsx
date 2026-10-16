import { useCallback, useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router';
import type { CorrectionView, ReportView } from '@sitelog/shared/field-contract.ts';
import { apiErrorCode, isOfflineError } from '@/api/field';
import { useApi } from '@/api/useApi';
import { OutlineButton } from '@/components/Buttons';
import { useFieldCopy } from '@/i18n/useFieldCopy';
import { useQueue } from '@/queue/useQueue';
import type { Clip, RecorderDeps } from '@/recorder/recorder';
import { FIX_POLL_MS, FixCard } from '@/screens/report/Draft';
import { fixFromView, type Fix } from '@/screens/report/fix';
import { FixSheet } from '@/screens/report/FixSheet';
import { RELINK } from './History';

/**
 * F10 *Change something* (W2-11, spec §19 Q81) on a filed report of the last 14 days: W2-10's
 * flow on the filed report. The change is said (a clip of at most 30 seconds through the upload
 * queue, `fixTo`) or typed, sent to `reports/:id/correction`; while the worker listens the card
 * says so, then shows the preview's lines (code's numbers) with **Save change**, which makes
 * version n+1 (`…/apply`): the office gets the new version, the PDF `_v{n+1}` and the "Updated"
 * email, and the reporter the `edit_applied` text. Older than 14 days: "That report is locked.
 * Ask the office to change it." (`view.change.locked`).
 */
export function ChangeReport({
  code,
  view,
  onSaved,
  onReload,
  stale = false,
  onStale,
  recorderDeps,
}: {
  code: string;
  view: ReportView;
  /** Save change made `version`: load the report again. */
  onSaved: (version: number) => void;
  /** The report moved on (locked, another version, no longer filed): load it again. */
  onReload: () => void;
  /**
   * W2-11 review: Save change was refused for a newer version. The reload remounts this card (it
   * is keyed by the version), so the parent keeps the notice ("The report changed while I was
   * listening…") until the reporter starts a new change or dismisses it.
   */
  stale?: boolean;
  onStale?: (stale: boolean) => void;
  /** Tests: a fake MediaRecorder. */
  recorderDeps?: RecorderDeps;
}) {
  const api = useApi();
  const queue = useQueue();
  const navigate = useNavigate();
  const { t } = useFieldCopy();
  const [fix, setFix] = useState<Fix>(() =>
    stale ? { kind: 'stale' } : fixFromView(view.correction?.afterFiling ? view.correction : null),
  );
  const [error, setError] = useState<string | null>(null);
  const [sheetOpen, setSheetOpen] = useState(false);
  const mounted = useRef(true);
  useEffect(
    () => () => {
      mounted.current = false;
    },
    [],
  );

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

  const failed = useCallback(
    (err: unknown) => {
      if (relinked(err)) return;
      const apiCode = apiErrorCode(err);
      setFix({ kind: 'idle' });
      if (apiCode === 'report_locked') {
        setError(t('history.change.locked'));
        onReload();
        return;
      }
      if (apiCode === 'wrong_state' || apiCode === 'site_inactive') {
        onReload();
        return;
      }
      setError(
        apiCode === 'correction_pending'
          ? t('draft.fix.errors.correction_pending')
          : isOfflineError(err)
            ? t('draft.fix.errors.offline')
            : t('draft.fix.errors.generic'),
      );
    },
    [onReload, relinked, t],
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
        if (ctl.signal.aborted || relinked(err)) return;
        if (apiErrorCode(err) === 'not_found') {
          setFix({ kind: 'idle' });
          return;
        }
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
      setError(null);
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
            setError(t('draft.fix.errors.generic'));
            return;
          }
          await request({ uploadId: done.uploadId });
        } catch (err) {
          if (apiErrorCode(err) || isOfflineError(err)) {
            failed(err);
            return;
          }
          console.error('[field] could not queue the change', err);
          setFix({ kind: 'idle' });
          setError(t('draft.fix.errors.queue'));
        }
      })();
    },
    [code, failed, queue, request, t, view.date, view.id, view.siteId],
  );

  const type = useCallback(
    (text: string) => {
      setSheetOpen(false);
      setError(null);
      setFix({ kind: 'sending' });
      void request({ text }).catch(failed);
    },
    [failed, request],
  );

  async function save(c: CorrectionView) {
    setFix({ kind: 'saving', view: c });
    setError(null);
    try {
      const res = await api.applyCorrection(code, view.id, c.id);
      setFix({ kind: 'idle' });
      onSaved(res.version ?? view.currentVersion + 1);
    } catch (err) {
      const apiCode = apiErrorCode(err);
      if (apiCode === 'draft_changed' || apiCode === 'correction_not_ready') {
        setFix({ kind: 'stale' });
        onStale?.(true);
        onReload();
        return;
      }
      if (relinked(err)) return;
      if (apiCode === 'report_locked' || apiCode === 'wrong_state') {
        failed(err);
        return;
      }
      setFix({ kind: 'ready', view: c });
      setError(isOfflineError(err) ? t('draft.fix.errors.offline') : t('draft.fix.errors.generic'));
    }
  }

  function open() {
    setFix({ kind: 'idle' });
    onStale?.(false);
    setError(null);
    setSheetOpen(true);
  }

  if (view.change?.locked) {
    return (
      <p role="status" className="m-0 text-[16px] leading-6 text-steel">
        {t('history.change.locked')}
      </p>
    );
  }
  if (!view.change?.canChange) return null;
  const busy = fix.kind !== 'idle';
  return (
    <>
      <FixCard
        fix={fix}
        error={error}
        onSave={(c) => void save(c)}
        onTryAgain={open}
        onDiscard={() => {
          setFix({ kind: 'idle' });
          onStale?.(false);
          setError(null);
        }}
        staleMessage={t('history.change.stale')}
      />
      {busy ? null : (
        <OutlineButton onClick={open}>
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
          {t('history.change.button')}
        </OutlineButton>
      )}
      <FixSheet
        open={sheetOpen}
        title={t('history.change.title')}
        hint={t('history.change.hint')}
        onSay={say}
        onType={type}
        onClose={() => setSheetOpen(false)}
        recorderDeps={recorderDeps}
      />
    </>
  );
}
