import { z } from 'zod';
import { isActiveReporterStatus, REPORTER_ROLES } from '@sitelog/shared';
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

/**
 * api-link-unknown-sender (§F11 step 5, §P10) — admin|ops of the site's org.
 * POST { unknownSenderId, siteId, name, role? }  → reporter + link + conversation, re-process the
 *                                                  held message, send the welcome
 * POST { unknownSenderId, action: 'ignore' }     → status 'ignored'
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
    .from('unknown_senders')
    .select('*')
    .eq('id', id)
    .maybeSingle()
    .throwOnError();
  if (!data) throw new HttpError(404, 'Unknown sender not found');
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
  if (sender.status !== 'pending')
    throw new HttpError(409, `This sender was already ${sender.status}`);

  const now = new Date().toISOString();
  const { data: existing } = await admin
    .from('reporters')
    .select('*')
    .eq('org_id', site.org_id)
    .eq('phone_e164', sender.phone_e164)
    .maybeSingle()
    .throwOnError();
  let reporterId: string;
  if (existing) {
    reporterId = existing.id;
    if (!isActiveReporterStatus(existing.status)) {
      await admin
        .from('reporters')
        .update({ status: 'verified', verified_at: now, invited_at: existing.invited_at ?? now })
        .eq('id', existing.id)
        .throwOnError();
    }
  } else {
    // The number already wrote to us, so it is verified; the welcome goes out as context.
    const { data: created } = await admin
      .from('reporters')
      .insert({
        org_id: site.org_id,
        name: body.name,
        phone_e164: sender.phone_e164,
        role: body.role,
        languages: body.languages,
        status: 'verified',
        invited_at: now,
        verified_at: now,
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
    .from('unknown_senders')
    .update({ status: 'linked', org_id: site.org_id, guessed_site_id: site.id })
    .eq('id', sender.id)
    .throwOnError();

  // Re-process the held message as a report (the worker decides whether it is still today's).
  let reprocessJobId: number | null = null;
  if (sender.first_message_id) {
    reprocessJobId = await enqueueJob(
      admin,
      'inbound_message',
      { messageId: sender.first_message_id },
      { dedupeKey: `reprocess:${sender.id}` },
    );
  }
  const welcomeJobId = await enqueueJob(
    admin,
    'send_welcome',
    { reporterId, siteId: site.id },
    { dedupeKey: `welcome:${reporterId}:${site.id}` },
  );

  await logAudit(admin, {
    orgId: site.org_id,
    actorType: 'user',
    actorId: user.userId,
    action: 'unknown_sender.linked',
    entity: 'unknown_sender',
    entityId: sender.id,
    diff: {
      reporterId,
      siteId: site.id,
      messageId: sender.first_message_id,
      reused: existing !== null,
    },
  });
  logInfo('unknown_sender.linked', {
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
      'This sender is not attributed to an organisation and cannot be ignored here',
    );
  }
  await requireOrgRole(admin, user.userId, sender.org_id, ['admin', 'ops']);
  if (sender.status === 'pending') {
    await admin
      .from('unknown_senders')
      .update({ status: 'ignored' })
      .eq('id', sender.id)
      .throwOnError();
    await logAudit(admin, {
      orgId: sender.org_id,
      actorType: 'user',
      actorId: user.userId,
      action: 'unknown_sender.ignored',
      entity: 'unknown_sender',
      entityId: sender.id,
    });
  }
  return { ok: true, unknownSenderId: sender.id, status: 'ignored' };
}
