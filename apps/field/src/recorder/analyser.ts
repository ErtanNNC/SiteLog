import { levelFromTimeDomain } from './level';

/** Where the level meter reads from: 0–1 per `read()`. */
export interface LevelSource {
  read(): number;
  /** Whether the meter really listens (an `AudioContext` iOS keeps suspended reads silence). */
  live?(): boolean;
  close(): void;
}

type AudioContextCtor = new () => AudioContext;

interface AudioWindow {
  AudioContext?: AudioContextCtor;
  webkitAudioContext?: AudioContextCtor;
}

/**
 * An `AnalyserNode` on the microphone stream (Field-04's level meter): 8-bit time-domain samples
 * through `levelFromTimeDomain`. Null where the browser has no `AudioContext`, or when creating one
 * fails: the recording goes on without a meter. The context is resumed best-effort (iOS keeps a
 * context suspended until a user gesture; the Record tap counts as one for the first screen).
 */
export function createStreamAnalyser(
  stream: MediaStream,
  win: AudioWindow = globalThis as AudioWindow,
): LevelSource | null {
  const Ctx = win.AudioContext ?? win.webkitAudioContext;
  if (!Ctx) return null;
  try {
    const ctx = new Ctx();
    const source = ctx.createMediaStreamSource(stream);
    const analyser = ctx.createAnalyser();
    analyser.fftSize = 256;
    source.connect(analyser);
    const buffer = new Uint8Array(analyser.fftSize);
    void ctx.resume?.().catch(() => undefined);
    return {
      read() {
        analyser.getByteTimeDomainData(buffer);
        return levelFromTimeDomain(buffer);
      },
      live: () => ctx.state === 'running',
      close() {
        try {
          source.disconnect();
        } catch {
          // Already gone.
        }
        void ctx.close().catch(() => undefined);
      },
    };
  } catch {
    return null;
  }
}
