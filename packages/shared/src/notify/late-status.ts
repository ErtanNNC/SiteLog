import type { MessageChannel, MsgStatus } from '../enums.ts';
import { noticeData, type NoticeData } from '../notifications.ts';
import type { JobPayloads } from '../schemas/jobs.ts';
import type { ReporterRow } from '../db/types.ts';
import { nextMessageStatus } from '../sms/twilio.ts';
import { lateFallback, messageDedupeKey } from './fallback.ts';

/**
 * A delivery status that arrives after the send (spec §4.5; W1-08, W2-01, W4-11): a Twilio
 * status callback (sms-webhook `/status`) or an İletimerkezi delivery report read by the worker's
 * `sms_status` job (spec §19 Q237). One code path for both, so a TR text that fails falls back
 * and tells the office exactly as a US one does:
 *
 * - the row moves through the §4.5 statuses, never backwards (`nextMessageStatus`), audited
 *   `sms.status` / `whatsapp.status` with `from`, `to` and the provider's code;
 * - a final failure (`failed` / `undeliverable`) of a text: when it is the account's or the
 *   sender's fault, the office hears about the account once per org per hour (`sms.provider_fault`,
 *   the reporter is never blamed); otherwise, for a welcome, F3 "Can't reach this number"
 *   (`reporter.invite_failed`); a WhatsApp failure is neither (W2-15);
 * - either way, a Notifier message goes on to the person's next channel (`lateFallback`, the
 *   `notify` job keyed `jobKeys.notifyAfter`), and that job tells the office (`message_failed`)
 *   once when no channel is left (W2-01).
 */

/** A §13 notice of a late failure (`reporter_invite_failed` / `message_failed`, admin and ops). */
export interface LateStatusNotice {
  orgId: string;
  kind: 'reporter_invite_failed' | 'message_failed';
  title: string;
  body: string;
  targetPath: string;
  /** What the panel renders in the reader's language; title and body are the English fallback. */
  data: NoticeData;
}

/** The office's notice of a welcome text the carrier could not deliver to the number. */
export function inviteFailedNotification(
  reporter: { org_id: string; name: string },
  error: string,
): LateStatusNotice {
  return {
    orgId: reporter.org_id,
    kind: 'reporter_invite_failed',
    title: `${reporter.name}: the welcome text could not be delivered`,
    body: `The carrier could not deliver the welcome text (${error}): the number may be a landline, blocked or out of service. Check it on Team & numbers, or contact them another way.`,
    targetPath: '/team',
    data: noticeData('welcome_carrier_undelivered', { name: reporter.name, error }),
  };
}

/**
 * The office's notice of a welcome text that failed for the account or the sender (Twilio
 * `failed`, or `undelivered` with a code that is not the number's: 30032 toll-free sender not
 * verified, 30034 unregistered 10DLC, 30002 account suspended, …). The wording follows
 * send_welcome's provider-fault notice; the reporter is never blamed.
 */
export function providerFaultNotification(
  orgId: string,
  reporterName: string | null,
  error: string,
): LateStatusNotice {
  return {
    orgId,
    kind: 'reporter_invite_failed',
    title: reporterName
      ? `${reporterName}: the welcome text failed at the SMS provider`
      : 'A welcome text failed at the SMS provider',
    body: `Texts are failing for this account (${error}). The SMS provider accepted the welcome text and then refused it for the account or the sender, not for the reporter's number. Re-send the welcome from Team & numbers once the provider account is fixed. Other texts that fail this way in the next hour are not notified again.`,
    targetPath: '/team',
    data: noticeData('welcome_account_fault', { name: reporterName, error }),
  };
}

/**
 * The same notice for any other text (a Notifier message, a device code, an inline text; W2-01
 * follow-up): the account is at fault, not the reporter's number. It stands for every text that
 * fails this way within the hour, so the `notify` job's fallback posts no per-message
 * `message_failed` for it (`attemptIsAccountFault`); the fallback still tries the person's next
 * channel, if any.
 */
export function messageAccountFaultNotification(
  orgId: string,
  reporterName: string | null,
  error: string,
): LateStatusNotice {
  return {
    orgId,
    kind: 'message_failed',
    title: reporterName
      ? `${reporterName}: a text to them failed at the SMS provider`
      : 'A text failed at the SMS provider',
    body: `Texts are failing for this account (${error}). The SMS provider accepted the text and then refused it for the account or the sender, not for the reporter's number. TalkOlog tries their other message channels, if they have any. Other texts that fail this way in the next hour are not notified again.`,
    targetPath: '/team',
    data: noticeData('message_account_fault', { name: reporterName, error }),
  };
}

/** One account-fault notice per org per hour (late failures come one per failed text). */
export const PROVIDER_FAULT_NOTICE_MS = 60 * 60 * 1000;

/** The outbound row a late status is about. */
export interface LateStatusMessage {
  id: string;
  status: MsgStatus;
  org_id: string | null;
  reporter_id: string | null;
  copy_key: string | null;
  /** `messages.payload`: the Notifier's dedupe key and attempt (W2-01). */
  payload?: unknown;
  /** `messages.channel`: `sms`, or `whatsapp` (Twilio posts both to `/status`). */
  channel?: MessageChannel | null;
}

export interface LateStatusAudit {
  orgId: string | null;
  actorType: 'system';
  action: string;
  entity: 'reporter' | 'message';
  entityId: string | null;
  diff: Record<string, unknown>;
}

/** What `applyLateStatus` reads and writes: sms-webhook's store, or the worker's Db. */
export interface LateStatusStore {
  updateMessageStatus(id: string, status: MsgStatus, error: string | null): Promise<void>;
  audit(entry: LateStatusAudit): Promise<void>;
  /** The payload of the `notify` job that sent under this Notifier dedupe key (the first), or null. */
  notifyJobByDedupeKey(dedupeKey: string): Promise<JobPayloads['notify'] | null>;
  /** `enqueue_job('notify', …)` under its job key; a taken key returns that job (D16). */
  enqueueNotify(payload: JobPayloads['notify'], dedupeKey: string): Promise<number>;
  reporterForInvite(
    id: string,
  ): Promise<Pick<ReporterRow, 'id' | 'org_id' | 'name' | 'status'> | null>;
  setInviteError(id: string, error: string): Promise<void>;
  /** An `sms.provider_fault` audit row with `notified: true` for the org since `since`. */
  providerFaultNotifiedSince(orgId: string, since: string): Promise<boolean>;
  notifyOrg(n: LateStatusNotice): Promise<void>;
}

export interface LateStatusLog {
  info(event: string, data: Record<string, unknown>): void;
  error(event: string, err: Error, data: Record<string, unknown>): void;
}

export interface LateStatusInput {
  message: LateStatusMessage;
  /** The status the provider reports, as a §4.5 status. */
  incoming: MsgStatus;
  /** `messages.error` to write with it (`twilio 30005`, `iletimerkezi report 112`), or null. */
  error: string | null;
  /** The provider's code, as audited. */
  errorCode: string | null;
  /** The failure is the account's or the sender's, not the number's (Twilio's codes; never İletimerkezi's report). */
  accountFault: boolean;
  /** How the status arrived: Twilio's callback, or the İletimerkezi report poll (W4-11). */
  via: 'status_callback' | 'report_poll';
  /** What the failure is called when the provider gave no error text (`twilio undelivered`). */
  reason?: string;
}

export interface LateStatusDeps {
  store: LateStatusStore;
  now: () => Date;
  log?: LateStatusLog;
}

/**
 * Applies a late status to its row (see the module comment). Returns the status the row moved
 * to, or null when it stays (the same status, or a step back). Idempotent: a repeated status
 * moves nothing and so does nothing else; the fallback job's key is per failed attempt.
 */
export async function applyLateStatus(
  deps: LateStatusDeps,
  input: LateStatusInput,
): Promise<MsgStatus | null> {
  const { store, now } = deps;
  const log = deps.log ?? { info: () => undefined, error: () => undefined };
  const { message } = input;
  const to = nextMessageStatus(message.status, input.incoming);
  if (!to) return null;
  const whatsapp = message.channel === 'whatsapp';
  await store.updateMessageStatus(message.id, to, input.error);
  await store.audit({
    orgId: message.org_id,
    actorType: 'system',
    action: whatsapp ? 'whatsapp.status' : 'sms.status',
    entity: 'message',
    entityId: message.id,
    diff: {
      from: message.status,
      to,
      error_code: input.errorCode,
      ...(input.via === 'report_poll' ? { via: input.via } : {}),
    },
  });
  if (to !== 'undeliverable' && to !== 'failed') return to;
  if (whatsapp) {
    // W2-15: a WhatsApp message Twilio took and then could not deliver: never a texts-account
    // notice nor "Can't reach this number" (the welcome is never on WhatsApp); the message goes on
    // the person's next channel (W2-01), and the office hears only if every channel fails.
    await fallBack(to);
    return to;
  }
  const reason = input.error ?? input.reason ?? `${input.via} ${to}`;
  if (input.accountFault) await providerFault(to, reason);
  else if (message.copy_key === 'welcome') await flagInviteFailure(reason);
  // Either way the message may still reach the person on their next channel (W2-01); an account
  // fault adds no per-message `message_failed` when none is left (the notify job).
  await fallBack(to);
  return to;

  async function fallBack(status: 'undeliverable' | 'failed'): Promise<void> {
    const messageKey = messageDedupeKey(message.payload ?? null);
    if (!messageKey || !message.reporter_id) return;
    const sentBy = await store.notifyJobByDedupeKey(messageKey);
    const fallback = lateFallback({ ...message, payload: message.payload ?? null }, status, sentBy);
    if (fallback.kind !== 'enqueue') {
      log.info('sms.status.no_fallback', { messageId: message.id, reason: fallback.reason });
      return;
    }
    const jobId = await store.enqueueNotify(fallback.payload, fallback.dedupeKey);
    await store.audit({
      orgId: message.org_id,
      actorType: 'system',
      action: 'notify.fallback_queued',
      entity: 'message',
      entityId: message.id,
      diff: { copy_key: message.copy_key, dedupe_key: messageKey, status, job_id: jobId },
    });
  }

  async function flagInviteFailure(error: string): Promise<void> {
    if (!message.reporter_id) return;
    const reporter = await store.reporterForInvite(message.reporter_id);
    // Nothing to flag once they replied (active), opted out, or the office disabled them.
    if (!reporter || reporter.status !== 'invited') return;
    await store.setInviteError(reporter.id, error.slice(0, 300));
    await store.notifyOrg(inviteFailedNotification(reporter, error));
    await store.audit({
      orgId: reporter.org_id,
      actorType: 'system',
      action: 'reporter.invite_failed',
      entity: 'reporter',
      entityId: reporter.id,
      diff: { error, status: 'undeliverable', message_id: message.id, via: input.via },
    });
    log.info('sms.status.invite_failed', { reporterId: reporter.id });
  }

  async function providerFault(status: 'undeliverable' | 'failed', error: string): Promise<void> {
    if (!message.org_id) return;
    const at = now();
    const since = new Date(at.getTime() - PROVIDER_FAULT_NOTICE_MS).toISOString();
    const notified = !(await store.providerFaultNotifiedSince(message.org_id, since));
    if (notified) {
      const reporter = message.reporter_id
        ? await store.reporterForInvite(message.reporter_id)
        : null;
      const name = reporter?.name ?? null;
      await store.notifyOrg(
        message.copy_key === 'welcome'
          ? providerFaultNotification(message.org_id, name, error)
          : messageAccountFaultNotification(message.org_id, name, error),
      );
    }
    await store.audit({
      orgId: message.org_id,
      actorType: 'system',
      action: 'sms.provider_fault',
      entity: 'message',
      entityId: message.id,
      diff: {
        error,
        code: input.errorCode,
        status,
        reporter_id: message.reporter_id,
        copy_key: message.copy_key,
        via: input.via,
        notified,
        at: at.toISOString(),
      },
    });
    log.error('sms.status.provider_fault', new Error(error), {
      messageId: message.id,
      orgId: message.org_id,
      code: input.errorCode,
      notified,
    });
  }
}
