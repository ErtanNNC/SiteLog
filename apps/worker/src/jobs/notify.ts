import { SmsSendError, type NotifierKey, type SmsVars } from '@sitelog/shared';
import type { JobHandler } from './types';

/**
 * §10.1 `notify(reporter_id, key, vars, dedupe_key)` (GAP D48; W1-10): one message to a field
 * reporter through the Notifier (spec §4.5, W1-08), which picks the channel from the person's
 * order in the country pack, renders the §9.2 text in their language, sends it on the pack's
 * driver and writes the `messages` row and its audit. The payload's `dedupeKey` is the logical
 * message's key (`notify:filed:{report_id}`): the job's dedupe key (one job per message, D16) and
 * the Notifier's (a retry after a send never texts twice).
 *
 * - Sent, or nothing deliverable (no consent, opted out, a disabled reporter): done; the Notifier
 *   audited what it did. A real org whose pack has no sender id here (`console_real_org`) reaches
 *   no phone, so the office is told (§13 "Message undeliverable / opted out", `message_failed`).
 * - Refused for good (`SmsSendError` not retryable: a bad number, the provider's opt-out list):
 *   the Notifier marked the row and recorded an opt-out; the office is told, no retry.
 * - A provider outage or an account fault (retryable, or not the number's fault): thrown, so the
 *   queue retries with backoff; a job that dies tells the office (src/dead-jobs.ts).
 */
export const notifyJob: JobHandler<'notify'> = async (ctx, payload) => {
  const reporter = await ctx.db.getReporter(payload.reporterId);
  if (!reporter) {
    ctx.log.warn('notify: reporter not found', { reporter_id: payload.reporterId });
    return;
  }
  const officeNotice = async (body: string) => {
    await ctx.db.notifyOrg(
      reporter.org_id,
      'message_failed',
      `${reporter.name}: a message to them was not sent`,
      body,
      '/team',
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

  let outcome;
  try {
    outcome = await ctx.notifier.send(
      reporter.id,
      payload.key as NotifierKey,
      payload.vars as SmsVars<NotifierKey>,
      { dedupeKey: payload.dedupeKey },
    );
  } catch (err) {
    if (err instanceof SmsSendError && !err.retryable && (err.undeliverable || err.optedOut)) {
      await officeNotice(
        err.optedOut
          ? 'Their number is on the SMS provider’s opt-out list, so SiteLog texts them nothing until they reply START.'
          : `The SMS provider refused their number (${err.message.slice(0, 200)}). Check the number in Team & numbers.`,
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
      );
    }
  }
};
