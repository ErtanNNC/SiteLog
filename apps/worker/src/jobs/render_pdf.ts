import { jobKeys, pdfStoragePath, readReportData, type StoredReportData } from '@sitelog/shared';
import { buildReportPdfInput, renderReportPdf } from '../pdf/render';
import { PermanentJobError, type JobHandler } from './types';

/**
 * §M4 — render the version to `pdfs/{org}/{site}/{report_no}_v{n}.pdf`, then email it (§13). Since
 * W1-15 nothing goes out on WhatsApp: the reporter's `filed` text comes from file_report through
 * the Notifier, and the payload's `sendToWhatsApp` and `notifyReporter` are ignored (D31: the
 * office-edit notice ended). A retry renders the same file again and finds the email's key taken.
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

  if (payload.emailRecipients) {
    const kind = version.version > 1 ? 'report_updated' : 'report_filed';
    await ctx.db.enqueueJob(
      'send_email',
      { kind, reportId: report.id, version: version.version, changeNote: payload.changeNote },
      { dedupeKey: jobKeys.reportEmail(kind, report.id, version.version) },
    );
  }
};
