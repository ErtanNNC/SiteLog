import type { MsgStatus } from '../enums.ts';
import { jobKeys, type JobPayloads } from '../schemas/jobs.ts';

/**
 * The fallback after a late status callback (spec §19 Q22, the second option; W2-01): an attempt
 * the provider took and then reported `failed` or `undeliverable` hands its message to the next
 * channel of the order. The status route (sms-webhook `/status`; the WhatsApp one in W2-16)
 * enqueues a `notify` job for it; the job re-runs the key's guard (is the message still useful?)
 * and the Notifier's walk, which skips the failed channel and sends on the next one, or reports
 * that every channel has failed (`message_failed`, §13).
 *
 * The job needs the message's variables, which hold link codes: `messages` never stores them (its
 * body is masked for real orgs), so they come from the `notify` job that sent the message. A
 * message sent outside a `notify` job (the welcome of `send_welcome`, the device code, the texts
 * the panel sends inline) has none and gets no late fallback; its attempts still fall back at send
 * time. `decide_next`'s `question_ready` and `draft_ready` are `notify` jobs since W2-07.
 */

/** The outbound row a status callback moved, as the status route reads it. */
export interface CallbackMessage {
  id: string;
  reporter_id: string | null;
  copy_key: string | null;
  /** `messages.payload`: the Notifier's dedupe key. */
  payload: unknown;
}

export type LateFallback =
  | { kind: 'enqueue'; payload: JobPayloads['notify']; dedupeKey: string }
  | {
      kind: 'none';
      reason: 'not_final' | 'not_notifier' | 'no_job';
    };

/** The Notifier's dedupe key of a `messages` row, if any. */
export function messageDedupeKey(payload: unknown): string | null {
  const key = (payload as { dedupe_key?: unknown } | null)?.dedupe_key;
  return typeof key === 'string' && key.length > 0 ? key : null;
}

/**
 * What a callback that moved `message` to `status` asks for. `sentBy` is the payload of the
 * `notify` job whose `dedupeKey` is the message's (`notifyJobByDedupeKey` of the store), or null.
 */
export function lateFallback(
  message: CallbackMessage,
  status: MsgStatus,
  sentBy: JobPayloads['notify'] | null,
): LateFallback {
  if (status !== 'failed' && status !== 'undeliverable')
    return { kind: 'none', reason: 'not_final' };
  const dedupeKey = messageDedupeKey(message.payload);
  if (!message.reporter_id || !message.copy_key || !dedupeKey) {
    return { kind: 'none', reason: 'not_notifier' };
  }
  if (
    !sentBy ||
    sentBy.reporterId !== message.reporter_id ||
    sentBy.key !== message.copy_key ||
    sentBy.dedupeKey !== dedupeKey
  ) {
    return { kind: 'none', reason: 'no_job' };
  }
  return {
    kind: 'enqueue',
    payload: {
      reporterId: sentBy.reporterId,
      key: sentBy.key,
      vars: sentBy.vars,
      dedupeKey,
      afterMessageId: message.id,
      ...(sentBy.guard ? { guard: sentBy.guard } : {}),
      ...(sentBy.reportGuard ? { reportGuard: sentBy.reportGuard } : {}),
    },
    dedupeKey: jobKeys.notifyAfter(dedupeKey, message.id),
  };
}
