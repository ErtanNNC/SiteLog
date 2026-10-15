import type { ReactNode } from 'react';
import { Link } from 'react-router';
import type { ReportView } from '@sitelog/shared/field-contract.ts';
import { SolidButton } from '@/components/Buttons';
import { OfflineBanner } from '@/components/OfflineBanner';
import { Screen, ScreenTitle } from '@/components/Screen';
import { useFieldCopy } from '@/i18n/useFieldCopy';
import type { ReportPhase } from './phase';
import type { PollProblem } from './useReportPoll';
import { TICKS, ticksDone } from './ticks';

/**
 * Processing (F5 step 4): "Writing your report…" with the step ticks while the worker writes the
 * draft or decides after an answer (`ReportScreen` polls). The screen can be closed; a message
 * comes when the question or the draft is ready. The same screen says "Filing your report…" after
 * Confirm & send, and "Report filed" until the Filed screen (Field-07, W1-15).
 */
export function ProcessingView({
  view,
  phase,
  problem,
  onRetry,
  notice,
}: {
  view: ReportView | null;
  phase: Extract<ReportPhase, 'processing' | 'filing' | 'filed' | 'ready' | 'gone'>;
  problem: PollProblem;
  onRetry: () => void;
  /** The F7 confirmation line or a refusal, above the title. */
  notice?: ReactNode;
}) {
  const { t } = useFieldCopy();
  const done = view ? ticksDone(view) : null;
  const title =
    phase === 'filing'
      ? t('filing.title')
      : phase === 'filed'
        ? t('processing.filedTitle')
        : phase === 'ready'
          ? t('processing.readyTitle')
          : t('processing.title');
  const notFound = problem === 'notFound' || phase === 'gone';
  const waiting = phase === 'processing' || phase === 'filing';

  return (
    <Screen title={title} dateLine={false}>
      <OfflineBanner />
      {notice}
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
      {phase === 'filing' ? (
        <p className="m-0 text-[16px] leading-6">{t('filing.body')}</p>
      ) : (
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
      )}
      {problem === 'failed' ? (
        <>
          <p role="alert" className="m-0 text-[15px] leading-5 text-missing">
            {t('processing.failed')}
          </p>
          <SolidButton onClick={onRetry}>{t('sending.retry')}</SolidButton>
        </>
      ) : null}
      {notFound ? (
        <p role="alert" className="m-0 text-[15px] leading-5 text-missing">
          {t('processing.notFound')}
        </p>
      ) : null}
      {waiting && !notFound ? (
        <p className="m-0 text-[15px] leading-5 text-dust">{t('processing.close')}</p>
      ) : null}
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
