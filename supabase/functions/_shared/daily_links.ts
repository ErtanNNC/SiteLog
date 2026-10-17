import type { DailyLinkStore } from '@sitelog/shared';
import type { AppClient } from './supabase.ts';

/**
 * `DailyLinkStore` (`ensureDailyLink`) over supabase-js with the service role: the office's
 * "Text today's link" (api-text-daily-link, W1-16) and the reminder ladder (scheduler-tick, W2-06)
 * read and write the same rows, so the link the ladder sends is the one the office already texted.
 */
export function supabaseDailyLinkStore(admin: AppClient): DailyLinkStore {
  return {
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
    orgDailyLinkTtlHours: (siteId) => orgDailyLinkTtlHours(admin, siteId),
  };
}

/**
 * W4-05 (§19 Q231): the site's org's `org_settings.daily_link_ttl_hours` (null: the environment's
 * `DAILY_LINK_TTL_HOURS`), read before every new daily link (`ensureDailyLink`).
 */
export async function orgDailyLinkTtlHours(
  admin: AppClient,
  siteId: string,
): Promise<number | null> {
  const { data: site } = await admin
    .from('sites')
    .select('org_id')
    .eq('id', siteId)
    .maybeSingle()
    .throwOnError();
  if (!site) return null;
  const { data } = await admin
    .from('org_settings')
    .select('daily_link_ttl_hours')
    .eq('org_id', site.org_id)
    .maybeSingle()
    .throwOnError();
  return data?.daily_link_ttl_hours ?? null;
}
