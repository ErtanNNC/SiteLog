import { useEffect, useId, useMemo, useState } from 'react';
import { OutlineButton, PrimaryButton, QuietButton } from '@/components/Buttons';
import { Sheet } from '@/components/Sheet';
import { useFieldCopy } from '@/i18n/useFieldCopy';
import type { Clip, RecorderDeps } from '@/recorder/recorder';
import { formatClock } from '@/screens/record/clock';
import { useRecorder } from '@/screens/record/useRecorder';

/** F9: a voice caption is short; the recorder stops it at a minute. */
const CAPTION_MAX_MS = 60_000;

/**
 * F9's photo step (W2-04), after *Add more photos* picked the files: the photos chosen (at most
 * the report's `remaining`; the rest are dropped and the sheet says so), how many can still be
 * added and until when, an optional voice caption ("say what the photos show", at most a minute)
 * and *Send photos*. The Filed screen queues them as one batch; the caption becomes each photo's
 * caption once transcribed. The microphone is asked for only when the reporter taps *Record a
 * caption*; without one the photos go without a caption.
 */
export function AddPhotosSheet({
  open,
  reportNo,
  files,
  dropped,
  remaining,
  until,
  onSend,
  onClose,
  recorderDeps,
}: {
  open: boolean;
  reportNo: string;
  files: readonly File[];
  /** Files picked beyond `remaining` (not sent). */
  dropped: number;
  /** Photos the report still takes after these (`addPhotos.remaining` before this batch). */
  remaining: number;
  /** The window's end, already in words ("Sat, Oct 10 23:59"). */
  until: string;
  onSend: (caption: Clip | null) => void;
  onClose: () => void;
  /** Tests: a fake MediaRecorder. */
  recorderDeps?: RecorderDeps;
}) {
  const { t } = useFieldCopy();
  const titleId = useId();
  return (
    <Sheet open={open} titleId={titleId} onClose={onClose}>
      {open ? (
        <SheetBody
          titleId={titleId}
          reportNo={reportNo}
          files={files}
          dropped={dropped}
          remaining={remaining}
          until={until}
          onSend={onSend}
          onClose={onClose}
          recorderDeps={recorderDeps}
          t={t}
        />
      ) : null}
    </Sheet>
  );
}

function SheetBody({
  titleId,
  reportNo,
  files,
  dropped,
  remaining,
  until,
  onSend,
  onClose,
  recorderDeps,
  t,
}: {
  titleId: string;
  reportNo: string;
  files: readonly File[];
  dropped: number;
  remaining: number;
  until: string;
  onSend: (caption: Clip | null) => void;
  onClose: () => void;
  recorderDeps?: RecorderDeps;
  t: ReturnType<typeof useFieldCopy>['t'];
}) {
  const captionId = useId();
  const { recorder, state } = useRecorder({ capMs: CAPTION_MAX_MS, ...recorderDeps });
  const [clip, setClip] = useState<Clip | null>(null);
  const [stopping, setStopping] = useState(false);
  const urls = useMemo(() => files.map((f) => URL.createObjectURL(f)), [files]);
  useEffect(() => () => urls.forEach((u) => URL.revokeObjectURL(u)), [urls]);
  useEffect(() => () => recorder.dispose(), [recorder]);

  const recording = state.status === 'recording' || state.status === 'starting';
  async function stop() {
    setStopping(true);
    try {
      setClip(await recorder.stop());
    } finally {
      setStopping(false);
    }
  }
  // The minute is up: the caption stops by itself.
  useEffect(() => {
    if (state.capReached && state.status === 'recording') void recorder.stop().then(setClip);
  }, [state.capReached, state.status, recorder]);

  return (
    <>
      <h2 id={titleId} className="m-0 text-[22px] leading-7 font-extrabold [font-stretch:118%]">
        {t('filed.photos.title', { no: reportNo })}
      </h2>
      <p className="m-0 text-[15px] leading-[21px] text-steel">
        {t('filed.photos.chosen', { count: files.length })}
      </p>
      <ul className="m-0 grid list-none grid-cols-4 gap-2 p-0">
        {urls.map((url, i) => (
          <li key={url}>
            <img
              src={url}
              alt={t('filed.photos.photo', { n: i + 1 })}
              className="block aspect-square w-full rounded-chip border border-rebar object-cover"
            />
          </li>
        ))}
      </ul>
      {dropped > 0 ? (
        <p role="status" className="m-0 text-[15px] leading-[21px] text-steel">
          {t('filed.photos.tooMany', { count: files.length })}
        </p>
      ) : null}
      <p className="m-0 text-[14px] leading-5 text-dust">
        {t('filed.photos.window', { count: remaining, until })}
      </p>

      <section
        aria-labelledby={captionId}
        className="flex flex-col gap-2 rounded-card border border-rebar bg-white px-3.5 py-3"
      >
        <h3 id={captionId} className="m-0 text-[16px] leading-6 font-bold">
          {t('filed.photos.caption')}
        </h3>
        <p className="m-0 text-[14px] leading-5 text-steel">{t('filed.photos.captionHint')}</p>
        {state.error ? (
          <p role="status" className="m-0 text-[14px] leading-5 text-steel">
            {t('filed.photos.noMic')}
          </p>
        ) : clip ? (
          <>
            <p role="status" className="m-0 text-[15px] leading-[21px] font-semibold">
              {t('filed.photos.captionReady')}{' '}
              <span className="font-mono text-[14px] font-normal text-steel">
                {formatClock(clip.durationMs)}
              </span>
            </p>
            <QuietButton onClick={() => setClip(null)}>
              {t('filed.photos.removeCaption')}
            </QuietButton>
          </>
        ) : recording ? (
          <>
            <p className="m-0 flex items-center gap-2 text-[15px] leading-[21px]">
              <span aria-hidden="true" className="size-2.5 rounded-full bg-signal" />
              {t('filed.photos.recording')}
              <span role="timer" className="font-mono text-[14px]">
                {formatClock(state.elapsedMs)}
              </span>
            </p>
            <OutlineButton disabled={stopping} onClick={() => void stop()}>
              {t('filed.photos.stop')}
            </OutlineButton>
          </>
        ) : (
          <OutlineButton onClick={() => void recorder.start()}>
            {t('filed.photos.record')}
          </OutlineButton>
        )}
      </section>

      <div className="flex flex-col gap-2">
        <PrimaryButton disabled={recording || stopping} onClick={() => onSend(clip)}>
          {t('filed.photos.send')}
        </PrimaryButton>
        <QuietButton onClick={onClose}>{t('filed.photos.cancel')}</QuietButton>
      </div>
    </>
  );
}
