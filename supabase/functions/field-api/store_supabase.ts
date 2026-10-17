import type { Json, TestClipView } from '@sitelog/shared';
import { logAudit } from '../_shared/audit.ts';
import { phoneOptedOut } from '../_shared/messaging.ts';
import type { AppClient } from '../_shared/supabase.ts';
import {
  FIELD_DB_ERRORS,
  FieldDbError,
  type AnswerResult,
  type VoiceAnswerResult,
  type AttachPhotosResult,
  type CompleteUploadResult,
  type ConfirmResult,
  type DayStatusResult,
  type DraftWriteResult,
  type FieldStore,
  type RequestCorrectionResult,
  type FiledSaveResult,
  type RateLimitResult,
  type ReportWithDate,
  type VoiceCallEndResult,
  type VoiceFileReportResult,
  type VoiceTurnSubmitResult,
  type VoiceCallStartResult,
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
        .select('id, name, country, locale, timezone, is_demo, units')
        .eq('id', orgId)
        .maybeSingle()
        .throwOnError();
      if (!org) return null;
      const [{ data: country }, { data: settings }] = await Promise.all([
        admin.from('countries').select('*').eq('code', org.country).single().throwOnError(),
        admin
          .from('org_settings')
          .select(
            'default_deadline, working_days, default_shift_hours, max_questions_per_report, required_fields',
          )
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

    async claimSend(key, ttlSeconds) {
      return await rpc<boolean>(
        admin.rpc('field_claim_send', { p_key: key, p_ttl_seconds: ttlSeconds }),
      );
    },

    async releaseSend(key) {
      await rpc<null>(admin.rpc('field_release_send', { p_key: key }));
    },

    async deviceVerifyLocked(reporterId, deviceId, until) {
      return await rpc<{ locked: boolean }>(
        admin.rpc('field_device_verify_locked', {
          p_reporter_id: reporterId,
          p_device_id: deviceId,
          p_until: until,
        }),
      );
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

    async getQuestion(id) {
      const { data } = await admin
        .from('questions')
        .select('*')
        .eq('id', id)
        .maybeSingle()
        .throwOnError();
      return data;
    },

    async listAnsweredQuestions(reportId) {
      const { data } = await admin
        .from('questions')
        .select('*')
        .eq('report_id', reportId)
        .not('answered_at', 'is', null)
        .order('answered_at', { ascending: false })
        .limit(10)
        .throwOnError();
      return data;
    },

    async countReportMedia(reportId) {
      // A spoken answer's clip (W2-09, `question_id`) and a correction clip (W2-10,
      // `correction_report_id`) are not voice notes of the report.
      const { data: uploads } = await admin
        .from('uploads')
        .select('id, kind')
        .eq('report_id', reportId)
        .is('question_id', null)
        .is('correction_report_id', null)
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

    async revokeConsent(reporterId, type, deviceId) {
      return await rpc<{ revoked: boolean; notified: boolean }>(
        admin.rpc('field_revoke_consent', {
          p_reporter_id: reporterId,
          p_type: type,
          p_device_id: deviceId,
        }),
      );
    },

    async noCallsToday(reporterId, deviceId, now) {
      return await rpc<{ until: string; changed: boolean }>(
        admin.rpc('field_no_calls_today', {
          p_reporter_id: reporterId,
          p_device_id: deviceId,
          p_now: now.toISOString(),
        }),
      );
    },

    async grantConsent(reporterId, type, textVersion, deviceId, evidence) {
      return await rpc<{ granted: boolean }>(
        admin.rpc('field_grant_consent', {
          p_reporter_id: reporterId,
          p_type: type,
          p_text_version: textVersion,
          p_device_id: deviceId,
          p_evidence: evidence,
        }),
      );
    },

    phoneOptedOut(phone, country) {
      return phoneOptedOut(admin, phone, country);
    },

    async pushSubscribe(i) {
      return await rpc<{ subscription_id: string }>(
        admin.rpc('field_push_subscribe', {
          p_reporter_id: i.reporterId,
          p_device_id: i.deviceId,
          p_endpoint: i.endpoint,
          p_p256dh: i.p256dh,
          p_auth: i.auth,
          p_user_agent: i.userAgent,
          p_text_version: i.textVersion,
          p_evidence: i.evidence,
        }),
      );
    },

    async pushUnsubscribe(reporterId, deviceId, reason) {
      return await rpc<{ revoked: number; consent_revoked: boolean }>(
        admin.rpc('field_push_unsubscribe', {
          p_reporter_id: reporterId,
          p_device_id: deviceId,
          p_reason: reason,
        }),
      );
    },

    async devicePushSubscribed(reporterId, deviceId) {
      const { data, error } = await admin
        .from('push_subscriptions')
        .select('id')
        .eq('reporter_id', reporterId)
        .eq('device_id', deviceId)
        .is('revoked_at', null)
        .limit(1);
      if (error) throw error;
      return (data ?? []).length > 0;
    },

    async attachPhotos(reportId, batchId, changeNote, caption) {
      return await rpc<AttachPhotosResult>(
        admin.rpc('field_attach_photos', {
          p_report_id: reportId,
          p_batch_id: batchId,
          p_change_note: changeNote,
          p_caption: caption,
        }),
      );
    },

    async filedPhotoState(reportId, exceptBatch) {
      const { data: rows } = await admin
        .from('uploads')
        .select('id, batch_id')
        .eq('report_id', reportId)
        .eq('kind', 'photo')
        .not('batch_id', 'is', null)
        .throwOnError();
      const uploads = rows.filter((u) => u.batch_id !== exceptBatch);
      if (uploads.length === 0) return { added: 0, pending: 0 };
      const { data: sources } = await admin
        .from('report_sources')
        .select('upload_id')
        .eq('report_id', reportId)
        .in(
          'upload_id',
          uploads.map((u) => u.id),
        )
        .throwOnError();
      return { added: uploads.length, pending: uploads.length - sources.length };
    },

    async flagLateUpload(uploadId, reporterId) {
      return await rpc<{ flagged: boolean }>(
        admin.rpc('field_flag_late_upload', {
          p_upload_id: uploadId,
          p_reporter_id: reporterId,
        }),
      );
    },

    async setDayStatus(input) {
      return await rpc<DayStatusResult>(
        admin.rpc('field_report_day_off', {
          p_reporter_id: input.reporterId,
          p_site_id: input.siteId,
          p_date: input.date,
          p_status: input.status,
          p_details: input.details as Json,
          p_questions: input.questions as unknown as Json,
          p_data: input.data as unknown as Json,
        }),
      );
    },

    async confirmReport(reportId, reporterId, version, draftRev) {
      return await rpc<ConfirmResult>(
        admin.rpc('field_confirm_report', {
          p_report_id: reportId,
          p_reporter_id: reporterId,
          p_version: version,
          p_draft_rev: draftRev,
        }),
      );
    },

    async answerQuestion(input) {
      return await rpc<AnswerResult>(
        admin.rpc('field_answer_question', {
          p_report_id: input.reportId,
          p_question_id: input.questionId,
          p_reporter_id: input.reporterId,
          p_base: input.base,
          p_data: input.data,
          p_answer: input.answer,
          p_answer_source: input.answerSource,
          p_new_company: input.newCompany,
        }),
      );
    },

    async answerQuestionVoice(input) {
      return await rpc<VoiceAnswerResult>(
        admin.rpc('field_answer_question_voice', {
          p_report_id: input.reportId,
          p_question_id: input.questionId,
          p_reporter_id: input.reporterId,
          p_upload_id: input.uploadId,
        }),
      );
    },

    async requestCorrection(input) {
      return await rpc<RequestCorrectionResult>(
        admin.rpc('field_request_correction', {
          p_report_id: input.reportId,
          p_reporter_id: input.reporterId,
          p_upload_id: input.uploadId,
          p_text: input.text,
        }),
      );
    },

    async getCorrection(id) {
      const { data } = await admin
        .from('draft_corrections')
        .select('*')
        .eq('id', id)
        .maybeSingle()
        .throwOnError();
      return data;
    },

    async latestCorrection(reportId, reporterId) {
      const { data } = await admin
        .from('draft_corrections')
        .select('*')
        .eq('report_id', reportId)
        .eq('reporter_id', reporterId)
        .order('created_at', { ascending: false })
        .limit(1)
        .maybeSingle()
        .throwOnError();
      return data;
    },

    async requestFiledCorrection(input) {
      return await rpc<RequestCorrectionResult>(
        admin.rpc('field_request_filed_correction', {
          p_report_id: input.reportId,
          p_reporter_id: input.reporterId,
          p_upload_id: input.uploadId,
          p_text: input.text,
        }),
      );
    },

    async saveFiledCorrection(input) {
      return await rpc<FiledSaveResult>(
        admin.rpc('field_save_filed_correction', {
          p_correction_id: input.correctionId,
          p_report_id: input.reportId,
          p_reporter_id: input.reporterId,
          p_change_note: input.changeNote,
          p_message: input.message,
        }),
      );
    },

    async applyCorrection(correctionId, reportId, reporterId) {
      return await rpc<DraftWriteResult>(
        admin.rpc('field_apply_correction', {
          p_correction_id: correctionId,
          p_report_id: reportId,
          p_reporter_id: reporterId,
        }),
      );
    },

    async editDraft(input) {
      return await rpc<DraftWriteResult>(
        admin.rpc('field_edit_draft', {
          p_report_id: input.reportId,
          p_reporter_id: input.reporterId,
          p_version: input.version,
          p_draft_rev: input.draftRev,
          p_base: input.base,
          p_data: input.data,
          p_changes: input.changes,
          p_source: input.source,
        }),
      );
    },

    async createTestClip(input) {
      await rpc<unknown>(
        admin.rpc('field_test_clip_create', {
          p_id: input.id,
          p_reporter_id: input.reporterId,
          p_device_id: input.deviceId,
          p_path: input.path,
          p_mime: input.mime,
          p_bytes: input.bytes,
        }),
      );
    },

    async getTestClip(id) {
      const { data } = await admin
        .from('test_clips')
        .select('*')
        .eq('id', id)
        .maybeSingle()
        .throwOnError();
      return data;
    },

    async completeTestClip(id, reporterId, bytes) {
      return await rpc<{ status: 'pending' | 'gone' }>(
        admin.rpc('field_test_clip_complete', {
          p_id: id,
          p_reporter_id: reporterId,
          p_bytes: bytes,
        }),
      );
    },

    async readTestClip(id, reporterId) {
      return await rpc<TestClipView>(
        admin.rpc('field_test_clip_read', { p_id: id, p_reporter_id: reporterId }),
      );
    },

    async audit(entry) {
      await logAudit(admin, entry);
    },

    // ── Calls (W3-03, 20261016000300_voice_calls.sql) ─────────────────────────────────────────
    async voiceCallStart(input) {
      return await rpc<VoiceCallStartResult>(
        admin.rpc('voice_call_start', {
          p_room: input.room,
          p_transport: input.transport,
          p_call_id: input.callId,
          p_from: input.from,
          p_to: input.to,
        }),
      );
    },

    async getCall(id) {
      const { data } = await admin
        .from('calls')
        .select('*')
        .eq('id', id)
        .maybeSingle()
        .throwOnError();
      return data;
    },

    async callerReporters(callId, country) {
      const { data: call } = await admin
        .from('calls')
        .select('from_e164')
        .eq('id', callId)
        .maybeSingle()
        .throwOnError();
      if (!call?.from_e164) return [];
      const { data: reporters } = await admin
        .from('reporters')
        .select('*')
        .eq('phone_e164', call.from_e164)
        .neq('status', 'disabled')
        .throwOnError();
      if (reporters.length === 0) return [];
      // A real caller never reaches a demo org (§19 Q44, Q116).
      const { data: orgs } = await admin
        .from('orgs')
        .select('id')
        .in('id', [...new Set(reporters.map((r) => r.org_id))])
        .eq('country', country)
        .eq('is_demo', false)
        .throwOnError();
      const real = new Set(orgs.map((o) => o.id));
      return reporters.filter((r) => real.has(r.org_id)).sort(callerOrder);
    },

    async voiceCallPickSite(callId, siteId, reporterId) {
      return await rpc<{ siteId: string; changed: boolean }>(
        admin.rpc('voice_call_pick_site', {
          p_call_id: callId,
          p_site_id: siteId,
          p_reporter_id: reporterId,
        }),
      );
    },

    async voiceCallFallback(callId, reason, at) {
      return await rpc<{ marked: boolean }>(
        admin.rpc('voice_call_fallback', { p_call_id: callId, p_reason: reason, p_at: at }),
      );
    },

    async voiceCallDisclosure(callId) {
      const r = await rpc<{ changed: boolean }>(
        admin.rpc('voice_call_update', { p_call_id: callId, p_disclosure_played: true }),
      );
      return { changed: !!r.changed };
    },

    async voiceCallRecording(callId, path) {
      await rpc(admin.rpc('voice_call_recording', { p_call_id: callId, p_path: path }));
    },

    async voiceCallEnd(input) {
      return await rpc<VoiceCallEndResult>(
        admin.rpc('voice_call_end', {
          p_call_id: input.callId,
          p_outcome: input.outcome,
          p_dialog_log: input.dialogLog,
          p_metrics: input.metrics,
        }),
      );
    },

    async claimToolRequest(callId, key, tool) {
      const { data: inserted } = await admin
        .from('voice_tool_requests')
        .upsert(
          { call_id: callId, request_key: key, tool },
          { onConflict: 'call_id,request_key', ignoreDuplicates: true },
        )
        .select('call_id')
        .throwOnError();
      if (inserted && inserted.length > 0) return { claimed: true };
      const { data: row } = await admin
        .from('voice_tool_requests')
        .select('tool, status, response')
        .eq('call_id', callId)
        .eq('request_key', key)
        .single()
        .throwOnError();
      return { claimed: false, tool: row.tool, status: row.status, response: row.response };
    },

    async getToolRequest(callId, key) {
      const { data } = await admin
        .from('voice_tool_requests')
        .select('tool, status, response')
        .eq('call_id', callId)
        .eq('request_key', key)
        .maybeSingle()
        .throwOnError();
      return data;
    },

    async voiceTurnSubmit(callId, kind, key, input) {
      return await rpc<VoiceTurnSubmitResult>(
        admin.rpc('voice_turn_submit', {
          p_call_id: callId,
          p_kind: kind,
          p_key: key,
          p_input: input,
        }),
      );
    },

    async voiceFileReport(input) {
      return await rpc<VoiceFileReportResult>(
        admin.rpc('voice_file_report', {
          p_call_id: input.callId,
          p_report_id: input.reportId,
          p_draft_rev: input.draftRev,
          p_utterance: input.utterance,
          p_confirmed: input.confirmed,
        }),
      );
    },

    async getVoiceTurn(id) {
      const { data } = await admin
        .from('voice_turns')
        .select('status, result, error')
        .eq('id', id)
        .maybeSingle()
        .throwOnError();
      return data;
    },

    async finishToolRequest(callId, key, status, response) {
      await admin
        .from('voice_tool_requests')
        .update({ status, response })
        .eq('call_id', callId)
        .eq('request_key', key)
        .throwOnError();
    },

    async releaseToolRequest(callId, key) {
      await admin
        .from('voice_tool_requests')
        .delete()
        .eq('call_id', callId)
        .eq('request_key', key)
        .is('status', null)
        .throwOnError();
    },

    async listCompanies(orgIds) {
      if (orgIds.length === 0) return [];
      const { data } = await admin
        .from('companies')
        .select('org_id, name, aliases')
        .in('org_id', orgIds)
        .order('name')
        .throwOnError();
      return data;
    },

    async listGlossary(orgIds, siteIds, reporterIds) {
      if (orgIds.length === 0) return [];
      const { data } = await admin
        .from('glossary_terms')
        .select(
          'heard, official, language, kind, status, times_heard, org_id, scope_site_id, scope_reporter_id',
        )
        .or(`org_id.is.null,org_id.in.(${orgIds.join(',')})`)
        .order('times_heard', { ascending: false })
        .throwOnError();
      const sites = new Set(siteIds);
      const reporters = new Set(reporterIds);
      return data.filter(
        (g) =>
          (g.scope_site_id === null || sites.has(g.scope_site_id)) &&
          (g.scope_reporter_id === null || reporters.has(g.scope_reporter_id)),
      );
    },
  };
}

/** §19 Q44's order: active, then invited, then opted out; newest first. */
function callerOrder(
  a: { status: string; created_at: string },
  b: { status: string; created_at: string },
): number {
  const rank = (s: string) => (s === 'active' ? 0 : s === 'invited' ? 1 : 2);
  return rank(a.status) - rank(b.status) || b.created_at.localeCompare(a.created_at);
}
