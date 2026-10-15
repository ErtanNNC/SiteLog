import {
  MessageSendError,
  SmsSendError,
  noticeData,
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
 *   the Notifier marked the rows and recorded an opt-out; the office is told, no retry.
 * - A provider outage or an account fault (retryable, or not the number's fault): thrown, so the
 *   queue retries with backoff; a job that dies tells the office (src/dead-jobs.ts).
 * - The fallback after a late status callback (`afterMessageId`, enqueued by sms-webhook's
 *   `/status`, `lateFallback`) first runs the key's guard: a message no longer useful is dropped
 *   (audited `notify.fallback_dropped`); otherwise the Notifier's walk skips the failed attempt.
 */

/** Whether a message is still worth sending when its fallback runs after a late callback. */
export type NotifyGuard = (ctx: Ctx, payload: JobPayloads['notify']) => Promise<boolean>;

/**
 * The guards per key (W2-01). None yet: W2-06 adds the reminder ladder's site-day check, W2-07
 * the open question and the unconfirmed draft. A key with no guard is still useful.
 */
export const NOTIFY_FALLBACK_GUARDS: Partial<Record<NotifierKey, NotifyGuard>> = {};

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
    }

    let outcome;
    try {
      outcome = await ctx.notifier.send(reporter.id, key, payload.vars as SmsVars<NotifierKey>, {
        dedupeKey: payload.dedupeKey,
      });
    } catch (err) {
      if (
        err instanceof MessageSendError &&
        !err.retryable &&
        (err.undeliverable || err.optedOut)
      ) {
        const error = err.message.slice(0, 200);
        const attempts = await ctx.db.listMessagesByDedupeKey(reporter.id, payload.dedupeKey);
        const channels = [...new Set(attempts.flatMap((a) => (a.channel ? [a.channel] : [])))].join(
          ', ',
        );
        if (!(err instanceof SmsSendError) || channels.includes(',')) {
          // More than SMS was tried: every channel of the order failed (§19 Q22, §13).
          await officeNotice(
            `SiteLog tried every message channel it has for them (${channels}) and none could deliver the message (${error}). Check their number and channels in Team & numbers.`,
            noticeData('message_channels_failed', { name: reporter.name, channels, error }),
          );
          return;
        }
        await officeNotice(
          err.optedOut
            ? 'Their number is on the SMS provider’s opt-out list, so SiteLog texts them nothing until they reply START.'
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
          'No SMS sender is set for this organisation’s country in this environment, so the text reached no phone.',
          noticeData('message_no_sender', { name: reporter.name }),
        );
      }
    }
  };
}

export const notifyJob: JobHandler<'notify'> = createNotifyJob();
