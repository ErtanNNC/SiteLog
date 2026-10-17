import { Camera, CloudSun, Mic, Phone } from 'lucide-react';
import { Link } from 'react-router';
import { formatAudioTimestamp } from '@sitelog/shared/format.ts';
import type { DelayEvidence } from '@/data/types';
import { useCopy } from '@/i18n/useCopy';
import { cn } from '@/lib/utils';

/** P7 at the cited second: `/reports/:id?clip=<voice note or call>&at=<s>` (W3-06). */
function delayEvidenceHref(reportId: string, evidence: DelayEvidence): string {
  const base = `/reports/${reportId}`;
  if (!evidence.clipId) return base;
  const q = new URLSearchParams({ clip: evidence.clipId });
  if (evidence.audioStart !== null) q.set('at', String(Math.floor(evidence.audioStart)));
  return `${base}?${q.toString()}`;
}

/**
 * P9 / F20 evidence chips: *Voice note ts* or *Call ts* (opening the report's player at that
 * second), Photos n, Weather data (green), and missing evidence as dashed red ("Photo requested"
 * when the site manager was asked for one, "No photo" for a report typed in the panel). In the
 * panel's language (W3-07).
 */
export function EvidenceChips({
  evidence,
  reportId,
  reportNo,
  className,
}: {
  evidence: DelayEvidence;
  reportId: string;
  reportNo: string;
  className?: string;
}) {
  const { t } = useCopy();
  const chip =
    'inline-flex min-h-7 items-center gap-1 rounded-chip border px-2 font-mono text-[12px] font-medium [&_svg]:size-4';
  const ts = evidence.audioStart !== null ? formatAudioTimestamp(evidence.audioStart) : null;
  const isCall = evidence.clip === 'call';
  const VoiceIcon = isCall ? Phone : Mic;
  return (
    <div className={cn('flex flex-wrap gap-1.5', className)}>
      {evidence.clip !== null && ts !== null ? (
        <Link
          to={delayEvidenceHref(reportId, evidence)}
          className={cn(
            chip,
            'border-rebar bg-chalk text-asphalt hover:border-iron focus-visible:outline-2 focus-visible:outline-offset-2',
            // §19 Q146: the 28 px chip keeps its look, its hit area is 44 px (as SourceLink's).
            'relative before:absolute before:inset-x-0 before:top-1/2 before:h-target before:-translate-y-1/2',
          )}
          aria-label={t(isCall ? 'evidence.openCall' : 'evidence.openVoiceNote', {
            no: reportNo,
            ts,
          })}
          data-testid="evidence-voice"
        >
          <VoiceIcon aria-hidden="true" />
          {t(isCall ? 'evidence.call' : 'evidence.voiceNote', { ts })}
        </Link>
      ) : (
        <span className={cn(chip, 'border-dashed border-missing text-missing')}>
          <Mic aria-hidden="true" />
          {t('evidence.audioMissing')}
        </span>
      )}
      {evidence.photos > 0 ? (
        <span className={cn(chip, 'border-rebar bg-chalk text-asphalt')}>
          <Camera aria-hidden="true" />
          {t('evidence.photos', { count: evidence.photos })}
        </span>
      ) : (
        <span className={cn(chip, 'border-dashed border-missing text-missing')}>
          <Camera aria-hidden="true" />
          {evidence.photoRequested ? t('evidence.photoRequested') : t('evidence.photoMissing')}
        </span>
      )}
      {evidence.weatherData ? (
        <span className={cn(chip, 'border-chip-filed-bg bg-chip-filed-bg text-chip-filed-fg')}>
          <CloudSun aria-hidden="true" />
          {t('evidence.weatherData')}
        </span>
      ) : (
        <span className={cn(chip, 'border-dashed border-missing text-missing')}>
          <CloudSun aria-hidden="true" />
          {t('evidence.weatherMissing')}
        </span>
      )}
    </div>
  );
}
