import { formatAudioTimestamp, formatTimeInTz } from '@sitelog/shared/format.ts';
import type { Source } from '@sitelog/shared/schemas/report.ts';
import { copy } from '@/copy/en';
import { cn } from '@/lib/utils';
import { useVoicePlayer } from './VoicePlayer';

export interface SourceLinkProps {
  source: Source | undefined;
  /** For reply/text sources: the message time, shown as "reply 17:41". */
  messageAt?: string | null;
  timezone: string;
  editorName?: string | null;
  onOpenMessage?: (messageId: string) => void;
  onOpenHistory?: () => void;
  className?: string;
}

/** Mono "audio 0:41" → seeks the player + highlights the transcript segment; "reply 17:41"; "edited by Lena". */
export function SourceLink({
  source,
  messageAt,
  timezone,
  editorName,
  onOpenMessage,
  onOpenHistory,
  className,
}: SourceLinkProps) {
  const player = useVoicePlayer();
  const base = cn(
    'inline-flex h-6 items-center rounded-chip px-1.5 font-mono text-[12px] font-medium text-level underline-offset-2 hover:bg-chip-review-bg hover:underline',
    className,
  );
  if (!source) return null;
  switch (source.type) {
    case 'audio': {
      const ts = formatAudioTimestamp(source.start);
      return (
        <button
          type="button"
          className={base}
          onClick={() => player?.seek(source.start)}
          aria-label={copy.source.seekTo(ts)}
          data-source="audio"
        >
          {copy.source.audio(ts)}
        </button>
      );
    }
    case 'reply':
    case 'text': {
      const t = messageAt ? formatTimeInTz(messageAt, timezone) : '';
      const label = source.type === 'reply' ? copy.source.reply(t) : copy.source.text(t);
      return (
        <button
          type="button"
          className={base}
          onClick={() => onOpenMessage?.(source.messageId)}
          aria-label={copy.source.openMessage}
          data-source={source.type}
        >
          {label.trim()}
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
        <span
          className={cn(base, 'text-dust hover:bg-transparent hover:no-underline')}
          data-source="weather_api"
        >
          {copy.source.weatherApi}
        </span>
      );
    default:
      return null;
  }
}
