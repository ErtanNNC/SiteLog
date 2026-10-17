import { jobKeys, pdfStoragePath, readReportData, type StoredReportData } from '@sitelog/shared';
import { buildReportPdfInput, renderReportPdf } from '../pdf/render';
import { PermanentJobError, type JobHandler } from './types';

/**
 * §M4 — render the version to `pdfs/{org}/{site}/{report_no}_v{n}.pdf`, then email it (§13). Since
 * W1-15 nothing goes out on WhatsApp: the reporter's `filed` text comes from file_report through
 * the Notifier, and the payload's `sendToWhatsApp` and `notifyReporter` are ignored (D31: the
 * office-edit notice ended). A retry renders the same file again and finds the email's key taken.
 * A version that is no longer current is still rendered (its file is kept), without its sign-off
 * (`versionSignedOff`) and without an email.
 *
 * F10 (W2-11): a version the reporter made on the web carries `signerId` (the signer of the version
 * it reopened, emailed with the recipients) and `editApplied` (their `edit_applied` text, queued
 * after the email under `jobKeys.editApplied`, so a retry texts once; none for a superseded version,
 * whose email is not sent either).
 */
export const renderPdf: JobHandler<'render_pdf'> = async (ctx, payload) => {
  const report = await ctx.db.getReport(payload.reportId);
  if (!report) throw new PermanentJobError(`report ${payload.reportId} not found`);
  const version = await ctx.db.getVersion(report.id, payload.version);
  if (!version) throw new PermanentJobError(`version ${payload.version} of ${report.id} not found`);
  const site = await ctx.db.siteContext(report.site_id);
  if (!site) throw new PermanentJobError(`site ${report.site_id} not found`);
  // Stored v1 or v2; the PDF reads the v2 view (D20).
  const data = readReportData(version.data as unknown as StoredReportData);

  const input = await buildReportPdfInput(ctx, { report, version, site, data });
  const buffer = await renderReportPdf(input);
  const path = pdfStoragePath(site.org.id, site.site.id, report.report_no, version.version);
  await ctx.storage.upload('pdfs', path, buffer, 'application/pdf');
  await ctx.db.updateVersion(report.id, version.version, { pdf_path: path });
  await ctx.db.logAudit({
    org_id: report.org_id,
    actor_type: 'agent',
    action: 'report.pdf_rendered',
    entity: 'report',
    entity_id: report.id,
    diff: { version: version.version, path, bytes: buffer.length },
  });
  ctx.metrics.add({ pdfBytes: buffer.length });

  if (payload.emailRecipients && version.version !== report.current_version) {
    // A newer version exists (an office edit while this job waited): its own render emails it, and
    // an email for this one would send the office a superseded report.
    ctx.log.info('render_pdf: version superseded, no email', {
      report_id: report.id,
      version: version.version,
      current_version: report.current_version,
    });
  } else if (payload.emailRecipients) {
    const kind = version.version > 1 ? 'report_updated' : 'report_filed';
    await ctx.db.enqueueJob(
      'send_email',
      {
        kind,
        reportId: report.id,
        version: version.version,
        changeNote: payload.changeNote,
        ...(payload.signerId ? { signerId: payload.signerId } : {}),
      },
      { dedupeKey: jobKeys.reportEmail(kind, report.id, version.version) },
    );
    if (payload.editApplied) {
      // F10 (W2-11): the reporter's change of a filed report is with the office; tell them once.
      await ctx.db.enqueueJob(
        'notify',
        {
          reporterId: payload.editApplied.reporterId,
          key: 'edit_applied',
          vars: {
            weekday: payload.editApplied.weekday,
            change: payload.editApplied.change,
            v: version.version,
          },
          dedupeKey: jobKeys.editApplied(report.id, version.version),
        },
        { dedupeKey: jobKeys.editApplied(report.id, version.version) },
      );
    }
  }
};
