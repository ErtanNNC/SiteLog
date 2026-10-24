import { useEffect, useId, useState, type ReactNode } from 'react';
import { ANSWER_CLIP_MAX_MS } from '@sitelog/shared/field-contract.ts';
import { PrimaryButton, QuietButton } from '@/components/Buttons';
import { Sheet } from '@/components/Sheet';
import { useFieldCopy } from '@/i18n/useFieldCopy';
import type { Clip, RecorderDeps } from '@/recorder/recorder';
import { formatClock } from '@/screens/record/clock';
import { useRecorder } from '@/screens/record/useRecorder';

/**
 * F7 *Other…* (W2-09, Field-05): the answer said, or for a number field typed. *Say it* is a mini
 * recorder (the recorder engine of the Recording screen, stopped at 30 seconds); its clip goes
 * through the upload queue like any clip and field-api hands it to the worker (`parse_answer`).
 * The microphone is asked for only when the reporter taps *Record your answer*. `typed` is the
 * number input of a number field (the Question screen's own `NumberAnswer`).
 */
export function OtherSheet({
  open,
  prompt,
  typed,
  onSay,
  onClose,
  recorderDeps,
}: {
  open: boolean;
  prompt: string;
  /** The number input for a number field; null for a question a number does not answer. */
  typed: ReactNode | null;
  onSay: (clip: Clip) => void;
  onClose: () => void;
  /** Tests: a fake MediaRecorder. */
  recorderDeps?: RecorderDeps;
}) {
  const titleId = useId();
  return (
    <Sheet open={open} titleId={titleId} onClose={onClose}>
      {open ? (
        <SheetBody
          titleId={titleId}
          prompt={prompt}
          typed={typed}
          onSay={onSay}
          onClose={onClose}
          recorderDeps={recorderDeps}
        />
      ) : null}
    </Sheet>
  );
}

function SheetBody({
  titleId,
  prompt,
  typed,
  onSay,
  onClose,
  recorderDeps,
}: {
  titleId: string;
  prompt: string;
  typed: ReactNode | null;
  onSay: (clip: Clip) => void;
  onClose: () => void;
  recorderDeps?: RecorderDeps;
}) {
  const { t } = useFieldCopy();
  const hintId = useId();
  const { recorder, state } = useRecorder({ capMs: ANSWER_CLIP_MAX_MS, ...recorderDeps });
  const [stopping, setStopping] = useState(false);
  useEffect(() => () => recorder.dispose(), [recorder]);
  const recording = state.status === 'recording' || state.status === 'starting';

  async function stop() {
    if (stopping) return;
    setStopping(true);
    try {
      const clip = await recorder.stop();
      if (clip) onSay(clip);
    } finally {
      setStopping(false);
    }
  }
  // 30 seconds: the answer stops and goes by itself.
  useEffect(() => {
    if (state.capReached && state.status === 'recording')
      void recorder.stop().then((clip) => clip && onSay(clip));
  }, [state.capReached, state.status, recorder, onSay]);

  return (
    <>
      <h2 id={titleId} className="m-0 text-[22px] leading-7 font-extrabold [font-stretch:118%]">
        {t('question.otherTitle')}
      </h2>
      <p className="m-0 text-[16px] leading-6 [overflow-wrap:anywhere]">{prompt}</p>

      <section className="flex flex-col items-center gap-3 rounded-card border border-rebar bg-white px-3.5 py-4">
        {state.error ? (
          <p role="status" className="m-0 self-stretch text-[15px] leading-[21px] text-steel">
            {typed ? t('question.noMic') : t('question.noMicOnly')}
          </p>
        ) : recording ? (
          <>
            <p className="m-0 flex items-center gap-2 text-[16px] leading-6 font-semibold">
              <span
                aria-hidden="true"
                className="size-2.5 rounded-full bg-signal shadow-[0_0_0_4px_var(--color-signal-tint)] motion-safe:animate-pulse"
              />
              {t('question.recording')}
              <span role="timer" className="font-mono text-[15px] font-normal">
                {formatClock(state.elapsedMs)} / {formatClock(ANSWER_CLIP_MAX_MS)}
              </span>
            </p>
            <PrimaryButton disabled={stopping} onClick={() => void stop()}>
              {t('question.stop')}
            </PrimaryButton>
          </>
        ) : (
          <>
            <button
              type="button"
              onClick={() => void recorder.start()}
              aria-describedby={hintId}
              className="flex size-[120px] flex-col items-center justify-center gap-1 rounded-full border-0 bg-signal text-asphalt shadow-[0_0_0_8px_var(--color-signal-tint)]"
            >
              <svg
                width="36"
                height="36"
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
              <span className="sr-only">{t('question.record')}</span>
            </button>
            <span aria-hidden="true" className="text-[16px] leading-6 font-bold">
              {t('question.record')}
            </span>
          </>
        )}
        <p id={hintId} className="m-0 text-center text-[14px] leading-5 text-dust">
          {t('question.otherHint')}
        </p>
      </section>

      {typed ? (
        <section className="flex flex-col gap-2">
          <h3 className="m-0 text-[16px] leading-6 font-bold">{t('question.typeIt')}</h3>
          {typed}
        </section>
      ) : null}

      <QuietButton disabled={recording || stopping} onClick={onClose}>
        {t('question.cancel')}
      </QuietButton>
    </>
  );
}
