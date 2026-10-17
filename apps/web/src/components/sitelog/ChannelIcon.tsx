import { Keyboard, Link2, Phone, type LucideIcon } from 'lucide-react';
import type { OverviewChannel } from '@/data/types';
import { useCopy } from '@/i18n/useCopy';
import { cn } from '@/lib/utils';

const ICONS: Record<OverviewChannel, LucideIcon> = {
  link: Link2,
  call: Phone,
  office: Keyboard,
};

export interface ChannelIconProps {
  channel: OverviewChannel;
  /** true: how the report came in ("Reported by call"); false: how the person reports. */
  reported?: boolean;
  /** The short visible label ("Link", "Call"); off for an icon-only use (W1-17's archive). */
  showLabel?: boolean;
  className?: string;
}

/**
 * §11.3 `ChannelIcon` (W1-16, D35): a text link or a call, with the meaning in words for screen
 * readers ("Reported by text link" / "Reported by call"); a report typed in the panel shows as
 * "Typed". The Web-Overview artboard has no channel column; the spec (P3, F17) adds one.
 */
export function ChannelIcon({
  channel,
  reported = true,
  showLabel = true,
  className,
}: ChannelIconProps) {
  const { t } = useCopy();
  const Icon = ICONS[channel];
  const meaning = t(reported ? `channel.reported.${channel}` : `channel.prefers.${channel}`);
  return (
    <span
      // `relative`: the sr-only text is positioned inside the icon, so in a table that scrolls
      // sideways it never widens the page (no sideways scroll at 320–390 px).
      className={cn(
        'relative inline-flex items-center gap-1.5 whitespace-nowrap text-caption',
        className,
      )}
      title={meaning}
      data-channel={channel}
    >
      <Icon className="size-4 shrink-0 stroke-2 text-dust" aria-hidden="true" />
      {showLabel ? <span aria-hidden="true">{t(`channel.${channel}`)}</span> : null}
      <span className="sr-only">{meaning}</span>
    </span>
  );
}
