/**
 * §11.3 MediaPlayer: a voice note or a call recording. 44 px orange play circle, waveform bars
 * from precomputed peaks (`uploads.peaks`, `calls.peaks`), mono current / duration and a 1× /
 * 1.5× speed switch. A report can hold several clips (voice notes, a spoken correction, a call):
 * each player registers with <MediaPlayerProvider> under its clip id, so a SourceLink ("audio
 * 0:41", "call 2:15") seeks the clip it cites and plays it, and the others pause. Uses an <audio>
 * element with the signed URL; without one (demo mode) a silent timer still advances time.
 *
 * A call with two lanes (W3-05, `calls.peaks` `{reporter, agent}`) draws the site manager's lane
 * over the assistant's, each labelled, with a speaker filter (both · site manager · assistant)
 * that dims the other lane and hides its lines in the clip's excerpts and transcript
 * (`useSpeakerFilter`). A v1 call row's single array stays one lane.
 */
import { Check, Pause, Play } from 'lucide-react';
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import { formatAudioTimestamp } from '@sitelog/shared/format.ts';
import { useCopy } from '@/i18n/useCopy';
import { foldLanes, laneDimmed, SPEAKER_FILTERS, type SpeakerFilter } from '@/lib/callLanes';
import { waveformBars } from '@/lib/peaks';
import { cn } from '@/lib/utils';

/** §11.3 playback speeds. */
export const PLAYBACK_RATES = [1, 1.5] as const;
export type PlaybackRate = (typeof PLAYBACK_RATES)[number];

export interface MediaPlayerHandle {
  seek: (seconds: number, autoplay?: boolean) => void;
  play: () => void;
  pause: () => void;
}

interface PlayerCtx {
  register: (clipId: string, h: MediaPlayerHandle | null) => void;
  /**
   * Seeks a clip (without an id: the first one registered) and plays it from there; with
   * `autoplay` false it only moves there (a link that opens P7 at a second, W3-06).
   */
  seek: (seconds: number, clipId?: string, autoplay?: boolean) => void;
  /** A player started: the others pause. */
  started: (clipId: string) => void;
  /** The clip playing or last sought, and its time. */
  active: { clipId: string | null; time: number };
  setTime: (clipId: string, t: number) => void;
  /** The second a source link sought, for highlighting its excerpt and transcript segment. */
  highlight: { clipId: string | null; at: number } | null;
  /** Each call's speaker filter (W3-05); a clip not listed shows both speakers. */
  filters: Readonly<Record<string, SpeakerFilter>>;
  setFilter: (clipId: string, filter: SpeakerFilter) => void;
}

const Ctx = createContext<PlayerCtx | null>(null);

export function MediaPlayerProvider({ children }: { children: ReactNode }) {
  const handles = useRef(new Map<string, MediaPlayerHandle>());
  const order = useRef<string[]>([]);
  const [active, setActive] = useState<PlayerCtx['active']>({ clipId: null, time: 0 });
  const [highlight, setHighlight] = useState<PlayerCtx['highlight']>(null);
  const register = useCallback((clipId: string, h: MediaPlayerHandle | null) => {
    if (h) {
      handles.current.set(clipId, h);
      if (!order.current.includes(clipId)) order.current.push(clipId);
    } else {
      handles.current.delete(clipId);
      order.current = order.current.filter((id) => id !== clipId);
    }
  }, []);
  const started = useCallback((clipId: string) => {
    for (const [id, h] of handles.current) if (id !== clipId) h.pause();
  }, []);
  const seek = useCallback(
    (s: number, clipId?: string, autoplay = true) => {
      const id = clipId ?? order.current[0] ?? null;
      setHighlight({ clipId: id, at: s });
      if (id === null) return;
      if (autoplay) started(id);
      handles.current.get(id)?.seek(s, autoplay);
    },
    [started],
  );
  const setTime = useCallback((clipId: string, time: number) => setActive({ clipId, time }), []);
  const [filters, setFilters] = useState<PlayerCtx['filters']>({});
  const setFilter = useCallback(
    (clipId: string, filter: SpeakerFilter) => setFilters((cur) => ({ ...cur, [clipId]: filter })),
    [],
  );
  const value = useMemo(
    () => ({ register, seek, started, active, setTime, highlight, filters, setFilter }),
    [register, seek, started, active, setTime, highlight, filters, setFilter],
  );
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useMediaPlayer(): PlayerCtx | null {
  return useContext(Ctx);
}

/** A call's speaker filter (W3-05): which lines its excerpts and transcript show. */
export function useSpeakerFilter(clipId: string | null): SpeakerFilter {
  const player = useMediaPlayer();
  return (clipId && player?.filters[clipId]) || 'both';
}

/** Whether second `at`…`end` of a clip is where the player is, or what a source link sought. */
export function useClipActive(clipId: string | null, start: number, end: number): boolean {
  const player = useMediaPlayer();
  if (!player) return false;
  const h = player.highlight;
  if (h && (h.clipId ?? clipId) === clipId && h.at >= start && h.at < end) return true;
  const a = player.active;
  return a.clipId === clipId && a.time > 0 && a.time >= start && a.time < end;
}

export interface MediaPlayerProps {
  /** The clip's id: its upload (voice note) or call. */
  clipId: string;
  kind?: 'voice_note' | 'call';
  /** The waveform; on a call with two lanes, the site manager's lane. */
  peaks: number[];
  /** A call's assistant lane (W3-05); null or absent: one lane. */
  agentPeaks?: number[] | null;
  durationS: number;
  url: string | null;
  className?: string;
}

export function MediaPlayer({
  clipId,
  kind = 'voice_note',
  peaks,
  agentPeaks,
  durationS,
  url,
  className,
}: MediaPlayerProps) {
  const { t } = useCopy();
  const ctx = useMediaPlayer();
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const [playing, setPlaying] = useState(false);
  const [time, setTimeState] = useState(0);
  const [rate, setRate] = useState<PlaybackRate>(1);
  const duration = Math.max(1, durationS);
  const isCall = kind === 'call';

  const report = useCallback(
    (t: number) => {
      const clamped = Math.max(0, Math.min(duration, t));
      setTimeState(clamped);
      ctx?.setTime(clipId, clamped);
    },
    [ctx, clipId, duration],
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

  const rateRef = useRef<PlaybackRate>(rate);
  useEffect(() => {
    rateRef.current = rate;
    if (audioRef.current) audioRef.current.playbackRate = rate;
  }, [rate]);

  const play = useCallback(() => {
    setPlaying(true);
    ctx?.started(clipId);
    if (audioRef.current && url) {
      audioRef.current.playbackRate = rateRef.current;
      try {
        const started = audioRef.current.play() as Promise<void> | undefined;
        started?.catch?.(() => setPlaying(false));
      } catch {
        setPlaying(false);
      }
      return;
    }
    // Silent stand-in (demo, or a file that is gone): advance 0.25 s of audio every 250 ms × rate.
    stopTimer();
    timerRef.current = setInterval(() => {
      setTimeState((cur) => {
        const next = cur + 0.25 * rateRef.current;
        if (next >= duration) {
          stopTimer();
          setPlaying(false);
          ctx?.setTime(clipId, duration);
          return duration;
        }
        ctx?.setTime(clipId, next);
        return next;
      });
    }, 250);
  }, [ctx, clipId, duration, url]);

  const seek = useCallback(
    (s: number, autoplay = false) => {
      report(s);
      if (audioRef.current && url) audioRef.current.currentTime = Math.max(0, s);
      if (autoplay && !playing) play();
    },
    [play, playing, report, url],
  );

  const handle = useMemo<MediaPlayerHandle>(() => ({ seek, play, pause }), [seek, play, pause]);
  useEffect(() => {
    ctx?.register(clipId, handle);
    return () => ctx?.register(clipId, null);
  }, [ctx, clipId, handle]);
  useEffect(() => () => stopTimer(), []);

  const twoLanes = isCall && !!agentPeaks;
  const lanes = twoLanes ? foldLanes(peaks, agentPeaks) : null;
  const bars = peaks.length ? waveformBars(peaks) : Array.from({ length: 48 }, () => 0.3);
  const progress = time / duration;
  const nextRate: PlaybackRate = rate === 1 ? 1.5 : 1;
  const filter: SpeakerFilter = (twoLanes && ctx?.filters[clipId]) || 'both';
  const drawBars = (values: number[], dimmed = false) =>
    values.map((p, i) => {
      const played = i / values.length <= progress;
      return (
        <span
          key={i}
          aria-hidden="true"
          className={cn(
            'w-full min-w-px flex-1 rounded-[1px]',
            played ? 'bg-signal' : 'bg-rebar',
            dimmed && 'opacity-30',
          )}
          style={{ height: `${Math.max(8, Math.min(100, p * 100))}%` }}
        />
      );
    });

  const player = (
    <div
      className={cn(
        'flex items-center gap-2 sm:gap-3',
        // Two lanes take a full-width line under the controls, so they stay legible at 390 px.
        twoLanes ? 'flex-wrap' : className,
      )}
      data-testid="media-player"
      data-clip={clipId}
      data-kind={kind}
      data-lanes={twoLanes ? 2 : 1}
    >
      {url ? (
        <audio
          ref={audioRef}
          src={url}
          preload="metadata"
          onTimeUpdate={(e) => report(e.currentTarget.currentTime)}
          onEnded={() => setPlaying(false)}
          onPause={() => setPlaying(false)}
          onPlay={() => setPlaying(true)}
        />
      ) : null}
      <button
        type="button"
        onClick={() => (playing ? pause() : play())}
        aria-label={
          playing
            ? t(isCall ? 'player.pauseCall' : 'player.pause')
            : t(isCall ? 'player.playCall' : 'player.play')
        }
        aria-pressed={playing}
        className="flex size-target shrink-0 items-center justify-center rounded-full bg-signal text-asphalt hover:bg-signal-deep hover:text-chalk"
        data-testid="player-toggle"
      >
        {playing ? (
          <Pause className="size-5 fill-current" aria-hidden="true" />
        ) : (
          <Play className="ml-0.5 size-5 fill-current" aria-hidden="true" />
        )}
      </button>
      <div
        className={cn(
          'min-w-0 flex-1 cursor-pointer',
          twoLanes
            ? 'order-last flex basis-full flex-col gap-1 py-0.5'
            : 'flex h-target items-end gap-px',
        )}
        role="slider"
        aria-label={t(isCall ? 'player.labelCall' : 'player.label')}
        aria-valuemin={0}
        aria-valuemax={Math.round(duration)}
        aria-valuenow={Math.round(time)}
        aria-valuetext={formatAudioTimestamp(time)}
        tabIndex={0}
        data-testid="player-position"
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
        {lanes
          ? (['reporter', 'agent'] as const).map((lane) => {
              const dimmed = laneDimmed(filter, lane);
              return (
                <div
                  key={lane}
                  className={cn('min-w-0', dimmed && 'text-dust')}
                  data-testid={`lane-${lane}`}
                  data-dimmed={dimmed || undefined}
                >
                  <div
                    className={cn(
                      'font-mono text-[11px] uppercase leading-[14px] tracking-[0.08em]',
                      dimmed ? 'text-dust' : 'text-asphalt',
                    )}
                  >
                    {t(lane === 'agent' ? 'player.laneAgent' : 'player.laneReporter')}
                  </div>
                  <div className="flex h-5 items-end gap-px">
                    {drawBars(lane === 'agent' ? (lanes.agent ?? []) : lanes.reporter, dimmed)}
                  </div>
                </div>
              );
            })
          : drawBars(bars)}
      </div>
      <div
        className={cn('shrink-0 font-mono text-data tabular text-dust', twoLanes && 'ml-auto')}
        data-testid="player-time"
      >
        <span className="text-asphalt">{formatAudioTimestamp(time)}</span>
        {' / '}
        {formatAudioTimestamp(duration)}
      </div>
      <button
        type="button"
        onClick={() => setRate(nextRate)}
        aria-label={`${t('player.speed')}: ${t('player.speedValue', { rate: String(rate) })}`}
        title={t('player.speed')}
        className="inline-flex h-target min-w-target shrink-0 items-center justify-center rounded-btn border border-rebar px-2 font-mono text-[12px] font-medium text-asphalt hover:bg-concrete"
        data-testid="player-speed"
      >
        {t('player.speedValue', { rate: String(rate) })}
      </button>
    </div>
  );
  if (!twoLanes) return player;
  return (
    <div className={cn('space-y-2', className)}>
      {player}
      <div
        role="group"
        aria-label={t('player.speakerFilter')}
        className="flex flex-wrap items-center gap-1.5"
        data-testid="speaker-filter"
      >
        <span className="eyebrow basis-full text-dust" aria-hidden="true">
          {t('player.speakerFilter')}
        </span>
        {SPEAKER_FILTERS.map((f) => {
          const on = filter === f;
          return (
            <button
              key={f}
              type="button"
              aria-pressed={on}
              onClick={() => ctx?.setFilter(clipId, f)}
              className={cn(
                'inline-flex h-target items-center gap-1 rounded-btn border px-2.5 text-caption',
                on
                  ? 'border-asphalt bg-concrete font-semibold text-asphalt'
                  : 'border-rebar text-asphalt hover:bg-concrete',
              )}
              data-filter={f}
            >
              {on ? <Check className="size-4" aria-hidden="true" /> : null}
              {t(`player.filter.${f}`)}
            </button>
          );
        })}
      </div>
    </div>
  );
}
