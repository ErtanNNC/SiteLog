import {
  ensurePhotosLink,
  fieldLinkUrl,
  fieldReportLinkUrl,
  photosLinkExpiresAt,
  jobKeys,
  noticeData,
  type DailyReportDataV1,
  type FieldChannel,
  type ReportRow,
  type ReportVersionRow,
  type SiteDayStatus,
} from '@sitelog/shared';
import { randomUUID } from 'node:crypto';
import type { Ctx } from '../context';
import { recordReportCostSafely } from '../cost';
import type { SiteContext } from '../db';
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
 * reporter confirms the new draft, or the timeouts file it. The check, the read of the draft and
 * the filing write are one: `fileVersion` files only while the report and its draft are still
 * what this filing read (else it reads them again, `FILE_ATTEMPTS`), in one transaction that
 * sets the status with the frozen data, and a draft write waits for it and then refuses
 * (`storeDraftVersion`).
 * Last step: the AI + WhatsApp cost estimate (§15 cost guardrail, src/cost.ts); it never fails filing.
 */

export type FileTrigger = 'confirm' | 'auto' | 'timeout' | 'office' | 'weather_day' | 'no_work';

export interface FileOptions {
  trigger: FileTrigger;
  confirmMessageId?: string | null;
  /**
   * The draft version a field-api confirm was for (trigger 'confirm'), or the draft a web
   * confirmation timeout files (trigger 'timeout' / 'auto', W2-07).
   */
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

/** How often fileReport computes the filing again when the report changed while it did. */
export const FILE_ATTEMPTS = 3;

export async function fileReport(
  ctx: Ctx,
  reportId: string,
  opts: FileOptions,
): Promise<FileResult> {
  for (let attempt = 1; ; attempt++) {
    const result = await fileOnce(ctx, reportId, opts);
    if (result) return result;
    // The draft or the report changed between reading and filing (a re-extraction, an answer, a
    // status change): nothing was written. Read it again: a confirm of the old draft is now
    // stale, a filing that is not a confirm files the new draft.
    ctx.log.info('filing: the report changed meanwhile, reading it again', {
      report_id: reportId,
      attempt,
    });
    if (attempt >= FILE_ATTEMPTS)
      throw new Error(`report ${reportId} changed during ${attempt} filing attempts`);
  }
}

/** One filing attempt; null when the report changed since it was read (nothing written). */
async function fileOnce(ctx: Ctx, reportId: string, opts: FileOptions): Promise<FileResult | null> {
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
  // A confirm, or a web confirmation timeout (W2-07: the draft nobody confirmed at that version
  // and revision), names the draft it is for: one that changed since files nothing.
  const forDraft =
    opts.trigger === 'confirm' || opts.trigger === 'timeout' || opts.trigger === 'auto';
  if (
    forDraft &&
    opts.version !== undefined &&
    (report.status !== 'awaiting_confirmation' ||
      report.current_version !== opts.version ||
      (opts.draftRev !== undefined && (existing.draft_rev ?? 1) !== opts.draftRev))
  ) {
    await ctx.db.logAudit({
      org_id: report.org_id,
      actor_type: 'system',
      action: opts.trigger === 'confirm' ? 'report.confirm_stale' : 'report.timeout_stale',
      entity: 'report',
      entity_id: report.id,
      diff: {
        confirmed_version: opts.version,
        current_version: report.current_version,
        ...(opts.draftRev !== undefined
          ? { confirmed_draft_rev: opts.draftRev, draft_rev: existing.draft_rev ?? 1 }
          : {}),
        status: report.status,
        ...(opts.trigger === 'confirm' ? {} : { trigger: opts.trigger }),
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
  // The version read above, at its revision: fileVersion writes only while it is still that one.
  const data = existing.data as DailyReportDataV1;
  const draftRev = existing.draft_rev ?? 1;
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
  const deadline = new Date(siteDay.deadline_at);
  const isLate = now.getTime() > deadline.getTime();
  const confirmed = opts.trigger === 'confirm' || opts.trigger === 'office';
  const dayStatus: SiteDayStatus =
    report.kind === 'weather_day' ? 'weather_day' : report.kind === 'no_work' ? 'no_work' : 'filed';
  // One transaction: the status, version and revision this filing was computed from are checked
  // under the row locks, then the report is filed and the version frozen together, so a
  // concurrent re-extraction either lands before (and this attempt is redone) or is refused
  // (storeDraftVersion), and a field poll never sees the frozen data as a newer draft.
  const outcome = await ctx.db.fileVersion({
    reportId: report.id,
    siteDayId: siteDay.id,
    version: versionNo,
    expect: { status: report.status, draftRev },
    data: frozen,
    summary: frozen.summary || null,
    report: {
      status: 'filed',
      current_version: versionNo,
      filed_at: now,
      confirmed_at: confirmed ? now : null,
      confirmed_via: opts.trigger === 'confirm' ? (opts.via ?? null) : null,
      is_late: isLate,
      needs_review: reasons.length > 0,
      review_reasons: reasons,
    },
    siteDay: { status: dayStatus, report_id: report.id, is_late: isLate },
    audit: {
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
    },
  });
  if (!outcome.filed) return null;
  const updated = outcome.report;
  if (reasons.length > 0) {
    await ctx.db.notifyOrg(
      report.org_id,
      'needs_review',
      `${report.report_no} needs review`,
      reasons.join(', '),
      `/reports/${report.id}`,
      null,
      noticeData('needs_review', { reportNo: report.report_no, reasons }),
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
  // W3-10 (F9 step 1, §13): after a report filed on a call, the photos link (`kind 'photos'`,
  // until 23:59 the day after, site time) in its own `photos_link` text, after `filed`.
  if (report.confirmed_via === 'voice') await enqueuePhotosLink(ctx, report, site);
}

/**
 * The `photos_link` text of a call-filed report (F9): the reporter's photos link for the report's
 * site and date (`ensurePhotosLink`: a retried filing derives the same link) through the Notifier,
 * which checks the consents; one per report (`notify:photos_link:{report}`).
 */
async function enqueuePhotosLink(ctx: Ctx, report: ReportRow, site: SiteContext): Promise<void> {
  if (!report.reporter_id) return;
  if (!ctx.config.LINK_SIGNING_SECRET) throw new Error('LINK_SIGNING_SECRET is not set');
  if (!ctx.config.FIELD_APP_URL) throw new Error('FIELD_APP_URL is not set');
  const day = await ctx.db.getSiteDay(report.site_day_id);
  if (!day) throw new Error(`site_day ${report.site_day_id} not found`);
  const link = await ensurePhotosLink(
    {
      listPhotosLinks: (r, s, d) => ctx.db.listPhotosLinks(r, s, d),
      insertPhotosLink: (row) => ctx.db.insertPhotosLink(row),
    },
    ctx.config.LINK_SIGNING_SECRET,
    {
      reporterId: report.reporter_id,
      siteId: report.site_id,
      reportDate: day.date,
      expiresAt: photosLinkExpiresAt(day.date, site.site.timezone),
      now: ctx.now(),
    },
    randomUUID,
  );
  if (link.created)
    await ctx.db.logAudit({
      org_id: report.org_id,
      actor_type: 'system',
      action: 'field_link.created',
      entity: 'reporter',
      entity_id: report.reporter_id,
      diff: {
        kind: 'photos',
        site_id: report.site_id,
        report_date: day.date,
        report_id: report.id,
      },
    });
  await ctx.db.enqueueJob(
    'notify',
    {
      reporterId: report.reporter_id,
      key: 'photos_link',
      vars: { link: fieldLinkUrl(ctx.config.FIELD_APP_URL, link.code) },
      dedupeKey: jobKeys.photosLink(report.id),
    },
    { dedupeKey: jobKeys.photosLink(report.id) },
  );
}
