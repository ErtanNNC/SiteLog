import { useEffect, useId, useState, type FormEvent } from 'react';
import { CORRECTION_CLIP_MAX_MS } from '@sitelog/shared/field-contract.ts';
import { QuietButton, PrimaryButton, SolidButton } from '@/components/Buttons';
import { Sheet } from '@/components/Sheet';
import { useFieldCopy } from '@/i18n/useFieldCopy';
import type { Clip, RecorderDeps } from '@/recorder/recorder';
import { formatClock } from '@/screens/record/clock';
import { useRecorder } from '@/screens/record/useRecorder';

/**
 * F8 *Fix by voice* (W2-10, Field-06): the correction said (a mini recorder, the Recording
 * screen's engine, stopped at 30 seconds; the clip goes through the upload queue like any clip
 * and field-api hands it to the worker, `apply_correction`) or typed (Appendix B `{text}`). The
 * microphone is asked for only when the reporter taps *Record your fix*.
 */
export function FixSheet({
  open,
  onSay,
  onType,
  onClose,
  recorderDeps,
}: {
  open: boolean;
  onSay: (clip: Clip) => void;
  onType: (text: string) => void;
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
          onSay={onSay}
          onType={onType}
          onClose={onClose}
          recorderDeps={recorderDeps}
        />
      ) : null}
    </Sheet>
  );
}

function SheetBody({
  titleId,
  onSay,
  onType,
  onClose,
  recorderDeps,
}: {
  titleId: string;
  onSay: (clip: Clip) => void;
  onType: (text: string) => void;
  onClose: () => void;
  recorderDeps?: RecorderDeps;
}) {
  const { t } = useFieldCopy();
  const hintId = useId();
  const textId = useId();
  const { recorder, state } = useRecorder({ capMs: CORRECTION_CLIP_MAX_MS, ...recorderDeps });
  const [stopping, setStopping] = useState(false);
  const [text, setText] = useState('');
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
  // 30 seconds: the fix stops and goes by itself.
  useEffect(() => {
    if (state.capReached && state.status === 'recording')
      void recorder.stop().then((clip) => clip && onSay(clip));
  }, [state.capReached, state.status, recorder, onSay]);

  function submit(e: FormEvent) {
    e.preventDefault();
    const words = text.trim();
    if (words.length >= 2) onType(words);
  }

  return (
    <>
      <h2 id={titleId} className="m-0 text-[22px] leading-7 font-extrabold [font-stretch:118%]">
        {t('draft.fix.title')}
      </h2>

      <section className="flex flex-col items-center gap-3 rounded-card border border-rebar bg-white px-3.5 py-4">
        {state.error ? (
          <p role="status" className="m-0 self-stretch text-[15px] leading-[21px] text-steel">
            {t('draft.fix.noMic')}
          </p>
        ) : recording ? (
          <>
            <p className="m-0 flex items-center gap-2 text-[16px] leading-6 font-semibold">
              <span
                aria-hidden="true"
                className="size-2.5 rounded-full bg-signal shadow-[0_0_0_4px_var(--color-signal-tint)] motion-safe:animate-pulse"
              />
              {t('draft.fix.recording')}
              <span role="timer" className="font-mono text-[15px] font-normal">
                {formatClock(state.elapsedMs)} / {formatClock(CORRECTION_CLIP_MAX_MS)}
              </span>
            </p>
            <PrimaryButton disabled={stopping} onClick={() => void stop()}>
              {t('draft.fix.stop')}
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
              <span className="sr-only">{t('draft.fix.record')}</span>
            </button>
            <span aria-hidden="true" className="text-[16px] leading-6 font-bold">
              {t('draft.fix.record')}
            </span>
          </>
        )}
        <p id={hintId} className="m-0 text-center text-[14px] leading-5 text-dust">
          {t('draft.fix.hint')}
        </p>
      </section>

      <form onSubmit={submit} className="flex flex-col gap-2">
        <h3 className="m-0 text-[16px] leading-6 font-bold">{t('draft.fix.typeIt')}</h3>
        <label htmlFor={textId} className="text-[15px] leading-[21px] text-steel">
          {t('draft.fix.typeLabel')}
        </label>
        <textarea
          id={textId}
          value={text}
          maxLength={500}
          rows={2}
          disabled={recording || stopping}
          onChange={(e) => setText(e.target.value)}
          className="min-h-target w-full rounded-card border border-rebar bg-chalk px-4 py-3 text-[17px] leading-6 text-asphalt"
        />
        <SolidButton type="submit" disabled={recording || stopping || text.trim().length < 2}>
          {t('draft.fix.send')}
        </SolidButton>
      </form>

      <QuietButton disabled={recording || stopping} onClick={onClose}>
        {t('draft.fix.cancel')}
      </QuietButton>
    </>
  );
}
