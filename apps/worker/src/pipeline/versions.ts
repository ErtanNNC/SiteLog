import type { DailyReportData, ReportRow, ReportVersionRow } from '@sitelog/shared';
import type { Ctx } from '../context';

/**
 * New versions on filed reports (§F8, §7.3). Versions are immutable; a new version on a signed-off
 * report reverts it to `filed` and notifies the signer.
 */

export interface NewVersionOptions {
  changeNote: string;
  author: 'reporter_reply' | 'agent';
  authorMessageId?: string | null;
  emailRecipients?: boolean;
  sendToWhatsApp?: boolean;
}

export interface NewVersionResult {
  report: ReportRow;
  version: ReportVersionRow;
  wasSignedOff: boolean;
}

export async function createReportVersion(
  ctx: Ctx,
  report: ReportRow,
  data: DailyReportData,
  opts: NewVersionOptions,
): Promise<NewVersionResult> {
  if (report.status !== 'filed' && report.status !== 'signed_off') {
    throw new Error(`report ${report.id} is ${report.status}; only filed reports get new versions`);
  }
  const next = report.current_version + 1;
  const version = await ctx.db.insertVersion({
    report_id: report.id,
    version: next,
    data,
    summary: data.summary || null,
    author: opts.author,
    author_message_id: opts.authorMessageId ?? null,
    change_note: opts.changeNote,
  });
  await ctx.db.denormalizeVersion(report.id, next);
  const wasSignedOff = report.status === 'signed_off';
  const signer = report.signed_off_by;
  const updated = await ctx.db.updateReport(report.id, {
    current_version: next,
    status: 'filed',
    signed_off_by: null,
    signed_off_at: null,
  });
  await ctx.db.logAudit({
    org_id: report.org_id,
    actor_type: opts.author === 'reporter_reply' ? 'reporter' : 'agent',
    actor_id: opts.author === 'reporter_reply' ? (report.reporter_id ?? null) : null,
    action: 'report.version_created',
    entity: 'report',
    entity_id: report.id,
    diff: { version: next, change_note: opts.changeNote, message_id: opts.authorMessageId ?? null },
  });
  if (wasSignedOff) {
    await ctx.db.logAudit({
      org_id: report.org_id,
      actor_type: 'agent',
      action: 'report.signoff_reverted',
      entity: 'report',
      entity_id: report.id,
      diff: { version: next },
    });
    await ctx.db.notifyOrg(
      report.org_id,
      'report_edited',
      `${report.report_no} was edited after sign-off`,
      opts.changeNote,
      `/reports/${report.id}`,
      signer,
    );
    if (signer) {
      await ctx.db.enqueueJob(
        'send_email',
        {
          kind: 'report_edited_after_signoff',
          reportId: report.id,
          version: next,
          changeNote: opts.changeNote,
        },
        { dedupeKey: `email:edited_after_signoff:${report.id}:${next}` },
      );
    }
  }
  await ctx.db.enqueueJob(
    'render_pdf',
    {
      reportId: report.id,
      version: next,
      sendToWhatsApp: opts.sendToWhatsApp ?? false,
      emailRecipients: opts.emailRecipients ?? true,
      changeNote: opts.changeNote,
    },
    { dedupeKey: `render_pdf:${report.id}:${next}` },
  );
  return { report: updated, version, wasSignedOff };
}
