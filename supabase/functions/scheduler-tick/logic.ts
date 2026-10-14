import {
  addDays,
  deadlineInstant,
  firstName,
  isActiveReporterStatus,
  isoWeekday,
  isWeatherObserved,
  isWorkingDay,
  ladderTimes,
  localDate,
  nextDueStage,
  REMINDER_STAGE,
  reminderVars,
  renderTemplateText,
  templateButtons,
  weatherPhrase,
  type DueStage,
  type JobPayloads,
  type LadderSettings,
  type SiteDayStatus,
  type SiteDayWeather,
  type TemplateName,
} from '@sitelog/shared';
import { isBillingBlocked } from '../_shared/billing.ts';

/**
 * Pure decisions of the scheduler tick (§7.1, §7.4, §F9, §10.10, §13). Everything here works on
 * plain inputs so index.ts only does I/O. Times are UTC instants; wall-clock → instant goes through
 * the site/org time zone (DST-safe via date-fns-tz in the shared package).
 */

export interface OrgSettingsInput {
  default_deadline: string;
  working_days: readonly number[];
  heads_up_enabled: boolean;
  heads_up_offset_min: number;
  reminder1_enabled: boolean;
  reminder1_offset_min: number;
  reminder2_enabled: boolean;
  reminder2_offset_min: number;
  missing_enabled: boolean;
  missing_offset_min: number;
  past_due_grace_days: number;
}

export interface OrgInput {
  id: string;
  timezone: string;
  billing_status: string | null;
  /** When the org entered past_due (from audit_log), null when unknown. */
  past_due_since: string | null;
  settings: OrgSettingsInput;
}

export interface SiteInput {
  id: string;
  org_id: string;
  name: string;
  timezone: string;
  deadline: string | null;
  lat: number | null;
  lng: number | null;
}

export interface SiteDayInput {
  id: string;
  site_id: string;
  date: string;
  status: SiteDayStatus;
  deadline_at: string;
  reminder_stage: number;
  reminders_paused: boolean;
  weather: unknown;
}

export function ladderFromSettings(s: OrgSettingsInput): LadderSettings {
  return {
    headsUpEnabled: s.heads_up_enabled,
    headsUpOffsetMin: s.heads_up_offset_min,
    reminder1Enabled: s.reminder1_enabled,
    reminder1OffsetMin: s.reminder1_offset_min,
    reminder2Enabled: s.reminder2_enabled,
    reminder2OffsetMin: s.reminder2_offset_min,
    missingEnabled: s.missing_enabled,
    missingOffsetMin: s.missing_offset_min,
  };
}

/** §F19 step 5 — blocked orgs get no site-days, reminders or weather fetches. */
export function orgIsBlocked(org: OrgInput, now: Date): boolean {
  return isBillingBlocked(
    { billingStatus: org.billing_status, pastDueSince: org.past_due_since },
    now,
    org.settings.past_due_grace_days,
  );
}

export interface SiteDayPlan {
  site_id: string;
  date: string;
  deadline_at: string;
}

/** Today's site-day for a site (site time zone), or null on non-working days (§7.4). */
export function planSiteDay(
  site: SiteInput,
  settings: OrgSettingsInput,
  now: Date,
): SiteDayPlan | null {
  const date = localDate(now, site.timezone);
  if (!isWorkingDay(date, settings.working_days)) return null;
  const deadline = site.deadline ?? settings.default_deadline;
  return {
    site_id: site.id,
    date,
    deadline_at: deadlineInstant(date, deadline, site.timezone).toISOString(),
  };
}

/**
 * Only site-days still waiting for a report walk the ladder (§7.1: pending → reminded → missing).
 * `processing` means a report is in flight, `filed`/`weather_day`/`no_work`/`missing` are terminal
 * for the ladder.
 */
export const LADDER_STATUSES: readonly SiteDayStatus[] = ['pending', 'reminded'];

export function asSiteDayWeather(value: unknown): SiteDayWeather | null {
  if (!value || typeof value !== 'object') return null;
  const w = value as Partial<SiteDayWeather>;
  const s = w.summary;
  if (
    !s ||
    typeof s !== 'object' ||
    typeof s.precipWorkingHoursIn !== 'number' ||
    typeof s.maxGustWorkingHoursMph !== 'number' ||
    !Array.isArray(w.hours)
  ) {
    return null;
  }
  return value as SiteDayWeather;
}

/** The ladder stage to run now for a site-day, or null. Each stage fires at most once. */
export function dueStage(sd: SiteDayInput, ladder: LadderSettings, now: Date): DueStage | null {
  if (!LADDER_STATUSES.includes(sd.status)) return null;
  const deadlineAt = new Date(sd.deadline_at);
  if (Number.isNaN(deadlineAt.getTime())) return null;
  return nextDueStage({
    now,
    deadlineAt,
    currentStage: sd.reminder_stage,
    settings: ladder,
    weatherObserved: isWeatherObserved(asSiteDayWeather(sd.weather)),
    remindersPaused: sd.reminders_paused,
  });
}

export type MessageStage = 1 | 2 | 3;

export const STAGE_TEMPLATES: Record<MessageStage, TemplateName> = {
  1: 'sitelog_weather_headsup',
  2: 'sitelog_reminder_1',
  3: 'sitelog_reminder_2',
};

export interface ReminderContext {
  siteDayId: string;
  conversationId: string;
  firstName: string;
  siteName: string;
  deadlineAt: Date;
  tz: string;
  ladder: LadderSettings;
  weather: SiteDayWeather | null;
}

export interface ReminderJob {
  payload: JobPayloads['send_template'];
  dedupeKey: string;
}

/** `send_template` job for stages 1–3 (§9.2 variables, §9.4 button ids). */
export function reminderJob(stage: MessageStage, ctx: ReminderContext): ReminderJob {
  const template = STAGE_TEMPLATES[stage];
  const { missingAt } = ladderTimes(ctx.deadlineAt, ctx.ladder);
  const vars = reminderVars(stage, {
    firstName: ctx.firstName,
    siteName: ctx.siteName,
    deadlineAt: ctx.deadlineAt,
    missingAt,
    tz: ctx.tz,
    weatherPhrase: ctx.weather ? weatherPhrase(ctx.weather) : undefined,
  });
  return {
    payload: {
      conversationId: ctx.conversationId,
      template,
      vars: Object.fromEntries(vars.map((value, i) => [String(i + 1), value])),
      freeFormText: renderTemplateText(template, vars),
      buttons: templateButtons(template, { siteDayId: ctx.siteDayId }),
      siteDayId: ctx.siteDayId,
      stage,
    },
    dedupeKey: `reminder:${ctx.siteDayId}:${stage}`,
  };
}

export interface SiteDayStagePatch {
  reminder_stage: number;
  status?: 'reminded' | 'missing';
}

/** §F9 table: R1/R2 move the site-day to `reminded`, the missing stage to `missing`. */
export function siteDayPatchForStage(stage: DueStage['stage']): SiteDayStagePatch {
  if (stage === REMINDER_STAGE.missing) return { reminder_stage: stage, status: 'missing' };
  if (stage >= REMINDER_STAGE.reminder1) return { reminder_stage: stage, status: 'reminded' };
  return { reminder_stage: stage };
}

export function missingNotification(
  siteName: string,
  reporterFirstName: string | null,
): {
  title: string;
  body: string;
} {
  return {
    title: `${siteName} — no report`,
    body: `${reporterFirstName ?? 'The site manager'} didn’t answer 2 reminders.`,
  };
}

export interface SiteReporterLink {
  site_id: string;
  reporter_id: string;
  is_primary: boolean;
}

export interface ReporterRef {
  id: string;
  name: string;
  status: string;
}

export interface ConversationRef {
  id: string;
  reporter_id: string | null;
}

export interface ReminderTarget {
  conversationId: string;
  reporterId: string;
  firstName: string;
}

/** The primary verified reporter with a conversation, else any verified linked reporter. */
export function pickReminderTarget(
  siteId: string,
  links: readonly SiteReporterLink[],
  reporters: readonly ReporterRef[],
  conversations: readonly ConversationRef[],
): ReminderTarget | null {
  const reporterById = new Map(reporters.map((r) => [r.id, r]));
  const conversationByReporter = new Map<string, string>();
  for (const c of conversations) if (c.reporter_id) conversationByReporter.set(c.reporter_id, c.id);
  const candidates = links
    .filter((l) => l.site_id === siteId)
    .sort((a, b) => Number(b.is_primary) - Number(a.is_primary));
  for (const link of candidates) {
    const reporter = reporterById.get(link.reporter_id);
    const conversationId = conversationByReporter.get(link.reporter_id);
    if (reporter && isActiveReporterStatus(reporter.status) && conversationId) {
      return { conversationId, reporterId: reporter.id, firstName: firstName(reporter.name) };
    }
  }
  return null;
}

export interface WeatherJob {
  payload: JobPayloads['fetch_weather'];
  dedupeKey: string;
}

/** §10.10 — one `fetch_weather` per site, date and slot; sites without coordinates are skipped. */
export function weatherJobFor(site: SiteInput, date: string, slot: string): WeatherJob | null {
  if (site.lat === null || site.lng === null) return null;
  return { payload: { siteId: site.id, date }, dedupeKey: `weather:${site.id}:${date}:${slot}` };
}

export function mondayOf(date: string): string {
  return addDays(date, 1 - isoWeekday(date));
}

export interface DigestDue {
  /** Monday of the completed week the digest covers. */
  weekStart: string;
  /** Monday of the current week; stored so the digest runs once per week. */
  runKey: string;
}

/**
 * §13 weekly digest: due from Monday 07:00 org time for the week that just ended, once per week.
 * A tick later in the week (after an outage) still sends it; the following Monday starts afresh.
 */
export function weeklyDigestDue(
  org: { timezone: string },
  lastRunKey: string | null,
  now: Date,
): DigestDue | null {
  const thisMonday = mondayOf(localDate(now, org.timezone));
  if (lastRunKey === thisMonday) return null;
  if (now.getTime() < deadlineInstant(thisMonday, '07:00', org.timezone).getTime()) return null;
  return { weekStart: addDays(thisMonday, -7), runKey: thisMonday };
}

/** §15 privacy — nightly retention job from 03:00 UTC, once per UTC day. Returns the day key to store. */
export function retentionDue(lastRunDate: string | null, now: Date): string | null {
  const today = now.toISOString().slice(0, 10);
  if (lastRunDate === today) return null;
  if (now.getUTCHours() < 3) return null;
  return today;
}
