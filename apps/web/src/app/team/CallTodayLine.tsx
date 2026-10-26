import { formatTimeInTz } from '@sitelog/shared/format.ts';
import type { CallToday } from '@/data/types';
import type { CopyT } from '@/i18n/useCopy';

/**
 * W4-04 (F3, §19 Q230): the reporter's latest outbound call today in words ("Office call ·
 * Ringing · 17:46"), on Team's row and Site detail. Words only: never a colour or an icon alone.
 */
export function CallTodayLine({ call, tz, t }: { call: CallToday; tz: string; t: CopyT }) {
  return (
    <span className="text-caption text-dust" data-testid="call-today" data-progress={call.progress}>
      {t('team.callToday.line', {
        kind: t(call.byOffice ? 'team.callToday.office' : 'team.callToday.reminder'),
        progress: t(`team.callProgress.${call.progress}`),
        time: formatTimeInTz(call.at, tz),
      })}
    </span>
  );
}
