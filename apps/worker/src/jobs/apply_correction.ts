import {
  applyCorrectionOps,
  jobKeys,
  readReportData,
  type DraftCorrectionRow,
  type Source,
  type StoredReportData,
} from '@sitelog/shared';
import { parseCorrectionV2 } from '../ai/correction';
import type { SettleCorrectionResult } from '../db';
import { skippedForConsent } from '../pipeline/consent';
import { transcribe } from './transcribe_upload';
import { PermanentJobError, type JobHandler } from './types';

/**
 * §10.6 `apply_correction` (W2-10, F8 *Fix by voice*): a fix of a web draft, said (a short clip,
 * `uploads.correction_report_id`) or typed. field_request_correction() enqueued it
 * (`correction:<id>`); it runs under the report's lock key.
 *
 * 1. A clip is transcribed like a voice note (`transcripts.upload_id`; a retry reuses it), but it
 *    is never report material: no report source, nothing extracted from it.
 * 2. `apply_correction` (the model; the words are data, phone numbers are taken out by `callTool`,
 *    §10.12) proposes JSON-patch operations, a change note, or a question when it cannot tell what
 *    to change (`needsClarification`).
 * 3. Code applies them (`applyCorrectionOps`): only the parts a fix may change, every total
 *    recomputed (a model total is ignored), every number one the words state, each changed value
 *    citing the clip (`voice_note` with its seconds) or, typed, `reporter_edit` (§19 Q80). The
 *    result is a **preview** (`field_settle_correction()` `ready`), made from the draft at its
 *    version and revision; nothing changes until the reporter saves it. Otherwise `unclear`.
 *
 * The model never files and never changes the draft: it only reads the fix. A correction settled
 * before, or a report no longer awaiting confirmation, changes nothing (`stale`).
 *
 * W2-11 (F10 *Change something*): a correction `after_filing` is made the same way on the filed (or
 * signed-off) report's current version; Save change makes version n+1 from its preview
 * (field_save_filed_correction()), never this job. A report no longer filed makes it `stale`.
 *
 * W2-12 (F10 by SMS): a correction with `message_id` came from an SMS EDIT
 * (sms_request_filed_correction()); its typed words cite `reporter_edit` via 'sms', and once it is
 * settled the `sms_keyword` job texts the preview back with its confirm link
 * (`jobKeys.smsEditPreview`).
 */
export const applyCorrectionJob: JobHandler<'apply_correction'> = async (ctx, payload) => {
  const [report, correction] = await Promise.all([
    ctx.db.getReport(payload.reportId),
    ctx.db.getCorrection(payload.correctionId),
  ]);
  if (!report || !correction || correction.report_id !== report.id)
    throw new PermanentJobError('apply_correction: report or correction not found');
  const log = ctx.log.child({ report_id: report.id, correction_id: correction.id });
  if (correction.status !== 'listening') {
    log.info('apply_correction: settled before', { status: correction.status });
    return;
  }
  const settle = async (
    outcome: 'ready' | 'unclear' | 'stale',
    detail: Record<string, unknown>,
  ): Promise<SettleCorrectionResult> => {
    const res = await ctx.db.settleCorrection(correction.id, outcome, detail);
    if (correction.message_id) {
      // W2-12: an SMS EDIT; its text gets the preview (or why there is none) once settled.
      await ctx.db.enqueueJob(
        'sms_keyword',
        { messageId: correction.message_id, correctionId: correction.id },
        { dedupeKey: jobKeys.smsEditPreview(correction.message_id, correction.id) },
      );
    }
    log.info('correction settled', {
      outcome,
      reason: detail.reason ?? null,
      changes: Array.isArray(detail.changes) ? detail.changes.length : null,
      ...res,
    });
    ctx.metrics.add({ correctionOutcome: res.settled ? res.status : `not_settled:${res.status}` });
    return res;
  };
  // W2-11 (F10): a change after filing is previewed on the filed (or signed-off) report's current
  // version; a draft's fix while the draft awaits confirmation.
  const inPlace = correction.after_filing
    ? report.status === 'filed' || report.status === 'signed_off'
    : report.status === 'awaiting_confirmation';
  if (!inPlace) {
    await settle('stale', { reason: 'report_moved_on' });
    return;
  }

  // F15, spec §19 Q95: nothing goes to a provider once the reporter turned a consent off.
  if (
    await skippedForConsent(ctx, {
      jobType: 'apply_correction',
      reporterId: correction.reporter_id,
      report,
      detail: { correction_id: correction.id, upload_id: correction.upload_id },
    })
  ) {
    await settle('unclear', { reason: 'consent_revoked' });
    return;
  }

  // 1. The words, and what a changed value cites.
  const words = await correctionWords(ctx, correction, report.id, log);
  if (!words) {
    await settle('unclear', { reason: 'silent' });
    return;
  }

  // 2. The model proposes operations on the current draft.
  const version = await ctx.db.getVersion(report.id, report.current_version || 1);
  if (!version?.data) throw new Error(`report ${report.id} has no draft`);
  const draft = readReportData(version.data as StoredReportData);
  const site = await ctx.db.siteContext(report.site_id);
  if (!site) throw new Error(`site ${report.site_id} not found`);
  const reporter = await ctx.db.getReporter(correction.reporter_id);
  if (!ctx.ai.claude) throw new Error('ANTHROPIC_API_KEY is required for apply_correction');
  const companies = site.companies.map((c) => ({ id: c.id, name: c.name, aliases: c.aliases }));
  const defaultShiftHours = Number(site.settings.default_shift_hours);
  const parsed = await parseCorrectionV2(
    ctx.ai.claude,
    ctx.config.CLAUDE_MODEL,
    {
      data: draft,
      correctionText: words.text,
      via: correction.via === 'voice' ? 'voice' : 'text',
      defaultShiftHours,
      companies,
      reporterLanguage: (reporter?.locale ?? site.org.locale).slice(0, 2),
    },
    log,
  );
  ctx.metrics.add({ tokens: parsed.usage, estCostUsd: parsed.estCostUsd });
  if (parsed.data.needsClarification) {
    await settle('unclear', {
      reason: 'clarification',
      clarification: parsed.data.needsClarification.slice(0, 300),
    });
    return;
  }

  // 3. Code applies it into the preview.
  const applied = applyCorrectionOps(draft, parsed.data.operations, {
    source: words.source,
    text: words.text,
    defaultShiftHours,
    companies,
  });
  if (!applied.ok) {
    await settle('unclear', { reason: applied.reason, detail: applied.detail ?? null });
    return;
  }
  try {
    await settle('ready', {
      data: applied.data,
      changes: applied.changes,
      operations: applied.operations,
      source: words.source,
      changeNote: parsed.data.changeNote,
      droppedTotals: applied.droppedTotals,
      baseVersion: report.current_version || 1,
      baseRev: version.draft_rev ?? 1,
    });
  } catch (err) {
    // The draft changed under the parse (a late photo's re-extraction): the job runs again on it.
    if (/draft_changed/.test(String((err as Error).message)))
      log.info('apply_correction: the draft changed; retrying on the new one');
    throw err;
  }
};

/**
 * The correction's words and the source a value it changes cites: a clip's transcript (transcribed
 * now, or the one a retry finds) with its seconds, or the typed text as `reporter_edit`. Null for a
 * clip with nothing in it.
 */
async function correctionWords(
  ctx: Parameters<JobHandler<'apply_correction'>>[0],
  correction: DraftCorrectionRow,
  reportId: string,
  log: Parameters<JobHandler<'apply_correction'>>[0]['log'],
): Promise<{ text: string; source: Source } | null> {
  if (correction.via === 'text') {
    const text = correction.text?.trim() ?? '';
    if (!text) return null;
    return {
      text,
      source: {
        type: 'reporter_edit',
        reporterId: correction.reporter_id,
        at: new Date(correction.created_at).toISOString(),
        // §19 Q80: the channel the reporter typed it on (W2-12: an SMS EDIT).
        via: correction.message_id ? 'sms' : 'web',
      },
    };
  }
  if (!correction.upload_id) throw new PermanentJobError(`correction ${correction.id} has no clip`);
  const upload = await ctx.db.getUpload(correction.upload_id);
  if (
    !upload ||
    upload.correction_report_id !== reportId ||
    upload.report_id !== reportId ||
    upload.kind !== 'audio'
  )
    throw new PermanentJobError(`upload ${correction.upload_id} is not a correction clip`);
  let transcript = await ctx.db.getUploadTranscript(upload.id);
  if (!transcript) {
    if (upload.purged_at) throw new PermanentJobError(`upload ${upload.id} was purged`);
    await transcribe(ctx, upload, log, 'correction');
    transcript = await ctx.db.getUploadTranscript(upload.id);
  }
  const text = transcript?.text.trim() ?? '';
  if (!text) return null;
  const segments = (transcript?.segments ?? []) as Array<{ start?: number; end?: number }>;
  const start = Math.max(0, Number(segments[0]?.start ?? 0));
  const end = Number(segments.at(-1)?.end ?? upload.duration_s ?? 0);
  return {
    text,
    source: {
      type: 'voice_note',
      uploadId: upload.id,
      start,
      ...(end > start ? { end } : {}),
    },
  };
}
