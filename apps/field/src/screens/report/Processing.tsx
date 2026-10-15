import { useEffect, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router';
import { reportPollDelay, type ReportView } from '@sitelog/shared/field-contract.ts';
import { apiErrorCode, retryAfterSeconds } from '@/api/field';
import { useApi } from '@/api/useApi';
import { SolidButton } from '@/components/Buttons';
import { OfflineBanner } from '@/components/OfflineBanner';
import { Screen, ScreenTitle } from '@/components/Screen';
import { useFieldCopy } from '@/i18n/useFieldCopy';
import { NoLink } from '@/screens/NoLink';
import { useSession } from '@/session/useSession';

import { stillProcessing, TICKS, ticksDone } from './ticks';

/** Refusals no later poll can change that the link flow explains (a new phone, a dead link). */
const RELINK = new Set([
  'device_unverified',
  'consent_required',
  'link_expired',
  'link_revoked',
  'link_not_found',
  'reporter_disabled',
]);

/**
 * Processing (F5 step 4): "Writing your report…" with the step ticks, polling `GET reports/:id`
 * until the worker has a question or a draft (those screens are W1-13). The screen can be closed;
 * a message comes when the draft is ready.
 *
 * Polling shares the device's rate limit (30 calls a minute) with the clip's own upload and the
 * photos behind it: every 2 s for the first 20 s, then every 5 s, then every 10 s
 * (`reportPollDelay`); not while the page is hidden (at once when it is back); after a 429 it waits
 * what field-api says. A refusal no poll can change stops it: the link flow for a phone or link
 * field-api no longer takes, "not available" for a report it no longer finds.
 */
export function Processing() {
  const { id = '' } = useParams();
  const { session } = useSession();
  if (!session) return <NoLink />;
  return <ProcessingLoaded code={session.code} id={id} />;
}

function ProcessingLoaded({ code, id }: { code: string; id: string }) {
  const api = useApi();
  const navigate = useNavigate();
  const { t } = useFieldCopy();
  const [view, setView] = useState<ReportView | null>(null);
  const [problem, setProblem] = useState<'failed' | 'notFound' | null>(null);
  const [attempt, setAttempt] = useState(0);

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
        if (!stillProcessing(next)) stopped = true;
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

  const done = view ? ticksDone(view) : null;
  const finished = view !== null && !stillProcessing(view);
  const filed = view?.status === 'filed' || view?.status === 'signed_off';
  const title = !finished
    ? t('processing.title')
    : filed
      ? t('processing.filedTitle')
      : t('processing.readyTitle');

  return (
    <Screen title={title} dateLine={false}>
      <OfflineBanner />
      {view ? (
        <span className="font-mono text-[12px] leading-[18px] tracking-[0.08em] text-dust uppercase">
          {t('processing.report', { no: view.reportNo })} · {view.siteName}
        </span>
      ) : null}
      {/* The heading changes when the worker is done: announced, so a screen-reader user hears it. */}
      <div aria-live="polite">
        <ScreenTitle>{title}</ScreenTitle>
      </div>
      {view ? (
        <p className="m-0 font-mono text-[13px] text-steel">
          {t('processing.counts', {
            voiceNotes: view.progress.voiceNotes,
            photos: view.progress.photos,
          })}
        </p>
      ) : null}
      <ul
        aria-label={t('processing.title')}
        className="m-0 flex list-none flex-col gap-2 p-0 text-[16px] leading-6"
      >
        {TICKS.map((tick) => {
          const ok = done?.[tick] ?? false;
          return (
            <li key={tick} className="flex items-center gap-2.5">
              {ok ? (
                <svg
                  width="20"
                  height="20"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="2.6"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  aria-hidden="true"
                  focusable="false"
                  className="text-signal-deep"
                >
                  <path d="M5 12l5 5 9-10" />
                </svg>
              ) : (
                <span aria-hidden="true" className="size-5 rounded-full border-2 border-rebar" />
              )}
              {/* Status never by colour or icon alone: the done state is in the name too. */}
              <span className={ok ? '' : 'text-dust'}>
                {t(`processing.ticks.${tick}`)}
                <span className="sr-only">{ok ? ` (${t('processing.tickDone')})` : ''}</span>
              </span>
            </li>
          );
        })}
      </ul>
      {problem === 'failed' ? (
        <>
          <p role="alert" className="m-0 text-[15px] leading-5 text-missing">
            {t('processing.failed')}
          </p>
          <SolidButton onClick={() => setAttempt((n) => n + 1)}>{t('sending.retry')}</SolidButton>
        </>
      ) : null}
      {problem === 'notFound' ? (
        <p role="alert" className="m-0 text-[15px] leading-5 text-missing">
          {t('processing.notFound')}
        </p>
      ) : null}
      {finished || problem === 'notFound' ? null : (
        <p className="m-0 text-[15px] leading-5 text-dust">{t('processing.close')}</p>
      )}
      <div className="sticky bottom-0 mt-auto bg-chalk pt-3">
        <Link
          to="/today"
          className="flex h-target w-full items-center justify-center rounded-card border border-rebar bg-white px-5 text-[16px] font-bold text-asphalt no-underline"
        >
          {t('sending.backToToday')}
        </Link>
      </div>
    </Screen>
  );
}
