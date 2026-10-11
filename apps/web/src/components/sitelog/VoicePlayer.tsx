/**
 * §11.3 VoicePlayer: 44 px orange play circle, waveform bars from precomputed peaks, mono
 * current/duration, `seek(seconds)` exposed through a ref and through <VoicePlayerProvider>
 * so SourceLink("audio 0:41") can seek + highlight the transcript segment. Uses an <audio>
 * element with the signed URL; in demo mode (no URL) a silent timer still advances time.
 */
import { Pause, Play } from 'lucide-react';
import {
  createContext,
  forwardRef,
  useCallback,
  useContext,
  useEffect,
  useImperativeHandle,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import { formatAudioTimestamp } from '@sitelog/shared/format.ts';
import { copy } from '@/copy/en';
import { cn } from '@/lib/utils';

export interface VoicePlayerHandle {
  seek: (seconds: number, autoplay?: boolean) => void;
  play: () => void;
  pause: () => void;
}

interface PlayerCtx {
  register: (h: VoicePlayerHandle | null) => void;
  seek: (seconds: number) => void;
  currentTime: number;
  setCurrentTime: (t: number) => void;
  highlight: number | null;
  setHighlight: (t: number | null) => void;
}

const Ctx = createContext<PlayerCtx | null>(null);

export function VoicePlayerProvider({ children }: { children: ReactNode }) {
  const handle = useRef<VoicePlayerHandle | null>(null);
  const [currentTime, setCurrentTime] = useState(0);
  const [highlight, setHighlight] = useState<number | null>(null);
  const register = useCallback((h: VoicePlayerHandle | null) => {
    handle.current = h;
  }, []);
  const seek = useCallback((s: number) => {
    setHighlight(s);
    handle.current?.seek(s, true);
  }, []);
  const value = useMemo(
    () => ({ register, seek, currentTime, setCurrentTime, highlight, setHighlight }),
    [register, seek, currentTime, highlight],
  );
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useVoicePlayer(): PlayerCtx | null {
  return useContext(Ctx);
}

export interface VoicePlayerProps {
  peaks: number[];
  durationS: number;
  url: string | null;
  languages?: string | null;
  className?: string;
  onTimeUpdate?: (t: number) => void;
}

export const VoicePlayer = forwardRef<VoicePlayerHandle, VoicePlayerProps>(
  ({ peaks, durationS, url, languages, className, onTimeUpdate }, ref) => {
    const ctx = useVoicePlayer();
    const audioRef = useRef<HTMLAudioElement | null>(null);
    const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);
    const [playing, setPlaying] = useState(false);
    const [time, setTimeState] = useState(0);
    const duration = Math.max(1, durationS);

    const setTime = useCallback(
      (t: number) => {
        const clamped = Math.max(0, Math.min(duration, t));
        setTimeState(clamped);
        ctx?.setCurrentTime(clamped);
        onTimeUpdate?.(clamped);
      },
      [ctx, duration, onTimeUpdate],
    );

    const stopTimer = () => {
      if (timerRef.current) clearInterval(timerRef.current);
      timerRef.current = null;
    };

    const pause = useCallback(() => {
      setPlaying(false);
      stopTimer();
      audioRef.current?.pause();
    }, []);

    const play = useCallback(() => {
      setPlaying(true);
      if (audioRef.current && url) {
        void audioRef.current.play().catch(() => setPlaying(false));
        return;
      }
      // Silent mock (demo): advance 0.25 s every 250 ms.
      stopTimer();
      timerRef.current = setInterval(() => {
        setTimeState((t) => {
          const next = t + 0.25;
          if (next >= duration) {
            stopTimer();
            setPlaying(false);
            ctx?.setCurrentTime(duration);
            return duration;
          }
          ctx?.setCurrentTime(next);
          onTimeUpdate?.(next);
          return next;
        });
      }, 250);
    }, [ctx, duration, onTimeUpdate, url]);

    const seek = useCallback(
      (s: number, autoplay = false) => {
        setTime(s);
        if (audioRef.current && url) audioRef.current.currentTime = s;
        if (autoplay && !playing) play();
      },
      [play, playing, setTime, url],
    );

    const handle = useMemo<VoicePlayerHandle>(() => ({ seek, play, pause }), [seek, play, pause]);
    useImperativeHandle(ref, () => handle, [handle]);
    useEffect(() => {
      ctx?.register(handle);
      return () => ctx?.register(null);
    }, [ctx, handle]);
    useEffect(() => () => stopTimer(), []);

    const bars = peaks.length ? peaks : Array.from({ length: 48 }, () => 0.3);
    const progress = time / duration;

    return (
      <div className={cn('flex items-center gap-3', className)} data-testid="voice-player">
        {url ? (
          <audio
            ref={audioRef}
            src={url}
            preload="metadata"
            onTimeUpdate={(e) => setTime(e.currentTarget.currentTime)}
            onEnded={() => setPlaying(false)}
            onPause={() => setPlaying(false)}
            onPlay={() => setPlaying(true)}
          />
        ) : null}
        <button
          type="button"
          onClick={() => (playing ? pause() : play())}
          aria-label={playing ? copy.player.pause : copy.player.play}
          aria-pressed={playing}
          className="flex size-11 shrink-0 items-center justify-center rounded-full bg-signal text-asphalt hover:bg-signal-deep hover:text-chalk"
        >
          {playing ? (
            <Pause className="size-5 fill-current" aria-hidden="true" />
          ) : (
            <Play className="ml-0.5 size-5 fill-current" aria-hidden="true" />
          )}
        </button>
        <div
          className="flex h-11 flex-1 cursor-pointer items-end gap-px"
          role="slider"
          aria-label={copy.player.label}
          aria-valuemin={0}
          aria-valuemax={Math.round(duration)}
          aria-valuenow={Math.round(time)}
          aria-valuetext={formatAudioTimestamp(time)}
          tabIndex={0}
          onClick={(e) => {
            const rect = e.currentTarget.getBoundingClientRect();
            seek(((e.clientX - rect.left) / rect.width) * duration);
          }}
          onKeyDown={(e) => {
            if (e.key === 'ArrowRight') seek(time + 5);
            if (e.key === 'ArrowLeft') seek(time - 5);
            if (e.key === ' ' || e.key === 'Enter') {
              e.preventDefault();
              if (playing) pause();
              else play();
            }
          }}
        >
          {bars.map((p, i) => {
            const played = i / bars.length <= progress;
            return (
              <span
                key={i}
                aria-hidden="true"
                className={cn(
                  'w-full min-w-px flex-1 rounded-[1px]',
                  played ? 'bg-signal' : 'bg-rebar',
                )}
                style={{ height: `${Math.max(8, Math.min(100, p * 100))}%` }}
              />
            );
          })}
        </div>
        <div className="shrink-0 font-mono text-data tabular text-dust">
          <span className="text-asphalt">{formatAudioTimestamp(time)}</span> /{' '}
          {formatAudioTimestamp(duration)}
        </div>
        {languages ? (
          <span className="hidden shrink-0 font-mono text-[12px] uppercase tracking-[0.08em] text-dust sm:inline">
            {languages}
          </span>
        ) : null}
      </div>
    );
  },
);
VoicePlayer.displayName = 'VoicePlayer';
