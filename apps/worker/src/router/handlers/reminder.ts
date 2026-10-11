import { localDate, waCopy } from '@sitelog/shared';
import type { Session } from '../session';
import { logNoWork, logWeatherDay } from './dayoff';
import { sendSitePicker, singleSiteOrPicker } from './site-select';

/** §F9 button handlers: Recording now · No work today · Site closed: weather. */
export async function handleReminderButton(s: Session, siteDayId: string, action: 'recording' | 'no_work' | 'weather'): Promise<void> {
  const { ctx } = s;
  if (action === 'recording') {
    await s.reply(waCopy.recordingAck(), undefined, { kind: 'recording_ack' });
    return;
  }
  const siteDay = siteDayId !== 'unknown' ? await ctx.db.getSiteDay(siteDayId) : null;
  const site = siteDay ? (s.siteById(siteDay.site_id) ?? (await ctx.db.getSite(siteDay.site_id))) : await singleSiteOrPicker(s, action === 'no_work' ? 'no_work' : 'weather_day');
  if (!site) return;
  const date = siteDay?.date ?? localDate(s.now, site.timezone);
  if (action === 'no_work') {
    await logNoWork(s, site, date);
  } else {
    await logWeatherDay(s, site, date, null, s.message.id);
  }
}

export { sendSitePicker };
