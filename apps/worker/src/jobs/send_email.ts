import { deriveTotals, firstName, formatDateShort, pdfFileName, type DailyReportData } from '@sitelog/shared';
import type { Ctx } from '../context';
import type { EmailAttachment } from '../email/provider';
import {
  evidencePackReadyEmail,
  invoiceQueryEmail,
  reportEditedAfterSignoffEmail,
  reportFiledEmail,
  reportMissingEmail,
  unknownSenderEmail,
  weeklyDigestEmail,
  type RenderedEmail,
} from '../email/templates';
import { PermanentJobError, type JobHandler } from './types';

/** §13 — every email the worker sends, by kind. */
export const sendEmail: JobHandler<'send_email'> = async (ctx, payload) => {
  const built = await buildEmail(ctx, payload);
  if (!built) return;
  const { to, rendered, attachments } = built;
  if (to.length === 0) {
    ctx.log.info('email skipped: no recipients', { kind: payload.kind });
    return;
  }
  const res = await ctx.email.send({ to, subject: rendered.subject, html: rendered.html, text: rendered.text, attachments, tags: { kind: payload.kind } });
  ctx.log.info('email sent', { kind: payload.kind, to: to.length, provider: ctx.email.name, id: res.id });
};

type EmailPayload = Parameters<JobHandler<'send_email'>>[1];

export async function buildEmail(ctx: Ctx, payload: EmailPayload): Promise<{ to: string[]; rendered: RenderedEmail; attachments?: EmailAttachment[] } | null> {
  const appUrl = ctx.config.APP_URL;
  switch (payload.kind) {
    case 'report_filed':
    case 'report_updated': {
      if (!payload.reportId) throw new PermanentJobError('reportId required');
      const report = await ctx.db.getReport(payload.reportId);
      if (!report) throw new PermanentJobError(`report ${payload.reportId} not found`);
      const version = await ctx.db.getVersion(report.id, payload.version ?? report.current_version);
      const site = await ctx.db.siteContext(report.site_id);
      if (!version || !site) throw new PermanentJobError(`report ${report.id} version/site missing`);
      const data = version.data as DailyReportData;
      const to = payload.to ?? [...site.recipients];
      if (payload.kind === 'report_updated' && report.signed_off_by) {
        const signer = await ctx.db.getUserContact(report.signed_off_by);
        if (signer?.email) to.push(signer.email);
      }
      const attachments: EmailAttachment[] = [];
      if (version.pdf_path) {
        try {
          attachments.push({ filename: pdfFileName(report.report_no, data.reportDate, version.version), content: await ctx.storage.download('pdfs', version.pdf_path), contentType: 'application/pdf' });
        } catch (err) {
          ctx.log.warn('pdf attachment missing', { err, report_id: report.id });
        }
      }
      const reporter = report.reporter_id ? await ctx.db.getReporter(report.reporter_id) : null;
      const rendered = reportFiledEmail({
        kind: payload.kind,
        orgName: site.org.name,
        siteName: site.site.name,
        reportNo: report.report_no,
        reportDate: data.reportDate,
        version: version.version,
        changeNote: payload.changeNote ?? version.change_note ?? null,
        summary: data.summary,
        totals: deriveTotals(data, { selfPerformCompanyIds: new Set(site.companies.filter((c) => c.is_self_perform).map((c) => c.id)) }),
        reviewReasons: report.review_reasons,
        isLate: report.is_late,
        reporterFirstName: reporter ? firstName(reporter.name) : null,
        url: `${appUrl}/reports/${report.id}`,
      });
      return { to: Array.from(new Set(to)), rendered, attachments };
    }
    case 'report_missing': {
      if (!payload.siteDayId) throw new PermanentJobError('siteDayId required');
      const siteDay = await ctx.db.getSiteDay(payload.siteDayId);
      if (!siteDay) throw new PermanentJobError(`site_day ${payload.siteDayId} not found`);
      const site = await ctx.db.siteContext(siteDay.site_id);
      if (!site) throw new PermanentJobError(`site ${siteDay.site_id} not found`);
      const members = await ctx.db.listMemberEmails(site.org.id, ['ops', 'admin']);
      const reporter = site.reporters[0] ?? null;
      const rendered = reportMissingEmail({
        orgName: site.org.name,
        siteName: site.site.name,
        date: siteDay.date,
        reporterFirstName: reporter ? firstName(reporter.name) : null,
        reporterPhone: reporter?.phone_e164 ?? null,
        url: `${appUrl}/sites/${site.site.id}`,
      });
      return { to: payload.to ?? members.map((m) => m.email), rendered };
    }
    case 'invoice_query': {
      if (!payload.invoiceId) throw new PermanentJobError('invoiceId required');
      const inv = await ctx.db.getInvoiceSummary(payload.invoiceId);
      if (!inv) throw new PermanentJobError(`invoice ${payload.invoiceId} not found`);
      const org = await ctx.db.getOrg(inv.org_id);
      const rendered = invoiceQueryEmail({
        orgName: org?.name ?? 'SiteLog',
        companyName: inv.company_name,
        invoiceNo: inv.invoice_no,
        periodStart: inv.period_start,
        periodEnd: inv.period_end,
        invoicedHours: inv.invoiced_hours,
        reportedHours: inv.reported_hours,
        url: `${appUrl}/hours`,
      });
      return { to: payload.to ?? [], rendered };
    }
    case 'evidence_pack_ready': {
      if (!payload.packId) throw new PermanentJobError('packId required');
      const pack = await ctx.db.getEvidencePack(payload.packId);
      if (!pack || !pack.pdf_path) throw new PermanentJobError(`pack ${payload.packId} not ready`);
      const org = await ctx.db.getOrg(pack.org_id);
      const site = pack.site_id ? await ctx.db.getSite(pack.site_id) : null;
      const url = await ctx.storage.signedUrl('exports', pack.pdf_path, 7 * 24 * 3600);
      const to = payload.to ?? [];
      if (to.length === 0 && pack.created_by) {
        const c = await ctx.db.getUserContact(pack.created_by);
        if (c?.email) to.push(c.email);
      }
      const rendered = evidencePackReadyEmail({ orgName: org?.name ?? 'SiteLog', siteName: site?.name ?? 'All sites', periodStart: pack.period_start, periodEnd: pack.period_end, downloadUrl: url, panelUrl: `${appUrl}/weather` });
      return { to, rendered };
    }
    case 'weekly_digest': {
      if (!payload.orgId) throw new PermanentJobError('orgId required');
      const org = await ctx.db.getOrg(payload.orgId);
      if (!org) throw new PermanentJobError(`org ${payload.orgId} not found`);
      const weekStart = (payload as { weekStart?: string }).weekStart ?? new Date(ctx.now().getTime() - 7 * 86400000).toISOString().slice(0, 10);
      const weekEnd = addDaysIso(weekStart, 6);
      const stats = await ctx.db.digestStats(org.id, weekStart, weekEnd);
      const members = await ctx.db.listMemberEmails(org.id, ['admin', 'pm']);
      const rendered = weeklyDigestEmail({ orgName: org.name, weekStart, weekEnd, stats, url: appUrl });
      return { to: payload.to ?? members.map((m) => m.email), rendered };
    }
    case 'unknown_sender': {
      if (!payload.unknownSenderId && !payload.orgId) throw new PermanentJobError('unknownSenderId or orgId required');
      const orgId = payload.orgId;
      const sender = payload.unknownSenderId ? await ctx.db.findPendingUnknownSenderById?.(payload.unknownSenderId) : null;
      const org = orgId ? await ctx.db.getOrg(orgId) : null;
      if (!org) return null;
      const members = await ctx.db.listMemberEmails(org.id, ['ops', 'admin']);
      const rendered = unknownSenderEmail({ orgName: org.name, phone: sender?.phone_e164 ?? 'unknown number', snippet: sender?.snippet ?? null, url: `${appUrl}/team` });
      return { to: payload.to ?? members.map((m) => m.email), rendered };
    }
    case 'report_edited_after_signoff': {
      if (!payload.reportId) throw new PermanentJobError('reportId required');
      const report = await ctx.db.getReport(payload.reportId);
      if (!report) throw new PermanentJobError(`report ${payload.reportId} not found`);
      const org = await ctx.db.getOrg(report.org_id);
      const rendered = reportEditedAfterSignoffEmail({ orgName: org?.name ?? 'SiteLog', reportNo: report.report_no, changeNote: payload.changeNote ?? '', version: payload.version ?? report.current_version, url: `${appUrl}/reports/${report.id}` });
      return { to: payload.to ?? [], rendered };
    }
  }
}

function addDaysIso(date: string, days: number): string {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

export { formatDateShort };
