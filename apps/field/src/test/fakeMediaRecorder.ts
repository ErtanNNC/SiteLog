import { vi } from 'vitest';
import type { MediaRecorderLike, RecorderDeps } from '@/recorder/recorder';

/** A MediaRecorder that hands out one chunk per `start` and on `stop`. */
export class FakeMediaRecorder implements MediaRecorderLike {
  static instances: FakeMediaRecorder[] = [];
  /** A browser that refuses the constructor options (then the engine retries without). */
  static refuseOptions = false;
  state: 'inactive' | 'recording' | 'paused' = 'inactive';
  mimeType: string;
  options: { mimeType?: string; audioBitsPerSecond?: number } | undefined;
  ondataavailable: ((event: { data: Blob }) => void) | null = null;
  onstop: (() => void) | null = null;
  onerror: ((event: unknown) => void) | null = null;
  constructor(
    public stream: MediaStream,
    options?: { mimeType?: string; audioBitsPerSecond?: number },
  ) {
    if (options && FakeMediaRecorder.refuseOptions) throw new TypeError('bad options');
    this.options = options;
    this.mimeType = options?.mimeType ?? 'audio/mp4';
    FakeMediaRecorder.instances.push(this);
  }
  start() {
    this.state = 'recording';
    this.ondataavailable?.({ data: new Blob(['aa'], { type: this.mimeType }) });
  }
  pause() {
    this.state = 'paused';
  }
  resume() {
    this.state = 'recording';
  }
  stop() {
    if (this.state === 'inactive') return;
    this.state = 'inactive';
    this.ondataavailable?.({ data: new Blob(['bb'], { type: this.mimeType }) });
    this.onstop?.();
  }
  /** The browser ends the recording by itself (a call takes the microphone). */
  interrupt() {
    this.stop();
  }
}

/** A track that can end, as a phone call or a headset gone ends it. */
export class FakeTrack extends EventTarget {
  readonly kind = 'audio';
  stop = vi.fn();
  end() {
    this.dispatchEvent(new Event('ended'));
  }
}

/** Recorder deps on fakes, with a clock the test moves (`tick`). */
export function fakeRecorderDeps(over: Partial<RecorderDeps> = {}) {
  let now = 10_000;
  const timers: { fn: () => void; ms: number; id: number }[] = [];
  const timeouts: (() => void)[] = [];
  let id = 0;
  const track = new FakeTrack();
  const stream = { getTracks: () => [track] } as unknown as MediaStream;
  const level = { read: vi.fn(() => 0.5), close: vi.fn() };
  const deps: RecorderDeps = {
    getUserMedia: vi.fn(async () => stream),
    Recorder: FakeMediaRecorder as never,
    requestedMime: 'audio/webm;codecs=opus',
    analyser: () => level,
    now: () => now,
    setInterval: (fn, ms) => {
      const t = { fn, ms, id: ++id };
      timers.push(t);
      return t.id;
    },
    clearInterval: (h) => {
      const i = timers.findIndex((t) => t.id === h);
      if (i >= 0) timers.splice(i, 1);
    },
    setTimeout: (fn) => {
      timeouts.push(fn);
      return timeouts.length;
    },
    vibrate: vi.fn(),
    ...over,
  };
  return {
    deps,
    track,
    level,
    timers,
    /** Runs the one-off timers (the wait for a lost stop event). */
    runTimeouts: () => timeouts.splice(0).forEach((fn) => fn()),
    /** Moves the clock and fires every interval whose period fits in `ms`. */
    tick: (ms: number) => {
      now += ms;
      timers.forEach((t) => {
        if (ms >= t.ms) t.fn();
      });
    },
    clock: () => now,
    recorder: () => FakeMediaRecorder.instances.at(-1)!,
  };
}
