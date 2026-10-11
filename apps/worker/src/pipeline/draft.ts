import {
  ButtonSets,
  deriveTotals,
  formatDraftCard,
  type ConversationRow,
  type DailyReportData,
  type MessageRow,
  type ReportRow,
  type ReportVersionRow,
} from '@sitelog/shared';
import type { Ctx } from '../context';
import type { SiteContext } from '../db';
import { sendFreeForm } from '../wa/send';
import { contextOf } from '../router/context';

/**
 * Drafts live in report_versions(version = current_version).data while the report is collecting
 * (§F5: denormalised rows are written only on filing). Corrections before filing overwrite the draft.
 */
export async function storeDraft(
  ctx: Ctx,
  report: ReportRow,
  data: DailyReportData,
  opts: { authorMessageId?: string | null; changeNote?: string | null } = {},
): Promise<ReportVersionRow> {
  const version = report.current_version || 1;
  return ctx.db.insertVersion({
    report_id: report.id,
    version,
    data,
    summary: data.summary || null,
    author: 'agent',
    author_message_id: opts.authorMessageId ?? null,
    change_note: opts.changeNote ?? null,
  });
}

export async function currentData(ctx: Ctx, report: ReportRow): Promise<DailyReportData | null> {
  const v = await ctx.db.getVersion(report.id, report.current_version || 1);
  return (v?.data as DailyReportData | null) ?? null;
}

export function draftCardFor(data: DailyReportData, site: SiteContext): string {
  const self = new Set(site.companies.filter((c) => c.is_self_perform).map((c) => c.id));
  return formatDraftCard(data, {
    siteName: site.site.name,
    totals: deriveTotals(data, { selfPerformCompanyIds: self }),
  });
}

/** §F7 step 1–2: send the draft card with OK / Fix buttons; report + conversation → awaiting_confirmation. */
export async function sendDraft(
  ctx: Ctx,
  convo: ConversationRow,
  report: ReportRow,
  site: SiteContext,
  data: DailyReportData,
): Promise<MessageRow> {
  const msg = await sendFreeForm(
    ctx,
    convo,
    draftCardFor(data, site),
    ButtonSets.draft(report.id),
    { kind: 'draft', reportId: report.id },
  );
  await ctx.db.updateReport(report.id, { status: 'awaiting_confirmation' });
  const prev = contextOf(convo);
  await ctx.db.updateConversation(convo.id, {
    state: 'awaiting_confirmation',
    context: {
      ...prev,
      active_report_id: report.id,
      pending_question_id: null,
      draft_message_id: msg.id,
      draft_wa_message_id: msg.wa_message_id,
      draft_sent_at: ctx.now().toISOString(),
      nudged_for: prev.nudged_for === report.id ? prev.nudged_for : null,
    },
  });
  await ctx.db.logAudit({
    org_id: report.org_id,
    actor_type: 'agent',
    action: 'report.draft_sent',
    entity: 'report',
    entity_id: report.id,
    diff: { message_id: msg.id },
  });
  return msg;
}
