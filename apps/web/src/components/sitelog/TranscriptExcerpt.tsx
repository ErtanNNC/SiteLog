import { formatAudioTimestamp } from '@sitelog/shared/format.ts';
import { copy } from '@/copy/en';
import { cn } from '@/lib/utils';
import { useVoicePlayer } from './VoicePlayer';

export interface TranscriptExcerptProps {
  start: number;
  end: number;
  quote: string;
  mapped?: string | null;
  className?: string;
}

/** Timestamp · original quote (any language) · "→" the mapped English facts. Highlights while the player is inside it. */
export function TranscriptExcerpt({
  start,
  end,
  quote,
  mapped,
  className,
}: TranscriptExcerptProps) {
  const player = useVoicePlayer();
  const ts = formatAudioTimestamp(start);
  const active = player
    ? (player.highlight !== null && player.highlight >= start && player.highlight < end) ||
      (player.currentTime > 0 && player.currentTime >= start && player.currentTime < end)
    : false;
  return (
    <div
      className={cn(
        'rounded-card border px-3 py-2',
        active ? 'border-signal bg-signal-tint/50' : 'border-rebar bg-chalk',
        className,
      )}
      data-active={active || undefined}
    >
      <button
        type="button"
        className="font-mono text-[12px] font-medium text-level hover:underline"
        onClick={() => player?.seek(start)}
        aria-label={copy.source.seekTo(ts)}
      >
        {ts}
      </button>
      <p className="mt-0.5 text-[15px] leading-[22px] text-asphalt">“{quote}”</p>
      {mapped ? (
        <p className="mt-1 text-caption text-dust">
          <span aria-hidden="true">→ </span>
          {mapped}
        </p>
      ) : null}
    </div>
  );
}
