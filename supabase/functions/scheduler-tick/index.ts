import { localDate, REMINDER_STAGE, weatherSlotDue, type Json } from '@sitelog/shared';
import { requireEnv } from '../_shared/env.ts';
import {
  bearerToken,
  error,
  json,
  requireMethod,
  timingSafeEqual,
  withHandler,
} from '../_shared/http.ts';
import { enqueueJob } from '../_shared/jobs.ts';
import { logError, logInfo, logWarn } from '../_shared/log.ts';
import { notifyOrg } from '../_shared/notify.ts';
import { adminClient, fetchAll, type AppClient } from '../_shared/supabase.ts';
import {
  asSiteDayWeather,
  dueStage,
  LADDER_STATUSES,
  ladderFromSettings,
  missingNotification,
  orgIsBlocked,
  pickReminderTarget,
  planSiteDay,
  reminderJob,
  retentionDue,
  siteDayPatchForStage,
  weatherJobFor,
  weeklyDigestDue,
  type OrgInput,
  type ReminderTarget,
  type SiteDayInput,
  type SiteDayPlan,
  type SiteInput,
} from './logic.ts';

/**
 * scheduler-tick (§4.2, §F9, §10.10, §13) — called every 5 minutes by pg_cron (migration 0006)
 * with `Authorization: Bearer ${SCHEDULER_SECRET}`. Creates today's site-days, runs the reminder
 * ladder, marks missing reports, schedules weather fetches, the weekly digest and the nightly
 * retention job. Decisions live in logic.ts; this file only does I/O.
 */

export interface TickResult {
  ok: boolean;
  sitesChecked: number;
  siteDaysCreated: number;
  remindersQueued: number;
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
    const result = await runTick(adminClient(), new Date());
    return json(req, result);
  }),
);

async function runTick(admin: AppClient, now: Date): Promise<TickResult> {
  const result: TickResult = {
    ok: true,
    sitesChecked: 0,
    siteDaysCreated: 0,
    remindersQueued: 0,
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

  // 4. Reminder ladder.
  const due: Array<{ sd: SiteDayInput; stage: 1 | 2 | 3 | 4 }> = [];
  for (const sd of todaysSiteDays) {
    if (!LADDER_STATUSES.includes(sd.status)) continue;
    const site = siteById.get(sd.site_id);
    const org = site ? orgs.get(site.org_id) : undefined;
    if (!site || !org) continue;
    const stage = dueStage(sd, ladderFromSettings(org.settings), now);
    if (stage) due.push({ sd, stage: stage.stage });
  }
  const targets = await loadReminderTargets(
    admin,
    due.map((d) => d.sd.site_id),
  );
  for (const { sd, stage } of due) {
    const site = siteById.get(sd.site_id);
    const org = site ? orgs.get(site.org_id) : undefined;
    if (!site || !org) continue;
    const target = targets.get(site.id) ?? null;
    try {
      if (stage === REMINDER_STAGE.missing) {
        if (!(await claimStage(admin, sd.id, stage))) continue;
        const note = missingNotification(site.name, target?.firstName ?? null);
        await notifyOrg(admin, {
          orgId: org.id,
          kind: 'missing_report',
          title: note.title,
          body: note.body,
          targetPath: '/',
        });
        await enqueueJob(
          admin,
          'send_email',
          { kind: 'report_missing', siteDayId: sd.id, siteId: site.id, orgId: org.id },
          { dedupeKey: `email:report_missing:${sd.id}` },
        );
        result.missing += 1;
        logInfo('scheduler.missing', { siteId: site.id, siteDayId: sd.id, orgId: org.id });
        continue;
      }
      if (!target) {
        // Nobody active to remind: leave the stage untouched; the office alert still fires later.
        logWarn('scheduler.reminder.no_reporter', { siteId: site.id, siteDayId: sd.id, stage });
        continue;
      }
      if (!(await claimStage(admin, sd.id, stage))) continue;
      const job = reminderJob(stage, {
        siteDayId: sd.id,
        conversationId: target.conversationId,
        firstName: target.firstName,
        siteName: site.name,
        deadlineAt: new Date(sd.deadline_at),
        tz: site.timezone,
        ladder: ladderFromSettings(org.settings),
        weather: asSiteDayWeather(sd.weather),
      });
      await enqueueJob(admin, 'send_template', job.payload, { dedupeKey: job.dedupeKey });
      result.remindersQueued += 1;
      logInfo('scheduler.reminder', {
        siteId: site.id,
        siteDayId: sd.id,
        stage,
        template: job.payload.template,
      });
    } catch (err) {
      result.errors += 1;
      logError('scheduler.reminder.failed', err, { siteId: site.id, siteDayId: sd.id, stage });
    }
  }

  // 5. Weather snapshots (12:00, 16:30, 23:30 site time) for sites with a site-day today.
  const sitesWithToday = new Set(todaysSiteDays.map((sd) => sd.site_id));
  for (const site of sites) {
    if (!sitesWithToday.has(site.id)) continue;
    const slot = weatherSlotDue(prevTick, now, site.timezone);
    if (!slot) continue;
    const job = weatherJobFor(site, localDate(now, site.timezone), slot);
    if (!job) continue;
    try {
      await enqueueJob(admin, 'fetch_weather', job.payload, { dedupeKey: job.dedupeKey });
      result.weatherJobs += 1;
    } catch (err) {
      result.errors += 1;
      logError('scheduler.weather.failed', err, { siteId: site.id, slot });
    }
  }

  // 6. Weekly digest (Monday 07:00 org time) — tracked per org in scheduler_state.
  const digestRuns = stringRecord(state.get(STATE.digests));
  for (const org of orgs.values()) {
    if (orgIsBlocked(org, now)) continue;
    const digest = weeklyDigestDue(org, digestRuns[org.id] ?? null, now);
    if (!digest) continue;
    try {
      await enqueueJob(
        admin,
        'weekly_digest',
        { orgId: org.id, weekStart: digest.weekStart },
        { dedupeKey: `weekly_digest:${org.id}:${digest.weekStart}` },
      );
      digestRuns[org.id] = digest.runKey;
      result.digests += 1;
    } catch (err) {
      result.errors += 1;
      logError('scheduler.digest.failed', err, { orgId: org.id });
    }
  }
  if (result.digests > 0) await saveState(admin, STATE.digests, digestRuns, now);

  // 7. Nightly retention cleanup (03:00 UTC, once per day).
  const retentionDay = retentionDue(stringField(state.get(STATE.retention), 'lastRunDate'), now);
  if (retentionDay) {
    try {
      await enqueueJob(admin, 'retention_cleanup', {}, { dedupeKey: `retention:${retentionDay}` });
      await saveState(admin, STATE.retention, { lastRunDate: retentionDay }, now);
      result.retention = true;
    } catch (err) {
      result.errors += 1;
      logError('scheduler.retention.failed', err);
    }
  }

  await saveState(admin, STATE.lastTick, { at: now.toISOString(), ...result }, now);
  result.ok = result.errors === 0;
  logInfo('scheduler.tick', result);
  return result;
}

/** Marks a ladder stage as taken; false when another tick got there first (stage only moves up). */
async function claimStage(
  admin: AppClient,
  siteDayId: string,
  stage: 1 | 2 | 3 | 4,
): Promise<boolean> {
  const { data } = await admin
    .from('site_days')
    .update(siteDayPatchForStage(stage))
    .eq('id', siteDayId)
    .lt('reminder_stage', stage)
    .select('id')
    .throwOnError();
  return data.length > 0;
}

async function loadOrgs(admin: AppClient): Promise<Map<string, OrgInput>> {
  const orgRows = await fetchAll((from, to) =>
    admin
      .from('orgs')
      .select('id, timezone, billing_status')
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
  const orgs = new Map<string, OrgInput>();
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

async function loadReminderTargets(
  admin: AppClient,
  siteIds: string[],
): Promise<Map<string, ReminderTarget>> {
  const targets = new Map<string, ReminderTarget>();
  const unique = [...new Set(siteIds)];
  if (unique.length === 0) return targets;
  const { data: links } = await admin
    .from('site_reporters')
    .select('site_id, reporter_id, is_primary')
    .in('site_id', unique)
    .throwOnError();
  const reporterIds = [...new Set(links.map((l) => l.reporter_id))];
  if (reporterIds.length === 0) return targets;
  const { data: reporters } = await admin
    .from('reporters')
    .select('id, name, status')
    .in('id', reporterIds)
    .throwOnError();
  const { data: conversations } = await admin
    .from('conversations')
    .select('id, reporter_id')
    .in('reporter_id', reporterIds)
    .throwOnError();
  for (const siteId of unique) {
    const target = pickReminderTarget(siteId, links, reporters, conversations);
    if (target) targets.set(siteId, target);
  }
  return targets;
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
