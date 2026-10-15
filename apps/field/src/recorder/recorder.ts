import { MAX_CLIP_SECONDS } from '@sitelog/shared/field-contract.ts';
import type { LevelSource } from './analyser';
import { createStreamAnalyser } from './analyser';
import { METER_BARS, pushLevel } from './level';
import { pickRecorderMime, uploadMimeFor } from './mime';

/**
 * The recorder behind the Recording screen (F5 step 2, Field-04): microphone → `MediaRecorder`
 * (the mime `pickRecorderMime` found, at a speech bitrate), chunks handed to `onChunk` as they come
 * (the screen saves them, so a page the phone kills keeps what was said) and kept in memory until
 * Stop, a timer that excludes pauses, and a level meter from an `AnalyserNode`. Pure of React and
 * injectable (the browser APIs are deps), so it is unit-tested with fakes; `useRecorder` wires it
 * to a screen.
 *
 * The browser can stop a recording by itself: a Bluetooth headset gone, a phone call or another
 * app taking the microphone, iOS interrupting capture. Then the engine builds the clip from what it
 * has and reports `interrupted`; `stop()` hands that clip over. The 15-minute cap
 * (`MAX_CLIP_SECONDS`, §9.3) is reported through `capReached`: the screen stops and sends the clip,
 * and another clip may start.
 */

export type RecorderStatus =
  'idle' | 'starting' | 'recording' | 'paused' | 'stopping' | 'stopped' | 'error';

/** `permission`: the microphone was refused; `unsupported`: no MediaRecorder; `failed`: anything else. */
export type RecorderError = 'permission' | 'unsupported' | 'failed';

export interface RecorderState {
  status: RecorderStatus;
  /** Recording time so far, pauses excluded. */
  elapsedMs: number;
  /** The last `METER_BARS` levels (0–1), newest last. */
  levels: readonly number[];
  error: RecorderError | null;
  /** The recorder's media type once it runs (what the upload is named). */
  mime: string | null;
  /** When recording started (ISO), once it runs. */
  startedAt: string | null;
  /** `elapsedMs` reached the cap: the screen must stop and send. */
  capReached: boolean;
  /** The browser stopped the recording by itself: `stop()` hands over the clip it left. */
  interrupted: boolean;
}

export interface Clip {
  blob: Blob;
  mime: string;
  durationMs: number;
  /** When recording started (ISO), for `uploads.recorded_at`. */
  startedAt: string;
  /** The loudest meter reading while the meter ran (0–1); null when it never ran. */
  peakLevel: number | null;
}

/** The part of `MediaRecorder` the engine uses (a fake in tests). */
export interface MediaRecorderLike {
  readonly state: 'inactive' | 'recording' | 'paused';
  readonly mimeType: string;
  start(timeslice?: number): void;
  pause(): void;
  resume(): void;
  stop(): void;
  ondataavailable: ((event: { data: Blob }) => void) | null;
  onstop: (() => void) | null;
  onerror: ((event: unknown) => void) | null;
}

export type MediaRecorderCtor = new (
  stream: MediaStream,
  options?: { mimeType?: string; audioBitsPerSecond?: number },
) => MediaRecorderLike;

/** Speech for transcription needs no more (Chrome's Opus default is about 128 kbps). */
export const AUDIO_BITS_PER_SECOND = 32_000;

/** How long to wait for the stop event of a recorder the browser already stopped. */
const STOP_EVENT_GRACE_MS = 500;

export interface RecorderDeps {
  getUserMedia?: (constraints: MediaStreamConstraints) => Promise<MediaStream>;
  /** `MediaRecorder`; undefined where the browser has none (then `error: 'unsupported'`). */
  Recorder?: MediaRecorderCtor;
  /** The mime to ask for; null when the browser supports none field-api stores. */
  requestedMime?: string | null;
  analyser?: (stream: MediaStream) => LevelSource | null;
  now?: () => number;
  setInterval?: (fn: () => void, ms: number) => unknown;
  clearInterval?: (handle: unknown) => void;
  /** One-off timer (the wait for a lost stop event). */
  setTimeout?: (fn: () => void, ms: number) => unknown;
  /** `navigator.vibrate` (§9.3 "haptic tick on start/stop"); feature-detected. */
  vibrate?: (ms: number) => void;
  /** Milliseconds between `ondataavailable` chunks. */
  timesliceMs?: number;
  /** The cap in milliseconds (default `MAX_CLIP_SECONDS`). */
  capMs?: number;
  /** Each chunk as it comes, with the recording time so far (the draft that survives the page). */
  onChunk?: (chunk: Blob, elapsedMs: number) => void;
}

export interface Recorder {
  getState(): RecorderState;
  subscribe(listener: () => void): () => void;
  /** Asks for the microphone and starts; resolves when recording (or in error). */
  start(): Promise<void>;
  pause(): void;
  resume(): void;
  /**
   * Stops and resolves with the clip; null when nothing was recorded. After an interruption it
   * resolves at once with the clip the browser left.
   */
  stop(): Promise<Clip | null>;
  /** Who gets each chunk as it comes (replaces `deps.onChunk`; null for nobody). */
  setOnChunk(listener: ((chunk: Blob, elapsedMs: number) => void) | null): void;
  /**
   * Releases the microphone without a clip, including one a `start()` still waiting for
   * permission would open, and returns to `idle`: a later `start()` works again (React StrictMode
   * unmounts and mounts a screen once in development). A `stop()` in flight is left alone: its
   * clip is never cut short.
   */
  dispose(): void;
}

const TICK_MS = 250;
const LEVEL_MS = 100;

function browserDeps(): Required<
  Pick<
    RecorderDeps,
    'now' | 'setInterval' | 'clearInterval' | 'setTimeout' | 'analyser' | 'timesliceMs' | 'capMs'
  >
> &
  RecorderDeps {
  const nav = globalThis.navigator as Navigator | undefined;
  const Recorder = (globalThis as { MediaRecorder?: MediaRecorderCtor }).MediaRecorder;
  return {
    getUserMedia:
      typeof nav?.mediaDevices?.getUserMedia === 'function'
        ? (c) => nav.mediaDevices.getUserMedia(c)
        : undefined,
    Recorder: typeof Recorder === 'function' ? Recorder : undefined,
    requestedMime: pickRecorderMime(),
    analyser: createStreamAnalyser,
    now: () => Date.now(),
    setInterval: (fn, ms) => setInterval(fn, ms),
    clearInterval: (h) => clearInterval(h as ReturnType<typeof setInterval>),
    setTimeout: (fn, ms) => setTimeout(fn, ms),
    vibrate: typeof nav?.vibrate === 'function' ? (ms) => void nav.vibrate(ms) : undefined,
    timesliceMs: 1000,
    capMs: MAX_CLIP_SECONDS * 1000,
  };
}

function permissionError(err: unknown): boolean {
  const name = (err as { name?: string } | null)?.name;
  return name === 'NotAllowedError' || name === 'SecurityError' || name === 'PermissionDeniedError';
}

export function createRecorder(given: RecorderDeps = {}): Recorder {
  const deps = { ...browserDeps(), ...given };
  const listeners = new Set<() => void>();
  let state: RecorderState = {
    status: 'idle',
    elapsedMs: 0,
    levels: [],
    error: null,
    mime: null,
    startedAt: null,
    capReached: false,
    interrupted: false,
  };
  let stream: MediaStream | null = null;
  let recorder: MediaRecorderLike | null = null;
  let level: LevelSource | null = null;
  let closedMs = 0;
  let segmentStart: number | null = null;
  let startedAt: number | null = null;
  let peak: number | null = null;
  let tickTimer: unknown = null;
  let levelTimer: unknown = null;
  /** Bumped by `start()` and `dispose()`: a start that resumes after a newer one or a dispose stops. */
  let generation = 0;
  /** Ends the current recording and builds its clip (one per recording). */
  let finish: (() => void) | null = null;
  /** A `stop()` waiting for the clip. */
  let waiting: ((clip: Clip | null) => void) | null = null;
  /** The clip of a recording the browser stopped by itself, until `stop()` takes it. */
  let left: Clip | null = null;
  let onChunk = deps.onChunk ?? null;

  const set = (patch: Partial<RecorderState>) => {
    state = { ...state, ...patch };
    listeners.forEach((l) => l());
  };
  const elapsed = () => closedMs + (segmentStart === null ? 0 : deps.now() - segmentStart);

  function stopTimers() {
    if (tickTimer !== null) deps.clearInterval(tickTimer);
    if (levelTimer !== null) deps.clearInterval(levelTimer);
    tickTimer = levelTimer = null;
  }

  function releaseStream() {
    level?.close();
    level = null;
    stream?.getTracks().forEach((t) => t.stop());
    stream = null;
  }

  function fail(error: RecorderError) {
    stopTimers();
    releaseStream();
    recorder = null;
    finish = null;
    set({ status: 'error', error });
  }

  function tick() {
    const elapsedMs = elapsed();
    if (elapsedMs >= deps.capMs && !state.capReached) set({ elapsedMs, capReached: true });
    else set({ elapsedMs });
  }

  function sampleLevel() {
    // A meter that is not running (iOS keeps an AudioContext suspended without a gesture) reads
    // silence: it is drawn but never taken for what the microphone heard.
    const live = level !== null && (level.live?.() ?? true);
    const value = live ? level!.read() : 0;
    if (live) peak = Math.max(peak ?? 0, value);
    set({ levels: pushLevel(state.levels, value, METER_BARS) });
  }

  function openSegment() {
    segmentStart = deps.now();
    tickTimer = deps.setInterval(tick, TICK_MS);
    levelTimer = deps.setInterval(sampleLevel, LEVEL_MS);
  }

  function closeSegment() {
    if (segmentStart !== null) closedMs += deps.now() - segmentStart;
    segmentStart = null;
    stopTimers();
  }

  return {
    getState: () => state,
    setOnChunk(listener) {
      onChunk = listener;
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },

    async start() {
      if (state.status !== 'idle' && state.status !== 'error' && state.status !== 'stopped') return;
      const mine = ++generation;
      closedMs = 0;
      segmentStart = null;
      peak = null;
      left = null;
      finish = null;
      set({
        status: 'starting',
        elapsedMs: 0,
        levels: [],
        error: null,
        startedAt: null,
        capReached: false,
        interrupted: false,
      });
      if (!deps.Recorder || !deps.getUserMedia || !deps.requestedMime) {
        fail('unsupported');
        return;
      }
      let opened: MediaStream;
      try {
        opened = await deps.getUserMedia({
          audio: { echoCancellation: true, noiseSuppression: true },
        });
      } catch (err) {
        if (mine === generation) fail(permissionError(err) ? 'permission' : 'failed');
        return;
      }
      if (mine !== generation) {
        // The screen went away (or started again) while the phone asked for the microphone: never
        // leave it open.
        opened.getTracks().forEach((t) => t.stop());
        return;
      }
      stream = opened;
      try {
        try {
          recorder = new deps.Recorder(stream, {
            mimeType: deps.requestedMime,
            audioBitsPerSecond: AUDIO_BITS_PER_SECOND,
          });
        } catch {
          // A browser that refuses the options but records all the same.
          recorder = new deps.Recorder(stream);
        }
      } catch {
        fail('unsupported');
        return;
      }
      const rec = recorder;
      const chunks: Blob[] = [];
      const mime = uploadMimeFor(rec.mimeType, deps.requestedMime);
      let ended = false;
      let errored = false;

      const done = () => {
        if (ended || mine !== generation) return;
        ended = true;
        closeSegment();
        const durationMs = elapsed();
        releaseStream();
        recorder = null;
        finish = null;
        deps.vibrate?.(30);
        const blob = new Blob(chunks, { type: mime.split(';')[0] });
        const clip: Clip | null =
          blob.size === 0
            ? null
            : {
                blob,
                mime,
                durationMs,
                startedAt: new Date(startedAt ?? deps.now()).toISOString(),
                peakLevel: peak,
              };
        if (waiting) {
          const resolve = waiting;
          waiting = null;
          set({ status: 'stopped', elapsedMs: durationMs });
          resolve(clip);
        } else if (errored && !clip) {
          set({ status: 'error', error: 'failed', elapsedMs: durationMs });
        } else {
          // Stopped by the browser: what was said is kept for `stop()`.
          left = clip;
          set({ status: 'stopped', elapsedMs: durationMs, interrupted: clip !== null });
        }
      };
      finish = done;

      /** The browser is ending the recording: take its last chunk, and do not wait forever. */
      const ending = () => {
        if (ended) return;
        try {
          if (rec.state !== 'inactive') rec.stop();
        } catch {
          // Already stopping.
        }
        deps.setTimeout(done, STOP_EVENT_GRACE_MS);
      };

      rec.ondataavailable = (event) => {
        if (!event.data || event.data.size === 0) return;
        chunks.push(event.data);
        if (mine === generation) onChunk?.(event.data, elapsed());
      };
      rec.onstop = done;
      rec.onerror = () => {
        if (state.status !== 'recording' && state.status !== 'paused') return;
        errored = true;
        ending();
      };
      // A headset gone, a call or the OS taking the microphone ends the track.
      for (const track of stream.getTracks()) {
        const t = track as MediaStreamTrack & {
          addEventListener?: MediaStreamTrack['addEventListener'];
        };
        if (typeof t.addEventListener === 'function') {
          t.addEventListener('ended', () => {
            if (state.status === 'recording' || state.status === 'paused') ending();
          });
        }
      }
      try {
        rec.start(deps.timesliceMs);
      } catch {
        fail('failed');
        return;
      }
      level = deps.analyser(stream);
      startedAt = deps.now();
      openSegment();
      deps.vibrate?.(30);
      set({ status: 'recording', mime, startedAt: new Date(startedAt).toISOString() });
    },

    pause() {
      if (state.status !== 'recording' || !recorder) return;
      try {
        recorder.pause();
      } catch {
        return;
      }
      closeSegment();
      set({ status: 'paused', elapsedMs: elapsed() });
    },

    resume() {
      if (state.status !== 'paused' || !recorder) return;
      try {
        recorder.resume();
      } catch {
        return;
      }
      openSegment();
      set({ status: 'recording' });
    },

    stop() {
      if (left) {
        const clip = left;
        left = null;
        set({ interrupted: false });
        return Promise.resolve(clip);
      }
      const rec = recorder;
      const end = finish;
      if (!rec || !end || (state.status !== 'recording' && state.status !== 'paused')) {
        return Promise.resolve(null);
      }
      closeSegment();
      set({ status: 'stopping', elapsedMs: elapsed() });
      return new Promise<Clip | null>((resolve) => {
        waiting = resolve;
        if (rec.state === 'inactive') {
          // Stopped by the browser already: its stop event may still come with the last chunk.
          deps.setTimeout(end, STOP_EVENT_GRACE_MS);
          return;
        }
        try {
          rec.stop();
        } catch {
          end();
        }
      });
    },

    dispose() {
      if (state.status === 'stopping') return;
      generation++;
      stopTimers();
      if (recorder && recorder.state !== 'inactive') {
        recorder.onstop = null;
        recorder.ondataavailable = null;
        try {
          recorder.stop();
        } catch {
          // Already stopped.
        }
      }
      recorder = null;
      finish = null;
      waiting = null;
      left = null;
      closedMs = 0;
      segmentStart = null;
      releaseStream();
      set({
        status: 'idle',
        elapsedMs: 0,
        levels: [],
        error: null,
        startedAt: null,
        capReached: false,
        interrupted: false,
      });
    },
  };
}
