import { MEMBER_ROLES, type MemberRole } from '@sitelog/shared';
import { bearerToken, HttpError } from './http.ts';
import { type AppClient, userClient } from './supabase.ts';

export interface AuthedUser {
  userId: string;
  email: string | null;
}

/** Resolves the caller from the Authorization bearer JWT via Supabase Auth (401 otherwise). */
export async function requireUser(req: Request): Promise<AuthedUser> {
  const jwt = bearerToken(req);
  if (!jwt) throw new HttpError(401, 'Sign in required');
  const { data, error } = await userClient(req).auth.getUser(jwt);
  if (error || !data.user) throw new HttpError(401, 'Invalid or expired session');
  return { userId: data.user.id, email: data.user.email ?? null };
}

/** Checks `org_members` for the user and returns their role (403 when missing or insufficient). */
export async function requireOrgRole(
  admin: AppClient,
  userId: string,
  orgId: string,
  roles: readonly MemberRole[] = MEMBER_ROLES,
): Promise<MemberRole> {
  const { data } = await admin
    .from('org_members')
    .select('role')
    .eq('org_id', orgId)
    .eq('user_id', userId)
    .maybeSingle()
    .throwOnError();
  if (!data) throw new HttpError(403, 'You are not a member of this organisation');
  if (!roles.includes(data.role)) {
    throw new HttpError(403, `This action needs one of these roles: ${roles.join(', ')}`);
  }
  return data.role;
}
