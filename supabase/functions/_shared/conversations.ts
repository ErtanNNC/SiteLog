import type { ConvoState } from '@sitelog/shared';
import type { AppClient } from './supabase.ts';

/**
 * Creates or attaches the `conversations` row for a reporter's phone (one row per phone, §6.3).
 * A conversation that already belongs to another reporter (same phone in two orgs, §19 #1) is
 * left untouched: routing then resolves the org by site membership in the worker (§F12).
 */
export async function attachConversation(
  admin: AppClient,
  p: { phone: string; orgId: string; reporterId: string; state: ConvoState },
): Promise<{ id: string; attached: boolean }> {
  const { data: existing } = await admin
    .from('conversations')
    .select('id, org_id, reporter_id')
    .eq('phone_e164', p.phone)
    .maybeSingle()
    .throwOnError();

  if (existing) {
    if (existing.reporter_id !== null && existing.reporter_id !== p.reporterId) {
      return { id: existing.id, attached: false };
    }
    await admin
      .from('conversations')
      .update({
        org_id: p.orgId,
        reporter_id: p.reporterId,
        ...(existing.reporter_id === null ? { state: p.state, context: {} } : {}),
      })
      .eq('id', existing.id)
      .throwOnError();
    return { id: existing.id, attached: true };
  }

  const { data: created } = await admin
    .from('conversations')
    .insert({ phone_e164: p.phone, org_id: p.orgId, reporter_id: p.reporterId, state: p.state })
    .select('id')
    .single()
    .throwOnError();
  return { id: created.id, attached: true };
}
