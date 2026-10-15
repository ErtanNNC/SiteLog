import { Camera, CloudSun, Mic } from 'lucide-react';
import { formatAudioTimestamp } from '@sitelog/shared/format.ts';
import { copy } from '@/copy/en';
import type { DelayEvidence } from '@/data/types';
import { cn } from '@/lib/utils';
import { useMediaPlayer } from './MediaPlayer';

/**
 * Audio ts · Photos n · Weather data (green) and missing evidence as dashed red ("Photo requested"
 * when the site manager was asked for one, "No photo" for a report typed in the panel).
 */
export function EvidenceChips({
  evidence,
  className,
}: {
  evidence: DelayEvidence;
  className?: string;
}) {
  const player = useMediaPlayer();
  const chip =
    'inline-flex h-7 items-center gap-1 rounded-chip border px-2 font-mono text-[12px] font-medium [&_svg]:size-4';
  return (
    <div className={cn('flex flex-wrap gap-1.5', className)}>
      {evidence.audioStart !== null ? (
        <button
          type="button"
          className={cn(chip, 'border-rebar bg-chalk text-asphalt hover:border-iron')}
          onClick={() => player?.seek(evidence.audioStart!)}
          aria-label={copy.source.seekTo(formatAudioTimestamp(evidence.audioStart))}
        >
          <Mic aria-hidden="true" />
          {copy.evidence.audio(formatAudioTimestamp(evidence.audioStart))}
        </button>
      ) : (
        <span className={cn(chip, 'border-dashed border-missing text-missing')}>
          <Mic aria-hidden="true" />
          {copy.evidence.audioMissing}
        </span>
      )}
      {evidence.photos > 0 ? (
        <span className={cn(chip, 'border-rebar bg-chalk text-asphalt')}>
          <Camera aria-hidden="true" />
          {copy.evidence.photos(evidence.photos)}
        </span>
      ) : (
        <span className={cn(chip, 'border-dashed border-missing text-missing')}>
          <Camera aria-hidden="true" />
          {evidence.photoRequested ? copy.evidence.photoRequested : copy.evidence.photoMissing}
        </span>
      )}
      {evidence.weatherData ? (
        <span className={cn(chip, 'border-chip-filed-bg bg-chip-filed-bg text-chip-filed-fg')}>
          <CloudSun aria-hidden="true" />
          {copy.evidence.weatherData}
        </span>
      ) : (
        <span className={cn(chip, 'border-dashed border-missing text-missing')}>
          <CloudSun aria-hidden="true" />
          {copy.evidence.weatherMissing}
        </span>
      )}
    </div>
  );
}
