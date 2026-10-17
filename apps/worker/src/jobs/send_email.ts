import {
  deriveTotals,
  firstName,
  formatDateShort,
  groupByEmailLanguage,
  isOwnEvidencePackPath,
  pdfFileName,
  readReportData,
  reportLanguageFor,
  type OrgLocale,
  type ReportLanguage,
  type StoredReportData,
} from '@sitelog/shared';
import type { Ctx } from '../context';
import type { MemberEmail } from '../db';
import type { EmailAttachment } from '../email/provider';
import {
  evidencePackReadyEmail,
  invoiceQueryEmail,
  reportEditedAfterSignoffEmail,
  reportFiledEmail,
  reportMissingEmail,
  unknownContactEmail,
  weeklyDigestEmail,
  type RenderedEmail,
} from '../email/templates';
import { PermanentJobError, type JobHandler } from './types';

/** Every org role: an address is matched to its member, whatever the role, for their language. */
const ALL_ROLES = ['admin', 'pm', 'ops', 'accounts'];

/**
 * §13 — every email the worker sends, by kind. The job's dedupe key (else its id) is the email's
 * idempotency key, so a retry after the provider accepted it sends nothing twice (W1-15). The key
 * never includes the content: a retry whose body changed (the PDF re-rendered in between) finds
 * the key used and succeeds as already sent (`alreadySent`), rather than sending a second email.
 *
 * W4-09 (§19 Q239, `OFFICE_EMAIL_LANGUAGE`): an office email is one message per language among its
 * readers; the English one keeps the job's key, the Turkish one sends under `{key}:tr`.
 */
export const sendEmail: JobHandler<'send_email'> = async (ctx, payload, job) => {
  const built = await buildEmail(ctx, payload);
  if (!built) return;
  const { messages, attachments, orgId } = built;
  if (messages.every((m) => m.to.length === 0)) {
    ctx.log.info('email skipped: no recipients', { kind: payload.kind });
    return;
  }
  const baseKey = job.dedupe_key ?? `send_email:${job.id}`;
  for (const m of messages) {
    if (m.to.length === 0) continue;
    const res = await ctx.email.send({
      to: m.to,
      subject: m.rendered.subject,
      html: m.rendered.html,
      text: m.rendered.text,
      attachments,
      tags: { kind: payload.kind },
      orgId,
      idempotencyKey: m.keySuffix ? `${baseKey}:${m.keySuffix}` : baseKey,
    });
    if (res.alreadySent) {
      ctx.log.info('email already sent under this key', {
        kind: payload.kind,
        language: m.language,
        provider: ctx.email.name,
      });
      continue;
    }
    ctx.log.info('email sent', {
      kind: payload.kind,
      language: m.language,
      to: m.to.length,
      provider: ctx.email.name,
      id: res.id,
    });
  }
};

type EmailPayload = Parameters<JobHandler<'send_email'>>[1];

/** One message of an email: its readers, its language and what they read. */
export interface BuiltMessage {
  language: ReportLanguage;
  to: string[];
  rendered: RenderedEmail;
  /** Appended to the job's idempotency key (`tr` for the Turkish half of an office email). */
  keySuffix: string | null;
}

export interface BuiltEmail {
  messages: BuiltMessage[];
  attachments?: EmailAttachment[];
  /** The org the email is about: the console provider files it there (the Demo phone's Email tab). */
  orgId: string;
}

/** A message in one language for everyone (the report email, the invoice query). */
function single(language: ReportLanguage, to: string[], rendered: RenderedEmail): BuiltMessage[] {
  return [{ language, to: Array.from(new Set(to)), rendered, keySuffix: null }];
}

/**
 * An office email (§19 Q239): the addresses split by each reader's panel language
 * (`org_members.ui_locale`, else the org's), one rendering per language.
 */
async function perReader(
  ctx: Ctx,
  org: { id: string; locale: OrgLocale } | null,
  to: string[],
  render: (language: ReportLanguage) => RenderedEmail,
  members?: MemberEmail[],
): Promise<BuiltMessage[]> {
  if (to.length === 0) return [];
  const known = members ?? (org ? await ctx.db.listMemberEmails(org.id, ALL_ROLES) : []);
  const groups = groupByEmailLanguage(
    to,
    known.map((m) => ({ email: m.email, uiLocale: m.ui_locale })),
    org?.locale ?? null,
  );
  return groups.map((g) => ({
    language: g.language,
    to: g.to,
    rendered: render(g.language),
    keySuffix: g.language === 'en' ? null : g.language,
  }));
}

export async function buildEmail(ctx: Ctx, payload: EmailPayload): Promise<BuiltEmail | null> {
  const appUrl = ctx.config.APP_URL;
  switch (payload.kind) {
    case 'report_filed':
    case 'report_updated': {
      if (!payload.reportId) throw new PermanentJobError('reportId required');
      const report = await ctx.db.getReport(payload.reportId);
      if (!report) throw new PermanentJobError(`report ${payload.reportId} not found`);
      const version = await ctx.db.getVersion(report.id, payload.version ?? report.current_version);
      const site = await ctx.db.siteContext(report.site_id);
      if (!version || !site)
        throw new PermanentJobError(`report ${report.id} version/site missing`);
      const data = readReportData(version.data as unknown as StoredReportData);
      const to = payload.to ?? [...site.recipients];
      if (payload.kind === 'report_updated') {
        // §13 "Recipients + signer": the signer of the report now, or of the version this one
        // reopened (F10, W2-11: the reporter's change cleared the sign-off before this email).
        for (const id of new Set([report.signed_off_by, payload.signerId].filter(Boolean))) {
          const signer = await ctx.db.getUserContact(id as string);
          if (signer?.email) to.push(signer.email);
        }
      }
      const attachments: EmailAttachment[] = [];
      if (version.pdf_path) {
        try {
          attachments.push({
            filename: pdfFileName(report.report_no, data.reportDate, version.version),
            content: await ctx.storage.download('pdfs', version.pdf_path),
            contentType: 'application/pdf',
          });
        } catch (err) {
          ctx.log.warn('pdf attachment missing', { err, report_id: report.id });
        }
      }
      const reporter = report.reporter_id ? await ctx.db.getReporter(report.reporter_id) : null;
      // §13: the report email is in the report's language, for every reader.
      const rendered = reportFiledEmail({
        kind: payload.kind,
        language: data.reportLanguage,
        orgName: site.org.name,
        siteName: site.site.name,
        reportNo: report.report_no,
        reportDate: data.reportDate,
        version: version.version,
        changeNote: payload.changeNote ?? version.change_note ?? null,
        summary: data.summary,
        totals: deriveTotals(data, {
          selfPerformCompanyIds: new Set(
            site.companies.filter((c) => c.is_self_perform).map((c) => c.id),
          ),
        }),
        reviewReasons: report.review_reasons,
        isLate: report.is_late,
        reporterFirstName: reporter ? firstName(reporter.name) : null,
        url: `${appUrl}/reports/${report.id}`,
      });
      return {
        messages: single(data.reportLanguage, to, rendered),
        attachments,
        orgId: report.org_id,
      };
    }
    case 'report_missing': {
      if (!payload.siteDayId) throw new PermanentJobError('siteDayId required');
      const siteDay = await ctx.db.getSiteDay(payload.siteDayId);
      if (!siteDay) throw new PermanentJobError(`site_day ${payload.siteDayId} not found`);
      const site = await ctx.db.siteContext(siteDay.site_id);
      if (!site) throw new PermanentJobError(`site ${siteDay.site_id} not found`);
      const members = await ctx.db.listMemberEmails(site.org.id, ['ops', 'admin']);
      const reporter = site.reporters[0] ?? null;
      const to = payload.to ?? members.map((m) => m.email);
      const messages = await perReader(
        ctx,
        site.org,
        to,
        (language) =>
          reportMissingEmail({
            language,
            orgName: site.org.name,
            siteName: site.site.name,
            date: siteDay.date,
            reporterFirstName: reporter ? firstName(reporter.name) : null,
            reporterPhone: reporter?.phone_e164 ?? null,
            url: `${appUrl}/sites/${site.site.id}`,
            reminders: payload.reminders ?? 0,
          }),
        payload.to ? undefined : members,
      );
      return { messages, orgId: site.org.id };
    }
    case 'invoice_query': {
      if (!payload.invoiceId) throw new PermanentJobError('invoiceId required');
      const inv = await ctx.db.getInvoiceSummary(payload.invoiceId);
      if (!inv) throw new PermanentJobError(`invoice ${payload.invoiceId} not found`);
      const org = await ctx.db.getOrg(inv.org_id);
      // §19 Q239: to the subcontractor, in the org's report language.
      const language = org ? reportLanguageFor(org.locale) : 'en';
      const rendered = invoiceQueryEmail({
        language,
        orgName: org?.name ?? 'SiteLog',
        companyName: inv.company_name,
        invoiceNo: inv.invoice_no,
        periodStart: inv.period_start,
        periodEnd: inv.period_end,
        invoicedHours: inv.invoiced_hours,
        reportedHours: inv.reported_hours,
        url: `${appUrl}/hours`,
      });
      return { messages: single(language, payload.to ?? [], rendered), orgId: inv.org_id };
    }
    case 'evidence_pack_ready': {
      if (!payload.packId) throw new PermanentJobError('packId required');
      const pack = await ctx.db.getEvidencePack(payload.packId);
      if (!pack || !pack.pdf_path) throw new PermanentJobError(`pack ${payload.packId} not ready`);
      // Only a path under the pack's own org and site (a row from before 20261014000001 may name
      // another org's PDF).
      if (!isOwnEvidencePackPath(pack))
        throw new PermanentJobError(`pack ${pack.id}: pdf_path is outside its org and site`);
      const org = await ctx.db.getOrg(pack.org_id);
      const site = pack.site_id ? await ctx.db.getSite(pack.site_id) : null;
      const url = await ctx.storage.signedUrl('exports', pack.pdf_path, 7 * 24 * 3600);
      const to = payload.to ?? [];
      if (to.length === 0 && pack.created_by) {
        const c = await ctx.db.getUserContact(pack.created_by);
        if (c?.email) to.push(c.email);
      }
      const messages = await perReader(ctx, org, to, (language) =>
        evidencePackReadyEmail({
          language,
          orgName: org?.name ?? 'SiteLog',
          siteName: site?.name ?? null,
          periodStart: pack.period_start,
          periodEnd: pack.period_end,
          downloadUrl: url,
          panelUrl: `${appUrl}/weather`,
        }),
      );
      return { messages, orgId: pack.org_id };
    }
    case 'weekly_digest': {
      if (!payload.orgId) throw new PermanentJobError('orgId required');
      const org = await ctx.db.getOrg(payload.orgId);
      if (!org) throw new PermanentJobError(`org ${payload.orgId} not found`);
      const weekStart =
        (payload as { weekStart?: string }).weekStart ??
        new Date(ctx.now().getTime() - 7 * 86400000).toISOString().slice(0, 10);
      const weekEnd = addDaysIso(weekStart, 6);
      const stats = await ctx.db.digestStats(org.id, weekStart, weekEnd);
      const members = await ctx.db.listMemberEmails(org.id, ['admin', 'pm']);
      const messages = await perReader(
        ctx,
        org,
        payload.to ?? members.map((m) => m.email),
        (language) =>
          weeklyDigestEmail({
            language,
            orgName: org.name,
            weekStart,
            weekEnd,
            stats,
            url: appUrl,
          }),
        payload.to ? undefined : members,
      );
      return { messages, orgId: org.id };
    }
    case 'unknown_contact': {
      if (!payload.unknownContactId && !payload.orgId)
        throw new PermanentJobError('unknownContactId or orgId required');
      const orgId = payload.orgId;
      const sender = payload.unknownContactId
        ? await ctx.db.getUnknownContact(payload.unknownContactId)
        : null;
      const org = orgId ? await ctx.db.getOrg(orgId) : null;
      if (!org) return null;
      const members = await ctx.db.listMemberEmails(org.id, ['ops', 'admin']);
      const messages = await perReader(
        ctx,
        org,
        payload.to ?? members.map((m) => m.email),
        (language) =>
          unknownContactEmail({
            language,
            orgName: org.name,
            phone: sender?.phone_e164 ?? null,
            snippet: sender?.snippet ?? null,
            url: `${appUrl}/team`,
          }),
        payload.to ? undefined : members,
      );
      return { messages, orgId: org.id };
    }
    case 'report_edited_after_signoff': {
      if (!payload.reportId) throw new PermanentJobError('reportId required');
      const report = await ctx.db.getReport(payload.reportId);
      if (!report) throw new PermanentJobError(`report ${payload.reportId} not found`);
      const org = await ctx.db.getOrg(report.org_id);
      // To the signer of the version the edit reopened (W4-09: the job names them).
      const to = payload.to ?? [];
      if (to.length === 0 && payload.signerId) {
        const signer = await ctx.db.getUserContact(payload.signerId);
        if (signer?.email) to.push(signer.email);
      }
      const messages = await perReader(ctx, org, to, (language) =>
        reportEditedAfterSignoffEmail({
          language,
          orgName: org?.name ?? 'SiteLog',
          reportNo: report.report_no,
          changeNote: payload.changeNote ?? '',
          version: payload.version ?? report.current_version,
          url: `${appUrl}/reports/${report.id}`,
        }),
      );
      return { messages, orgId: report.org_id };
    }
  }
}

function addDaysIso(date: string, days: number): string {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

export { formatDateShort };
