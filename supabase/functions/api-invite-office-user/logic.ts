import type { MemberRole } from '@sitelog/shared';

/** Pure rules of §F20 office-user management: an org always keeps at least one admin. */

export interface MemberRef {
  user_id: string;
  role: MemberRole;
}

export function adminCount(members: readonly MemberRef[]): number {
  return members.filter((m) => m.role === 'admin').length;
}

/**
 * Reason a change is refused, or null when allowed. `nextRole` null = removal.
 * The caller may not remove themself (mirrors the org_members RLS delete policy).
 */
export function memberChangeRefusal(
  members: readonly MemberRef[],
  targetUserId: string,
  nextRole: MemberRole | null,
  callerUserId: string,
): string | null {
  const target = members.find((m) => m.user_id === targetUserId);
  if (!target) return 'This user is not a member of the organisation';
  if (nextRole === null && targetUserId === callerUserId) return 'You cannot remove yourself';
  const demotesAdmin = target.role === 'admin' && nextRole !== 'admin';
  if (demotesAdmin && adminCount(members) <= 1) {
    return 'An organisation needs at least one admin; promote someone else first';
  }
  if (nextRole !== null && nextRole === target.role) return 'The user already has this role';
  return null;
}

/**
 * F24 (W4-03): the invite's user metadata. `ui_locale` is the language of the invite email and of
 * the panel's first open (spec §19 Q239: Supabase's Auth templates choose EN or TR by it, W4-09):
 * the language the admin chose, else the org's ("the company's language", stored as null).
 */
export function inviteMetadata(
  orgId: string,
  role: MemberRole,
  uiLocale: string | null,
  orgLocale: string,
): { invited_org_id: string; invited_role: MemberRole; ui_locale: string } {
  return { invited_org_id: orgId, invited_role: role, ui_locale: uiLocale ?? orgLocale };
}

/** "priya.n@kestrel.build" → "priya.n" — placeholder until the user sets a display name. */
export function displayNameFromEmail(email: string): string {
  return email.split('@')[0] ?? email;
}
