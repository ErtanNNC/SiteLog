import { z } from 'zod';
import { MEMBER_ROLES, ORG_LOCALES } from '@sitelog/shared';
import { logAudit } from '../_shared/audit.ts';
import { type AuthedUser, requireOrgRole, requireUser } from '../_shared/auth.ts';
import { requireEnv } from '../_shared/env.ts';
import {
  HttpError,
  json,
  parseWith,
  readJson,
  requireMethod,
  withHandler,
} from '../_shared/http.ts';
import { logInfo, logWarn } from '../_shared/log.ts';
import { adminClient, type AppClient } from '../_shared/supabase.ts';
import { displayNameFromEmail, inviteMetadata, memberChangeRefusal } from './logic.ts';

/**
 * api-invite-office-user (§F20, §P10) — admin of the org.
 * POST { orgId, email, role, uiLocale? }            → Supabase invite email + org_members row
 *   (F24, W4-03: `uiLocale` en-US | tr-TR | null = the company's language, stored in
 *   org_members.ui_locale; the invite's metadata carries it, or the org's, for the email)
 * POST { action: 'change_role', orgId, userId, role }
 * POST { action: 'remove', orgId, userId }         → never the last admin, never yourself
 */

const InviteSchema = z.object({
  action: z.literal('invite').optional(),
  orgId: z.uuid(),
  email: z.email().trim().toLowerCase(),
  role: z.enum(MEMBER_ROLES),
  uiLocale: z.enum(ORG_LOCALES).nullable().optional(),
});
const ChangeRoleSchema = z.object({
  action: z.literal('change_role'),
  orgId: z.uuid(),
  userId: z.uuid(),
  role: z.enum(MEMBER_ROLES),
});
const RemoveSchema = z.object({ action: z.literal('remove'), orgId: z.uuid(), userId: z.uuid() });
const BodySchema = z.union([ChangeRoleSchema, RemoveSchema, InviteSchema]);

Deno.serve(
  withHandler('api-invite-office-user', async (req) => {
    requireMethod(req, 'POST');
    const user = await requireUser(req);
    const body = parseWith(BodySchema, await readJson(req));
    const admin = adminClient();
    await requireOrgRole(admin, user.userId, body.orgId, ['admin']);
    if (body.action === 'change_role') return json(req, await changeRole(admin, user, body));
    if (body.action === 'remove') return json(req, await remove(admin, user, body));
    return json(req, await invite(admin, user, body), { status: 201 });
  }),
);

async function invite(admin: AppClient, caller: AuthedUser, body: z.output<typeof InviteSchema>) {
  const redirectTo = `${requireEnv('APP_URL').replace(/\/+$/, '')}/auth/callback`;
  const { data: org } = await admin
    .from('orgs')
    .select('locale, name')
    .eq('id', body.orgId)
    .single()
    .throwOnError();
  const uiLocale = body.uiLocale ?? null;
  const inviteData = inviteMetadata(body.orgId, body.role, uiLocale, org.locale, org.name);

  // New user: Supabase sends the invite email. Existing user: no invite is possible, so we only
  // add the membership; they sign in with their usual magic link (§F1) and land in the org.
  let userId: string;
  let emailSent = false;
  const invited = await admin.auth.admin.inviteUserByEmail(body.email, {
    redirectTo,
    data: inviteData,
  });
  if (!invited.error && invited.data.user) {
    userId = invited.data.user.id;
    emailSent = true;
  } else {
    const existing = await admin.auth.admin.generateLink({
      type: 'magiclink',
      email: body.email,
      options: { redirectTo, data: inviteData },
    });
    if (existing.error || !existing.data.user) {
      logWarn('member.invite_failed', {
        orgId: body.orgId,
        error: invited.error?.message ?? existing.error?.message,
      });
      throw new HttpError(502, 'Could not invite this email address', invited.error?.message);
    }
    userId = existing.data.user.id;
  }

  const { data: membership } = await admin
    .from('org_members')
    .select('role')
    .eq('org_id', body.orgId)
    .eq('user_id', userId)
    .maybeSingle()
    .throwOnError();
  if (membership) throw new HttpError(409, `This user is already a member (${membership.role})`);

  await admin
    .from('org_members')
    .upsert(
      {
        org_id: body.orgId,
        user_id: userId,
        role: body.role,
        display_name: displayNameFromEmail(body.email),
        ui_locale: uiLocale,
      },
      { onConflict: 'org_id,user_id', ignoreDuplicates: true },
    )
    .throwOnError();
  await logAudit(admin, {
    orgId: body.orgId,
    actorType: 'user',
    actorId: caller.userId,
    action: 'member.invited',
    entity: 'org_member',
    entityId: userId,
    diff: { email: body.email, role: body.role, ui_locale: uiLocale, emailSent },
  });
  logInfo('member.invited', { orgId: body.orgId, userId, role: body.role, emailSent });
  return { ok: true, userId, role: body.role, emailSent, existingUser: !emailSent };
}

async function loadMembers(admin: AppClient, orgId: string) {
  const { data } = await admin
    .from('org_members')
    .select('user_id, role')
    .eq('org_id', orgId)
    .throwOnError();
  return data;
}

async function changeRole(
  admin: AppClient,
  caller: AuthedUser,
  body: z.output<typeof ChangeRoleSchema>,
) {
  const members = await loadMembers(admin, body.orgId);
  const refusal = memberChangeRefusal(members, body.userId, body.role, caller.userId);
  if (refusal) throw new HttpError(409, refusal);
  const previous = members.find((m) => m.user_id === body.userId)?.role ?? null;
  await admin
    .from('org_members')
    .update({ role: body.role })
    .eq('org_id', body.orgId)
    .eq('user_id', body.userId)
    .throwOnError();
  await logAudit(admin, {
    orgId: body.orgId,
    actorType: 'user',
    actorId: caller.userId,
    action: 'member.role_changed',
    entity: 'org_member',
    entityId: body.userId,
    diff: { from: previous, to: body.role },
  });
  return { ok: true, userId: body.userId, role: body.role };
}

async function remove(admin: AppClient, caller: AuthedUser, body: z.output<typeof RemoveSchema>) {
  const members = await loadMembers(admin, body.orgId);
  const refusal = memberChangeRefusal(members, body.userId, null, caller.userId);
  if (refusal) throw new HttpError(409, refusal);
  const previous = members.find((m) => m.user_id === body.userId)?.role ?? null;
  await admin
    .from('org_members')
    .delete()
    .eq('org_id', body.orgId)
    .eq('user_id', body.userId)
    .throwOnError();
  await logAudit(admin, {
    orgId: body.orgId,
    actorType: 'user',
    actorId: caller.userId,
    action: 'member.removed',
    entity: 'org_member',
    entityId: body.userId,
    diff: { role: previous },
  });
  return { ok: true, userId: body.userId };
}
