import type { InboundMessage, InboundStatus, Json, MsgStatus, MsgType } from '@sitelog/shared';

/** Pure decisions of the webhook: sender → conversation target, message/status rows. */

export interface ReporterMatch {
  id: string;
  org_id: string;
  status: string;
}

export interface ConversationTarget {
  /** Set only when exactly one org owns this phone (§19 #1 shared number). */
  orgId: string | null;
  reporterId: string | null;
  /** When the phone belongs to reporters in several orgs the worker asks which site (§F12). */
  candidateReporterIds: string[];
}

export function resolveConversationTarget(reporters: readonly ReporterMatch[]): ConversationTarget {
  const active = reporters.filter((r) => r.status !== 'disabled');
  const orgIds = new Set(active.map((r) => r.org_id));
  const only = active[0];
  if (orgIds.size === 1 && only) {
    return { orgId: only.org_id, reporterId: only.id, candidateReporterIds: [] };
  }
  return { orgId: null, reporterId: null, candidateReporterIds: active.map((r) => r.id) };
}

export interface MessageInsert {
  conversation_id: string;
  direction: 'in';
  wa_message_id: string;
  type: MsgType;
  body: string | null;
  payload: Json;
  media_id: string | null;
  media_mime: string | null;
  status: 'received';
}

export function messageRow(m: InboundMessage, conversationId: string): MessageInsert {
  return {
    conversation_id: conversationId,
    direction: 'in',
    wa_message_id: m.waMessageId,
    type: m.type,
    body: m.body,
    payload: m.raw as unknown as Json,
    media_id: m.mediaId,
    media_mime: m.mediaMime,
    status: 'received',
  };
}

export interface ConversationSnapshot {
  org_id: string | null;
  reporter_id: string | null;
  context: Json;
  last_inbound_at: string | null;
}

export interface ConversationPatch {
  org_id?: string;
  reporter_id?: string;
  context?: Json;
  last_inbound_at?: string;
}

type JsonObject = { [key: string]: Json | undefined };

function asObject(value: Json | null | undefined): JsonObject {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
}

function sameIds(a: Json | undefined, b: readonly string[]): boolean {
  return Array.isArray(a) && a.length === b.length && a.every((x, i) => x === b[i]);
}

/**
 * What to change on an existing conversation for a new inbound message:
 * - `last_inbound_at` moves forward only (out-of-order deliveries never reopen an older window);
 * - an unassigned conversation (org_id null) is attached when the phone now resolves to one org;
 * - with several candidate orgs the candidates are kept in `context.candidate_reporter_ids`.
 * An already-attached conversation is never re-assigned here.
 */
export function conversationPatch(
  existing: ConversationSnapshot,
  target: ConversationTarget,
  sentAt: Date,
): ConversationPatch {
  const patch: ConversationPatch = {};
  const previous = existing.last_inbound_at ? new Date(existing.last_inbound_at).getTime() : NaN;
  if (Number.isNaN(previous) || sentAt.getTime() > previous) {
    patch.last_inbound_at = sentAt.toISOString();
  }
  if (existing.org_id !== null) return patch;

  const ctx = asObject(existing.context);
  if (target.orgId && target.reporterId) {
    patch.org_id = target.orgId;
    patch.reporter_id = target.reporterId;
    if ('candidate_reporter_ids' in ctx) {
      patch.context = Object.fromEntries(
        Object.entries(ctx).filter(([key]) => key !== 'candidate_reporter_ids'),
      );
    }
  } else if (
    target.candidateReporterIds.length > 0 &&
    !sameIds(ctx.candidate_reporter_ids, target.candidateReporterIds)
  ) {
    patch.context = { ...ctx, candidate_reporter_ids: target.candidateReporterIds };
  }
  return patch;
}

export interface ConversationInsert {
  phone_e164: string;
  org_id: string | null;
  reporter_id: string | null;
  state: 'new';
  context: Json;
  last_inbound_at: string;
}

export function newConversationRow(
  phone: string,
  target: ConversationTarget,
  sentAt: Date,
): ConversationInsert {
  return {
    phone_e164: phone,
    org_id: target.orgId,
    reporter_id: target.reporterId,
    state: 'new',
    context:
      target.candidateReporterIds.length > 0
        ? { candidate_reporter_ids: target.candidateReporterIds }
        : {},
    last_inbound_at: sentAt.toISOString(),
  };
}

const DELIVERY_STATUS: Record<string, MsgStatus> = {
  sent: 'sent',
  delivered: 'delivered',
  read: 'read',
  failed: 'failed',
};

const STATUS_RANK: Record<MsgStatus, number> = {
  received: 0,
  queued: 1,
  sent: 2,
  delivered: 3,
  read: 4,
  failed: 5,
  // SMS only (v1.2): terminal like `failed`; Meta never reports it, and no WhatsApp delivery
  // status moves a message out of it.
  undeliverable: 5,
};

/** Meta status webhook → `messages.status`; null for statuses we do not track (deleted, warning). */
export function mapDeliveryStatus(status: string): MsgStatus | null {
  return DELIVERY_STATUS[status] ?? null;
}

/** Statuses that may still be moved to `status` (delivery statuses only move forward). */
export function statusesBelow(status: MsgStatus): MsgStatus[] {
  return (Object.keys(STATUS_RANK) as MsgStatus[]).filter(
    (s) => STATUS_RANK[s] < STATUS_RANK[status],
  );
}

export interface StatusUpdate {
  waMessageId: string;
  patch: { status: MsgStatus; error?: string };
  /** Only rows currently in one of these statuses are updated; null = unconditional. */
  onlyIfIn: MsgStatus[] | null;
}

export function statusUpdate(s: InboundStatus): StatusUpdate | null {
  const status = mapDeliveryStatus(s.status);
  if (!status) return null;
  return {
    waMessageId: s.waMessageId,
    patch: s.error ? { status, error: s.error } : { status },
    onlyIfIn: status === 'failed' ? null : statusesBelow(status),
  };
}

/** "+15550143378" → "+1555***378" for logs (phone numbers are customer data, §15). */
export function maskPhone(e164: string): string {
  const digits = e164.replace(/\D/g, '');
  if (digits.length < 7) return '***';
  return `+${digits.slice(0, 4)}***${digits.slice(-3)}`;
}

export function inboundDedupeKey(waMessageId: string): string {
  return `inbound:${waMessageId}`;
}
