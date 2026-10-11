import { deadlineInstant, localDate, waCopy, type SiteRow } from '@sitelog/shared';
import { deadlineFor, workingDaysOf, type Session } from '../session';

/** §7.2 global commands: help · stop · language <code> (no work / edit live in dayoff.ts and edit.ts). */

export async function handleHelp(s: Session): Promise<void> {
  await s.reply(waCopy.help(), undefined, { kind: 'help' });
}

const LANGUAGE_NAMES: Record<string, string> = {
  en: 'English',
  es: 'Spanish',
  pl: 'Polish',
  hi: 'Hindi',
  pt: 'Portuguese',
  fr: 'French',
};

export async function handleLanguage(s: Session, code: string): Promise<void> {
  const lang = code.toLowerCase().slice(0, 2);
  await s.setState(null, { language: lang });
  await s.reply(waCopy.languageAck(LANGUAGE_NAMES[lang] ?? lang), undefined, { kind: 'language' });
}

/** "stop" pauses the rest of today's reminder ladder for the reporter's sites (§F9). */
export async function handleStop(s: Session): Promise<void> {
  const { ctx } = s;
  const sites = s.activeSites.length ? s.activeSites : s.sites;
  for (const site of sites) {
    const settings = await ctx.db.getOrgSettings(site.org_id);
    if (!settings) continue;
    const date = localDate(s.now, site.timezone);
    const siteDay = await ctx.db.getOrCreateSiteDay(
      site.id,
      date,
      deadlineInstant(date, deadlineFor(site, settings), site.timezone),
    );
    if (!siteDay.reminders_paused) {
      await ctx.db.updateSiteDay(siteDay.id, { reminders_paused: true });
      await ctx.db.logAudit({
        org_id: site.org_id,
        actor_type: 'reporter',
        actor_id: s.reporter.id,
        action: 'site_day.reminders_paused',
        entity: 'site_day',
        entity_id: siteDay.id,
        diff: { message_id: s.message.id },
      });
    }
  }
  await s.reply(waCopy.stopAck(), undefined, { kind: 'stop' });
}

/** The single site a command applies to, or null when the reporter must pick one. */
export function singleSite(s: Session): SiteRow | null {
  if (s.activeSites.length === 1) return s.activeSites[0]!;
  const last = s.context.last_site_id
    ? s.activeSites.find((x) => x.id === s.context.last_site_id)
    : undefined;
  if (last && s.activeSites.length > 1) return null;
  return last ?? null;
}

export function todayFor(s: Session, site: SiteRow): string {
  return localDate(s.now, site.timezone);
}

export { workingDaysOf };
