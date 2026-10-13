import {
  ButtonSets,
  deriveTotals,
  formatDraftCard,
  type ConversationRow,
  type DailyReportDataV1,
  type MessageRow,
  type ReportRow,
  type ReportSourceRow,
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
  data: DailyReportDataV1,
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

/**
 * Photos are added to the draft by code, not the model (§10.4): a photo that arrived after the
 * extraction started is appended here instead of paying for another extraction. Returns the data
 * to use (stored when it changed).
 */
export async function syncDraftPhotos(
  ctx: Ctx,
  report: ReportRow,
  data: DailyReportDataV1,
  sources: Array<
    Pick<ReportSourceRow, 'message_id' | 'kind' | 'caption' | 'taken_at'> & {
      message_created_at?: string;
    }
  >,
): Promise<DailyReportDataV1> {
  const have = new Set(data.photos.map((p) => p.messageId));
  const missing = sources.filter((s) => s.kind === 'photo' && !have.has(s.message_id));
  if (missing.length === 0) return data;
  const next: DailyReportDataV1 = {
    ...data,
    photos: [
      ...data.photos,
      ...missing.map((s) => ({
        messageId: s.message_id,
        caption: s.caption ?? undefined,
        takenAt: s.taken_at ?? s.message_created_at ?? ctx.now().toISOString(),
      })),
    ],
  };
  await storeDraft(ctx, report, next);
  return next;
}

/** A photo without a caption carries nothing for the model to read. */
export function isPlainPhoto(s: Pick<ReportSourceRow, 'kind' | 'caption'>): boolean {
  return s.kind === 'photo' && !(s.caption ?? '').trim();
}

export async function currentData(ctx: Ctx, report: ReportRow): Promise<DailyReportDataV1 | null> {
  const v = await ctx.db.getVersion(report.id, report.current_version || 1);
  return (v?.data as DailyReportDataV1 | null) ?? null;
}

export function draftCardFor(data: DailyReportDataV1, site: SiteContext): string {
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
  data: DailyReportDataV1,
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
