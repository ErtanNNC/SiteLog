import { formatAudioTimestamp, formatTimeInTz } from '@sitelog/shared/format.ts';
import type { Source } from '@sitelog/shared/schemas/report.ts';
import { copy } from '@/copy/en';
import { cn } from '@/lib/utils';
import { useVoicePlayer } from './VoicePlayer';

export interface SourceLinkProps {
  /** A §10.3 v2 source (stored v1 data is upgraded on read). */
  source: Source | undefined;
  /** For answer sources: when the answer came in, shown as "reply 17:41". */
  messageAt?: string | null;
  /** For an answer given in a message (an upgraded v1 reply): the message the link opens. */
  messageId?: string | null;
  timezone: string;
  editorName?: string | null;
  /**
   * The voice note the page's player holds (its upload or message id). A voice-note source of
   * another note (a spoken correction, F10) shows its second without seeking this player.
   */
  playerAudioId?: string | null;
  onOpenMessage?: (messageId: string) => void;
  onOpenHistory?: () => void;
  className?: string;
}

/** Mono "audio 0:41" → seeks the player + highlights the transcript segment; "reply 17:41"; "edited by Lena". */
export function SourceLink({
  source,
  messageAt,
  messageId,
  timezone,
  editorName,
  playerAudioId,
  onOpenMessage,
  onOpenHistory,
  className,
}: SourceLinkProps) {
  const player = useVoicePlayer();
  const base = cn(
    'inline-flex h-6 items-center rounded-chip px-1.5 font-mono text-[12px] font-medium text-level underline-offset-2 hover:bg-chip-review-bg hover:underline',
    className,
  );
  const plain = cn(base, 'text-dust hover:bg-transparent hover:no-underline');
  if (!source) return null;
  switch (source.type) {
    case 'voice_note': {
      const ts = formatAudioTimestamp(source.start);
      if (playerAudioId !== undefined && source.uploadId !== playerAudioId)
        return (
          <span className={plain} data-source="voice_note">
            {copy.source.audio(ts)}
          </span>
        );
      return (
        <button
          type="button"
          className={base}
          onClick={() => player?.seek(source.start)}
          aria-label={copy.source.seekTo(ts)}
          data-source="voice_note"
        >
          {copy.source.audio(ts)}
        </button>
      );
    }
    // Call recordings play in the panel from week 2 (M7): until then the second is shown only.
    case 'call':
      return (
        <span className={plain} data-source="call">
          {copy.source.call(formatAudioTimestamp(source.start))}
        </span>
      );
    case 'answer': {
      const t = messageAt ? formatTimeInTz(messageAt, timezone) : '';
      const label = copy.source.reply(t).trim();
      if (!messageId)
        return (
          <span className={plain} data-source="answer">
            {label}
          </span>
        );
      return (
        <button
          type="button"
          className={base}
          onClick={() => onOpenMessage?.(messageId)}
          aria-label={copy.source.openMessage}
          data-source="answer"
        >
          {label}
        </button>
      );
    }
    case 'office_edit':
      return (
        <button
          type="button"
          className={base}
          onClick={onOpenHistory}
          aria-label={copy.source.openHistory}
          data-source="office_edit"
        >
          {copy.source.editedBy(editorName ?? 'office')}
        </button>
      );
    case 'weather_api':
      return (
        <span className={plain} data-source="weather_api">
          {copy.source.weatherApi}
        </span>
      );
    default:
      return null;
  }
}
