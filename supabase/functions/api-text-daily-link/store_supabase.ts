import { logAudit } from '../_shared/audit.ts';
import { loadOrgPack } from '../_shared/countries.ts';
import { supabaseDailyLinkStore } from '../_shared/daily_links.ts';
import type { AppClient } from '../_shared/supabase.ts';
import type { TextLinkStore } from './app.ts';

/** `TextLinkStore` over supabase-js with the service role (the caller's role is checked in app.ts). */
export function supabaseTextLinkStore(admin: AppClient): TextLinkStore {
  return {
    async loadSite(siteId) {
      const { data } = await admin
        .from('sites')
        .select('id, org_id, name, timezone, status')
        .eq('id', siteId)
        .maybeSingle()
        .throwOnError();
      return data;
    },
    async memberRole(userId, orgId) {
      const { data } = await admin
        .from('org_members')
        .select('role')
        .eq('org_id', orgId)
        .eq('user_id', userId)
        .maybeSingle()
        .throwOnError();
      return data?.role ?? null;
    },
    async siteReporters(siteId) {
      const { data: links } = await admin
        .from('site_reporters')
        .select('reporter_id, is_primary')
        .eq('site_id', siteId)
        .throwOnError();
      if (!links.length) return [];
      const { data: reporters } = await admin
        .from('reporters')
        .select('id, name, status')
        .in(
          'id',
          links.map((l) => l.reporter_id),
        )
        .order('name')
        .throwOnError();
      const primary = new Set(links.filter((l) => l.is_primary).map((l) => l.reporter_id));
      return reporters.map((r) => ({ ...r, is_primary: primary.has(r.id) }));
    },
    async voiceNumber(orgId) {
      const { pack } = await loadOrgPack(admin, orgId);
      return pack.voiceNumber ?? null;
    },
    ...supabaseDailyLinkStore(admin),
    async audit(entry) {
      await logAudit(admin, {
        orgId: entry.orgId,
        actorType: 'user',
        actorId: entry.actorId,
        action: entry.action,
        entity: entry.entity,
        entityId: entry.entityId,
        diff: entry.diff,
      });
    },
  };
}
