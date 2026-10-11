import { waCopy, type SiteRow } from '@sitelog/shared';
import type { Session } from '../session';
import { sendSitePicker } from './intake';

/** The one site a command applies to; multi-site reporters get the picker with the intent remembered. */
export async function singleSiteOrPicker(
  s: Session,
  intent: 'report' | 'no_work' | 'weather_day',
): Promise<SiteRow | null> {
  if (s.activeSites.length === 1) return s.activeSites[0]!;
  if (s.activeSites.length === 0) {
    if (s.pausedSites.length)
      await s.reply(waCopy.sitePaused(s.pausedSites[0]!.name), undefined, { kind: 'site_paused' });
    return null;
  }
  await sendSitePicker(s, [s.message.id], intent);
  return null;
}

export { sendSitePicker };
