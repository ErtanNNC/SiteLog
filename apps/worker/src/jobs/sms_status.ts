import {
  applyLateStatus,
  iletimerkeziOrderId,
  iletimerkeziReportErrorText,
  IletimerkeziReportError,
  jobKeys,
  reportVerdict,
  SMS_STATUS_POLL_OFFSETS_MS,
  SMS_STATUS_POLLS,
  type LateStatusStore,
} from '@sitelog/shared';
import type { Ctx } from '../context';
import type { Db } from '../db';
import { workerIletimerkeziReports } from '../messaging';
import { PermanentJobError, type JobHandler } from './types';

/**
 * `sms_status` (W4-11, spec §4.5, §19 Q237 recommended: `ILETIMERKEZI_STATUS=poll`): the delivery
 * report of one İletimerkezi text. `enqueue_sms_status_poll()` (SQL, 20261017000440) queues poll 1
 * when the row becomes `sent`, at +2 min; each poll that finds no final answer queues the next at
 * `sentAt` + 15 min, then + 2 h (`SMS_STATUS_POLL_OFFSETS_MS`, keys `jobKeys.smsStatus`).
 *
 * - The row is no longer `sent` (a later status, or not an İletimerkezi row): nothing to do.
 * - `delivered` / `undelivered` in the report: `applyLateStatus` moves the row (never backwards,
 *   audited `sms.status` with `via: report_poll`); an undelivered text is the number's, so a
 *   welcome flags "Can't reach this number" and a Notifier message goes on to the person's next
 *   channel, whose `notify` job tells the office once (`message_failed`) when none is left.
 * - Not ready, pending, unknown, or the recipient not listed: the next poll; after the last the
 *   row stays `sent`, audited `sms.status_unresolved`.
 * - HTTP 429 / 5xx / network: thrown, so the job's backoff retries this poll. Any other refusal of
 *   the report (credentials, an answer the parser does not know): audited `sms.status_poll_failed`
 *   and the next poll is queued as if the report were not ready; nothing about the text changes.
 * - No report source (`ILETIMERKEZI_STATUS=off`, no credentials, or the report endpoint not
 *   confirmed yet, §19 Q280): logged, the row stays `sent`, as before W4-11.
 */
export const smsStatusJob: JobHandler<'sms_status'> = async (ctx, payload) => {
  const message = await ctx.db.getMessage(payload.messageId);
  if (!message) throw new PermanentJobError(`message ${payload.messageId} not found`);
  const log = ctx.log.child({ message_id: message.id, poll: payload.poll });
  if (message.provider !== 'iletimerkezi' || message.status !== 'sent') {
    log.info('sms_status: nothing to read', { status: message.status });
    return;
  }
  const orderId = iletimerkeziOrderId(message.provider_message_id);
  if (!orderId) throw new PermanentJobError(`message ${message.id} has no İletimerkezi order id`);
  const reports =
    ctx.iletimerkeziReports !== undefined
      ? ctx.iletimerkeziReports
      : workerIletimerkeziReports(ctx.config);
  if (!reports) {
    log.warn('sms_status: no İletimerkezi report source; the row stays sent (spec §19 Q280)', {
      status_mode: ctx.config.ILETIMERKEZI_STATUS,
    });
    return;
  }

  let verdict: ReturnType<typeof reportVerdict>;
  try {
    verdict = reportVerdict(await reports.report(orderId), message.phone_e164);
  } catch (err) {
    if (!(err instanceof IletimerkeziReportError) || err.retryable) throw err;
    await ctx.db.logAudit({
      org_id: message.org_id,
      actor_type: 'system',
      action: 'sms.status_poll_failed',
      entity: 'message',
      entity_id: message.id,
      diff: { poll: payload.poll, error: err.message.slice(0, 200), http_status: err.status },
    });
    log.error('sms_status: the report was refused', { err });
    await nextPoll(ctx, payload, message.org_id);
    return;
  }

  if (verdict.status === null) {
    log.info('sms_status: not final yet', { delivery: verdict.delivery });
    await nextPoll(ctx, payload, message.org_id, verdict.delivery, verdict.code);
    return;
  }
  const moved = await applyLateStatus(
    {
      store: workerLateStatusStore(ctx.db),
      now: ctx.now,
      log: {
        info: (event, data) => log.info(event, data),
        error: (event, err, data) => log.error(event, { ...data, err }),
      },
    },
    {
      message,
      incoming: verdict.status,
      error: verdict.status === 'delivered' ? null : iletimerkeziReportErrorText(verdict.code),
      errorCode: verdict.code,
      // The report speaks of the recipient: an undelivered text is the number's (spec §19 Q280).
      accountFault: false,
      via: 'report_poll',
    },
  );
  log.info('sms_status: final', { status: verdict.status, moved });
};

/** Poll n + 1 at `sentAt` + its offset, or the end of the polls (`sms.status_unresolved`). */
async function nextPoll(
  ctx: Ctx,
  payload: { messageId: string; poll: number; sentAt: string },
  orgId: string | null,
  delivery: string = 'pending',
  code: string | null = null,
): Promise<void> {
  if (payload.poll >= SMS_STATUS_POLLS) {
    await ctx.db.logAudit({
      org_id: orgId,
      actor_type: 'system',
      action: 'sms.status_unresolved',
      entity: 'message',
      entity_id: payload.messageId,
      diff: { polls: payload.poll, delivery, code, sent_at: payload.sentAt },
    });
    return;
  }
  const poll = payload.poll + 1;
  const runAfter = new Date(
    new Date(payload.sentAt).getTime() + SMS_STATUS_POLL_OFFSETS_MS[poll - 1]!,
  );
  await ctx.db.enqueueJob(
    'sms_status',
    { messageId: payload.messageId, poll, sentAt: payload.sentAt },
    { dedupeKey: jobKeys.smsStatus(payload.messageId, poll), runAfter },
  );
}

/** `applyLateStatus`'s store over the worker Db (sms-webhook's store_supabase.ts does the same). */
export function workerLateStatusStore(db: Db): LateStatusStore {
  return {
    updateMessageStatus: (id, status, error) => db.updateSmsMessage(id, { status, error }),
    audit: (entry) =>
      db.logAudit({
        org_id: entry.orgId,
        actor_type: entry.actorType,
        action: entry.action,
        entity: entry.entity,
        entity_id: entry.entityId,
        diff: entry.diff,
      }),
    notifyJobByDedupeKey: (key) => db.notifyJobByDedupeKey(key),
    enqueueNotify: (payload, jobKey) => db.enqueueJob('notify', payload, { dedupeKey: jobKey }),
    async reporterForInvite(id) {
      const r = await db.getReporter(id);
      return r ? { id: r.id, org_id: r.org_id, name: r.name, status: r.status } : null;
    },
    setInviteError: async (id, error) => {
      await db.updateReporter(id, { last_invite_error: error });
    },
    providerFaultNotifiedSince: (orgId, since) => db.providerFaultNotifiedSince(orgId, since),
    notifyOrg: async (n) => {
      await db.notifyOrg(n.orgId, n.kind, n.title, n.body, n.targetPath, null, n.data);
    },
  };
}
