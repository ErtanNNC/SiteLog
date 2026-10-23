import {
  DEFAULT_CALL_WINDOW,
  MessageSendError,
  REMIND_POLICY_DEFAULTS,
  SmsSendError,
  attemptIsAccountFault,
  attemptIsFinal,
  attemptOf,
  insideWindow,
  noticeData,
  notifyReportId,
  type RemindPolicy,
  type JobPayloads,
  type NoticeData,
  type NotifierKey,
  type SmsVars,
} from '@sitelog/shared';
import type { Ctx } from '../context';
import type { JobHandler } from './types';

/**
 * §10.1 `notify(reporter_id, key, vars, dedupe_key)` (GAP D48; W1-10): one message to a field
 * reporter through the Notifier (spec §4.5, W1-08), which picks the channel from the person's
 * order in the country pack, renders the §9.2 text in their language, sends it on the pack's
 * driver and writes the `messages` row and its audit. The payload's `dedupeKey` is the logical
 * message's key (`notify:filed:{report_id}`): the job's dedupe key (one job per message, D16) and
 * the Notifier's (a retry after a send never sends twice, on any channel).
 *
 * - Sent, or nothing deliverable (no consent, opted out, a disabled reporter): done; the Notifier
 *   audited what it did. A real org whose pack has no sender id here (`console_real_org`) reaches
 *   no phone, so the office is told (§13 "Message undeliverable / opted out", `message_failed`).
 * - A channel refused for good hands the message to the next channel inside the Notifier (spec
 *   §19 Q22, W2-01). Refused for good on every channel of the order (`MessageSendError` not
 *   retryable: a bad number, the provider's opt-out list, a late failure on the last channel):
 *   the Notifier marked the rows and recorded an opt-out; the office is told, no retry. Except
 *   when every failed attempt failed for the provider account or the sender (a late Twilio
 *   `failed`, or `undelivered` with 30032, 30034, 30002, 30007, …: `attemptIsAccountFault`):
 *   sms-webhook already told the office that texts are failing for the account, at most once per
 *   org per hour (`sms.provider_fault`), so no `message_failed` per message (audited
 *   `notify.failed` with `notice: null`).
 * - A provider outage or an account fault (retryable, or not the number's fault): thrown, so the
 *   queue retries with backoff; a job that dies tells the office (src/dead-jobs.ts).
 * - The fallback after a late status callback (`afterMessageId`, enqueued by sms-webhook's
 *   `/status`, `lateFallback`) first runs the key's guard: a message no longer useful is dropped
 *   (audited `notify.fallback_dropped`); otherwise the Notifier's walk skips the failed attempt.
 * - A reminder-ladder message (W2-06) carries a `guard`: before it is sent the site-day must still
 *   wait for a report and the call window be open, or nothing goes out (`notify.skipped`,
 *   `stale_stage` / `quiet_hours`, `ladderGuardVerdict`).
 * - A web report's text (W2-07: `question_ready`, `draft_ready`, the 30-minute nudge) carries a
 *   `reportGuard`: the question must still be open, or the draft unconfirmed at that version and
 *   revision (`stale_report`); a text deferred because the reporter's device was active goes out
 *   only if no device of theirs was seen since (`device_active`, spec §19 Q61); the nudge only
 *   inside the call window (`quiet_hours`, Q77). `reportGuardVerdict`.
 */

/** Whether a message is still worth sending when its fallback runs after a late callback. */
export type NotifyGuard = (ctx: Ctx, payload: JobPayloads['notify']) => Promise<boolean>;

/** Why a guarded message is no longer sent (audited `notify.skipped`). */
export type GuardVerdict = 'stale_stage' | 'quiet_hours' | 'stale_report' | 'device_active';

/**
 * The reminder ladder's re-check before sending (W2-06; the payload's `guard`, written by
 * claim_site_day_reminder()): null while the message is still due; `stale_stage` when the site-day
 * left the statuses the stage was claimed for (filed, `processing`, `no_work`, `weather_day`,
 * `missing`) or its reminders were paused since (STOP, the office); `quiet_hours` once the call
 * window has closed (spec §19 Q77, `notAfter`: a retry or a late worker does not text at 22:00).
 */
export async function ladderGuardVerdict(
  ctx: Ctx,
  guard: NonNullable<JobPayloads['notify']['guard']>,
): Promise<GuardVerdict | null> {
  const day = await ctx.db.getSiteDay(guard.siteDayId);
  if (!day || !guard.statuses.includes(day.status) || day.reminders_paused) return 'stale_stage';
  if (guard.notAfter && ctx.now().getTime() >= Date.parse(guard.notAfter)) return 'quiet_hours';
  return null;
}

/**
 * A web report's re-check before its text goes out (W2-07; the payload's `reportGuard`, written by
 * decide_next): null while the text is still useful. `stale_report` when the report left the
 * status the text is about, its question was answered or timed out, or its draft is no longer that
 * version and revision (a newer draft has its own text and clock); `device_active` when a text
 * deferred for the reporter's active device finds a device of theirs seen since (spec §19 Q61:
 * they saw it on the recorder); `quiet_hours` for the nudge outside the org's call window at the
 * site (spec §19 Q77, `RemindPolicy.quietHours`).
 */
export async function reportGuardVerdict(
  ctx: Ctx,
  guard: NonNullable<JobPayloads['notify']['reportGuard']>,
  policy: Pick<RemindPolicy, 'quietHours'> = REMIND_POLICY_DEFAULTS,
): Promise<GuardVerdict | null> {
  const report = await ctx.db.getReport(guard.reportId);
  if (!report || report.status !== guard.status) return 'stale_report';
  if (guard.questionId) {
    const question = await ctx.db.getQuestion(guard.questionId);
    if (!question || question.report_id !== report.id || question.answered_at)
      return 'stale_report';
  }
  if (guard.version !== undefined) {
    if ((report.current_version || 1) !== guard.version) return 'stale_report';
    if (guard.draftRev !== undefined) {
      const version = await ctx.db.getVersion(report.id, guard.version);
      if ((version?.draft_rev ?? 1) !== guard.draftRev) return 'stale_report';
    }
  }
  if (guard.deviceNotSeenAfter && report.reporter_id) {
    const seen = await ctx.db.reporterDeviceLastSeen(report.reporter_id);
    if (seen && Date.parse(seen) > Date.parse(guard.deviceNotSeenAfter)) return 'device_active';
  }
  if (guard.quietHours && policy.quietHours === 'skip') {
    const site = await ctx.db.siteContext(report.site_id);
    if (
      site &&
      !insideWindow(ctx.now(), site.site.timezone, {
        start: site.settings.call_window_start ?? DEFAULT_CALL_WINDOW.start,
        end: site.settings.call_window_end ?? DEFAULT_CALL_WINDOW.end,
      })
    )
      return 'quiet_hours';
  }
  return null;
}

/** Both re-checks a payload carries (the ladder's, a web report's); null when it may be sent. */
export async function guardVerdict(
  ctx: Ctx,
  payload: JobPayloads['notify'],
): Promise<{ verdict: GuardVerdict; entity: Record<string, string> } | null> {
  if (payload.guard) {
    const verdict = await ladderGuardVerdict(ctx, payload.guard);
    if (verdict) return { verdict, entity: { site_day_id: payload.guard.siteDayId } };
  }
  if (payload.reportGuard) {
    const verdict = await reportGuardVerdict(ctx, payload.reportGuard);
    if (verdict) return { verdict, entity: { report_id: payload.reportGuard.reportId } };
  }
  return null;
}

/** The fallback guard of the guarded keys: the same re-checks (a payload without one passes). */
const payloadGuard: NotifyGuard = async (ctx, payload) =>
  (await guardVerdict(ctx, payload)) === null;

/**
 * The guards per key (W2-01): the reminder ladder's site-day check (W2-06), the web report's open
 * question and unconfirmed draft (W2-07: `question_ready`, `draft_ready` and the nudge, which is
 * `draft_ready`, spec §19 Q78 as decided). A key with no guard is still useful.
 */
export const NOTIFY_FALLBACK_GUARDS: Partial<Record<NotifierKey, NotifyGuard>> = {
  daily_link: payloadGuard,
  weather_headsup: payloadGuard,
  reminder_1: payloadGuard,
  reminder_2: payloadGuard,
  // W3-17: the 17:00 "I'll call you at …" (§19 Q130) and a call not reached (F6 step 1, F11).
  call_coming: payloadGuard,
  missed_call: payloadGuard,
  question_ready: payloadGuard,
  draft_ready: payloadGuard,
};

export function createNotifyJob(
  guards: Partial<Record<NotifierKey, NotifyGuard>> = NOTIFY_FALLBACK_GUARDS,
): JobHandler<'notify'> {
  return async (ctx, payload) => {
    const reporter = await ctx.db.getReporter(payload.reporterId);
    if (!reporter) {
      ctx.log.warn('notify: reporter not found', { reporter_id: payload.reporterId });
      return;
    }
    const officeNotice = async (body: string, data: NoticeData) => {
      await ctx.db.notifyOrg(
        reporter.org_id,
        'message_failed',
        `${reporter.name}: a message to them was not sent`,
        body,
        '/team',
        null,
        data,
      );
      await ctx.db.logAudit({
        org_id: reporter.org_id,
        actor_type: 'system',
        action: 'notify.failed',
        entity: 'reporter',
        entity_id: reporter.id,
        diff: { key: payload.key, dedupe_key: payload.dedupeKey, reason: body },
      });
    };

    const key = payload.key as NotifierKey;
    if (payload.afterMessageId) {
      const guard = guards[key];
      if (guard && !(await guard(ctx, payload))) {
        await ctx.db.logAudit({
          org_id: reporter.org_id,
          actor_type: 'system',
          action: 'notify.fallback_dropped',
          entity: 'message',
          entity_id: payload.afterMessageId,
          diff: { key: payload.key, dedupe_key: payload.dedupeKey, reason: 'guard' },
        });
        return;
      }
    } else if (payload.guard || payload.reportGuard) {
      // The re-check before the first send: a ladder stage claimed before the report came in, a
      // job that waited past the call window (W2-06), a web text whose question or draft moved
      // on, or whose reporter came back to the recorder (W2-07) sends nothing.
      const skip = await guardVerdict(ctx, payload);
      if (skip) {
        await ctx.db.logAudit({
          org_id: reporter.org_id,
          actor_type: 'system',
          action: 'notify.skipped',
          entity: 'reporter',
          entity_id: reporter.id,
          diff: {
            copy_key: payload.key,
            dedupe_key: payload.dedupeKey,
            reason: skip.verdict,
            ...skip.entity,
          },
        });
        return;
      }
    }

    let outcome;
    try {
      const reportId = notifyReportId(payload);
      outcome = await ctx.notifier.send(reporter.id, key, payload.vars as SmsVars<NotifierKey>, {
        dedupeKey: payload.dedupeKey,
        // W2-15: the report's per-channel messaging cost (`messages.payload.report_id`).
        ...(reportId ? { reportId } : {}),
      });
    } catch (err) {
      if (
        err instanceof MessageSendError &&
        !err.retryable &&
        (err.undeliverable || err.optedOut)
      ) {
        const error = err.message.slice(0, 200);
        const attempts = await ctx.db.listMessagesByDedupeKey(reporter.id, payload.dedupeKey);
        const failed = attempts.map(attemptOf).filter(attemptIsFinal);
        if (failed.length > 0 && failed.every(attemptIsAccountFault)) {
          // The account's fault, not the person's: covered by the rate-limited provider-fault
          // notice of sms-webhook's status route; one notice per failed text would flood.
          await ctx.db.logAudit({
            org_id: reporter.org_id,
            actor_type: 'system',
            action: 'notify.failed',
            entity: 'reporter',
            entity_id: reporter.id,
            diff: {
              key: payload.key,
              dedupe_key: payload.dedupeKey,
              reason: error,
              account_fault: true,
              notice: null,
            },
          });
          return;
        }
        const channels = [...new Set(attempts.flatMap((a) => (a.channel ? [a.channel] : [])))].join(
          ', ',
        );
        if (!(err instanceof SmsSendError) || channels.includes(',')) {
          // More than SMS was tried: every channel of the order failed (§19 Q22, §13).
          await officeNotice(
            `TalkOlog tried every message channel it has for them (${channels}) and none could deliver the message (${error}). Check their number and channels in Team & numbers.`,
            noticeData('message_channels_failed', { name: reporter.name, channels, error }),
          );
          return;
        }
        await officeNotice(
          err.optedOut
            ? 'Their number is on the SMS provider’s opt-out list, so TalkOlog texts them nothing until they reply START.'
            : `The SMS provider refused their number (${error}). Check the number in Team & numbers.`,
          err.optedOut
            ? noticeData('message_opted_out', { name: reporter.name })
            : noticeData('message_refused', { name: reporter.name, error }),
        );
        return;
      }
      throw err;
    }
    if (outcome.channel === null) {
      ctx.log.info('notify: nothing sent', {
        key: payload.key,
        reason: outcome.reason,
        detail: outcome.detail ?? null,
      });
      if (outcome.detail === 'console_real_org') {
        await officeNotice(
          'No SMS or WhatsApp sender is set for this organisation’s country in this environment, so the message reached no phone.',
          noticeData('message_no_sender', { name: reporter.name }),
        );
      }
    }
  };
}

export const notifyJob: JobHandler<'notify'> = createNotifyJob();
