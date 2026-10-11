import { pdfFileName, pdfStoragePath, waCopy, weekdayName, type DailyReportData } from '@sitelog/shared';
import { buildReportPdfInput, renderReportPdf } from '../pdf/render';
import { sendBusinessInitiated, sendDocumentMessage } from '../wa/send';
import { PermanentJobError, rawPayload, type JobHandler } from './types';

/** §M4 — render the version to `pdfs/{org}/{site}/{report_no}_v{n}.pdf`, send it on WhatsApp, email it. */
export const renderPdf: JobHandler<'render_pdf'> = async (ctx, payload, job) => {
  const report = await ctx.db.getReport(payload.reportId);
  if (!report) throw new PermanentJobError(`report ${payload.reportId} not found`);
  const version = await ctx.db.getVersion(report.id, payload.version);
  if (!version) throw new PermanentJobError(`version ${payload.version} of ${report.id} not found`);
  const site = await ctx.db.siteContext(report.site_id);
  if (!site) throw new PermanentJobError(`site ${report.site_id} not found`);
  const data = version.data as DailyReportData;

  const input = await buildReportPdfInput(ctx, { report, version, site, data });
  const buffer = await renderReportPdf(input);
  const path = pdfStoragePath(site.org.id, site.site.id, report.report_no, version.version);
  await ctx.storage.upload('pdfs', path, buffer, 'application/pdf');
  await ctx.db.updateVersion(report.id, version.version, { pdf_path: path });
  await ctx.db.logAudit({ org_id: report.org_id, actor_type: 'agent', action: 'report.pdf_rendered', entity: 'report', entity_id: report.id, diff: { version: version.version, path, bytes: buffer.length } });
  ctx.metrics.add({ pdfBytes: buffer.length });

  const reporter = report.reporter_id ? await ctx.db.getReporter(report.reporter_id) : null;
  const convo = reporter ? await ctx.db.getConversationByPhone(reporter.phone_e164) : null;
  const filename = pdfFileName(report.report_no, data.reportDate, version.version);

  if (payload.sendToWhatsApp && convo) {
    await sendDocumentMessage(ctx, convo, { buffer, filename, mime: 'application/pdf', caption: `Daily Report ${report.report_no}` }, { kind: 'pdf', reportId: report.id });
    await sendBusinessInitiated(ctx, convo, 'sitelog_report_edited_by_office', [report.report_no, ''], waCopy.editHint(weekdayName(data.reportDate)), { buttons: [], meta: { kind: 'edit_hint', reportId: report.id } });
  }
  const notifyReporter = rawPayload(job).notifyReporter === true;
  if (notifyReporter && convo && payload.changeNote) {
    await sendBusinessInitiated(ctx, convo, 'sitelog_report_edited_by_office', [report.report_no, payload.changeNote], null, { buttons: [], meta: { kind: 'office_edit', reportId: report.id } });
  }
  if (payload.emailRecipients) {
    const kind = version.version > 1 ? 'report_updated' : 'report_filed';
    await ctx.db.enqueueJob('send_email', { kind, reportId: report.id, version: version.version, changeNote: payload.changeNote }, { dedupeKey: `email:${kind}:${report.id}:${version.version}` });
  }
};
