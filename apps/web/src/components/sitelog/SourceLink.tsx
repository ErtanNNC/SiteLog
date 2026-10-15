import { formatAudioTimestamp, formatTimeInTz } from '@sitelog/shared/format.ts';
import type { Source } from '@sitelog/shared/schemas/report.ts';
import { useCopy } from '@/i18n/useCopy';
import { cn } from '@/lib/utils';
import { useMediaPlayer } from './MediaPlayer';

export interface SourceLinkProps {
  /** A §10.3 v2 source (stored v1 data is upgraded on read). */
  source: Source | undefined;
  /**
   * The clips the page plays (upload ids of voice notes, ids of calls). A source citing one of
   * them seeks it; a source of a clip the page does not hold shows its second only.
   */
  clipIds?: ReadonlySet<string>;
  /** For an answer: when it came in, shown as "answer 17:41". */
  answerAt?: string | null;
  /** An answer given in a WhatsApp reply (an upgraded v1 source): worded "reply 17:41". */
  isReply?: boolean;
  timezone: string;
  editorName?: string | null;
  /** Reveals the answer (its question id, or a v1 reply's message id) in the Activity timeline. */
  onShowAnswer?: (anchor: string) => void;
  onOpenHistory?: () => void;
  className?: string;
}

/**
 * §11.3 SourceLink: mono "audio 0:41" / "call 2:15" seek the clip they cite and play it (and
 * highlight the excerpt); "answer 17:41" reveals the answer in Activity; "edited by Lena" opens
 * the version history; "weather data" is plain text.
 */
export function SourceLink({
  source,
  clipIds,
  answerAt,
  isReply,
  timezone,
  editorName,
  onShowAnswer,
  onOpenHistory,
  className,
}: SourceLinkProps) {
  const { t } = useCopy();
  const player = useMediaPlayer();
  const base = cn(
    'inline-flex h-6 items-center rounded-chip px-1.5 font-mono text-[12px] font-medium text-level underline-offset-2 hover:bg-chip-review-bg hover:underline',
    className,
  );
  const plain = cn(base, 'text-dust hover:bg-transparent hover:no-underline');
  if (!source) return null;
  switch (source.type) {
    case 'voice_note':
    case 'call': {
      const ts = formatAudioTimestamp(source.start);
      const isCall = source.type === 'call';
      const clipId = isCall ? source.callId : source.uploadId;
      const label = t(isCall ? 'source.links.call' : 'source.links.audio', { ts });
      if (!player || (clipIds && !clipIds.has(clipId)))
        return (
          <span className={plain} data-source={source.type}>
            {label}
          </span>
        );
      return (
        <button
          type="button"
          className={base}
          onClick={() => player.seek(source.start, clipId)}
          aria-label={`${label} · ${t(isCall ? 'source.links.playCall' : 'source.links.playVoiceNote', { ts })}`}
          data-source={source.type}
        >
          {label}
        </button>
      );
    }
    case 'answer': {
      const time = answerAt ? formatTimeInTz(answerAt, timezone) : '';
      const label = t(isReply ? 'source.links.reply' : 'source.links.answer', { time }).trim();
      if (!onShowAnswer)
        return (
          <span className={plain} data-source="answer">
            {label}
          </span>
        );
      return (
        <button
          type="button"
          className={base}
          onClick={() => onShowAnswer(source.questionId)}
          aria-label={`${label} · ${t('source.links.showAnswer')}`}
          data-source="answer"
        >
          {label}
        </button>
      );
    }
    case 'office_edit': {
      const label = editorName
        ? t('source.links.editedBy', { name: editorName })
        : t('source.links.editedByOffice');
      return (
        <button
          type="button"
          className={base}
          onClick={onOpenHistory}
          aria-label={`${label} · ${t('source.links.openHistory')}`}
          data-source="office_edit"
        >
          {label}
        </button>
      );
    }
    case 'weather_api':
      return (
        <span className={plain} data-source="weather_api">
          {t('source.links.weather')}
        </span>
      );
    default:
      return null;
  }
}
