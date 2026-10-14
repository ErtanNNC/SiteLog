import {
  waCopy,
  type DailyReportDataV1,
  type ReportRow,
  type ReportVersionRow,
  type SiteDayStatus,
} from '@sitelog/shared';
import { firstName } from '@sitelog/shared';
import type { Ctx } from '../context';
import { recordReportCostSafely } from '../cost';
import { sendFreeForm } from '../wa/send';
import { currentData } from './draft';
import { reviewReasons, validateDraft } from './validate';
import { contextOf } from '../router/context';

/**
 * §F7 step 3 — filing: freeze the current version, write the denormalised rows, set filed_at /
 * confirmed_at / is_late, flip the site-day, flag review reasons, render + deliver the PDF.
 * Idempotent: a report that is already filed or signed off is returned unchanged.
 * Last step: the AI + WhatsApp cost estimate (§15 cost guardrail, src/cost.ts); it never fails filing.
 */

export type FileTrigger = 'confirm' | 'auto' | 'timeout' | 'office' | 'weather_day' | 'no_work';

export interface FileOptions {
  trigger: FileTrigger;
  confirmMessageId?: string | null;
  extraReasons?: string[];
  /** Skip the WhatsApp "Filed." messages (weather day / no work have their own copy). */
  silent?: boolean;
}

export interface FileResult {
  report: ReportRow;
  version: ReportVersionRow;
  reasons: string[];
  alreadyFiled: boolean;
}

export async function fileReport(
  ctx: Ctx,
  reportId: string,
  opts: FileOptions,
): Promise<FileResult> {
  const report = await ctx.db.getReport(reportId);
  if (!report) throw new Error(`report ${reportId} not found`);
  const versionNo = report.current_version || 1;
  const existing = await ctx.db.getVersion(report.id, versionNo);
  if (!existing) throw new Error(`report ${reportId} has no version ${versionNo}`);
  if (report.status === 'filed' || report.status === 'signed_off') {
    return { report, version: existing, reasons: report.review_reasons, alreadyFiled: true };
  }
  const site = await ctx.db.siteContext(report.site_id);
  if (!site) throw new Error(`site ${report.site_id} not found`);
  const siteDay = await ctx.db.getSiteDay(report.site_day_id);
  if (!siteDay) throw new Error(`site_day ${report.site_day_id} not found`);
  const data = (await currentData(ctx, report)) as DailyReportDataV1;
  const sources = await ctx.db.listReportSources(report.id);
  const questions = await ctx.db.listQuestions(report.id);
  const now = ctx.now();

  // Review reasons: validation gaps + unanswered questions + trigger-specific extras + earlier flags.
  const photoCount = sources.filter((s) => s.kind === 'photo').length;
  const validation =
    report.kind === 'daily'
      ? validateDraft(data, site.settings, photoCount)
      : { gaps: [], missingRequired: [], lowConfidence: [], reviewReasons: [], isComplete: true };
  const extras = [...(opts.extraReasons ?? []), ...report.review_reasons];
  if (opts.trigger === 'timeout') extras.push('unconfirmed');
  const reasons = reviewReasons(validation, questions, extras);

  // Freeze: write the computed missingRequired / lowConfidence into the version data.
  const frozen: DailyReportDataV1 = {
    ...data,
    missingRequired: validation.missingRequired,
    lowConfidence: validation.lowConfidence,
    photos: data.photos.length
      ? data.photos
      : sources
          .filter((s) => s.kind === 'photo' && s.media_id)
          .map((s) => ({
            // v1 data keys a photo by its media id (an upload's id, or the message's).
            messageId: s.media_id!,
            caption: s.caption ?? undefined,
            takenAt: s.taken_at ?? s.message_created_at,
          })),
  };
  await ctx.db.updateVersion(report.id, versionNo, {
    data: frozen,
    summary: frozen.summary || null,
  });
  await ctx.db.denormalizeVersion(report.id, versionNo);

  const deadline = new Date(siteDay.deadline_at);
  const isLate = now.getTime() > deadline.getTime();
  const confirmed = opts.trigger === 'confirm' || opts.trigger === 'office';
  const updated = await ctx.db.updateReport(report.id, {
    status: 'filed',
    current_version: versionNo,
    filed_at: now,
    confirmed_at: confirmed ? now : null,
    is_late: isLate,
    needs_review: reasons.length > 0,
    review_reasons: reasons,
  });
  const dayStatus: SiteDayStatus =
    report.kind === 'weather_day' ? 'weather_day' : report.kind === 'no_work' ? 'no_work' : 'filed';
  await ctx.db.updateSiteDay(siteDay.id, {
    status: dayStatus,
    report_id: report.id,
    is_late: isLate,
  });

  await ctx.db.logAudit({
    org_id: report.org_id,
    actor_type:
      opts.trigger === 'office' ? 'user' : opts.trigger === 'confirm' ? 'reporter' : 'agent',
    actor_id: opts.trigger === 'confirm' ? (report.reporter_id ?? null) : null,
    action: 'report.filed',
    entity: 'report',
    entity_id: report.id,
    diff: {
      trigger: opts.trigger,
      version: versionNo,
      is_late: isLate,
      review_reasons: reasons,
      confirm_message_id: opts.confirmMessageId ?? null,
    },
  });
  if (reasons.length > 0) {
    await ctx.db.notifyOrg(
      report.org_id,
      'needs_review',
      `${report.report_no} needs review`,
      reasons.join(', '),
      `/reports/${report.id}`,
    );
  }

  const renderWanted = report.kind !== 'no_work' || site.settings.no_work_pdf;
  if (renderWanted) {
    await ctx.db.enqueueJob(
      'render_pdf',
      {
        reportId: report.id,
        version: versionNo,
        sendToWhatsApp: report.kind === 'daily' && !opts.silent,
        emailRecipients: site.settings.email_pdf_on_file,
      },
      { dedupeKey: `render_pdf:${report.id}:${versionNo}` },
    );
  }

  // Conversation → idle; the "Filed." line goes out now, the PDF + edit hint follow from render_pdf.
  const reporter = report.reporter_id ? await ctx.db.getReporter(report.reporter_id) : null;
  const convo = reporter ? await ctx.db.getConversationByPhone(reporter.phone_e164) : null;
  if (convo) {
    const prev = contextOf(convo);
    if (prev.active_report_id === report.id || !prev.active_report_id) {
      await ctx.db.updateConversation(convo.id, {
        state: 'idle',
        context: {
          ...prev,
          active_report_id: null,
          pending_question_id: null,
          draft_message_id: null,
          draft_wa_message_id: null,
          fix_requested_for: null,
          last_filed_report_id: report.id,
        },
      });
    }
    if (!opts.silent && report.kind === 'daily') {
      const text =
        opts.trigger === 'timeout' || opts.trigger === 'auto'
          ? waCopy.filedUnconfirmed(report.report_no)
          : waCopy.filed(report.report_no, firstName(reporter!.name));
      await sendFreeForm(ctx, convo, text, undefined, { kind: 'filed', reportId: report.id });
    }
  }
  await recordReportCostSafely(ctx, report.id);
  const version = (await ctx.db.getVersion(report.id, versionNo))!;
  return { report: updated, version, reasons, alreadyFiled: false };
}
