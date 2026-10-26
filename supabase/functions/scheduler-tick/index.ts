import {
  type CountryPack,
  type CountryRow,
  dailyLinkExpiresAt,
  ensureDailyLink,
  fieldLinkUrl,
  type Json,
  localDate,
  type NoticeData,
  toCountryPack,
} from '@sitelog/shared';
import { logAudit } from '../_shared/audit.ts';
import { supabaseDailyLinkStore } from '../_shared/daily_links.ts';
import { optionalEnv, requireEnv } from '../_shared/env.ts';
import {
  bearerToken,
  error,
  HttpError,
  json,
  requireMethod,
  timingSafeEqual,
  withHandler,
} from '../_shared/http.ts';
import { enqueueJob } from '../_shared/jobs.ts';
import { logError, logInfo, logWarn } from '../_shared/log.ts';
import { adminClient, type AppClient, fetchAll } from '../_shared/supabase.ts';
import {
  asSiteDayWeather,
  claimArgs,
  type LadderReporter,
  type LadderStep,
  ladderKeyNeedsLink,
  ladderVars,
  missingNotification,
  type OrgInput,
  orgIsBlocked,
  planLadder,
  planMissing,
  planSiteDay,
  planTickJobs,
  type SiteDayInput,
  type SiteDayPlan,
  type SiteInput,
  type SiteReporterLink,
  siteReporterFirstName,
} from './logic.ts';

/**
 * scheduler-tick (§4.2, §7.4, F11, §10.10, §13) — called every 5 minutes by pg_cron (migration
 * 0006) with `Authorization: Bearer ${SCHEDULER_SECRET}`. Creates today's site-days, runs the
 * reminder ladder (W2-06: the daily link, the weather heads-up, R1 and R2 for every reporter of a
 * site still waiting for a report, each stage claimed with its `notify` jobs in one transaction by
 * claim_site_day_reminder(), through the Notifier on each reporter's channel order), marks a day
 * past its deadline plus the missing offset `missing` (§7.1) and alerts the office (panel notice
 * and email, naming the reminders sent), and schedules weather fetches, the weekly digest and the
 * nightly retention job; billing-blocked orgs are skipped. Decisions live in logic.ts; this file
 * only does I/O. Env: SCHEDULER_SECRET, LINK_SIGNING_SECRET and FIELD_APP_URL (the daily links),
 * DAILY_LINK_TTL_HOURS (default 72).
 */

export interface TickResult {
  ok: boolean;
  sitesChecked: number;
  siteDaysCreated: number;
  /** Ladder stages claimed by this tick (W2-06). */
  ladderStages: number;
  /** `notify` jobs those stages queued. */
  ladderMessages: number;
  /** Site-days marked `missing` (§7.1) by this tick. */
  missing: number;
  weatherJobs: number;
  digests: number;
  retention: boolean;
  errors: number;
}

const STATE = {
  lastTick: 'last_tick',
  digests: 'weekly_digest_runs',
  retention: 'retention_cleanup',
} as const;

Deno.serve(
  withHandler('scheduler-tick', async (req) => {
    requireMethod(req, 'POST', 'GET');
    const token = bearerToken(req);
    if (!token || !timingSafeEqual(token, requireEnv('SCHEDULER_SECRET'))) {
      return error(req, 401, 'Unauthorized');
    }
    const result = await runTick(adminClient(), tickClock(req));
    return json(req, result);
  }),
);

/**
 * The tick's clock: the real time, or `?now=<ISO instant>` when this environment sets
 * SCHEDULER_CLOCK_OVERRIDE=true. Only the local stack and CI set it (the `e2e:supabase` ladder
 * spec moves the clock to 17:46 and 18:31 site time); a hosted project never does (RUNBOOK), and
 * the call still needs SCHEDULER_SECRET.
 */
function tickClock(req: Request): Date {
  if (optionalEnv('SCHEDULER_CLOCK_OVERRIDE') !== 'true') return new Date();
  const param = new URL(req.url).searchParams.get('now');
  if (!param) return new Date();
  const at = new Date(param);
  if (Number.isNaN(at.getTime())) throw new HttpError(400, 'now must be an ISO instant');
  return at;
}

async function runTick(admin: AppClient, now: Date): Promise<TickResult> {
  const result: TickResult = {
    ok: true,
    sitesChecked: 0,
    siteDaysCreated: 0,
    ladderStages: 0,
    ladderMessages: 0,
    missing: 0,
    weatherJobs: 0,
    digests: 0,
    retention: false,
    errors: 0,
  };
  const state = await loadState(admin);
  const prevTick = parseInstant(stringField(state.get(STATE.lastTick), 'at'));

  // 1. Orgs, settings, billing.
  const orgs = await loadOrgs(admin);

  // 2. Active sites of orgs that are not blocked by billing.
  const siteRows = await fetchAll((from, to) =>
    admin
      .from('sites')
      .select('id, org_id, name, timezone, deadline, lat, lng')
      .eq('status', 'active')
      .order('id')
      .range(from, to)
      .throwOnError(),
  );
  const sites: SiteInput[] = siteRows.filter((s) => {
    const org = orgs.get(s.org_id);
    return org !== undefined && !orgIsBlocked(org, now);
  });
  const siteById = new Map(sites.map((s) => [s.id, s]));
  result.sitesChecked = sites.length;

  // 3. Today's site-days (working days only).
  const plans: SiteDayPlan[] = [];
  const todays = new Set<string>();
  for (const site of sites) {
    const org = orgs.get(site.org_id);
    if (!org) continue;
    todays.add(localDate(now, site.timezone));
    const plan = planSiteDay(site, org.settings, now);
    if (plan) plans.push(plan);
  }
  if (plans.length > 0) {
    const { data: created } = await admin
      .from('site_days')
      .upsert(plans, { onConflict: 'site_id,date', ignoreDuplicates: true })
      .select('id')
      .throwOnError();
    result.siteDaysCreated = created.length;
  }
  const siteDayRows =
    todays.size > 0
      ? await fetchAll((from, to) =>
          admin
            .from('site_days')
            .select(
              'id, site_id, date, status, deadline_at, reminder_stage, reminders_paused, weather',
            )
            .in('date', [...todays])
            .order('id')
            .range(from, to)
            .throwOnError(),
        )
      : [];
  const todaysSiteDays: SiteDayInput[] = siteDayRows.filter((sd) => {
    const site = siteById.get(sd.site_id);
    return site !== undefined && sd.date === localDate(now, site.timezone);
  });

  // 4. The reminder ladder (W2-06): each due stage claimed with its notify jobs in one
  //    transaction (claim_site_day_reminder), so a filing or an upload racing the tick wins.
  try {
    const ladder = await runLadder(admin, { sites, orgs, todaysSiteDays, now });
    result.ladderStages = ladder.stages;
    result.ladderMessages = ladder.messages;
    result.errors += ladder.errors;
  } catch (err) {
    result.errors += 1;
    logError('scheduler.ladder.failed', err, {});
  }

  // 5. The §7.1 status step: a day past its deadline plus the missing offset becomes `missing`
  //    (the panel's Overview and Reports read it), audited; the office gets the `missing_report`
  //    notice and the `report_missing` email, naming the reminders that went out (§13; none:
  //    spec §19 Q55's wording).
  const marks = planMissing({ sites, orgs, todaysSiteDays, now });
  const reporterNames = await loadReporterNames(
    admin,
    marks.map((m) => m.siteId),
  ).catch((err) => {
    // The notice then says "The site manager"; the status step and the alerts still run.
    logError('scheduler.missing.reporters_failed', err, {});
    return new Map<string, string>();
  });
  const remindersSent = await loadRemindersSent(
    admin,
    marks.map((m) => m.siteDayId),
  ).catch((err) => {
    // The notice then uses Q55's wording; the status step and the alerts still run.
    logError('scheduler.missing.reminders_failed', err, {});
    return new Map<string, number>();
  });
  for (const mark of marks) {
    try {
      const reminders = remindersSent.get(mark.siteDayId) ?? 0;
      const note = missingNotification(
        siteById.get(mark.siteId)?.name ?? 'A site',
        reporterNames.get(mark.siteId) ?? null,
        reminders,
      );
      // The status change, its audit, the notice and the email job commit together; the guarded
      // update inside is the claim, so only the call that made the day missing alerts, and a
      // failure commits nothing and the next tick retries (spec §19 Q55, 20261015000061).
      if (!(await markMissing(admin, mark.siteDayId, mark.missingAt, note, reminders))) continue;
      result.missing += 1;
      logInfo('scheduler.missing', {
        siteId: mark.siteId,
        siteDayId: mark.siteDayId,
        orgId: mark.orgId,
      });
    } catch (err) {
      result.errors += 1;
      logError('scheduler.missing.failed', err, { siteId: mark.siteId, siteDayId: mark.siteDayId });
    }
  }
  // 6–8. Weather snapshots, the weekly digest and the nightly retention job (logic.ts planTickJobs).
  const digestRuns = stringRecord(state.get(STATE.digests));
  const planned = planTickJobs({
    sites,
    orgs,
    todaysSiteDays,
    now,
    prevTick,
    digestRuns,
    retentionLastRun: stringField(state.get(STATE.retention), 'lastRunDate'),
  });
  for (const job of planned) {
    try {
      await enqueueJob(admin, job.type, job.payload, { dedupeKey: job.dedupeKey });
      if (job.type === 'fetch_weather') result.weatherJobs += 1;
      if (job.type === 'weekly_digest') {
        digestRuns[job.orgId] = job.runKey;
        result.digests += 1;
      }
      if (job.type === 'retention_cleanup') {
        await saveState(admin, STATE.retention, { lastRunDate: job.day }, now);
        result.retention = true;
      }
    } catch (err) {
      result.errors += 1;
      logError(`scheduler.${job.type}.failed`, err, {
        ...(job.type === 'fetch_weather' ? { siteId: job.siteId, slot: job.slot } : {}),
        ...(job.type === 'weekly_digest' ? { orgId: job.orgId } : {}),
      });
    }
  }
  if (result.digests > 0) await saveState(admin, STATE.digests, digestRuns, now);

  await saveState(admin, STATE.lastTick, { at: now.toISOString(), ...result }, now);
  result.ok = result.errors === 0;
  logInfo('scheduler.tick', result);
  return result;
}

/**
 * §7.1 `→ missing`: reminder_stage 4 and status 'missing', only while the day is still pending or
 * reminded below stage 4, with its audit row, the office's `missing_report` notice and the
 * `report_missing` email job in the same transaction (`mark_site_day_missing()`); false when a
 * report, an office action or another tick got there first.
 */
async function markMissing(
  admin: AppClient,
  siteDayId: string,
  missingAt: Date,
  note: { title: string; body: string; data: NoticeData },
  reminders: number,
): Promise<boolean> {
  const { data } = await admin
    .rpc('mark_site_day_missing', {
      p_site_day_id: siteDayId,
      p_missing_at: missingAt.toISOString(),
      p_title: note.title,
      p_body: note.body,
      p_data: note.data,
      p_reminders: reminders,
    })
    .throwOnError();
  return data === true;
}

/** The first name each site's missing notice names (`siteReporterFirstName`). */
async function loadReporterNames(
  admin: AppClient,
  siteIds: string[],
): Promise<Map<string, string>> {
  const names = new Map<string, string>();
  const unique = [...new Set(siteIds)];
  if (unique.length === 0) return names;
  const { data: links } = await admin
    .from('site_reporters')
    .select('site_id, reporter_id, is_primary')
    .in('site_id', unique)
    .throwOnError();
  const reporterIds = [...new Set(links.map((l) => l.reporter_id))];
  if (reporterIds.length === 0) return names;
  const { data: reporters } = await admin
    .from('reporters')
    .select('id, name, status')
    .in('id', reporterIds)
    .throwOnError();
  for (const siteId of unique) {
    const name = siteReporterFirstName(siteId, links, reporters);
    if (name) names.set(siteId, name);
  }
  return names;
}

async function loadOrgs(admin: AppClient): Promise<Map<string, OrgInput & { country: string }>> {
  const orgRows = await fetchAll((from, to) =>
    admin
      .from('orgs')
      .select(
        'id, timezone, billing_status, country, units, is_demo, trial_ends_at, billing_provider, billing_subscription_id',
      )
      .order('id')
      .range(from, to)
      .throwOnError(),
  );
  const settingsRows = await fetchAll((from, to) =>
    admin.from('org_settings').select('*').order('org_id').range(from, to).throwOnError(),
  );
  const settingsByOrg = new Map(settingsRows.map((s) => [s.org_id, s]));
  const pastDueSince = await loadPastDueSince(
    admin,
    orgRows.filter((o) => o.billing_status === 'past_due').map((o) => o.id),
  );
  const orgs = new Map<string, OrgInput & { country: string }>();
  for (const o of orgRows) {
    const settings = settingsByOrg.get(o.id);
    if (!settings) {
      logWarn('scheduler.org.no_settings', { orgId: o.id });
      continue;
    }
    orgs.set(o.id, {
      id: o.id,
      timezone: o.timezone,
      billing_status: o.billing_status,
      past_due_since: pastDueSince.get(o.id) ?? null,
      settings,
      country: o.country,
      units: o.units === 'metric' ? 'metric' : 'imperial',
      is_demo: o.is_demo === true,
      trial_ends_at: o.trial_ends_at,
      billing_provider: o.billing_provider,
      billing_subscription_id: o.billing_subscription_id,
    });
  }
  return orgs;
}

/** When each past_due org entered arrears: latest `billing.status_changed` → past_due audit row. */
async function loadPastDueSince(admin: AppClient, orgIds: string[]): Promise<Map<string, string>> {
  const since = new Map<string, string>();
  if (orgIds.length === 0) return since;
  const { data } = await admin
    .from('audit_log')
    .select('org_id, created_at')
    .eq('action', 'billing.status_changed')
    .eq('diff->>to', 'past_due')
    .in('org_id', orgIds)
    .order('created_at', { ascending: false })
    .throwOnError();
  for (const row of data) {
    if (row.org_id && !since.has(row.org_id)) since.set(row.org_id, row.created_at);
  }
  return since;
}

async function loadState(admin: AppClient): Promise<Map<string, Json>> {
  const { data } = await admin
    .from('scheduler_state')
    .select('key, value')
    .in('key', [STATE.lastTick, STATE.digests, STATE.retention])
    .throwOnError();
  return new Map(data.map((row) => [row.key, row.value]));
}

async function saveState(admin: AppClient, key: string, value: Json, now: Date): Promise<void> {
  await admin
    .from('scheduler_state')
    .upsert({ key, value, updated_at: now.toISOString() }, { onConflict: 'key' })
    .throwOnError();
}

function stringField(value: Json | undefined, key: string): string | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const field = value[key];
  return typeof field === 'string' ? field : null;
}

function stringRecord(value: Json | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  if (!value || typeof value !== 'object' || Array.isArray(value)) return out;
  for (const [k, v] of Object.entries(value)) if (typeof v === 'string') out[k] = v;
  return out;
}

function parseInstant(iso: string | null): Date | null {
  if (!iso) return null;
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? null : d;
}

/**
 * The reminder ladder's I/O (W2-06): reads the site-days' reporters and what already ran, plans
 * the due stages (`planLadder`, which calls `remind()` per reporter), makes each message's daily
 * link (`ensureDailyLink`, the same link the office's "Text today's link" sends; audited
 * `field_link.created` when new) and claims each stage with its `notify` jobs in one transaction
 * (claim_site_day_reminder: false when a filing, an upload, a pause or another tick got there
 * first, and then nothing is queued). A failing stage is logged and retried by the next tick.
 */
async function runLadder(
  admin: AppClient,
  input: {
    sites: readonly SiteInput[];
    orgs: ReadonlyMap<string, OrgInput & { country: string }>;
    todaysSiteDays: readonly SiteDayInput[];
    now: Date;
  },
): Promise<{ stages: number; messages: number; errors: number }> {
  const out = { stages: 0, messages: 0, errors: 0 };
  const waiting = input.todaysSiteDays.filter(
    (sd) => (sd.status === 'pending' || sd.status === 'reminded') && !sd.reminders_paused,
  );
  if (waiting.length === 0) return out;
  const siteIds = [...new Set(waiting.map((sd) => sd.site_id))];
  const { data: linkRows } = await admin
    .from('site_reporters')
    .select('site_id, reporter_id, is_primary')
    .in('site_id', siteIds)
    .throwOnError();
  const links: SiteReporterLink[] = linkRows;
  const reporterIds = [...new Set(links.map((l) => l.reporter_id))];
  const reporters = new Map<string, LadderReporter>();
  if (reporterIds.length > 0) {
    const { data } = await admin
      .from('reporters')
      .select('id, org_id, name, status, contact_pref, message_channel, locale, no_calls_until')
      .in('id', reporterIds)
      .throwOnError();
    for (const r of data) reporters.set(r.id, r);
  }
  // W3-17 (§19 Q131): who holds their own automated-call consent (never office_attested).
  const autoCall = new Set<string>();
  if (reporterIds.length > 0) {
    const { data } = await admin
      .from('consents')
      .select('reporter_id, method')
      .eq('type', 'auto_call')
      .is('revoked_at', null)
      .in('reporter_id', reporterIds)
      .throwOnError();
    for (const c of data) if (c.method !== 'office_attested') autoCall.add(c.reporter_id);
  }
  const { data: done } = await admin
    .from('audit_log')
    .select('entity_id')
    .eq('action', 'site_day.reminder')
    .eq('entity', 'site_day')
    .eq('diff->>stage', 'daily_link')
    .in(
      'entity_id',
      waiting.map((sd) => sd.id),
    )
    .throwOnError();
  const dailyLinkDone = new Set(done.flatMap((d) => (d.entity_id ? [d.entity_id] : [])));
  const packs = await loadPacks(admin, input.orgs);

  const steps = planLadder({
    sites: input.sites,
    orgs: input.orgs,
    packs,
    todaysSiteDays: waiting,
    links,
    reporters,
    dailyLinkDone,
    now: input.now,
    autoCall,
  });
  if (steps.length === 0) return out;

  const secret = requireEnv('LINK_SIGNING_SECRET');
  const fieldAppUrl = requireEnv('FIELD_APP_URL');
  const ttlHours = Number(optionalEnv('DAILY_LINK_TTL_HOURS') ?? '72');
  const linkStore = supabaseDailyLinkStore(admin);
  const siteById = new Map(input.sites.map((s) => [s.id, s]));
  const siteDayById = new Map(waiting.map((sd) => [sd.id, sd]));

  for (const step of steps) {
    try {
      const site = siteById.get(step.siteId)!;
      const org = input.orgs.get(step.orgId)!;
      const pack = packs.get(step.orgId)!;
      const linkFor = await stepLinks(step, async (reporterId) => {
        const link = await ensureDailyLink(
          linkStore,
          secret,
          {
            reporterId,
            siteId: step.siteId,
            reportDate: step.date,
            expiresAt: dailyLinkExpiresAt(input.now, ttlHours),
            now: input.now,
          },
          () => crypto.randomUUID(),
        );
        if (link.created) {
          await logAudit(admin, {
            orgId: step.orgId,
            actorType: 'system',
            action: 'field_link.created',
            entity: 'reporter',
            entityId: reporterId,
            diff: {
              kind: 'daily',
              site_id: step.siteId,
              report_date: step.date,
              link_id: link.id,
              by: 'scheduler-tick',
            },
          });
        }
        return fieldLinkUrl(fieldAppUrl, link.code);
      });
      const weather = asSiteDayWeather(siteDayById.get(step.siteDayId)?.weather ?? null);
      const args = claimArgs(step, (target, key) =>
        ladderVars(key, {
          siteName: site.name,
          link: linkFor.get(target.reporter.id) ?? null,
          voiceNumber: pack.voiceNumber,
          deadlineAt: step.deadlineAt,
          missingAt: step.missingAt,
          reminder1At: step.reminder1At,
          tz: site.timezone,
          weather,
          locale: target.reporter.locale,
          units: org.units ?? 'imperial',
        }),
      );
      const { data: claimed } = await admin
        .rpc('claim_site_day_reminder', {
          p_site_day_id: step.siteDayId,
          p_stage: step.stage,
          p_messages: args.messages,
          p_skipped: args.skipped,
          p_not_after: step.notAfter?.toISOString() ?? null,
          p_calls: args.calls,
        })
        .throwOnError();
      if (claimed !== true) continue;
      out.stages += 1;
      out.messages += args.messages.length;
      logInfo('scheduler.ladder', {
        siteDayId: step.siteDayId,
        stage: step.stage,
        sent: args.messages.length,
        called: args.calls.length,
        skipped: args.skipped.length,
      });
    } catch (err) {
      out.errors += 1;
      logError('scheduler.ladder.stage_failed', err, {
        siteDayId: step.siteDayId,
        stage: step.stage,
      });
    }
  }
  return out;
}

/** The daily link of each reporter of a step whose message carries `{link}`. */
async function stepLinks(
  step: LadderStep,
  make: (reporterId: string) => Promise<string>,
): Promise<Map<string, string>> {
  const links = new Map<string, string>();
  for (const t of step.targets) {
    const keys =
      t.action.kind === 'message'
        ? [t.action.key]
        : t.action.kind === 'call' && t.action.message
          ? [t.action.message]
          : [];
    if (keys.some(ladderKeyNeedsLink) && !links.has(t.reporter.id)) {
      links.set(t.reporter.id, await make(t.reporter.id));
    }
  }
  return links;
}

/** Each org's country pack (one read of `countries`). */
async function loadPacks(
  admin: AppClient,
  orgs: ReadonlyMap<string, { id: string; country: string }>,
): Promise<Map<string, CountryPack>> {
  const { data } = await admin.from('countries').select('*').throwOnError();
  const byCode = new Map((data as CountryRow[]).map((row) => [row.code, toCountryPack(row)]));
  const packs = new Map<string, CountryPack>();
  for (const org of orgs.values()) {
    const pack = byCode.get(org.country);
    if (pack) packs.set(org.id, pack);
    else logWarn('scheduler.org.no_pack', { orgId: org.id, country: org.country });
  }
  return packs;
}

/**
 * The reminders (R1, R2) that went out to at least one reporter, per site-day: the
 * `site_day.reminder` audit rows of claim_site_day_reminder() with a non-empty `sent`.
 */
async function loadRemindersSent(
  admin: AppClient,
  siteDayIds: string[],
): Promise<Map<string, number>> {
  const counts = new Map<string, number>();
  if (siteDayIds.length === 0) return counts;
  const { data } = await admin
    .from('audit_log')
    .select('entity_id, diff')
    .eq('action', 'site_day.reminder')
    .eq('entity', 'site_day')
    .in('entity_id', siteDayIds)
    .throwOnError();
  for (const row of data) {
    const diff = row.diff as { stage?: unknown; sent?: unknown } | null;
    if (!row.entity_id || !diff) continue;
    if (diff.stage !== 'reminder_1' && diff.stage !== 'reminder_2') continue;
    if (!Array.isArray(diff.sent) || diff.sent.length === 0) continue;
    counts.set(row.entity_id, (counts.get(row.entity_id) ?? 0) + 1);
  }
  return counts;
}
