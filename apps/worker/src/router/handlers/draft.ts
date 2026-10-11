import {
  applyPatch,
  DailyReportDataSchema,
  recomputeManpowerTotals,
  waCopy,
  type ReportRow,
} from '@sitelog/shared';
import { parseCorrection } from '../../ai/correction';
import { currentData, sendDraft, storeDraft } from '../../pipeline/draft';
import type { Session } from '../session';

/** §F7 — confirm, fix, resend. The model never files; only an explicit confirm (or a timeout) does. */

export async function confirmReport(s: Session, reportId: string): Promise<void> {
  const { ctx } = s;
  const report = await ctx.db.getReport(reportId);
  if (!report) return;
  if (report.status === 'filed' || report.status === 'signed_off') return;
  if (
    report.status !== 'awaiting_confirmation' &&
    report.status !== 'awaiting_answer' &&
    report.status !== 'collecting'
  )
    return;
  await ctx.db.enqueueJob(
    'file_report',
    { reportId: report.id, trigger: 'confirm', confirmMessageId: s.message.id },
    { dedupeKey: `file:${report.id}` },
  );
  await s.setState('processing', { active_report_id: report.id, fix_requested_for: null });
}

export async function requestFix(s: Session, reportId: string): Promise<void> {
  await s.setState('awaiting_confirmation', {
    fix_requested_for: reportId,
    active_report_id: reportId,
  });
  await s.reply(waCopy.fixPrompt(), undefined, { kind: 'fix_prompt', reportId });
}

/** "Apex had 7 not 6" → apply_correction → patch → resend the draft (loop). */
export async function applyFix(
  s: Session,
  report: ReportRow,
  correctionText: string,
): Promise<void> {
  const { ctx } = s;
  const data = await currentData(ctx, report);
  const site = await ctx.db.siteContext(report.site_id);
  if (!data || !site) return;
  if (!ctx.ai.claude) throw new Error('ANTHROPIC_API_KEY is required to apply corrections');
  const res = await parseCorrection(
    ctx.ai.claude,
    ctx.config.CLAUDE_MODEL,
    {
      data,
      correctionText,
      messageId: s.message.id,
      defaultShiftHours: Number(site.settings.default_shift_hours),
      companies: site.companies.map((c) => ({ id: c.id, name: c.name, aliases: c.aliases })),
    },
    ctx.log,
  );
  ctx.metrics.add({ tokens: res.usage, estCostUsd: res.estCostUsd });
  if (res.data.needsClarification) {
    await s.setState('awaiting_confirmation', {
      fix_requested_for: report.id,
      active_report_id: report.id,
    });
    await s.reply(waCopy.questionGeneric(res.data.needsClarification), undefined, {
      kind: 'fix_clarify',
      reportId: report.id,
    });
    return;
  }
  if (res.data.operations.length === 0) {
    await s.reply(waCopy.fixPrompt(), undefined, { kind: 'fix_prompt', reportId: report.id });
    return;
  }
  const patched = applyPatch(data, res.data.operations);
  const { entries } = recomputeManpowerTotals(patched.manpower);
  const next = DailyReportDataSchema.parse({ ...patched, manpower: entries });
  await storeDraft(ctx, report, next, {
    authorMessageId: s.message.id,
    changeNote: res.data.changeNote,
  });
  await ctx.db.logAudit({
    org_id: report.org_id,
    actor_type: 'reporter',
    actor_id: s.reporter.id,
    action: 'report.draft_corrected',
    entity: 'report',
    entity_id: report.id,
    diff: {
      change_note: res.data.changeNote,
      operations: res.data.operations,
      message_id: s.message.id,
    },
  });
  await s.setState(null, { fix_requested_for: null });
  const msg = await sendDraft(ctx, s.convo, report, site, next);
  s.convo = (await ctx.db.getConversation(s.convo.id)) ?? s.convo;
  void msg;
}
