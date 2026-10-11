import type { Json } from '@sitelog/shared';
import type { AppClient } from './supabase.ts';

/** `log_audit(...)` RPC wrapper (§15: every state change writes audit_log). */

export type ActorType = 'user' | 'reporter' | 'agent' | 'system';

export interface AuditEntry {
  orgId: string | null;
  actorType: ActorType;
  actorId?: string | null;
  action: string;
  entity?: string | null;
  entityId?: string | null;
  diff?: Json | null;
}

export async function logAudit(admin: AppClient, entry: AuditEntry): Promise<void> {
  await admin
    .rpc('log_audit', {
      p_org: entry.orgId,
      p_actor_type: entry.actorType,
      p_actor_id: entry.actorId ?? null,
      p_action: entry.action,
      p_entity: entry.entity ?? null,
      p_entity_id: entry.entityId ?? null,
      p_diff: entry.diff ?? null,
    })
    .throwOnError();
}
