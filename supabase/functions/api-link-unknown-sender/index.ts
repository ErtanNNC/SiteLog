import { z } from 'zod';
import { REPORTER_ROLES, jobKeys } from '@sitelog/shared';
import { logAudit } from '../_shared/audit.ts';
import { requireOrgRole, requireUser, type AuthedUser } from '../_shared/auth.ts';
import { attachConversation } from '../_shared/conversations.ts';
import {
  HttpError,
  json,
  parseWith,
  readJson,
  requireMethod,
  withHandler,
} from '../_shared/http.ts';
import { enqueueJob } from '../_shared/jobs.ts';
import { logInfo } from '../_shared/log.ts';
import { adminClient, type AppClient } from '../_shared/supabase.ts';
import { checkLink } from './logic.ts';

/**
 * api-link-unknown-sender (§F11 step 5, §P10) — admin|ops of the site's org. Reads
 * `unknown_contacts` (renamed from unknown_senders in 20261014000003); the function keeps its name,
 * URL and request body until W1-16 deploys api-link-unknown-contact (D38). It links WhatsApp
 * senders only (`channel` null): a contact from a text or a call, and a reporter who opted out,
 * get 409 (`checkLink`, logic.ts), so no one becomes active here without consent.
 * POST { unknownSenderId, siteId, name, role? }  → reporter + link + conversation, re-process the
 *                                                  held WhatsApp message, send the welcome
 * POST { unknownSenderId, action: 'ignore' }     → status 'ignored' (any channel)
 */

const LinkSchema = z.object({
  action: z.literal('link').optional(),
  unknownSenderId: z.uuid(),
  siteId: z.uuid(),
  name: z.string().trim().min(1).max(120),
  role: z.enum(REPORTER_ROLES).default('site_manager'),
  languages: z.array(z.string().trim().min(2).max(8)).min(1).max(5).default(['en']),
});
const IgnoreSchema = z.object({ action: z.literal('ignore'), unknownSenderId: z.uuid() });
const BodySchema = z.union([IgnoreSchema, LinkSchema]);

Deno.serve(
  withHandler('api-link-unknown-sender', async (req) => {
    requireMethod(req, 'POST');
    const user = await requireUser(req);
    const body = parseWith(BodySchema, await readJson(req));
    const admin = adminClient();
    if (body.action === 'ignore') return json(req, await ignore(admin, user, body.unknownSenderId));
    return json(req, await link(admin, user, body), { status: 201 });
  }),
);

async function loadSender(admin: AppClient, id: string) {
  const { data } = await admin
    .from('unknown_contacts')
    .select('*')
    .eq('id', id)
    .maybeSingle()
    .throwOnError();
  if (!data) throw new HttpError(404, 'Unknown contact not found');
  return data;
}

async function link(admin: AppClient, user: AuthedUser, body: z.output<typeof LinkSchema>) {
  const sender = await loadSender(admin, body.unknownSenderId);
  const { data: site } = await admin
    .from('sites')
    .select('id, org_id, name')
    .eq('id', body.siteId)
    .maybeSingle()
    .throwOnError();
  if (!site) throw new HttpError(404, 'Site not found');
  await requireOrgRole(admin, user.userId, site.org_id, ['admin', 'ops']);

  const now = new Date().toISOString();
  const { data: existing } = await admin
    .from('reporters')
    .select('*')
    .eq('org_id', site.org_id)
    .eq('phone_e164', sender.phone_e164)
    .maybeSingle()
    .throwOnError();
  const check = checkLink(sender, existing);
  if (!check.ok) throw new HttpError(409, check.reason);
  let reporterId: string;
  if (existing) {
    reporterId = existing.id;
    if (check.activate) {
      await admin
        .from('reporters')
        .update({
          status: 'active',
          verified_at: now,
          activated_at: existing.activated_at ?? now,
          invited_at: existing.invited_at ?? now,
        })
        .eq('id', existing.id)
        .throwOnError();
    }
  } else {
    // The number already wrote to us on WhatsApp, so it is active; the welcome goes out as context.
    const { data: created } = await admin
      .from('reporters')
      .insert({
        org_id: site.org_id,
        name: body.name,
        phone_e164: sender.phone_e164,
        role: body.role,
        languages: body.languages,
        status: 'active',
        invited_at: now,
        verified_at: now,
        activated_at: now,
      })
      .select('id')
      .single()
      .throwOnError();
    reporterId = created.id;
  }

  const { data: primaries } = await admin
    .from('site_reporters')
    .select('site_id')
    .eq('site_id', site.id)
    .eq('is_primary', true)
    .throwOnError();
  await admin
    .from('site_reporters')
    .upsert(
      { site_id: site.id, reporter_id: reporterId, is_primary: primaries.length === 0 },
      { onConflict: 'site_id,reporter_id', ignoreDuplicates: true },
    )
    .throwOnError();

  const conversation = await attachConversation(admin, {
    phone: sender.phone_e164,
    orgId: site.org_id,
    reporterId,
    state: 'idle',
  });

  await admin
    .from('unknown_contacts')
    .update({ status: 'linked', org_id: site.org_id, guessed_site_id: site.id })
    .eq('id', sender.id)
    .throwOnError();

  // Re-process the held WhatsApp message as a report (the worker decides whether it is still
  // today's). checkLink admitted only a WhatsApp sender, so message_id is a WhatsApp message.
  let reprocessJobId: number | null = null;
  if (sender.message_id) {
    reprocessJobId = await enqueueJob(
      admin,
      'inbound_message',
      { messageId: sender.message_id },
      { dedupeKey: `reprocess:${sender.id}` },
    );
  }
  const welcomeJobId = await enqueueJob(
    admin,
    'send_welcome',
    { reporterId, siteId: site.id },
    // D16: one welcome per linked sender (an invite of the same reporter has its own key).
    { dedupeKey: jobKeys.welcomeLinked(reporterId, sender.id) },
  );

  await logAudit(admin, {
    orgId: site.org_id,
    actorType: 'user',
    actorId: user.userId,
    action: 'unknown_contact.linked',
    entity: 'unknown_contact',
    entityId: sender.id,
    diff: {
      reporterId,
      siteId: site.id,
      messageId: sender.message_id,
      reused: existing !== null,
    },
  });
  logInfo('unknown_contact.linked', {
    orgId: site.org_id,
    senderId: sender.id,
    reporterId,
    siteId: site.id,
  });

  return {
    ok: true,
    reporterId,
    siteId: site.id,
    conversationId: conversation.id,
    reused: existing !== null,
    reprocessJobId,
    welcomeJobId,
  };
}

async function ignore(admin: AppClient, user: AuthedUser, unknownSenderId: string) {
  const sender = await loadSender(admin, unknownSenderId);
  if (!sender.org_id) {
    throw new HttpError(
      409,
      'This contact is not attributed to an organisation and cannot be ignored here',
    );
  }
  await requireOrgRole(admin, user.userId, sender.org_id, ['admin', 'ops']);
  if (sender.status === 'pending') {
    await admin
      .from('unknown_contacts')
      .update({ status: 'ignored' })
      .eq('id', sender.id)
      .throwOnError();
    await logAudit(admin, {
      orgId: sender.org_id,
      actorType: 'user',
      actorId: user.userId,
      action: 'unknown_contact.ignored',
      entity: 'unknown_contact',
      entityId: sender.id,
    });
  }
  return { ok: true, unknownSenderId: sender.id, status: 'ignored' };
}
