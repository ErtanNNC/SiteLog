import type { Json } from '@sitelog/shared';
import { logAudit } from '../_shared/audit.ts';
import type { AppClient } from '../_shared/supabase.ts';
import {
  FIELD_DB_ERRORS,
  FieldDbError,
  type CompleteUploadResult,
  type ConfirmResult,
  type DayStatusResult,
  type FieldStore,
  type RateLimitResult,
  type ReportWithDate,
} from './store.ts';

/**
 * FieldStore on the service-role client (field-api in production). Field users never reach these
 * tables themselves (§6.5); the route has scoped every id it passes in to the link's reporter and
 * sites. RPC refusals (the exception message is a code) become FieldDbError.
 */
export function supabaseFieldStore(admin: AppClient): FieldStore {
  /** An RPC call: its data, or FieldDbError for a known refusal (anything else is rethrown). */
  async function rpc<T>(
    call: PromiseLike<{ data: unknown; error: { message: string } | null }>,
  ): Promise<T> {
    const { data, error } = await call;
    if (error) {
      if ((FIELD_DB_ERRORS as readonly string[]).includes(error.message)) {
        throw new FieldDbError(error.message);
      }
      throw new Error(`field-api rpc: ${error.message}`);
    }
    return data as T;
  }

  return {
    async findLink(codeHash) {
      const { data } = await admin
        .from('field_links')
        .select('*')
        .eq('code_hash', codeHash)
        .maybeSingle()
        .throwOnError();
      return data;
    },

    async markLinkOpened(linkId, at) {
      const { data } = await admin
        .from('field_links')
        .update({ last_opened_at: at })
        .eq('id', linkId)
        .is('last_opened_at', null)
        .select('id')
        .throwOnError();
      if (data.length > 0) return true;
      await admin
        .from('field_links')
        .update({ last_opened_at: at })
        .eq('id', linkId)
        .throwOnError();
      return false;
    },

    async getReporter(id) {
      const { data } = await admin
        .from('reporters')
        .select('*')
        .eq('id', id)
        .maybeSingle()
        .throwOnError();
      return data;
    },

    async updateReporter(id, patch) {
      const { data } = await admin
        .from('reporters')
        .update(patch)
        .eq('id', id)
        .select('*')
        .single()
        .throwOnError();
      return data;
    },

    async getOrgContext(orgId) {
      const { data: org } = await admin
        .from('orgs')
        .select('id, name, country, locale, timezone, is_demo')
        .eq('id', orgId)
        .maybeSingle()
        .throwOnError();
      if (!org) return null;
      const [{ data: country }, { data: settings }] = await Promise.all([
        admin.from('countries').select('*').eq('code', org.country).single().throwOnError(),
        admin
          .from('org_settings')
          .select('default_deadline, working_days')
          .eq('org_id', orgId)
          .maybeSingle()
          .throwOnError(),
      ]);
      return { org, country, settings };
    },

    async listReporterSites(reporterId) {
      const { data: reporter } = await admin
        .from('reporters')
        .select('org_id')
        .eq('id', reporterId)
        .single()
        .throwOnError();
      const { data: links } = await admin
        .from('site_reporters')
        .select('site_id')
        .eq('reporter_id', reporterId)
        .throwOnError();
      const ids = links.map((l) => l.site_id);
      if (ids.length === 0) return [];
      const { data: sites } = await admin
        .from('sites')
        .select('*')
        .in('id', ids)
        .eq('org_id', reporter.org_id)
        .order('name')
        .throwOnError();
      return sites;
    },

    async findDevice(tokenHash) {
      const { data } = await admin
        .from('field_devices')
        .select('*')
        .eq('device_token_hash', tokenHash)
        .maybeSingle()
        .throwOnError();
      return data;
    },

    async insertDevice(row) {
      const { data } = await admin
        .from('field_devices')
        .insert(row)
        .select('*')
        .single()
        .throwOnError();
      return data;
    },

    async updateDevice(id, patch) {
      await admin.from('field_devices').update(patch).eq('id', id).throwOnError();
    },

    async rateLimit(key, limit, windowSeconds) {
      return await rpc<RateLimitResult>(
        admin.rpc('field_rate_limit', {
          p_key: key,
          p_limit: limit,
          p_window_seconds: windowSeconds,
        }),
      );
    },

    async listConsents(reporterId) {
      const { data } = await admin
        .from('consents')
        .select('*')
        .eq('reporter_id', reporterId)
        .order('given_at')
        .throwOnError();
      return data;
    },

    async insertConsents(rows) {
      if (rows.length === 0) return [];
      const { data } = await admin.from('consents').insert(rows).select('*').throwOnError();
      return data;
    },

    async getSiteDay(siteId, date) {
      const { data } = await admin
        .from('site_days')
        .select('*')
        .eq('site_id', siteId)
        .eq('date', date)
        .maybeSingle()
        .throwOnError();
      return data;
    },

    async getSiteDayById(id) {
      const { data } = await admin
        .from('site_days')
        .select('*')
        .eq('id', id)
        .maybeSingle()
        .throwOnError();
      return data;
    },

    async getLiveReport(siteDayId) {
      const { data } = await admin
        .from('reports')
        .select('*')
        .eq('site_day_id', siteDayId)
        .neq('status', 'void')
        .order('created_at')
        .limit(1)
        .throwOnError();
      return data[0] ?? null;
    },

    async getReport(id) {
      const { data } = await admin
        .from('reports')
        .select('*')
        .eq('id', id)
        .maybeSingle()
        .throwOnError();
      return data;
    },

    async getVersion(reportId, version) {
      const { data } = await admin
        .from('report_versions')
        .select('*')
        .eq('report_id', reportId)
        .eq('version', version)
        .maybeSingle()
        .throwOnError();
      return data;
    },

    async getOpenQuestion(reportId) {
      const { data } = await admin
        .from('questions')
        .select('*')
        .eq('report_id', reportId)
        .is('answered_at', null)
        .order('asked_at', { ascending: false })
        .limit(1)
        .throwOnError();
      return data[0] ?? null;
    },

    async countReportMedia(reportId) {
      const { data: uploads } = await admin
        .from('uploads')
        .select('id, kind')
        .eq('report_id', reportId)
        .throwOnError();
      const voice = uploads.filter((u) => u.kind === 'audio').map((u) => u.id);
      let transcribed = 0;
      if (voice.length > 0) {
        const { count } = await admin
          .from('transcripts')
          .select('id', { count: 'exact', head: true })
          .in('upload_id', voice)
          .throwOnError();
        transcribed = count ?? 0;
      }
      return {
        voiceNotes: voice.length,
        transcribed,
        photos: uploads.length - voice.length,
      };
    },

    async listRecentReports(siteIds, sinceDate) {
      if (siteIds.length === 0) return [];
      const { data: days } = await admin
        .from('site_days')
        .select('id, date')
        .in('site_id', siteIds)
        .gte('date', sinceDate)
        .throwOnError();
      if (days.length === 0) return [];
      const dateOf = new Map(days.map((d) => [d.id, d.date]));
      const { data: reports } = await admin
        .from('reports')
        .select('*')
        .in('site_day_id', [...dateOf.keys()])
        .neq('status', 'void')
        .throwOnError();
      return reports.map((r): ReportWithDate => ({ ...r, date: dateOf.get(r.site_day_id)! }));
    },

    async insertUpload(row) {
      const { data } = await admin.from('uploads').insert(row).select('*').single().throwOnError();
      return data;
    },

    async getUpload(id) {
      const { data } = await admin
        .from('uploads')
        .select('*')
        .eq('id', id)
        .maybeSingle()
        .throwOnError();
      return data;
    },

    async createSignedUploadUrl(bucket, path) {
      const { data, error } = await admin.storage.from(bucket).createSignedUploadUrl(path);
      if (error || !data) throw new Error(`signed upload URL: ${error?.message ?? 'no data'}`);
      return { signedUrl: data.signedUrl, token: data.token };
    },

    async objectInfo(bucket, path) {
      // Storage's object info: `size` and `content_type` (camel-cased by storage-js) come from
      // the stored object's metadata, never from the uploader's custom metadata.
      const { data, error } = await admin.storage.from(bucket).info(path);
      if (error) {
        const status =
          (error as { status?: number }).status ??
          (error as { originalError?: { status?: number } }).originalError?.status;
        if (status === 400 || status === 404) return null; // as exists() reads a missing object
        throw new Error(`storage info: ${error.message}`);
      }
      const info = data as { size?: number | null; contentType?: string | null };
      return {
        size: typeof info.size === 'number' ? info.size : null,
        contentType: typeof info.contentType === 'string' ? info.contentType : null,
      };
    },

    async removeObject(bucket, path) {
      const { error } = await admin.storage.from(bucket).remove([path]);
      if (error) throw new Error(`storage remove: ${error.message}`);
    },

    async createSignedUrl(bucket, path, seconds) {
      const { data } = await admin.storage.from(bucket).createSignedUrl(path, seconds);
      return data?.signedUrl ?? null;
    },

    async completeUpload(uploadId, reporterId, bytes) {
      return await rpc<CompleteUploadResult>(
        admin.rpc('field_complete_upload', {
          p_upload_id: uploadId,
          p_reporter_id: reporterId,
          p_bytes: bytes,
        }),
      );
    },

    async setDayStatus(input) {
      return await rpc<DayStatusResult>(
        admin.rpc('field_set_day_status', {
          p_reporter_id: input.reporterId,
          p_site_id: input.siteId,
          p_date: input.date,
          p_status: input.status,
          p_details: input.details as Json,
        }),
      );
    },

    async confirmReport(reportId, reporterId, version) {
      return await rpc<ConfirmResult>(
        admin.rpc('field_confirm_report', {
          p_report_id: reportId,
          p_reporter_id: reporterId,
          p_version: version,
        }),
      );
    },

    async audit(entry) {
      await logAudit(admin, entry);
    },
  };
}
