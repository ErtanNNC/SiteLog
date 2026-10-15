import { type Json, localDate, REMINDER_STAGE } from '@sitelog/shared';
import { logAudit } from '../_shared/audit.ts';
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
import { adminClient, type AppClient, fetchAll } from '../_shared/supabase.ts';
import {
  LADDER_STATUSES,
  type OrgInput,
  orgIsBlocked,
  planMissing,
  planSiteDay,
  planTickJobs,
  siteDayPatchForStage,
  type SiteDayInput,
  type SiteDayPlan,
  type SiteInput,
} from './logic.ts';

/**
 * scheduler-tick (§4.2, §F9, §10.10, §13) — called every 5 minutes by pg_cron (migration 0006)
 * with `Authorization: Bearer ${SCHEDULER_SECRET}`. Creates today's site-days, marks a day past its
 * deadline plus the missing offset `missing` (§7.1), and schedules weather fetches, the weekly
 * digest and the nightly retention job; billing-blocked orgs are skipped. The
 * v1.0 WhatsApp reminder ladder (heads-up, R1, R2, the missing alert) is stopped (W1-10) until M6
 * brings it back on SMS. Decisions live in logic.ts; this file only does I/O.
 */

export interface TickResult {
  ok: boolean;
  sitesChecked: number;
  siteDaysCreated: number;
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
    const result = await runTick(adminClient(), new Date());
    return json(req, result);
  }),
);

async function runTick(admin: AppClient, now: Date): Promise<TickResult> {
  const result: TickResult = {
    ok: true,
    sitesChecked: 0,
    siteDaysCreated: 0,
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

  // 4. No reminder ladder (W1-10): the v1.0 WhatsApp heads-up, R1, R2 and the missing alert are
  //    stopped until M6 rebuilds them on SMS through the Notifier (logic.ts REMINDER_LADDER_RUNS).
  //    The §7.1 status step still runs: a day past its deadline plus the missing offset becomes
  //    `missing` (the panel's Overview and Reports read it), audited, with no text and no alert.
  for (const mark of planMissing({ sites, orgs, todaysSiteDays, now })) {
    try {
      if (!(await markMissing(admin, mark.siteDayId))) continue;
      await logAudit(admin, {
        orgId: mark.orgId,
        actorType: 'system',
        action: 'site_day.status_changed',
        entity: 'site_day',
        entityId: mark.siteDayId,
        diff: {
          from: mark.from,
          to: 'missing',
          reminder_stage: REMINDER_STAGE.missing,
          missing_at: mark.missingAt.toISOString(),
          by: 'scheduler-tick',
        },
      });
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
  // 5–7. Weather snapshots, the weekly digest and the nightly retention job (logic.ts planTickJobs).
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
 * §7.1 `→ missing`: reminder_stage 4 and status 'missing' (logic.ts siteDayPatchForStage), only
 * while the day is still pending or reminded below stage 4; false when a report, an office action
 * or another tick got there first.
 */
async function markMissing(admin: AppClient, siteDayId: string): Promise<boolean> {
  const { data } = await admin
    .from('site_days')
    .update(siteDayPatchForStage(REMINDER_STAGE.missing))
    .eq('id', siteDayId)
    .in('status', [...LADDER_STATUSES])
    .lt('reminder_stage', REMINDER_STAGE.missing)
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
