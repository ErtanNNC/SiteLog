import { z } from 'zod';
import {
  CONTACT_PREFS,
  REPORTER_LOCALES,
  REPORTER_ROLES,
  ensurePersonalLink,
} from '@sitelog/shared';
import { logAudit } from '../_shared/audit.ts';
import { requireOrgRole, requireUser, type AuthedUser } from '../_shared/auth.ts';
import { loadOrgPack } from '../_shared/countries.ts';
import { requireEnv } from '../_shared/env.ts';
import { supabaseLinkStore } from '../_shared/messaging.ts';
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
import { adminClient, type AppClient, type TableRow } from '../_shared/supabase.ts';
import { canResend, invitePhone, inviteProfile, linkRows } from './logic.ts';

/**
 * api-invite-reporter (§F2 step 2, §F3, §P10) — admin|ops.
 * POST { orgId, name, phone, role?, siteIds[], languages?, locale?, contactPref? }
 *      → reporter `invited` + site links + its personal field link + the welcome job
 * POST { action: 'resend', reporterId }                         → one re-send after 48 h
 * POST { action: 'disable', reporterId }                        → status 'disabled'
 *
 * W1-08: the welcome is a text with the reporter's personal link (F3, §9.2), sent by the worker's
 * send_welcome through the Notifier. The invite creates the personal `field_links` row (its code
 * derived from the row id under LINK_SIGNING_SECRET, `ensurePersonalLink`, so the worker can text
 * it); no WhatsApp conversation is attached any more. The phone is read with the org's country as
 * its default region, and `locale` / `contactPref` default from the org's pack when omitted, so
 * the deployed panel's request (no locale, no preference) keeps working. The answer never holds
 * the link code.
 */

const InviteSchema = z.object({
  action: z.literal('invite').optional(),
  orgId: z.uuid(),
  name: z.string().trim().min(1).max(120),
  phone: z.string().trim().min(5).max(32),
  role: z.enum(REPORTER_ROLES).default('site_manager'),
  siteIds: z.array(z.uuid()).min(1).max(50),
  languages: z.array(z.string().trim().min(2).max(8)).min(1).max(5).optional(),
  locale: z.enum(REPORTER_LOCALES).optional(),
  contactPref: z.enum(CONTACT_PREFS).optional(),
});
const ResendSchema = z.object({ action: z.literal('resend'), reporterId: z.uuid() });
const DisableSchema = z.object({ action: z.literal('disable'), reporterId: z.uuid() });
const BodySchema = z.union([ResendSchema, DisableSchema, InviteSchema]);

type Reporter = TableRow<'reporters'>;

Deno.serve(
  withHandler('api-invite-reporter', async (req) => {
    requireMethod(req, 'POST');
    const user = await requireUser(req);
    const body = parseWith(BodySchema, await readJson(req));
    const admin = adminClient();
    if (body.action === 'resend') return json(req, await resend(admin, user, body.reporterId));
    if (body.action === 'disable') return json(req, await disable(admin, user, body.reporterId));
    const result = await invite(admin, user, body);
    return json(req, result, { status: result.reused ? 200 : 201 });
  }),
);

async function invite(admin: AppClient, user: AuthedUser, body: z.output<typeof InviteSchema>) {
  await requireOrgRole(admin, user.userId, body.orgId, ['admin', 'ops']);
  const { org, pack } = await loadOrgPack(admin, body.orgId);
  const phone = invitePhone(body.phone, org.country);
  if (!phone)
    throw new HttpError(400, 'Phone must be a valid international number, e.g. +1 555 014 3378');
  const profile = inviteProfile(pack, body);
  if (!profile.ok) throw new HttpError(400, profile.reason);
  const firstSiteId = body.siteIds[0];
  if (!firstSiteId) throw new HttpError(400, 'At least one site is required');

  const { data: sites } = await admin
    .from('sites')
    .select('id')
    .eq('org_id', body.orgId)
    .in('id', body.siteIds)
    .throwOnError();
  if (sites.length !== new Set(body.siteIds).size) {
    throw new HttpError(400, 'One or more sites do not belong to this organisation');
  }

  // Same phone already in this org → reuse the reporter and link the new sites (§F2 edge case).
  const { data: existing } = await admin
    .from('reporters')
    .select('*')
    .eq('org_id', body.orgId)
    .eq('phone_e164', phone)
    .maybeSingle()
    .throwOnError();
  let reporter: Reporter;
  if (existing) {
    reporter = existing;
    // A reused reporter keeps the language and report mode they chose, unless the office sets them.
    const patch: Partial<Reporter> = {
      ...(body.locale ? { locale: profile.locale } : {}),
      ...(body.contactPref ? { contact_pref: profile.contactPref } : {}),
    };
    if (existing.status === 'disabled') {
      Object.assign(patch, {
        status: 'invited',
        invited_at: null,
        last_invite_error: null,
        name: body.name,
      });
    }
    if (Object.keys(patch).length > 0) {
      const { data: updated } = await admin
        .from('reporters')
        .update(patch)
        .eq('id', existing.id)
        .select('*')
        .single()
        .throwOnError();
      reporter = updated;
    }
  } else {
    const { data: created } = await admin
      .from('reporters')
      .insert({
        org_id: body.orgId,
        name: body.name,
        phone_e164: phone,
        role: body.role,
        languages: profile.languages,
        locale: profile.locale,
        contact_pref: profile.contactPref,
        status: 'invited',
      })
      .select('*')
      .single()
      .throwOnError();
    reporter = created;
  }

  const { data: primaries } = await admin
    .from('site_reporters')
    .select('site_id')
    .in('site_id', body.siteIds)
    .eq('is_primary', true)
    .throwOnError();
  const links = linkRows(reporter.id, body.siteIds, new Set(primaries.map((p) => p.site_id)));
  await admin
    .from('site_reporters')
    .upsert(links, { onConflict: 'site_id,reporter_id', ignoreDuplicates: true })
    .throwOnError();

  // The personal link (F3): reused when the reporter has one SiteLog can text again.
  const personal = await ensurePersonalLink(
    supabaseLinkStore(admin),
    requireEnv('LINK_SIGNING_SECRET'),
    reporter.id,
    () => crypto.randomUUID(),
  );
  if (personal.created) {
    await logAudit(admin, {
      orgId: body.orgId,
      actorType: 'user',
      actorId: user.userId,
      action: 'field_link.created',
      entity: 'reporter',
      entityId: reporter.id,
      diff: { kind: 'personal', site_id: null, report_date: null },
    });
  }

  const jobId = await enqueueJob(
    admin,
    'send_welcome',
    { reporterId: reporter.id, siteId: firstSiteId },
    { dedupeKey: `welcome:${reporter.id}:${firstSiteId}` },
  );
  await logAudit(admin, {
    orgId: body.orgId,
    actorType: 'user',
    actorId: user.userId,
    action: 'reporter.invited',
    entity: 'reporter',
    entityId: reporter.id,
    diff: {
      siteIds: body.siteIds,
      role: body.role,
      reused: existing !== null,
      locale: reporter.locale,
      contact_pref: reporter.contact_pref,
      jobId,
    },
  });
  logInfo('reporter.invited', {
    orgId: body.orgId,
    reporterId: reporter.id,
    reused: existing !== null,
  });

  return {
    reporter,
    reused: existing !== null,
    linkedSiteIds: links.map((l) => l.site_id),
    primarySiteIds: links.filter((l) => l.is_primary).map((l) => l.site_id),
    personalLinkId: personal.id,
    welcomeJobId: jobId,
  };
}

async function resend(admin: AppClient, user: AuthedUser, reporterId: string) {
  const reporter = await loadReporter(admin, reporterId);
  await requireOrgRole(admin, user.userId, reporter.org_id, ['admin', 'ops']);
  const { count } = await admin
    .from('audit_log')
    .select('id', { count: 'exact', head: true })
    .eq('action', 'reporter.reinvited')
    .eq('entity_id', reporter.id)
    .throwOnError();
  const check = canResend(reporter, count ?? 0, new Date());
  if (!check.ok)
    throw new HttpError(409, check.reason, check.retryAt ? { retryAt: check.retryAt } : undefined);

  const { data: links } = await admin
    .from('site_reporters')
    .select('site_id, is_primary')
    .eq('reporter_id', reporter.id)
    .order('is_primary', { ascending: false })
    .limit(1)
    .throwOnError();
  const siteId = links[0]?.site_id;
  const jobId = await enqueueJob(
    admin,
    'send_welcome',
    { reporterId: reporter.id, siteId, reinvite: true },
    { dedupeKey: `welcome:${reporter.id}:reinvite` },
  );
  await logAudit(admin, {
    orgId: reporter.org_id,
    actorType: 'user',
    actorId: user.userId,
    action: 'reporter.reinvited',
    entity: 'reporter',
    entityId: reporter.id,
    diff: { siteId: siteId ?? null, jobId },
  });
  return { ok: true, reporterId: reporter.id, welcomeJobId: jobId };
}

async function disable(admin: AppClient, user: AuthedUser, reporterId: string) {
  const reporter = await loadReporter(admin, reporterId);
  await requireOrgRole(admin, user.userId, reporter.org_id, ['admin', 'ops']);
  if (reporter.status !== 'disabled') {
    await admin
      .from('reporters')
      .update({ status: 'disabled' })
      .eq('id', reporter.id)
      .throwOnError();
    await logAudit(admin, {
      orgId: reporter.org_id,
      actorType: 'user',
      actorId: user.userId,
      action: 'reporter.disabled',
      entity: 'reporter',
      entityId: reporter.id,
      diff: { from: reporter.status },
    });
  }
  return { ok: true, reporterId: reporter.id, status: 'disabled' };
}

async function loadReporter(admin: AppClient, reporterId: string): Promise<Reporter> {
  const { data } = await admin
    .from('reporters')
    .select('*')
    .eq('id', reporterId)
    .maybeSingle()
    .throwOnError();
  if (!data) throw new HttpError(404, 'Reporter not found');
  return data;
}
