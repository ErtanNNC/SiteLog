import {
  addDays,
  type CountryPack,
  dailyLinkDue,
  dailyLinkInstant,
  deadlineInstant,
  DEFAULT_CALL_WINDOW,
  type DueStage,
  firstName,
  formatPhone,
  formatTimeInTz,
  isActiveReporterStatus,
  isoWeekday,
  isWeatherObserved,
  isWorkingDay,
  type JobPayloads,
  languageOf,
  type LadderSettings,
  ladderTimes,
  localDate,
  nextDueStage,
  noticeData,
  type NoticeData,
  OUTBOUND_CALL_POLICY,
  placesCalls,
  REMINDER_STAGE,
  reminderVars,
  remind,
  REMIND_POLICY_DEFAULTS,
  type RemindAction,
  type RemindKey,
  type RemindPolicy,
  type RemindStage,
  renderTemplateText,
  renderWeatherPhrase,
  SMS_WEATHER_PHRASES,
  type SiteDayStatus,
  type SiteDayWeather,
  templateButtons,
  type TemplateName,
  type UnitSystem,
  weatherPhrase,
  weatherSlotDue,
  windowEndAfter,
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
  /** §6.3 field channels (20261013000007): null = the column default. */
  daily_link_time?: string | null;
  /** W3-17: the org's switch for automated calls (M10's control); null = the default, true. */
  auto_call_enabled?: boolean | null;
  second_call_enabled?: boolean | null;
  call_window_start?: string | null;
  call_window_end?: string | null;
}

export interface OrgInput {
  id: string;
  timezone: string;
  billing_status: string | null;
  /** When the org entered past_due (from audit_log), null when unknown. */
  past_due_since: string | null;
  settings: OrgSettingsInput;
  /** `orgs.units`: the heads-up's weather phrase (W2-06); imperial when absent. */
  units?: UnitSystem;
  /** `orgs.is_demo` (W3-17): a demo org's calls ring the Demo phone (§19 Q132). */
  is_demo?: boolean;
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

/**
 * The office's panel notice when a day becomes `missing` (§13 "Report missing: ops + admin").
 * With reminders sent (W2-06), §13's wording: "{first} didn't answer {n} reminders"; with none
 * (the ladder skipped every reporter, or no reporter is linked), spec §19 Q55's wording, which
 * says only that nothing came in by the deadline.
 */
export function missingNotification(
  siteName: string,
  reporterFirstName: string | null,
  reminders = 0,
): {
  title: string;
  body: string;
  /** What the panel renders in the reader's language; title and body are the English fallback. */
  data: NoticeData;
} {
  const who = reporterFirstName ?? 'The site manager';
  const body =
    reminders > 0 && reporterFirstName
      ? `${who} didn’t answer ${reminders} reminder${reminders === 1 ? '' : 's'}.`
      : `${who} hasn’t sent today’s report, and the deadline has passed.`;
  return {
    title: `${siteName} — no report`,
    body,
    data: noticeData('missing_report', {
      site: siteName,
      first: reporterFirstName,
      ...(reminders > 0 ? { reminders } : {}),
    }),
  };
}

/**
 * The first name the missing notice names for a site: its primary reporter if active, else any
 * active reporter of the site, else null ("The site manager").
 */
export function siteReporterFirstName(
  siteId: string,
  links: readonly SiteReporterLink[],
  reporters: readonly ReporterRef[],
): string | null {
  const byId = new Map(reporters.map((r) => [r.id, r]));
  const candidates = links
    .filter((l) => l.site_id === siteId)
    .sort((a, b) => Number(b.is_primary) - Number(a.is_primary));
  for (const link of candidates) {
    const reporter = byId.get(link.reporter_id);
    if (reporter && isActiveReporterStatus(reporter.status)) return firstName(reporter.name);
  }
  return null;
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

/** A today site-day the tick marks `missing` (§7.1), with what its audit row needs. */
export interface MissingMark {
  siteDayId: string;
  siteId: string;
  orgId: string;
  from: SiteDayStatus;
  /** When the day became missing: the deadline plus the org's missing offset. */
  missingAt: Date;
}

/**
 * §7.1 `pending|reminded → missing`: a today site-day with no report whose deadline plus the org's
 * missing offset (`missing_offset_min`, default 90) has passed, while the org's missing step is on
 * and the date is one of its working days (a site-day a stray upload or STOP made on a Saturday is
 * never escalated; mark_site_day_missing() checks it again). The tick sets `reminder_stage` 4 and
 * `status 'missing'` (`siteDayPatchForStage(REMINDER_STAGE.missing)`), audits it and alerts the
 * office (the `missing_report` panel notice, `missingNotification`, and the `report_missing`
 * email). Paused reminders do not stop it (the step is office-facing).
 */
export function planMissing(input: {
  sites: readonly SiteInput[];
  orgs: ReadonlyMap<string, OrgInput>;
  todaysSiteDays: readonly SiteDayInput[];
  now: Date;
}): MissingMark[] {
  const siteById = new Map(input.sites.map((s) => [s.id, s]));
  const marks: MissingMark[] = [];
  for (const sd of input.todaysSiteDays) {
    if (!LADDER_STATUSES.includes(sd.status)) continue;
    if (sd.reminder_stage >= REMINDER_STAGE.missing) continue;
    const site = siteById.get(sd.site_id);
    const org = site ? input.orgs.get(site.org_id) : undefined;
    if (!site || !org) continue;
    if (!isWorkingDay(sd.date, org.settings.working_days)) continue;
    const ladder = ladderFromSettings(org.settings);
    if (ladder.missingEnabled === false) continue;
    const deadlineAt = new Date(sd.deadline_at);
    if (Number.isNaN(deadlineAt.getTime())) continue;
    const { missingAt } = ladderTimes(deadlineAt, ladder);
    if (input.now.getTime() < missingAt.getTime()) continue;
    marks.push({ siteDayId: sd.id, siteId: site.id, orgId: org.id, from: sd.status, missingAt });
  }
  return marks;
}

/** A job scheduler-tick queues (`planTickJobs`). The ladder's `send_template` is not one of them. */
export type PlannedJob =
  | {
      type: 'fetch_weather';
      payload: JobPayloads['fetch_weather'];
      dedupeKey: string;
      siteId: string;
      slot: string;
    }
  | {
      type: 'weekly_digest';
      payload: JobPayloads['weekly_digest'];
      dedupeKey: string;
      orgId: string;
      runKey: string;
    }
  | {
      type: 'retention_cleanup';
      payload: JobPayloads['retention_cleanup'];
      dedupeKey: string;
      day: string;
    };

export interface TickPlanInput {
  /** Active sites of orgs billing does not block. */
  sites: readonly SiteInput[];
  orgs: ReadonlyMap<string, OrgInput>;
  /** Today's site-days (site time) of those sites. */
  todaysSiteDays: readonly SiteDayInput[];
  now: Date;
  prevTick: Date | null;
  /** scheduler_state `weekly_digest_runs`: org id → the Monday its digest last ran for. */
  digestRuns: Readonly<Record<string, string>>;
  /** scheduler_state `retention_cleanup.lastRunDate`. */
  retentionLastRun: string | null;
}

/**
 * The jobs one tick queues after creating today's site-days (§4.2): the §10.10 weather snapshots
 * (12:00, 16:30, 23:30 site time) for sites with a site-day today, the §13 weekly digest per org,
 * and the nightly retention job. The reminder ladder is `planLadder`.
 */
export function planTickJobs(input: TickPlanInput): PlannedJob[] {
  const jobs: PlannedJob[] = [];
  const sitesWithToday = new Set(input.todaysSiteDays.map((sd) => sd.site_id));
  for (const site of input.sites) {
    if (!sitesWithToday.has(site.id)) continue;
    const slot = weatherSlotDue(input.prevTick, input.now, site.timezone);
    if (!slot) continue;
    const job = weatherJobFor(site, localDate(input.now, site.timezone), slot);
    if (job) jobs.push({ type: 'fetch_weather', ...job, siteId: site.id, slot });
  }
  for (const org of input.orgs.values()) {
    if (orgIsBlocked(org, input.now)) continue;
    const digest = weeklyDigestDue(org, input.digestRuns[org.id] ?? null, input.now);
    if (!digest) continue;
    jobs.push({
      type: 'weekly_digest',
      payload: { orgId: org.id, weekStart: digest.weekStart },
      dedupeKey: `weekly_digest:${org.id}:${digest.weekStart}`,
      orgId: org.id,
      runKey: digest.runKey,
    });
  }
  const retentionDay = retentionDue(input.retentionLastRun, input.now);
  if (retentionDay) {
    jobs.push({
      type: 'retention_cleanup',
      payload: {},
      dedupeKey: `retention:${retentionDay}`,
      day: retentionDay,
    });
  }
  return jobs;
}

// ── The reminder ladder (W2-06; spec §7.1, §7.4, F11) ────────────────────────────────────────────

/**
 * The owner parameters of the ladder (spec §19 Q76, Q77; decided 2026-10-16 as built): the
 * recommended defaults (`REMIND_POLICY_DEFAULTS`).
 */
export const LADDER_POLICY: RemindPolicy = REMIND_POLICY_DEFAULTS;

/** A reporter of a site, as the ladder reads them (`reporters`). */
export interface LadderReporter {
  id: string;
  org_id: string;
  name: string;
  status: string;
  contact_pref: 'link' | 'call';
  message_channel: 'sms' | 'whatsapp' | 'push' | null;
  locale: string;
  /** §19 Q129 (W3-17): "Don't call me today" until this instant. */
  no_calls_until?: string | null;
}

/** One reporter of a step and what `remind()` decided for them. */
export interface LadderTarget {
  reporter: LadderReporter;
  action: RemindAction;
}

/** One stage of one site-day to claim now (`claim_site_day_reminder()`). */
export interface LadderStep {
  siteDayId: string;
  siteId: string;
  orgId: string;
  date: string;
  stage: RemindStage;
  deadlineAt: Date;
  missingAt: Date;
  /** Every reporter of the site in its org, the primary first, with remind()'s answer. */
  targets: LadderTarget[];
  /**
   * When the quiet hours begin (§19 Q77 `skip`): a `notify` job still waiting then sends nothing.
   * null with `send`.
   */
  notAfter: Date | null;
  /** When R1 runs: `call_coming`'s "{time}" (§19 Q130). */
  reminder1At: Date;
  /**
   * W3-17 (§19 Q127): a call of this stage waiting for capacity gives up at this time (the
   * stage's time plus 30 minutes) and the stage's message goes instead.
   */
  callGiveUpAt: Date;
}

/**
 * The site's reporters in its org, the primary first, then the others (backups) in name order:
 * every one of them hears the ladder for that site (W2-06; one message per site, so a reporter of
 * two sites gets each site's, F14, and a phone in two orgs each org's, as two reporter rows).
 * A link to a reporter of another org is ignored.
 */
export function siteLadderReporters(
  site: Pick<SiteInput, 'id' | 'org_id'>,
  links: readonly SiteReporterLink[],
  reporters: ReadonlyMap<string, LadderReporter>,
): LadderReporter[] {
  return links
    .filter((l) => l.site_id === site.id)
    .flatMap((l) => {
      const r = reporters.get(l.reporter_id);
      return r && r.org_id === site.org_id ? [{ r, primary: l.is_primary }] : [];
    })
    .sort((a, b) => Number(b.primary) - Number(a.primary) || a.r.name.localeCompare(b.r.name))
    .map((x) => x.r);
}

export interface LadderPlanInput {
  /** Active sites of orgs billing does not block. */
  sites: readonly SiteInput[];
  orgs: ReadonlyMap<string, OrgInput>;
  /** Each org's country pack, by org id. */
  packs: ReadonlyMap<string, CountryPack>;
  todaysSiteDays: readonly SiteDayInput[];
  links: readonly SiteReporterLink[];
  reporters: ReadonlyMap<string, LadderReporter>;
  /** Site-days whose daily link stage is already claimed (its `site_day.reminder` audit row). */
  dailyLinkDone: ReadonlySet<string>;
  now: Date;
  /**
   * W3-17: the reporters holding their own `auto_call` consent (§19 Q131); only these are called.
   * Omitted: none.
   */
  autoCall?: ReadonlySet<string>;
  policy?: RemindPolicy;
}

/**
 * The ladder steps due now (§7.4): for each today site-day still waiting for a report (`pending`
 * or `reminded`), reminders not paused, on one of the org's working days, the daily link from
 * `daily_link_time` until R1 has run (once: `dailyLinkDone`), and the latest due stage among the
 * heads-up (weather observed), R1 and R2 (each once: `reminder_stage`; after an outage only the
 * latest; none once the missing step is due, which is `planMissing`'s). The claim RPC checks
 * every condition again in SQL, plus "no live report".
 */
export function planLadder(input: LadderPlanInput): LadderStep[] {
  const policy = input.policy ?? LADDER_POLICY;
  const siteById = new Map(input.sites.map((s) => [s.id, s]));
  const steps: LadderStep[] = [];
  for (const sd of input.todaysSiteDays) {
    if (!LADDER_STATUSES.includes(sd.status) || sd.reminders_paused) continue;
    const site = siteById.get(sd.site_id);
    const org = site ? input.orgs.get(site.org_id) : undefined;
    const pack = org ? input.packs.get(org.id) : undefined;
    if (!site || !org || !pack) continue;
    if (orgIsBlocked(org, input.now)) continue;
    if (!isWorkingDay(sd.date, org.settings.working_days)) continue;
    const deadlineAt = new Date(sd.deadline_at);
    if (Number.isNaN(deadlineAt.getTime())) continue;
    const ladder = ladderFromSettings(org.settings);
    const times = ladderTimes(deadlineAt, ladder);
    const weather = asSiteDayWeather(sd.weather);
    const s = org.settings;
    const callWindow = {
      start: s.call_window_start ?? DEFAULT_CALL_WINDOW.start,
      end: s.call_window_end ?? DEFAULT_CALL_WINDOW.end,
    };
    const reporters = siteLadderReporters(site, input.links, input.reporters);
    // W3-17 (§19 Q51, Q125, Q132): a pack with an outbound trunk here, or a demo org (console).
    const callsPlaced = placesCalls({ isDemo: org.is_demo === true }, pack);
    const stageAt: Record<RemindStage, Date> = {
      daily_link: times.reminder1At,
      heads_up: times.headsUpAt,
      reminder_1: times.reminder1At,
      reminder_2: times.reminder2At,
    };
    const step = (stage: RemindStage): LadderStep => ({
      siteDayId: sd.id,
      siteId: site.id,
      orgId: org.id,
      date: sd.date,
      stage,
      deadlineAt,
      missingAt: times.missingAt,
      targets: reporters.map((r) => ({
        reporter: r,
        action: remind(
          {
            status: r.status,
            contactPref: r.contact_pref,
            messageChannel: r.message_channel,
            // Only `auto_call` matters to remind() (§19 Q131), and only where calls are placed.
            consents: new Set(input.autoCall?.has(r.id) ? (['auto_call'] as const) : []),
            noCallsUntil: r.no_calls_until ?? null,
          },
          pack,
          stage,
          {
            now: input.now,
            tz: site.timezone,
            settings: {
              headsUpEnabled: s.heads_up_enabled,
              reminder1Enabled: s.reminder1_enabled,
              reminder2Enabled: s.reminder2_enabled,
              secondCallEnabled: s.second_call_enabled ?? true,
              autoCallEnabled: s.auto_call_enabled ?? true,
              callWindow,
            },
            weatherObserved: isWeatherObserved(weather),
            outboundTrunk: callsPlaced,
            r1At: times.reminder1At,
            policy,
          },
        ),
      })),
      notAfter:
        policy.quietHours === 'skip' ? windowEndAfter(input.now, site.timezone, callWindow) : null,
      reminder1At: times.reminder1At,
      callGiveUpAt: new Date(
        Math.max(stageAt[stage].getTime(), input.now.getTime()) +
          OUTBOUND_CALL_POLICY.giveUpAfterMin * 60_000,
      ),
    });

    const due = dueStage(sd, ladder, input.now);
    // Once the missing step is due the day is the office's: no text at all (planMissing).
    if (due?.stage === REMINDER_STAGE.missing) continue;
    if (
      !input.dailyLinkDone.has(sd.id) &&
      dailyLinkDue({
        now: input.now,
        dailyLinkAt: dailyLinkInstant(sd.date, s.daily_link_time ?? null, site.timezone),
        currentStage: sd.reminder_stage,
      })
    ) {
      steps.push(step('daily_link'));
    }
    if (due) steps.push(step(STAGE_NAMES[due.stage]));
  }
  return steps;
}

const STAGE_NAMES: Record<1 | 2 | 3, RemindStage> = {
  1: 'heads_up',
  2: 'reminder_1',
  3: 'reminder_2',
};

/** What a ladder message's variables are built from (W2-06). */
export interface LadderVarsInput {
  siteName: string;
  /** The reporter's daily link for the site and day (`ensureDailyLink`), for keys with `{link}`. */
  link: string | null;
  /** The pack's voice number (E.164) or null: `{number}` only when set (`renderSms` variants). */
  voiceNumber: string | null;
  deadlineAt: Date;
  missingAt: Date;
  /** When R1 runs (`call_coming`'s "{time}", W3-17); the deadline when not given. */
  reminder1At?: Date;
  tz: string;
  weather: SiteDayWeather | null;
  /** The reporter's locale (`reporters.locale`): the language of the weather phrase. */
  locale: string;
  units: UnitSystem;
}

/** The §9.2 variables of a ladder key (times are wall-clock at the site, "17:30"). */
export function ladderVars(key: RemindKey, i: LadderVarsInput): Record<string, string> {
  const number: Record<string, string> = i.voiceNumber
    ? { number: formatPhone(i.voiceNumber) }
    : {};
  const link = (): string => {
    if (!i.link) throw new Error(`ladder key ${key} needs a link`);
    return i.link;
  };
  switch (key) {
    case 'daily_link':
      return { site: i.siteName, link: link(), ...number };
    case 'call_coming':
      // §9.2: "I'll call you at {time} for today's report. Prefer to do it now? {link}" (§19 Q130).
      return { time: formatTimeInTz(i.reminder1At ?? i.deadlineAt, i.tz), link: link() };
    case 'weather_headsup': {
      const language = languageOf(i.locale);
      return {
        deadline: formatTimeInTz(i.deadlineAt, i.tz),
        weather_phrase: i.weather
          ? renderWeatherPhrase(i.weather, language, i.units)
          : SMS_WEATHER_PHRASES[language].fallback,
      };
    }
    case 'reminder_1':
      return { site: i.siteName, link: link() };
    case 'reminder_2':
      return { time: formatTimeInTz(i.missingAt, i.tz), link: link(), ...number };
  }
}

/** Whether a ladder key carries `{link}` (all but the heads-up). */
export function ladderKeyNeedsLink(key: RemindKey): boolean {
  return key !== 'weather_headsup';
}

/**
 * The claim's arguments for one step (`claim_site_day_reminder()`): a message per reporter whose
 * action is a message (with its variables from `varsFor`), a call per reporter whose action is a
 * call (W3-17: one `place_call` job each, which gives up waiting for capacity at the step's
 * `callGiveUpAt`, §19 Q127) with its message, if any (R2's), and every other reporter as skipped,
 * with remind()'s reason.
 */
export function claimArgs(
  step: LadderStep,
  varsFor: (target: LadderTarget, key: RemindKey) => Record<string, string>,
): {
  messages: Array<{ reporterId: string; key: RemindKey; vars: Record<string, string> }>;
  skipped: Array<{ reporterId: string; reason: string }>;
  calls: Array<{ reporterId: string; giveUpAt: string }>;
} {
  const messages: Array<{ reporterId: string; key: RemindKey; vars: Record<string, string> }> = [];
  const skipped: Array<{ reporterId: string; reason: string }> = [];
  const calls: Array<{ reporterId: string; giveUpAt: string }> = [];
  for (const t of step.targets) {
    const a = t.action;
    if (a.kind === 'message') {
      messages.push({ reporterId: t.reporter.id, key: a.key, vars: varsFor(t, a.key) });
    } else if (a.kind === 'call') {
      calls.push({ reporterId: t.reporter.id, giveUpAt: step.callGiveUpAt.toISOString() });
      if (a.message) {
        messages.push({ reporterId: t.reporter.id, key: a.message, vars: varsFor(t, a.message) });
      }
    } else {
      skipped.push({ reporterId: t.reporter.id, reason: a.reason });
    }
  }
  return { messages, skipped, calls };
}
