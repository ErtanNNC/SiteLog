import { logAudit } from '../_shared/audit.ts';
import { loadOrgPack } from '../_shared/countries.ts';
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
    async listDailyLinks(reporterId, siteId, reportDate) {
      const { data } = await admin
        .from('field_links')
        .select('id, code_hash, expires_at')
        .eq('reporter_id', reporterId)
        .eq('site_id', siteId)
        .eq('report_date', reportDate)
        .eq('kind', 'daily')
        .is('revoked_at', null)
        .order('created_at', { ascending: false })
        .throwOnError();
      return data;
    },
    async insertDailyLink(row) {
      const { error } = await admin.from('field_links').insert({ ...row, kind: 'daily' });
      if (!error) return true;
      if (error.code === '23505') return false;
      throw error;
    },
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
