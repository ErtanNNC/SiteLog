import { useCallback, useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router';
import { reportPollDelay, type ReportView } from '@sitelog/shared/field-contract.ts';
import { apiErrorCode, retryAfterSeconds } from '@/api/field';
import { useApi } from '@/api/useApi';

/** Refusals no later poll can change that the link flow explains (a new phone, a dead link). */
export const RELINK = new Set([
  'device_unverified',
  'consent_required',
  'link_expired',
  'link_revoked',
  'link_not_found',
  'reporter_disabled',
]);

export type PollProblem = 'failed' | 'notFound' | null;

/**
 * `GET reports/:id` while the worker has the report (W1-09's Processing poll, shared by the
 * question, draft and filing states since W1-13). Polling shares the device's rate limit (30 calls
 * a minute) with the clip's own upload and the photos behind it: every 2 s for the first 20 s,
 * then every 5 s, then every 10 s (`reportPollDelay`); not while the page is hidden (at once when
 * it is back); after a 429 it waits what field-api says. It stops when `keepPolling` says the
 * reporter's turn has come (a question, the draft, filed) or on a refusal no poll can change: the
 * link flow for a phone or link field-api no longer takes, "not available" for a report it no
 * longer finds. `restart()` polls again from the fast start (after an answer or Confirm & send).
 */
export function useReportPoll(
  code: string,
  id: string,
  keepPolling: (view: ReportView) => boolean,
): { view: ReportView | null; problem: PollProblem; restart: () => void } {
  const api = useApi();
  const navigate = useNavigate();
  const [view, setView] = useState<ReportView | null>(null);
  const [problem, setProblem] = useState<PollProblem>(null);
  const [attempt, setAttempt] = useState(0);
  // Read at each poll: the screen's own state (an answer just sent) decides too.
  const keep = useRef(keepPolling);
  useEffect(() => {
    keep.current = keepPolling;
  });

  useEffect(() => {
    const controller = new AbortController();
    const startedAt = Date.now();
    let timer: ReturnType<typeof setTimeout> | null = null;
    let polling = false;
    let stopped = false;
    const later = (ms: number) => {
      timer = setTimeout(() => {
        timer = null;
        // Hidden: no polling; `visibilitychange` polls at once when the page is back.
        if (document.visibilityState !== 'hidden') void poll();
      }, ms);
    };
    const poll = async () => {
      polling = true;
      let wait: number | null = null;
      try {
        const next = await api.report(code, id, controller.signal);
        if (controller.signal.aborted) return;
        setView(next);
        setProblem(null);
        if (!keep.current(next)) stopped = true;
      } catch (err) {
        if (controller.signal.aborted) return;
        const apiCode = apiErrorCode(err);
        if (apiCode && RELINK.has(apiCode)) {
          // The phone must pass the link flow again (as Today does); it explains a dead link.
          stopped = true;
          navigate(`/r/${code}`, { replace: true });
          return;
        }
        if (apiCode === 'not_found') {
          stopped = true;
          setProblem('notFound');
          return;
        }
        setProblem('failed');
        const after = retryAfterSeconds(err);
        if (after !== null) wait = after * 1000;
      } finally {
        polling = false;
      }
      if (!stopped && !controller.signal.aborted) {
        later(Math.max(wait ?? 0, reportPollDelay(Date.now() - startedAt)));
      }
    };
    const onVisibility = () => {
      if (document.visibilityState === 'hidden' || stopped || polling) return;
      if (timer) clearTimeout(timer);
      timer = null;
      void poll();
    };
    document.addEventListener('visibilitychange', onVisibility);
    void poll();
    return () => {
      controller.abort();
      stopped = true;
      if (timer) clearTimeout(timer);
      document.removeEventListener('visibilitychange', onVisibility);
    };
  }, [api, code, id, attempt, navigate]);

  const restart = useCallback(() => setAttempt((n) => n + 1), []);
  return { view, problem, restart };
}
