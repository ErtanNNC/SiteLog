import { z } from 'zod';
import { REPORTER_ROLES, ensurePersonalLink, jobKeys } from '@sitelog/shared';
import { logAudit } from '../_shared/audit.ts';
import { requireOrgRole, requireUser, type AuthedUser } from '../_shared/auth.ts';
import { attachConversation } from '../_shared/conversations.ts';
import { loadOrgPack } from '../_shared/countries.ts';
import { requireEnv } from '../_shared/env.ts';
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
import { phoneOptedOut, supabaseLinkStore } from '../_shared/messaging.ts';
import { adminClient, type AppClient } from '../_shared/supabase.ts';
import { inviteProfile } from '../api-invite-reporter/logic.ts';
import { checkContactLink } from './logic.ts';

/**
 * api-link-unknown-contact (F13 step 4, P10; W1-16, D38) — admin|ops of the site's org. Replaces
 * api-link-unknown-sender: the panel calls this one from W1-16 on, and the old function is deleted
 * after the demo (deploy new, switch, delete old).
 * POST { unknownContactId, siteId, name, role?, languages? } → the contact's reporter on the site
 * POST { unknownContactId, action: 'ignore' }                 → status 'ignored'
 *
 * A caller or texter (`channel` 'sms' / 'voice') becomes a reporter `invited` until F3 consent
 * (`opted_out` when the phone sent STOP on the pack's sender), gets their personal link and the
 * welcome text, and turns active on their first consent; a held call recording is not re-processed
 * (calls are week 2). A WhatsApp-era sender keeps api-link-unknown-sender's rule (active, the held
 * message re-processed). The rules are `checkContactLink` (logic.ts). Audited
 * `unknown_contact.linked` (and `reporter.invited` for a new reporter) or `unknown_contact.ignored`.
 */

const LinkSchema = z.object({
  action: z.literal('link').optional(),
  unknownContactId: z.uuid(),
  siteId: z.uuid(),
  name: z.string().trim().min(1).max(120),
  role: z.enum(REPORTER_ROLES).default('site_manager'),
  languages: z.array(z.string().trim().min(2).max(8)).min(1).max(5).optional(),
});
const IgnoreSchema = z.object({ action: z.literal('ignore'), unknownContactId: z.uuid() });
const BodySchema = z.union([IgnoreSchema, LinkSchema]);

Deno.serve(
  withHandler('api-link-unknown-contact', async (req) => {
    requireMethod(req, 'POST');
    const user = await requireUser(req);
    const body = parseWith(BodySchema, await readJson(req));
    const admin = adminClient();
    if (body.action === 'ignore') {
      return json(req, await ignore(admin, user, body.unknownContactId));
    }
    return json(req, await link(admin, user, body), { status: 201 });
  }),
);

async function loadContact(admin: AppClient, id: string) {
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
  const contact = await loadContact(admin, body.unknownContactId);
  const { data: site } = await admin
    .from('sites')
    .select('id, org_id, name')
    .eq('id', body.siteId)
    .maybeSingle()
    .throwOnError();
  if (!site) throw new HttpError(404, 'Site not found');
  await requireOrgRole(admin, user.userId, site.org_id, ['admin', 'ops']);

  const { data: existing } = await admin
    .from('reporters')
    .select('*')
    .eq('org_id', site.org_id)
    .eq('phone_e164', contact.phone_e164)
    .maybeSingle()
    .throwOnError();
  const check = checkContactLink(contact, site.org_id, existing);
  if (!check.ok) throw new HttpError(check.status, check.reason);

  const now = new Date().toISOString();
  let reporterId: string;
  let created = false;
  if (check.mode === 'whatsapp') {
    // api-link-unknown-sender's rule: the number already wrote to us on WhatsApp.
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
      const { data: inserted } = await admin
        .from('reporters')
        .insert({
          org_id: site.org_id,
          name: body.name,
          phone_e164: contact.phone_e164,
          role: body.role,
          languages: body.languages ?? ['en'],
          status: 'active',
          invited_at: now,
          verified_at: now,
          activated_at: now,
        })
        .select('id')
        .single()
        .throwOnError();
      reporterId = inserted.id;
      created = true;
    }
  } else if (existing) {
    // Already invited or active in this org: link the site, keep the status.
    reporterId = existing.id;
  } else {
    // F3: invited until they consent; a phone that sent STOP on the pack's sender stays opted out.
    const { pack } = await loadOrgPack(admin, site.org_id);
    const profile = inviteProfile(pack, { languages: body.languages });
    if (!profile.ok) throw new HttpError(400, profile.reason);
    const optedOut = await phoneOptedOut(admin, contact.phone_e164, pack.code);
    const { data: inserted } = await admin
      .from('reporters')
      .insert({
        org_id: site.org_id,
        name: body.name,
        phone_e164: contact.phone_e164,
        role: body.role,
        languages: profile.languages,
        locale: profile.locale,
        contact_pref: profile.contactPref,
        status: optedOut ? 'opted_out' : 'invited',
        opted_out_at: optedOut ? now : null,
      })
      .select('id')
      .single()
      .throwOnError();
    reporterId = inserted.id;
    created = true;
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

  if (check.mode === 'consent') {
    // The personal link the welcome carries (F3), as api-invite-reporter makes it.
    const personal = await ensurePersonalLink(
      supabaseLinkStore(admin),
      requireEnv('LINK_SIGNING_SECRET'),
      reporterId,
      () => crypto.randomUUID(),
    );
    if (personal.created) {
      await logAudit(admin, {
        orgId: site.org_id,
        actorType: 'user',
        actorId: user.userId,
        action: 'field_link.created',
        entity: 'reporter',
        entityId: reporterId,
        diff: { kind: 'personal', site_id: null, report_date: null },
      });
    }
  } else {
    await attachConversation(admin, {
      phone: contact.phone_e164,
      orgId: site.org_id,
      reporterId,
      state: 'idle',
    });
  }

  await admin
    .from('unknown_contacts')
    .update({ status: 'linked', guessed_site_id: site.id })
    .eq('id', contact.id)
    .throwOnError();

  let reprocessJobId: number | null = null;
  if (check.mode === 'whatsapp' && contact.message_id) {
    reprocessJobId = await enqueueJob(
      admin,
      'inbound_message',
      { messageId: contact.message_id },
      { dedupeKey: `reprocess:${contact.id}` },
    );
  }
  const welcomeJobId = await enqueueJob(
    admin,
    'send_welcome',
    { reporterId, siteId: site.id },
    // D16: one welcome per linked contact (an invite of the same reporter has its own key).
    { dedupeKey: jobKeys.welcomeLinked(reporterId, contact.id) },
  );

  if (created) {
    await logAudit(admin, {
      orgId: site.org_id,
      actorType: 'user',
      actorId: user.userId,
      action: 'reporter.invited',
      entity: 'reporter',
      entityId: reporterId,
      diff: { siteIds: [site.id], role: body.role, from_unknown_contact: contact.id },
    });
  }
  await logAudit(admin, {
    orgId: site.org_id,
    actorType: 'user',
    actorId: user.userId,
    action: 'unknown_contact.linked',
    entity: 'unknown_contact',
    entityId: contact.id,
    diff: {
      reporterId,
      siteId: site.id,
      channel: contact.channel,
      consent: check.mode === 'consent' ? 'pending' : 'whatsapp',
      messageId: contact.message_id,
      callId: contact.call_id,
      reused: existing !== null,
    },
  });
  logInfo('unknown_contact.linked', {
    orgId: site.org_id,
    contactId: contact.id,
    reporterId,
    siteId: site.id,
    channel: contact.channel,
  });

  return {
    ok: true,
    reporterId,
    siteId: site.id,
    reused: existing !== null,
    consent: check.mode === 'consent' ? 'pending' : 'given',
    reprocessJobId,
    welcomeJobId,
  };
}

async function ignore(admin: AppClient, user: AuthedUser, unknownContactId: string) {
  const contact = await loadContact(admin, unknownContactId);
  if (!contact.org_id) {
    throw new HttpError(
      409,
      'This contact is not attributed to an organisation and cannot be ignored here',
    );
  }
  await requireOrgRole(admin, user.userId, contact.org_id, ['admin', 'ops']);
  if (contact.status === 'pending') {
    await admin
      .from('unknown_contacts')
      .update({ status: 'ignored' })
      .eq('id', contact.id)
      .throwOnError();
    await logAudit(admin, {
      orgId: contact.org_id,
      actorType: 'user',
      actorId: user.userId,
      action: 'unknown_contact.ignored',
      entity: 'unknown_contact',
      entityId: contact.id,
    });
  }
  return { ok: true, unknownContactId: contact.id, status: 'ignored' };
}
