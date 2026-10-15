import { useEffect, useId, useRef, useState } from 'react';
import type { ChangeEvent } from 'react';
import { Link, useNavigate } from 'react-router';
import { MIN_CLIP_SECONDS } from '@sitelog/shared/field-contract.ts';
import { formatDateInTz, formatPhone } from '@sitelog/shared/format.ts';
import { InverseButton, PrimaryButton, SteelButton } from '@/components/Buttons';
import { buttonClasses } from '@/components/buttonStyles';
import { OfflineBanner } from '@/components/OfflineBanner';
import { ActionBar, Screen } from '@/components/Screen';
import { useFieldCopy } from '@/i18n/useFieldCopy';
import { useOnline } from '@/lib/online';
import { sendingErrorKey } from '@/lib/sendingErrors';
import type { DraftRecorder } from '@/queue/drafts';
import { failedKind, type QueuedUpload } from '@/queue/types';
import { useQueue, useQueueSnapshot } from '@/queue/useQueue';
import { silentClip } from '@/recorder/level';
import { audioFileMime, photoMime } from '@/recorder/photos';
import type { Clip, RecorderDeps } from '@/recorder/recorder';
import type { WakeLock } from '@/recorder/wakeLock';
import { NoLink } from '@/screens/NoLink';
import { currentSite, type FieldSession } from '@/session/session';
import { useSession } from '@/session/useSession';
import { formatClock } from './clock';
import { LevelMeter } from './LevelMeter';
import { useRecorder, useWakeLock } from './useRecorder';

const PROMPTS = ['work', 'crew', 'hours', 'weather', 'deliveries', 'safety'] as const;
/** Shorter than this and the clip is not sent (F5 "recording < 5 s or silent"). */
const MIN_CLIP_MS = MIN_CLIP_SECONDS * 1000;
const BACK_CLASSES = buttonClasses('steel', 'no-underline');

function CameraIcon({ size = 24 }: { size?: number }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
    >
      <path d="M4 8h3l2-3h6l2 3h3v11H4z" />
      <circle cx="12" cy="13" r="3.5" />
    </svg>
  );
}

/** What the sending screen says on top: the 15-minute cap, a microphone the phone took away. */
interface Notices {
  cap: boolean;
  interrupted: boolean;
}
const NONE: Notices = { cap: false, interrupted: false };

type Phase =
  | { kind: 'recording' }
  | ({ kind: 'short' } & Notices)
  | ({ kind: 'sending'; id: string } & Notices)
  | ({ kind: 'failed'; id: string; error: string | null } & Notices);

type Kept = { kind: 'queued'; item: QueuedUpload } | { kind: 'short' };

/**
 * Recording (F5 step 2, Field-04): timer, level meter, Pause, Stop & send, Add photo, the
 * 15-minute cap, then the upload through the queue (F5 step 3): signed URL, `complete`, and
 * Processing once the report exists; "saved on your phone" without signal. Microphone refused or
 * no MediaRecorder: the settings steps and the native-recorder file fallback.
 *
 * Nothing said is lost: the recording is saved chunk by chunk as it is made (a draft the queue
 * sends at the next start if the phone kills the page), photos taken meanwhile wait in the queue
 * for their clip, and leaving the screen while recording (the back gesture, the system back
 * button) stops and queues the clip, as does the browser stopping the recording by itself.
 */
export function Record({
  recorderDeps,
  wakeLock,
}: {
  /** For tests: fake browser APIs. */
  recorderDeps?: RecorderDeps;
  wakeLock?: WakeLock;
}) {
  const { session } = useSession();
  if (!session) return <NoLink />;
  const site = currentSite(session);
  if (!site) return <NoLink />;
  return (
    <RecordLoaded
      session={session}
      siteId={site.id}
      siteName={site.name}
      timeZone={site.timezone}
      recorderDeps={recorderDeps}
      wakeLock={wakeLock}
    />
  );
}

function RecordLoaded({
  session,
  siteId,
  siteName,
  timeZone,
  recorderDeps,
  wakeLock,
}: {
  session: FieldSession;
  siteId: string;
  siteName: string;
  timeZone: string;
  recorderDeps?: RecorderDeps;
  wakeLock?: WakeLock;
}) {
  const { t, tc } = useFieldCopy();
  const navigate = useNavigate();
  const queue = useQueue();
  const snapshot = useQueueSnapshot();
  const online = useOnline();
  const draft = useRef<DraftRecorder | null>(null);
  const { recorder, state } = useRecorder(recorderDeps, (chunk, ms) =>
    draft.current?.append(chunk, ms),
  );
  /** This screen's hold on the photos taken while recording: they go with the clip. */
  const [holdId] = useState(() => crypto.randomUUID());
  const [phase, setPhase] = useState<Phase>({ kind: 'recording' });
  const [photos, setPhotos] = useState<{ id: string; url: string }[]>([]);
  const [photoError, setPhotoError] = useState(false);
  const photoInput = useRef<HTMLInputElement>(null);
  const audioInput = useRef<HTMLInputElement>(null);
  const sending = useRef(false);
  /** False once the screen is gone: a send that finishes later must not navigate. */
  const alive = useRef(true);
  /** The thumbnails shown, for revoking their object URLs when the screen goes. */
  const photosRef = useRef(photos);
  useEffect(() => {
    photosRef.current = photos;
  }, [photos]);
  const timerId = useId();
  const promptsId = useId();
  const recording = state.status === 'recording';
  const live = recording || state.status === 'paused';
  const held = useWakeLock(live, wakeLock);
  const date = session.date ?? formatDateInTz(new Date(), timeZone);
  const code = session.code;

  function begin() {
    void draft.current?.close({ discard: true });
    draft.current = queue.startDraft({ code, siteId, date });
    void recorder.start();
  }

  /** Queues a clip worth sending (with its draft gone in the same write) and the held photos. */
  async function keep(clip: Clip | null, d: DraftRecorder | null): Promise<Kept> {
    if (!clip || clip.durationMs < MIN_CLIP_MS || silentClip(clip.peakLevel)) {
      await d?.close({ discard: true });
      return { kind: 'short' };
    }
    await d?.seal();
    const item = await queue.enqueue(
      {
        code,
        kind: 'audio',
        mime: clip.mime,
        blob: clip.blob,
        siteId,
        date,
        recordedAt: clip.startedAt,
      },
      d ? { draftId: d.id } : {},
    );
    await d?.close({ discard: false });
    void queue.release(holdId);
    return { kind: 'queued', item };
  }

  useEffect(() => {
    alive.current = true;
    begin();
    return () => {
      alive.current = false;
      const d = draft.current;
      const status = recorder.getState().status;
      if (status === 'recording' || status === 'paused' || status === 'stopped') {
        // Left while recording (the back gesture, the system back button): what was said goes to
        // the queue, which outlives this screen. A stopped recorder hands over a clip the browser
        // cut off, or nothing.
        void recorder
          .stop()
          .then((clip) => keep(clip, d))
          .catch((err: unknown) => console.error('[field] could not keep the recording', err));
      } else if (status !== 'stopping') {
        // A Stop & send in flight finishes on its own.
        recorder.dispose();
        void d?.close({ discard: true });
      }
      // Photos taken here go like Today's (never dropped without the reporter's tap).
      void queue.release(holdId);
      photosRef.current.forEach((p) => URL.revokeObjectURL(p.url));
    };
    // The screen's whole life: one recorder, one hold.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // The recorder's type and start time name the draft (a page that dies can still send it).
  useEffect(() => {
    if (state.mime && state.startedAt) {
      draft.current?.describe({ mime: state.mime, startedAt: state.startedAt });
    }
  }, [state.mime, state.startedAt]);

  // Android Chrome asks before a reload or close while recording (the draft keeps it anyway).
  useEffect(() => {
    if (!live) return;
    const onBeforeUnload = (e: BeforeUnloadEvent) => {
      e.preventDefault();
      e.returnValue = '';
    };
    window.addEventListener('beforeunload', onBeforeUnload);
    return () => window.removeEventListener('beforeunload', onBeforeUnload);
  }, [live]);

  function clearThumbs() {
    photosRef.current.forEach((p) => URL.revokeObjectURL(p.url));
    setPhotos([]);
  }

  async function follow(id: string, notices: Notices) {
    setPhase({ kind: 'sending', id, ...notices });
    const done = await queue.waitFor(id);
    // The reporter went back to Today meanwhile: the queue goes on sending without this screen.
    if (!alive.current) return;
    if (done.status === 'done' && done.result) {
      navigate(`/report/${done.result.reportId}`, { replace: true });
    } else {
      setPhase({ kind: 'failed', id, error: done.error, ...notices });
    }
  }

  async function stopAndSend(notices: Partial<Notices> = {}) {
    if (sending.current) return;
    sending.current = true;
    const n = { ...NONE, ...notices };
    try {
      const kept = await keep(await recorder.stop(), draft.current);
      if (kept.kind === 'short') {
        setPhase({ kind: 'short', ...n });
        return;
      }
      clearThumbs();
      await follow(kept.item.id, n);
    } catch (err) {
      console.error('[field] could not queue the recording', err);
      setPhase({ kind: 'failed', id: '', error: null, ...n });
    } finally {
      sending.current = false;
    }
  }

  // The recorder's own events, answered after the render that showed them: the cap (the clip is
  // sent, another may start, §9.3), and the browser stopping the recording (a call, another app,
  // a headset gone: what was said is sent).
  useEffect(() => {
    if (phase.kind !== 'recording') return;
    const notices = state.capReached
      ? { cap: true }
      : state.interrupted
        ? { interrupted: true }
        : null;
    if (notices) void Promise.resolve().then(() => stopAndSend(notices));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state.capReached, state.interrupted]);

  async function onPhotos(e: ChangeEvent<HTMLInputElement>) {
    const files = Array.from(e.target.files ?? []);
    e.target.value = '';
    setPhotoError(false);
    for (const file of files) {
      const mime = photoMime(file);
      if (!mime) {
        setPhotoError(true);
        continue;
      }
      try {
        // Into the queue at once (it survives the page), held until the clip goes.
        const item = await queue.enqueue(
          {
            code,
            kind: 'photo',
            mime,
            blob: file,
            siteId,
            date,
            recordedAt: file.lastModified ? new Date(file.lastModified).toISOString() : null,
          },
          { hold: holdId },
        );
        if (!alive.current) {
          void queue.release(holdId);
          continue;
        }
        setPhotos((prev) => [...prev, { id: item.id, url: URL.createObjectURL(file) }]);
      } catch (err) {
        console.error('[field] could not keep a photo', err);
        setPhotoError(true);
      }
    }
  }

  function removePhoto(photo: { id: string; url: string }) {
    void queue.remove(photo.id);
    URL.revokeObjectURL(photo.url);
    setPhotos((prev) => prev.filter((p) => p !== photo));
  }

  async function onAudioFile(e: ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file) return;
    const mime = audioFileMime(file);
    if (!mime) {
      setPhase({ kind: 'failed', id: '', error: 'media_type_not_allowed', ...NONE });
      return;
    }
    try {
      const item = await queue.enqueue({
        code,
        kind: 'audio',
        mime,
        blob: file,
        siteId,
        date,
        recordedAt: file.lastModified ? new Date(file.lastModified).toISOString() : null,
      });
      void queue.release(holdId);
      clearThumbs();
      await follow(item.id, NONE);
    } catch (err) {
      console.error('[field] could not queue the recording', err);
      setPhase({ kind: 'failed', id: '', error: null, ...NONE });
    }
  }

  function again() {
    setPhase({ kind: 'recording' });
    begin();
  }

  const header = (
    <header
      data-on-dark
      className="flex h-header flex-none items-center gap-2.5 border-b border-steel px-4 text-chalk"
    >
      <span
        aria-hidden="true"
        className={`size-2.5 rounded-full ${recording ? 'bg-signal shadow-[0_0_0_4px_var(--color-signal-tint)] motion-safe:animate-pulse' : 'bg-iron'}`}
      />
      <b className="text-[16px]">
        {t(state.status === 'paused' ? 'recording.paused' : 'recording.title')}
      </b>
      <span className="ml-auto min-w-0 truncate text-[14px] text-dust-light">{siteName}</span>
    </header>
  );

  const backToToday = (
    <Link to="/today" replace className={BACK_CLASSES}>
      {t('sending.backToToday')}
    </Link>
  );

  const notices = (n: Notices) => (
    <>
      {n.interrupted ? (
        <p role="status" className="m-0 text-[15px] leading-5 text-dust-light">
          {t('recording.interrupted')}
        </p>
      ) : null}
      {n.cap ? (
        <p role="status" className="m-0 text-[15px] leading-5 text-dust-light">
          {t('recording.maxReached')}
        </p>
      ) : null}
    </>
  );

  // ── Sending / queued / failed ────────────────────────────────────────────────────────────────
  if (phase.kind === 'sending' || phase.kind === 'failed') {
    const item = phase.id ? snapshot.items.find((i) => i.id === phase.id) : undefined;
    const waiting =
      phase.kind === 'sending' && (!online || (item?.status === 'queued' && item.attempts > 0));
    const failed = phase.kind === 'failed';
    const can = failed && phase.id ? failedKind(phase.error) : null;
    const title = failed ? t('sending.failed') : waiting ? t('sending.queued') : t('sending.title');
    return (
      <Screen key={phase.kind} title={title} header={header} dark dateLine={false}>
        <OfflineBanner showFailed={false} />
        {notices(phase)}
        <h1 className="m-0 text-[26px] leading-[30px] font-extrabold [font-stretch:118%]">
          {title}
        </h1>
        <p role={failed ? 'alert' : 'status'} className="m-0 text-[16px] leading-6 text-dust-light">
          {failed
            ? t(sendingErrorKey(phase.error))
            : waiting
              ? t('sending.queuedBody')
              : t('sending.body')}
        </p>
        <ActionBar dark>
          <div className="flex w-full flex-col gap-2">
            {can === 'retry' ? (
              <PrimaryButton
                onClick={() => {
                  const notes = { cap: phase.cap, interrupted: phase.interrupted };
                  void queue.retry(phase.id).then(() => follow(phase.id, notes));
                }}
              >
                {t('sending.retry')}
              </PrimaryButton>
            ) : null}
            {can === 'final' ? (
              <SteelButton
                onClick={() => {
                  void queue.remove(phase.id);
                  navigate('/today', { replace: true });
                }}
              >
                {t('sending.remove')}
              </SteelButton>
            ) : null}
            {backToToday}
          </div>
        </ActionBar>
      </Screen>
    );
  }

  // ── Too short or silent ──────────────────────────────────────────────────────────────────────
  if (phase.kind === 'short') {
    return (
      <Screen key="short" title={t('recording.title')} header={header} dark dateLine={false}>
        {notices(phase)}
        <h1 className="m-0 text-[22px] leading-7 font-bold">{t('recording.tooShort')}</h1>
        <ActionBar dark>
          <div className="flex w-full flex-col gap-2">
            <PrimaryButton onClick={again}>{tc('retry')}</PrimaryButton>
            {backToToday}
          </div>
        </ActionBar>
      </Screen>
    );
  }

  // ── Microphone refused / unsupported / failed ────────────────────────────────────────────────
  if (state.status === 'error') {
    const permission = state.error === 'permission';
    const unsupported = state.error === 'unsupported';
    const broke = state.error === 'failed';
    const voice = session.country.voiceNumber;
    const title = broke
      ? t('recording.failed')
      : unsupported
        ? t('recording.unsupported.title')
        : t('recording.permission.title');
    return (
      <Screen key="error" title={title} header={header} dark dateLine={false}>
        <h1 className="m-0 text-[26px] leading-[30px] font-extrabold [font-stretch:118%]">
          {title}
        </h1>
        {permission ? (
          <>
            <p className="m-0 text-[16px] leading-6 text-dust-light">
              {t('recording.permission.body')}
            </p>
            <ul className="m-0 flex list-none flex-col gap-2 p-0 text-[15px] leading-[21px] text-dust-light">
              <li>{t('recording.permission.ios')}</li>
              <li>{t('recording.permission.android')}</li>
            </ul>
          </>
        ) : null}
        {unsupported ? (
          <p className="m-0 text-[16px] leading-6 text-dust-light">
            {t('recording.unsupported.body')}
          </p>
        ) : null}
        {broke ? <InverseButton onClick={again}>{tc('retry')}</InverseButton> : null}
        {unsupported ? null : (
          <p className="m-0 text-[15px] leading-[21px] text-dust-light">
            {t('recording.permission.fallback')}
          </p>
        )}
        <input
          ref={audioInput}
          type="file"
          accept="audio/*"
          capture
          onChange={(e) => void onAudioFile(e)}
          className="sr-only"
          tabIndex={-1}
          aria-hidden="true"
        />
        <PrimaryButton onClick={() => audioInput.current?.click()}>
          {t('recording.permission.pick')}
        </PrimaryButton>
        {voice ? (
          <a
            href={`tel:${voice}`}
            className="flex h-target items-center justify-center text-[15px] font-semibold text-chalk underline"
          >
            {t('recording.permission.orCall', { number: formatPhone(voice) })}
          </a>
        ) : null}
        <ActionBar dark>{backToToday}</ActionBar>
      </Screen>
    );
  }

  // ── Recording ────────────────────────────────────────────────────────────────────────────────
  const paused = state.status === 'paused';
  const starting =
    state.status === 'idle' ||
    state.status === 'starting' ||
    state.status === 'stopping' ||
    state.status === 'stopped';
  return (
    <Screen key="recording" title={t('recording.title')} header={header} dark dateLine={false}>
      <OfflineBanner />
      <h1 className="sr-only">{t('recording.title')}</h1>
      <div className="flex flex-col items-center gap-1.5 pt-1.5">
        <span id={timerId} className="sr-only">
          {t('recording.timerLabel')}
        </span>
        <span
          role="timer"
          aria-labelledby={timerId}
          className="font-mono text-[60px] leading-none font-medium tracking-[-0.02em]"
        >
          {formatClock(state.elapsedMs)}
        </span>
        <span className="text-[14px] text-dust-light" role="status">
          {starting
            ? t('recording.starting')
            : paused
              ? t('recording.pausedHint')
              : held
                ? t('recording.keepTalking')
                : ''}
        </span>
      </div>

      <LevelMeter levels={state.levels} active={recording} />

      <section
        aria-labelledby={promptsId}
        className="flex flex-col gap-2.5 rounded-card bg-steel px-4 py-3.5"
      >
        <h2
          id={promptsId}
          className="m-0 font-mono text-[12px] leading-[18px] font-normal tracking-[0.08em] text-dust-light uppercase"
        >
          {t('today.promptsTitle')}
        </h2>
        <ul className="m-0 grid list-none grid-cols-2 gap-x-3 gap-y-2 p-0 text-[15px]">
          {PROMPTS.map((p) => (
            <li key={p}>{t(`today.prompts.${p}`)}</li>
          ))}
        </ul>
      </section>

      <ul
        aria-label={t('recording.photos')}
        className="m-0 flex list-none flex-wrap items-center gap-2.5 p-0"
      >
        {photos.map((p, i) => (
          <li key={p.id}>
            <button
              type="button"
              aria-label={t('recording.removePhoto', { n: i + 1 })}
              onClick={() => removePhoto(p)}
              className="relative size-[72px] overflow-hidden rounded-btn border-0 bg-steel p-0"
            >
              <img src={p.url} alt="" className="size-full object-cover" />
              <span
                aria-hidden="true"
                className="absolute right-1 bottom-1 rounded-chip bg-asphalt/80 px-1 text-[11px] text-chalk"
              >
                {t('recording.photo', { n: i + 1 })}
              </span>
            </button>
          </li>
        ))}
        <li>
          <input
            ref={photoInput}
            type="file"
            accept="image/*"
            capture="environment"
            multiple
            onChange={(e) => void onPhotos(e)}
            className="sr-only"
            tabIndex={-1}
            aria-hidden="true"
          />
          <button
            type="button"
            aria-label={t('recording.addPhoto')}
            onClick={() => photoInput.current?.click()}
            className="flex size-[72px] items-center justify-center rounded-btn border-[1.5px] border-dashed border-iron bg-transparent text-chalk"
          >
            <CameraIcon />
          </button>
        </li>
      </ul>
      {photoError ? (
        <p role="alert" className="m-0 text-[14px] text-dust-light">
          {t('sending.errors.media_type_not_allowed')}
        </p>
      ) : null}

      <ActionBar dark>
        {/* The name says what a tap does (no aria-pressed: "Resume recording, pressed" contradicts itself). */}
        <button
          type="button"
          aria-label={t(paused ? 'recording.resume' : 'recording.pause')}
          disabled={starting}
          onClick={() => (paused ? recorder.resume() : recorder.pause())}
          className="flex size-target flex-none items-center justify-center rounded-full border border-iron bg-steel text-chalk disabled:opacity-60"
        >
          {paused ? (
            <svg
              width="22"
              height="22"
              viewBox="0 0 24 24"
              fill="currentColor"
              aria-hidden="true"
              focusable="false"
            >
              <path d="M8 5v14l11-7z" />
            </svg>
          ) : (
            <svg
              width="22"
              height="22"
              viewBox="0 0 24 24"
              fill="currentColor"
              aria-hidden="true"
              focusable="false"
            >
              <rect x="6" y="5" width="4" height="14" rx="1" />
              <rect x="14" y="5" width="4" height="14" rx="1" />
            </svg>
          )}
        </button>
        <PrimaryButton onClick={() => void stopAndSend()} disabled={starting} className="flex-1">
          <svg
            width="18"
            height="18"
            viewBox="0 0 24 24"
            fill="currentColor"
            aria-hidden="true"
            focusable="false"
          >
            <rect x="6" y="6" width="12" height="12" rx="2" />
          </svg>
          {t('recording.stopSend')}
        </PrimaryButton>
      </ActionBar>
    </Screen>
  );
}
