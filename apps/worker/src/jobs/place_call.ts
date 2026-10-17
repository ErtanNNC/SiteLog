import { randomUUID } from 'node:crypto';
import {
  DAILY_LINK_TTL_HOURS_DEFAULT,
  DEFAULT_CALL_WINDOW,
  formatPhone,
  OUTBOUND_CALL_POLICY,
  afterUnanswered,
  dailyLinkExpiresAt,
  ensureDailyLink,
  fieldLinkUrl,
  insideWindow,
  ladderDedupeKey,
  missedCallNotifyKey,
  outboundCallKey,
  ringEndJobKey,
  skipSendsMessage,
  telephonyFor,
  toCountryPack,
  windowEndAfter,
  type CallRow,
  type CallSkipReason,
  type CountryPack,
  type JobPayloads,
  type OrgSettingsRow,
  type OutboundCallStage,
  type ReporterRow,
  type SiteDayRow,
  type SiteRow,
  type UnansweredStatus,
} from '@sitelog/shared';
import type { Ctx } from '../context';
import { createTelephony } from '../telephony';
import { PermanentJobError, type JobHandler } from './types';

/**
 * §10.1 `place_call` (W3-17, M8; spec §7.4, F6 step 1, F11, §9.4 "Calls policy", §4.5
 * `Notifier.call`, §19 Q125–Q132). One job type, three phases:
 *
 * - **dial** (R1 and R2 from claim_site_day_reminder(), the one callback from
 *   voice_schedule_callback()): the guards in code (inside the org's call window at the site,
 *   §9.4; before the stage's `notAfter`), then outbound_call_start() for the guards that need the
 *   database (the day still waits for a report, the reporter active and preferring calls, their
 *   own `auto_call` consent, §19 Q131; not "Don't call me today", Q129; the attempt unused, Q128;
 *   the org placing calls and its `auto_call_enabled`; capacity on LiveKit, Q127) and the `calls`
 *   row. Then the telephony: `console` for a demo org (the Demo phone rings, §19 Q132; its end is a
 *   delayed `ring_end`), `livekit` on the pack's trunk with the pack's voice number as caller id
 *   (§19 Q125, Q126; the agent takes an answered call and hangs up on a voicemail greeting,
 *   leaving no message, F6 step 1). A skipped R1 becomes the stage's own text (`reminder_1`)
 *   where the reporter would otherwise hear nothing (`skipSendsMessage`); R2's text went with the
 *   claim. No capacity: wait and try again every minute until the stage's `giveUpAt` (R1 + 30 min).
 * - **ring_end**: a console call still ringing counts as not answered.
 * - **missed**: a call not reached gets `missed_call` ("Missed you … Call {number} or tap {link}",
 *   F6 step 1, F11) through the Notifier; a dial that failed before ringing gets the stage's own
 *   text instead (R1; nothing for R2, whose text went, or a callback).
 *
 * Every skip is audited `call.skipped` with its reason; every text is a `notify` job (its key, its
 * guard: the day still waiting, the call window open), so a retry never texts twice.
 */
export const placeCallJob: JobHandler<'place_call'> = async (ctx, payload) => {
  if (payload.phase === 'ring_end') return ringEnd(ctx, payload.callId);
  if (payload.phase === 'missed') return missed(ctx, payload.callId);
  return dial(ctx, payload);
};

type DialPayload = Extract<JobPayloads['place_call'], { stage: OutboundCallStage }>;

interface CallScope {
  reporter: ReporterRow;
  siteDay: SiteDayRow;
  site: SiteRow;
  org: { id: string; is_demo: boolean };
  settings: OrgSettingsRow | null;
  pack: CountryPack;
}

async function scopeOf(ctx: Ctx, reporterId: string, siteDayId: string): Promise<CallScope> {
  const [reporter, siteDay] = await Promise.all([
    ctx.db.getReporter(reporterId),
    ctx.db.getSiteDay(siteDayId),
  ]);
  if (!reporter) throw new PermanentJobError(`reporter ${reporterId} not found`);
  if (!siteDay) throw new PermanentJobError(`site-day ${siteDayId} not found`);
  const site = await ctx.db.getSite(siteDay.site_id);
  if (!site) throw new PermanentJobError(`site ${siteDay.site_id} not found`);
  const [org, settings] = await Promise.all([
    ctx.db.getOrg(site.org_id),
    ctx.db.getOrgSettings(site.org_id),
  ]);
  if (!org) throw new PermanentJobError(`org ${site.org_id} not found`);
  const country = await ctx.db.getCountry(org.country);
  if (!country) throw new PermanentJobError(`country pack ${org.country} not found`);
  return {
    reporter,
    siteDay,
    site,
    org: { id: org.id, is_demo: org.is_demo === true },
    settings,
    pack: toCountryPack(country),
  };
}

function callWindowOf(settings: OrgSettingsRow | null) {
  return {
    start: settings?.call_window_start ?? DEFAULT_CALL_WINDOW.start,
    end: settings?.call_window_end ?? DEFAULT_CALL_WINDOW.end,
  };
}

async function dial(ctx: Ctx, payload: DialPayload): Promise<void> {
  const scope = await scopeOf(ctx, payload.reporterId, payload.siteDayId);
  const now = ctx.now();
  const log = ctx.log.child({
    site_day_id: scope.siteDay.id,
    reporter_id: scope.reporter.id,
    stage: payload.stage,
  });

  // §9.4: outbound only inside the call window (site time), and not after the stage's notAfter.
  const window = callWindowOf(scope.settings);
  if (
    !insideWindow(now, scope.site.timezone, window) ||
    (payload.notAfter && now.getTime() >= Date.parse(payload.notAfter))
  ) {
    await skipped(ctx, scope, payload.stage, 'outside_window');
    return;
  }

  const driver = telephonyFor({ isDemo: scope.org.is_demo }, scope.pack);
  if (!driver) {
    await skipped(ctx, scope, payload.stage, 'no_trunk');
    return;
  }
  const telephony = (ctx.telephony ?? createTelephony(ctx.config)).get(driver);
  if (!telephony) {
    await skipped(ctx, scope, payload.stage, 'telephony_unavailable');
    return;
  }

  const start = await ctx.db.outboundCallStart({
    reporterId: scope.reporter.id,
    siteDayId: scope.siteDay.id,
    stage: payload.stage,
    now,
    telephony: driver,
    maxConcurrent: driver === 'livekit' ? ctx.config.VOICE_MAX_CONCURRENT_CALLS : null,
  });
  if (start.status === 'skipped') {
    if (start.reason === 'capacity' && (await waitForCapacity(ctx, payload, now))) {
      log.info('place_call: no capacity, waiting', { open: start.open, wait: payload.wait ?? 0 });
      return;
    }
    await skipped(ctx, scope, payload.stage, start.reason);
    return;
  }

  await ctx.db.outboundCallRinging(start.callId);
  const result = await telephony.dial({
    callId: start.callId,
    room: start.room,
    to: start.to,
    from: start.from,
    trunkId: start.trunkId,
  });
  log.info('place_call: dialled', {
    call_id: start.callId,
    telephony: driver,
    result: result.kind,
    ...(result.kind === 'unanswered' ? { status: result.status, reason: result.reason } : {}),
  });
  if (result.kind === 'ringing') {
    // The console's ring: settled after it (the Demo phone shows it ringing meanwhile).
    await ctx.db.enqueueJob(
      'place_call',
      { phase: 'ring_end', callId: start.callId },
      { delayMs: result.settleAfterS * 1000, dedupeKey: ringEndJobKey(start.callId) },
    );
    return;
  }
  if (result.kind === 'unanswered') {
    const ended = await ctx.db.outboundCallUnanswered(start.callId, result.status, result.reason);
    if (ended.ended) await afterNotReached(ctx, start.callId, result.status);
  }
}

/**
 * §19 Q127: no capacity now. Before the stage's give-up time the call waits a minute and tries
 * again (the next wait's own key); after it, false (the caller skips with `capacity`).
 */
async function waitForCapacity(ctx: Ctx, payload: DialPayload, now: Date): Promise<boolean> {
  const giveUp = payload.giveUpAt
    ? Date.parse(payload.giveUpAt)
    : now.getTime() + OUTBOUND_CALL_POLICY.giveUpAfterMin * 60_000;
  const next = now.getTime() + OUTBOUND_CALL_POLICY.capacityWaitS * 1000;
  const wait = (payload.wait ?? 0) + 1;
  if (next >= giveUp || wait > 60) return false;
  await ctx.db.enqueueJob(
    'place_call',
    { ...payload, giveUpAt: new Date(giveUp).toISOString(), wait },
    {
      delayMs: OUTBOUND_CALL_POLICY.capacityWaitS * 1000,
      dedupeKey: outboundCallKey(payload.siteDayId, payload.reporterId, payload.stage, wait),
    },
  );
  return true;
}

/** A call not placed: audited, and the stage's text where the reporter would hear nothing. */
async function skipped(
  ctx: Ctx,
  scope: CallScope,
  stage: OutboundCallStage,
  reason: CallSkipReason,
): Promise<void> {
  const textKey = stage === 'reminder_1' && skipSendsMessage(reason) ? 'reminder_1' : null;
  await ctx.db.logAudit({
    org_id: scope.org.id,
    actor_type: 'system',
    action: 'call.skipped',
    entity: 'reporter',
    entity_id: scope.reporter.id,
    diff: {
      stage,
      reason,
      site_day_id: scope.siteDay.id,
      message: textKey,
    },
  });
  if (textKey) await stageText(ctx, scope);
}

/** R1's `reminder_1` with the day's link, as the ladder would have sent it (its key and guard). */
async function stageText(ctx: Ctx, scope: CallScope): Promise<void> {
  const link = await dailyLink(ctx, scope);
  const window = callWindowOf(scope.settings);
  await ctx.db.enqueueJob(
    'notify',
    {
      reporterId: scope.reporter.id,
      key: 'reminder_1',
      vars: { site: scope.site.name, link },
      dedupeKey: ladderDedupeKey('reminder_1', scope.siteDay.id, scope.reporter.id),
      guard: {
        siteDayId: scope.siteDay.id,
        statuses: ['pending', 'reminded'],
        notAfter: windowEndAfter(ctx.now(), scope.site.timezone, window).toISOString(),
      },
    },
    { dedupeKey: ladderDedupeKey('reminder_1', scope.siteDay.id, scope.reporter.id) },
  );
}

/** The reporter's daily link for the site and day (the one the ladder texts). */
async function dailyLink(ctx: Ctx, scope: CallScope): Promise<string> {
  const secret = ctx.config.LINK_SIGNING_SECRET;
  const base = ctx.config.FIELD_APP_URL;
  if (!secret) throw new Error('LINK_SIGNING_SECRET is not set');
  if (!base) throw new Error('FIELD_APP_URL is not set');
  const link = await ensureDailyLink(
    {
      listDailyLinks: (r, s, d) => ctx.db.listDailyLinks(r, s, d),
      insertDailyLink: (row) => ctx.db.insertDailyLink(row),
    },
    secret,
    {
      reporterId: scope.reporter.id,
      siteId: scope.site.id,
      reportDate: scope.siteDay.date,
      expiresAt: dailyLinkExpiresAt(ctx.now(), DAILY_LINK_TTL_HOURS_DEFAULT),
      now: ctx.now(),
    },
    randomUUID,
  );
  if (link.created) {
    await ctx.db.logAudit({
      org_id: scope.org.id,
      actor_type: 'system',
      action: 'field_link.created',
      entity: 'reporter',
      entity_id: scope.reporter.id,
      diff: {
        kind: 'daily',
        site_id: scope.site.id,
        report_date: scope.siteDay.date,
        link_id: link.id,
        by: 'place_call',
      },
    });
  }
  return fieldLinkUrl(base, link.code);
}

/** A console call's ring is over: unanswered unless it was picked up meanwhile. */
async function ringEnd(ctx: Ctx, callId: string): Promise<void> {
  const call = await ctx.db.getCall(callId);
  if (!call) throw new PermanentJobError(`call ${callId} not found`);
  if (call.ended_at || call.status !== 'ringing') return;
  const ended = await ctx.db.outboundCallUnanswered(callId, 'no_answer', 'console_no_answer');
  if (ended.ended) await afterNotReached(ctx, callId, 'no_answer');
}

/** voice_call_end()'s `missed` step (a voicemail greeting the agent hung up on). */
async function missed(ctx: Ctx, callId: string): Promise<void> {
  const call = await ctx.db.getCall(callId);
  if (!call) throw new PermanentJobError(`call ${callId} not found`);
  if (call.direction !== 'outbound' || call.outcome !== 'not_reached') return;
  const status: UnansweredStatus =
    call.status === 'busy' || call.status === 'failed' || call.status === 'voicemail'
      ? call.status
      : 'no_answer';
  await afterNotReached(ctx, callId, status);
}

/**
 * F6 step 1, F11: the phone rang and nobody answered (or a machine did) → `missed_call`; the dial
 * failed before ringing → R1's own text (`afterUnanswered`).
 */
async function afterNotReached(ctx: Ctx, callId: string, status: UnansweredStatus): Promise<void> {
  const call = await ctx.db.getCall(callId);
  if (!call?.reporter_id || !call.site_day_id) return;
  const scope = await scopeOf(ctx, call.reporter_id, call.site_day_id);
  if (afterUnanswered(status) === 'stage_message') {
    if (call.attempt === 1) await stageText(ctx, scope);
    return;
  }
  await missedCallText(ctx, scope, call);
}

async function missedCallText(ctx: Ctx, scope: CallScope, call: CallRow): Promise<void> {
  const link = await dailyLink(ctx, scope);
  const window = callWindowOf(scope.settings);
  await ctx.db.enqueueJob(
    'notify',
    {
      reporterId: scope.reporter.id,
      key: 'missed_call',
      // "Call {number} or tap {link}" when the pack has a voice number (`renderSms`'s variant).
      vars: {
        link,
        ...(scope.pack.voiceNumber ? { number: formatPhone(scope.pack.voiceNumber) } : {}),
      },
      dedupeKey: missedCallNotifyKey(call.id),
      guard: {
        siteDayId: scope.siteDay.id,
        // A callback may follow a call that left a draft (`processing`).
        statuses: ['pending', 'reminded', 'processing'],
        notAfter: windowEndAfter(ctx.now(), scope.site.timezone, window).toISOString(),
      },
    },
    { dedupeKey: missedCallNotifyKey(call.id) },
  );
}
