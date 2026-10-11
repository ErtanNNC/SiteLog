import { normalizeWebhook, verifyChallenge, verifyMetaSignature } from '@sitelog/shared';
import { requireEnv } from '../_shared/env.ts';
import { error, json, requireMethod, text, withHandler } from '../_shared/http.ts';
import { enqueueJob } from '../_shared/jobs.ts';
import { logError, logInfo, logWarn } from '../_shared/log.ts';
import { adminClient, type AppClient } from '../_shared/supabase.ts';
import {
  conversationPatch,
  inboundDedupeKey,
  maskPhone,
  messageRow,
  newConversationRow,
  resolveConversationTarget,
  statusUpdate,
  type ConversationTarget,
} from './logic.ts';
import type { InboundMessage, InboundStatus } from '@sitelog/shared';

/**
 * whatsapp-webhook (§4.2, §4.3, §M2).
 * GET  → Meta verification handshake.
 * POST → verify X-Hub-Signature-256, normalise, store message + conversation, enqueue
 *        `inbound_message`, update delivery statuses. No AI work here; the worker does the rest.
 */

Deno.serve(
  withHandler('whatsapp-webhook', async (req) => {
    requireMethod(req, 'GET', 'POST');
    return req.method === 'GET' ? handleVerify(req) : await handleInbound(req);
  }),
);

function handleVerify(req: Request): Response {
  const result = verifyChallenge(new URL(req.url).searchParams, requireEnv('WA_VERIFY_TOKEN'));
  if (!result.ok) {
    logWarn('wa.webhook.verify_rejected');
    return error(req, 403, 'Verification failed');
  }
  return text(req, result.challenge);
}

async function handleInbound(req: Request): Promise<Response> {
  const raw = await req.text();
  const signed = await verifyMetaSignature(
    raw,
    req.headers.get('x-hub-signature-256'),
    requireEnv('WA_APP_SECRET'),
  );
  if (!signed) {
    logWarn('wa.webhook.bad_signature', { bytes: raw.length });
    return error(req, 401, 'Invalid signature');
  }

  let normalized: { messages: InboundMessage[]; statuses: InboundStatus[] };
  try {
    normalized = normalizeWebhook(JSON.parse(raw));
  } catch (err) {
    // A signed payload we cannot parse will not get better on retry: acknowledge and log it.
    logError('wa.webhook.unparseable', err, { bytes: raw.length });
    return json(req, { ok: false, reason: 'unparseable' });
  }

  const admin = adminClient();
  const summary = {
    received: normalized.messages.length,
    stored: 0,
    duplicates: 0,
    failed: 0,
    statuses: 0,
  };

  for (const message of normalized.messages) {
    try {
      const outcome = await storeInbound(admin, message);
      if (outcome === 'stored') summary.stored += 1;
      else summary.duplicates += 1;
    } catch (err) {
      summary.failed += 1;
      logError('wa.inbound.failed', err, { waMessageId: message.waMessageId, type: message.type });
    }
  }

  for (const status of normalized.statuses) {
    try {
      await applyStatus(admin, status);
      summary.statuses += 1;
    } catch (err) {
      logError('wa.status.failed', err, { waMessageId: status.waMessageId, status: status.status });
    }
  }

  logInfo('wa.webhook.ack', summary);
  // Storage failures are infrastructure problems (DB unreachable): a non-2xx makes Meta redeliver
  // and the wa_message_id dedupe makes that safe. Everything else is acknowledged with 200.
  if (summary.failed > 0) return json(req, { ok: false, ...summary }, { status: 500 });
  return json(req, { ok: true, ...summary });
}

async function storeInbound(admin: AppClient, m: InboundMessage): Promise<'stored' | 'duplicate'> {
  const { data: reporters } = await admin
    .from('reporters')
    .select('id, org_id, status')
    .eq('phone_e164', m.phoneE164)
    .neq('status', 'disabled')
    .throwOnError();
  const target = resolveConversationTarget(reporters);
  const conversationId = await upsertConversation(admin, m, target);

  const { data: inserted } = await admin
    .from('messages')
    .upsert(messageRow(m, conversationId), { onConflict: 'wa_message_id', ignoreDuplicates: true })
    .select('id')
    .throwOnError();
  const messageId = inserted[0]?.id;
  if (!messageId) {
    logInfo('wa.inbound.duplicate', { waMessageId: m.waMessageId });
    return 'duplicate';
  }

  const jobId = await enqueueJob(
    admin,
    'inbound_message',
    { messageId },
    { dedupeKey: inboundDedupeKey(m.waMessageId) },
  );
  logInfo('wa.inbound.stored', {
    waMessageId: m.waMessageId,
    type: m.type,
    messageId,
    conversationId,
    orgId: target.orgId,
    phone: maskPhone(m.phoneE164),
    jobId,
  });
  return 'stored';
}

async function upsertConversation(
  admin: AppClient,
  m: InboundMessage,
  target: ConversationTarget,
): Promise<string> {
  const existing = await findConversation(admin, m.phoneE164);
  if (existing) {
    const patch = conversationPatch(existing, target, m.sentAt);
    if (Object.keys(patch).length > 0) {
      await admin.from('conversations').update(patch).eq('id', existing.id).throwOnError();
    }
    return existing.id;
  }

  const { data: created, error: insertError } = await admin
    .from('conversations')
    .insert(newConversationRow(m.phoneE164, target, m.sentAt))
    .select('id')
    .single();
  if (!insertError) return created.id;
  if (insertError.code !== '23505') throw insertError;

  // Lost a race with a concurrent delivery for the same phone: reuse the row it created.
  const raced = await findConversation(admin, m.phoneE164);
  if (!raced) throw insertError;
  const patch = conversationPatch(raced, target, m.sentAt);
  if (Object.keys(patch).length > 0) {
    await admin.from('conversations').update(patch).eq('id', raced.id).throwOnError();
  }
  return raced.id;
}

async function findConversation(admin: AppClient, phone: string) {
  const { data } = await admin
    .from('conversations')
    .select('id, org_id, reporter_id, context, last_inbound_at')
    .eq('phone_e164', phone)
    .maybeSingle()
    .throwOnError();
  return data;
}

async function applyStatus(admin: AppClient, s: InboundStatus): Promise<void> {
  const update = statusUpdate(s);
  if (!update) return;
  let query = admin.from('messages').update(update.patch).eq('wa_message_id', update.waMessageId);
  if (update.onlyIfIn) query = query.in('status', update.onlyIfIn);
  await query.throwOnError();
}
