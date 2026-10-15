import type { MessageChannel, MsgStatus } from '../enums.ts';

/**
 * The fallback walk between message channels (spec §4.5, §19 Q22 decided 2026-10-15: the second
 * option; W2-01). Pure, so the Notifier, the status callback's fallback job and the tests share
 * one rule:
 *
 * - One logical message (one dedupe key) walks the person's deliverable channels in order. Each
 *   attempt is its own `messages` row under the key (`payload.attempt`, 1, 2, …).
 * - An attempt that was sent (`sent`, `delivered`, `read`) ends the walk: a retry or a replay
 *   returns it and sends nothing on any channel.
 * - An attempt is final for its channel when it was refused for good (`undeliverable`) or when the
 *   provider accepted it and a status callback then failed it (`failed` with a provider message
 *   id). The next channel of the order is tried after it; never two channels for one message
 *   unless one has failed.
 * - Any other `queued` or `failed` attempt is pending: it is sent again on its own row (a retryable
 *   error retries the same channel through the job's backoff first). A pending attempt whose
 *   channel has left the order since (consent revoked, opted out) is abandoned: the walk moves on.
 */

/** One attempt of a logical message: a `messages` row under its dedupe key. */
export interface MessageAttempt {
  id: string;
  channel: MessageChannel | null;
  status: MsgStatus;
  provider: string | null;
  provider_message_id: string | null;
  error: string | null;
  /** `payload.error_code`: the provider's code of a refused send. */
  error_code: string | null;
  /** `payload.attempt`; a row written before W2-01 has none and counts as the first. */
  attempt: number;
}

/** What the Notifier does next for a logical message. */
export type AttemptPlan =
  /** An attempt went out: return it, send nothing. */
  | { kind: 'done'; attempt: MessageAttempt }
  /**
   * Send on `channel` as attempt number `attempt`: again on the row of `retry`, or on a new row.
   * `after` is the attempt the walk moves past to open this one (its `notify.attempt_failed`
   * audit); null for the first attempt and for a retry.
   */
  | {
      kind: 'send';
      channel: MessageChannel;
      attempt: number;
      retry: MessageAttempt | null;
      after: MessageAttempt | null;
    }
  /** Every channel of the order has failed for this message: `last` is the latest final attempt. */
  | { kind: 'exhausted'; last: MessageAttempt }
  /** No channel and no attempt. */
  | { kind: 'none' };

const SENT: readonly MsgStatus[] = ['sent', 'delivered', 'read', 'received'];

/** The attempt went out (the provider took it, or `console` wrote it). */
export function attemptWasSent(a: Pick<MessageAttempt, 'status'>): boolean {
  return SENT.includes(a.status);
}

/** The attempt failed for good on its channel: the walk tries the next channel after it. */
export function attemptIsFinal(a: Pick<MessageAttempt, 'status' | 'provider_message_id'>): boolean {
  if (a.status === 'undeliverable') return true;
  return a.status === 'failed' && a.provider_message_id !== null;
}

/** `payload.attempt` of a row (1 when absent or not a positive integer). */
export function attemptNumber(payload: unknown): number {
  const n = (payload as { attempt?: unknown } | null)?.attempt;
  return typeof n === 'number' && Number.isInteger(n) && n > 0 ? n : 1;
}

/**
 * The next step for a message whose deliverable channels are `order` (computed now:
 * `deliverableChannels`, the phone opt-out) and whose earlier attempts are `attempts`.
 */
export function planAttempt(
  order: readonly MessageChannel[],
  attempts: readonly MessageAttempt[],
): AttemptPlan {
  const sorted = [...attempts].sort((a, b) => a.attempt - b.attempt);
  const sent = sorted.findLast(attemptWasSent);
  if (sent) return { kind: 'done', attempt: sent };
  const failed = new Set<MessageChannel>();
  for (const a of sorted) if (a.channel !== null && attemptIsFinal(a)) failed.add(a.channel);
  // A pending attempt on a channel still in the order goes first, wherever that channel now is
  // in the order: it may have reached the person (a crash after the provider took it).
  const pending = sorted.findLast(
    (a) =>
      !attemptIsFinal(a) &&
      a.channel !== null &&
      order.includes(a.channel) &&
      !failed.has(a.channel),
  );
  if (pending) {
    return {
      kind: 'send',
      channel: pending.channel!,
      attempt: pending.attempt,
      retry: pending,
      after: null,
    };
  }
  const last = sorted.at(-1) ?? null;
  const next = order.find((c) => !failed.has(c));
  if (next) {
    return {
      kind: 'send',
      channel: next,
      attempt: last ? last.attempt + 1 : 1,
      retry: null,
      after: last,
    };
  }
  if (!last) return { kind: 'none' };
  return { kind: 'exhausted', last: sorted.findLast(attemptIsFinal) ?? last };
}
