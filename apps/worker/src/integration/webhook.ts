import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Sql } from 'postgres';
import { pgArray } from '../db';
import {
  JobPayloadSchemas,
  metaSignature,
  normalizeWebhook,
  verifyMetaSignature,
  type InboundMessage,
  type InboundStatus,
} from '@sitelog/shared';
// The webhook's pure decisions, imported from the edge function itself (type-only imports of
// @sitelog/shared, so the file resolves in Node as well as in Deno).
import {
  conversationPatch,
  inboundDedupeKey,
  messageRow,
  newConversationRow,
  resolveConversationTarget,
  statusUpdate,
  type ConversationPatch,
  type ConversationSnapshot,
  type ConversationTarget,
  type ReporterMatch,
} from '../../../../supabase/functions/whatsapp-webhook/logic.ts';

/**
 * The POST half of supabase/functions/whatsapp-webhook/index.ts, step for step, on postgres.js
 * instead of supabase-js/PostgREST (PGlite has no PostgREST): verify X-Hub-Signature-256 →
 * normalizeWebhook → per message: reporters by phone → resolveConversationTarget → find / patch /
 * insert the conversation (23505 race → reuse the winner) → `insert … on conflict (wa_message_id)
 * do nothing returning id` (duplicate delivery → no row → no job) → `enqueue_job('inbound_message',
 * …, dedupe 'inbound:<wamid>')`; then the delivery statuses. Same summary and status codes.
 *
 * One deliberate difference: `receivedAt` (optional) sets messages.created_at. The edge function
 * leaves it to the column default (now()); tests and the load test run the worker on an injected
 * clock, and the worker reads created_at (report received_at, photo windows, storage paths), so the
 * row must carry the same clock's time.
 */

export interface WebhookResult {
  status: number;
  body: {
    ok: boolean;
    received?: number;
    stored?: number;
    duplicates?: number;
    failed?: number;
    statuses?: number;
    reason?: string;
    error?: string;
  };
  /** messages.id of every stored (non-duplicate) message, in payload order. */
  messageIds: string[];
}

export interface DeliverOptions {
  /** messages.created_at for the stored rows (see above). Default: the column default, now(). */
  receivedAt?: Date;
}

export async function handleWebhookPost(
  sql: Sql,
  raw: string,
  signatureHeader: string | null,
  appSecret: string,
  opts: DeliverOptions = {},
): Promise<WebhookResult> {
  const signed = await verifyMetaSignature(raw, signatureHeader, appSecret);
  if (!signed)
    return { status: 401, body: { ok: false, error: 'Invalid signature' }, messageIds: [] };

  let normalized: { messages: InboundMessage[]; statuses: InboundStatus[] };
  try {
    normalized = normalizeWebhook(JSON.parse(raw));
  } catch {
    // A signed payload we cannot parse will not get better on retry: acknowledge it.
    return { status: 200, body: { ok: false, reason: 'unparseable' }, messageIds: [] };
  }

  const summary = {
    received: normalized.messages.length,
    stored: 0,
    duplicates: 0,
    failed: 0,
    statuses: 0,
  };
  const messageIds: string[] = [];
  for (const message of normalized.messages) {
    try {
      const id = await storeInbound(sql, message, opts);
      if (id) {
        summary.stored += 1;
        messageIds.push(id);
      } else summary.duplicates += 1;
    } catch {
      summary.failed += 1;
    }
  }
  for (const status of normalized.statuses) {
    try {
      await applyStatus(sql, status);
      summary.statuses += 1;
    } catch {
      /* logged and ignored by the edge function */
    }
  }
  if (summary.failed > 0) return { status: 500, body: { ok: false, ...summary }, messageIds };
  return { status: 200, body: { ok: true, ...summary }, messageIds };
}

/** Returns the new messages.id, or null for a duplicate delivery. */
async function storeInbound(
  sql: Sql,
  m: InboundMessage,
  opts: DeliverOptions,
): Promise<string | null> {
  const reporters = await sql<ReporterMatch[]>`
    select id, org_id, status::text as status from reporters
    where phone_e164 = ${m.phoneE164} and status <> 'disabled'`;
  const target = resolveConversationTarget(reporters);
  const conversationId = await upsertConversation(sql, m, target);

  const row = messageRow(m, conversationId);
  const inserted = await sql<Array<{ id: string }>>`
    insert into messages (conversation_id, direction, wa_message_id, type, body, payload, media_id, media_mime, status, created_at)
    values (${row.conversation_id}, ${row.direction}, ${row.wa_message_id}, ${row.type}, ${row.body},
            ${sql.json(row.payload as never)}, ${row.media_id}, ${row.media_mime}, ${row.status},
            coalesce(${opts.receivedAt ? opts.receivedAt.toISOString() : null}::timestamptz, now()))
    on conflict (wa_message_id) do nothing
    returning id`;
  const messageId = inserted[0]?.id;
  if (!messageId) return null;

  const payload = JobPayloadSchemas.inbound_message.parse({ messageId });
  await sql`select enqueue_job(${'inbound_message'}, ${sql.json(payload as never)}, ${null}, ${inboundDedupeKey(m.waMessageId)})`;
  return messageId;
}

async function upsertConversation(
  sql: Sql,
  m: InboundMessage,
  target: ConversationTarget,
): Promise<string> {
  const existing = await findConversation(sql, m.phoneE164);
  if (existing) {
    await patchConversation(sql, existing.id, conversationPatch(existing, target, m.sentAt));
    return existing.id;
  }
  const row = newConversationRow(m.phoneE164, target, m.sentAt);
  try {
    const created = await sql<Array<{ id: string }>>`
      insert into conversations (phone_e164, org_id, reporter_id, state, context, last_inbound_at)
      values (${row.phone_e164}, ${row.org_id}, ${row.reporter_id}, ${row.state}, ${sql.json(row.context as never)}, ${row.last_inbound_at})
      returning id`;
    return created[0]!.id;
  } catch (err) {
    if ((err as { code?: string }).code !== '23505') throw err;
    // Lost a race with a concurrent delivery for the same phone: reuse the row it created.
    const raced = await findConversation(sql, m.phoneE164);
    if (!raced) throw err;
    await patchConversation(sql, raced.id, conversationPatch(raced, target, m.sentAt));
    return raced.id;
  }
}

async function findConversation(
  sql: Sql,
  phone: string,
): Promise<(ConversationSnapshot & { id: string }) | null> {
  const rows = await sql<Array<ConversationSnapshot & { id: string }>>`
    select id, org_id, reporter_id, context, last_inbound_at from conversations where phone_e164 = ${phone}`;
  return rows[0] ?? null;
}

async function patchConversation(sql: Sql, id: string, patch: ConversationPatch): Promise<void> {
  const entries = Object.entries(patch).filter(([, v]) => v !== undefined);
  if (entries.length === 0) return;
  const frags = entries.map(
    ([k, v]) => sql`${sql(k)} = ${k === 'context' ? sql.json(v as never) : (v as string)}`,
  );
  const set = frags.reduce((acc, f) => sql`${acc}, ${f}`);
  await sql`update conversations set ${set} where id = ${id}`;
}

async function applyStatus(sql: Sql, s: InboundStatus): Promise<void> {
  const update = statusUpdate(s);
  if (!update) return;
  const set =
    update.patch.error !== undefined
      ? sql`status = ${update.patch.status}, error = ${update.patch.error}`
      : sql`status = ${update.patch.status}`;
  const only = update.onlyIfIn
    ? sql`and status = any(${pgArray(update.onlyIfIn)}::msg_status[])`
    : sql``;
  await sql`update messages set ${set} where wa_message_id = ${update.waMessageId} ${only}`;
}

// ───────────────────────────── Meta payloads ─────────────────────────────

const FIXTURES = join(import.meta.dirname, '..', '..', '..', '..', 'fixtures');

/** A recorded webhook body from fixtures/webhooks (parsed). */
export function webhookFixture(name: string): MetaPayload {
  return JSON.parse(readFileSync(join(FIXTURES, 'webhooks', name), 'utf8')) as MetaPayload;
}

type Dict = Record<string, unknown>;
export interface MetaPayload {
  object: string;
  entry: Array<{ id?: string; changes: Array<{ field?: string; value: Dict }> }>;
}

/** The first message of a payload (the fixtures carry one each). */
export function firstMessage(p: MetaPayload): Dict {
  const value = p.entry[0]!.changes[0]!.value;
  return (value.messages as Dict[])[0]!;
}

export interface MessageOverrides {
  /** E.164 or WA id digits of the sender. */
  from?: string;
  /** wamid of the inbound message. */
  id?: string;
  /** Sent time (Meta sends unix seconds). */
  at?: Date;
  /** Media id (audio/image fixtures). */
  mediaId?: string;
  /** Caption (image) */
  caption?: string;
}

/**
 * A copy of a fixture payload re-addressed for a replay: sender, wamid, timestamp and media id.
 * Contacts follow the sender so the profile lookup stays consistent.
 */
export function readdress(p: MetaPayload, o: MessageOverrides): MetaPayload {
  const copy = structuredClone(p);
  const value = copy.entry[0]!.changes[0]!.value;
  const msg = (value.messages as Dict[])[0]!;
  const waId = o.from ? o.from.replace(/\D/g, '') : undefined;
  if (waId) {
    msg.from = waId;
    value.contacts = ((value.contacts as Dict[] | undefined) ?? []).map((c) => ({
      ...c,
      wa_id: waId,
    }));
  }
  if (o.id) msg.id = o.id;
  if (o.at) msg.timestamp = String(Math.floor(o.at.getTime() / 1000));
  const type = msg.type as string;
  const media = msg[type] as Dict | undefined;
  if (media && o.mediaId) media.id = o.mediaId;
  if (media && o.caption !== undefined) media.caption = o.caption;
  return copy;
}

/** An interactive button reply (as in fixtures/webhooks/button-reply.json) for a given button. */
export function buttonReplyPayload(
  button: { id: string; title: string },
  o: MessageOverrides & { contextId?: string | null },
): MetaPayload {
  const p = readdress(webhookFixture('button-reply.json'), o);
  const msg = firstMessage(p);
  msg.interactive = { type: 'button_reply', button_reply: { id: button.id, title: button.title } };
  if (o.contextId) msg.context = { ...(msg.context as Dict), id: o.contextId };
  else delete msg.context;
  return p;
}

/** A plain text message, built on the audio-note envelope. */
export function textPayload(body: string, o: MessageOverrides): MetaPayload {
  const p = readdress(webhookFixture('audio-note.json'), o);
  const msg = firstMessage(p);
  delete msg.audio;
  msg.type = 'text';
  msg.text = { body };
  return p;
}

/** Sign and deliver a payload like Meta does (raw body + X-Hub-Signature-256). */
export async function deliverSigned(
  sql: Sql,
  payload: MetaPayload | string,
  appSecret: string,
  opts: DeliverOptions & { signWith?: string } = {},
): Promise<WebhookResult> {
  const raw = typeof payload === 'string' ? payload : JSON.stringify(payload);
  const signature = await metaSignature(raw, opts.signWith ?? appSecret);
  return handleWebhookPost(sql, raw, signature, appSecret, opts);
}
