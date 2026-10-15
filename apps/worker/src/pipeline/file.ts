import {
  fieldReportLinkUrl,
  jobKeys,
  type DailyReportDataV1,
  type FieldChannel,
  type ReportRow,
  type ReportVersionRow,
  type SiteDayStatus,
} from '@sitelog/shared';
import type { Ctx } from '../context';
import { recordReportCostSafely } from '../cost';
import type { SiteContext } from '../db';
import { currentData } from './draft';
import { reviewReasons, validateDraft } from './validate';
import { personalLinkCode } from './web';
import { contextOf } from '../router/context';

/**
 * §10.1 `file_report`, F8 "Filing": freeze the current version, write the denormalised rows, set
 * filed_at / confirmed_at / confirmed_via / is_late, flip the site-day, flag review reasons, then
 * the post-filing steps (`ensurePostFiling`): `render_pdf` (which enqueues `send_email` with the
 * PDF) and the reporter's `filed` text through the Notifier (`notify`, keyed
 * `notify:filed:{report}`), whose link opens the Filed screen (W1-15; the v1.0 WhatsApp "Filed."
 * and PDF document are gone).
 *
 * Idempotent and retry-safe: a report that is already filed is returned unchanged, but its
 * post-filing jobs are enqueued again under their keys (D16: a taken key returns its job and
 * enqueues nothing), so a failure after `status = filed` (a retried file_report job, or another
 * filing that finds it filed) can no longer skip the PDF, the text or the email
 * (docs/AUDIT_BACKLOG.md). A field-api confirm names the version the reporter confirmed
 * (`opts.version`, `opts.draftRev`, field_confirm_report()): if the report has left
 * awaiting_confirmation, moved to another version, or its draft was rewritten in place since (a
 * late photo's re-extraction: another `draft_rev`), nothing is filed (`report.confirm_stale`); the
 * reporter confirms the new draft, or the timeouts file it.
 * Last step: the AI + WhatsApp cost estimate (§15 cost guardrail, src/cost.ts); it never fails filing.
 */

export type FileTrigger = 'confirm' | 'auto' | 'timeout' | 'office' | 'weather_day' | 'no_work';

export interface FileOptions {
  trigger: FileTrigger;
  confirmMessageId?: string | null;
  /** The draft version a field-api confirm was for (with trigger 'confirm'). */
  version?: number;
  /**
   * That version's draft revision the reporter saw (`report_versions.draft_rev`, 20261015000070):
   * drafts are overwritten in place, so a re-extraction since the confirm makes it stale.
   */
  draftRev?: number;
  extraReasons?: string[];
  /**
   * The channel the reporter confirmed on (`reports.confirmed_via`, §10.1 `file_report(report_id,
   * via)`): `web` from field_confirm_report(). Stored only for a confirm.
   */
  via?: FieldChannel;
  /** No `filed` text (weather day / no work have their own copy). */
  silent?: boolean;
}

/**
 * How long after filing a filing that finds the report filed still re-enqueues its post-filing
 * jobs: longer than a file_report job's retries take (§10.1: 30 s + 2 min + 10 min + 30 min + 2 h),
 * well inside the jobs' retention (JOB_RETENTION_DAYS), so a key is never free again by then.
 */
export const POST_FILING_RETRY_MS = 24 * 3600_000;

export interface FileResult {
  report: ReportRow;
  version: ReportVersionRow;
  reasons: string[];
  alreadyFiled: boolean;
  /** A confirm for a state or version the report has left: nothing was filed. */
  stale?: boolean;
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
    const filedAt = report.filed_at ? new Date(report.filed_at).getTime() : null;
    if (
      report.status === 'filed' &&
      filedAt !== null &&
      ctx.now().getTime() - filedAt < POST_FILING_RETRY_MS
    ) {
      const site = await ctx.db.siteContext(report.site_id);
      if (site) await ensurePostFiling(ctx, report, site, report.current_version || 1, opts);
    }
    return { report, version: existing, reasons: report.review_reasons, alreadyFiled: true };
  }
  if (
    opts.trigger === 'confirm' &&
    opts.version !== undefined &&
    (report.status !== 'awaiting_confirmation' ||
      report.current_version !== opts.version ||
      (opts.draftRev !== undefined && (existing.draft_rev ?? 1) !== opts.draftRev))
  ) {
    await ctx.db.logAudit({
      org_id: report.org_id,
      actor_type: 'system',
      action: 'report.confirm_stale',
      entity: 'report',
      entity_id: report.id,
      diff: {
        confirmed_version: opts.version,
        current_version: report.current_version,
        ...(opts.draftRev !== undefined
          ? { confirmed_draft_rev: opts.draftRev, draft_rev: existing.draft_rev ?? 1 }
          : {}),
        status: report.status,
      },
    });
    return {
      report,
      version: existing,
      reasons: report.review_reasons,
      alreadyFiled: false,
      stale: true,
    };
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
    confirmed_via: opts.trigger === 'confirm' ? (opts.via ?? null) : null,
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
      via: opts.trigger === 'confirm' ? (opts.via ?? null) : null,
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

  // _(current)_ The v1.0 WhatsApp conversation of the reporter goes back to idle (state only; its
  // "Filed." text and PDF document are replaced by the `filed` text below). Kept until step 22
  // retires the WhatsApp worker, whose router would otherwise still point at this report.
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
  }
  await ensurePostFiling(ctx, updated, site, versionNo, opts);
  await recordReportCostSafely(ctx, report.id);
  const version = (await ctx.db.getVersion(report.id, versionNo))!;
  return { report: updated, version, reasons, alreadyFiled: false };
}

/**
 * The post-filing jobs of a filed report (§10.1 `file_report` → `render_pdf` → `notify(filed)`,
 * `send_email`), each under its key, so calling this again (a retried filing) enqueues nothing new:
 * - `render_pdf` of the filed version (unless a no-work day without a PDF), which enqueues the
 *   §13 email with the PDF once the file exists (`email_pdf_on_file`);
 * - the reporter's `filed` text (§9.2) through the Notifier (`notify`, priority 0), keyed
 *   `notify:filed:{report}` for the job and the Notifier, with the Filed-screen link
 *   `/r/{personal code}/report/{id}` (it opens the PDF through a freshly signed URL). Daily reports
 *   of a reporter only: a weather day or no-work filing (`silent`) has its own copy.
 *
 * The PDF and the email are enqueued first, so a missing link configuration (which throws, and
 * retries the filing) never holds them back.
 */
export async function ensurePostFiling(
  ctx: Ctx,
  report: ReportRow,
  site: SiteContext,
  versionNo: number,
  opts: Pick<FileOptions, 'silent'>,
): Promise<void> {
  if (report.kind !== 'no_work' || site.settings.no_work_pdf) {
    await ctx.db.enqueueJob(
      'render_pdf',
      {
        reportId: report.id,
        version: versionNo,
        sendToWhatsApp: false,
        emailRecipients: site.settings.email_pdf_on_file,
      },
      { dedupeKey: jobKeys.renderPdf(report.id, versionNo) },
    );
  }
  if (report.kind !== 'daily' || opts.silent || !report.reporter_id) return;
  const { base, code } = await personalLinkCode(ctx, report.reporter_id, report.org_id);
  await ctx.db.enqueueJob(
    'notify',
    {
      reporterId: report.reporter_id,
      key: 'filed',
      vars: { report_no: report.report_no, pdf_link: fieldReportLinkUrl(base, code, report.id) },
      dedupeKey: jobKeys.filed(report.id),
    },
    { dedupeKey: jobKeys.filed(report.id) },
  );
}
