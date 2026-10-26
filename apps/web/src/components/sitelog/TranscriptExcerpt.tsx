import { formatAudioTimestamp } from '@sitelog/shared/format.ts';
import { useCopy } from '@/i18n/useCopy';
import { cn } from '@/lib/utils';
import { useClipActive, useMediaPlayer } from './MediaPlayer';

export interface TranscriptExcerptProps {
  /** The clip the excerpt is from (a voice note's upload, a call). */
  clipId?: string | null;
  kind?: 'voice_note' | 'call';
  start: number;
  end: number;
  quote: string;
  mapped?: string | null;
  /** A call excerpt's speaker (§11.3: assistant lines muted). */
  speaker?: 'reporter' | 'agent';
  className?: string;
}

/**
 * §11.3 TranscriptExcerpt: timestamp · speaker · original words (any language) · "→" the mapped
 * facts. The timestamp seeks the clip; the excerpt is highlighted while the player is inside it.
 */
export function TranscriptExcerpt({
  clipId = null,
  kind = 'voice_note',
  start,
  end,
  quote,
  mapped,
  speaker,
  className,
}: TranscriptExcerptProps) {
  const { t } = useCopy();
  const player = useMediaPlayer();
  const ts = formatAudioTimestamp(start);
  const active = useClipActive(clipId, start, end);
  const isCall = kind === 'call';
  return (
    <div
      className={cn(
        'rounded-card border px-3 py-2',
        active ? 'border-signal bg-signal-tint/50' : 'border-rebar bg-chalk',
        className,
      )}
      data-active={active || undefined}
      data-testid="transcript-excerpt"
    >
      <div className="flex items-center gap-2">
        <button
          type="button"
          className="inline-flex min-h-6 items-center font-mono text-[12px] font-medium text-level hover:underline"
          onClick={() => player?.seek(start, clipId ?? undefined)}
          aria-label={`${ts} · ${t(isCall ? 'source.links.playCall' : 'source.links.playVoiceNote', { ts })}`}
        >
          {ts}
        </button>
        {speaker ? (
          <span className="font-mono text-[11px] uppercase tracking-[0.08em] text-dust">
            {t(speaker === 'agent' ? 'report.transcript.agent' : 'report.transcript.reporter')}
          </span>
        ) : null}
      </div>
      <p
        className={cn(
          'mt-0.5 text-[15px] leading-[22px]',
          speaker === 'agent' ? 'text-dust' : 'text-asphalt',
        )}
      >
        “{quote}”
      </p>
      {mapped ? (
        <p className="mt-1 text-caption text-dust">
          <span aria-hidden="true">→ </span>
          {mapped}
        </p>
      ) : null}
    </div>
  );
}
