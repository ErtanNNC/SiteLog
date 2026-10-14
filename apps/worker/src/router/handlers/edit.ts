import {
  applyPatch,
  ButtonSets,
  DailyReportDataV1Schema,
  isWithinEditWindow,
  localDate,
  recomputeManpowerTotals,
  resolveDayReference,
  truncateTitle,
  waCopy,
  weekdayName,
  type ReportRow,
} from '@sitelog/shared';
import { stripDayReference } from '../../ai/classify';
import { parseCorrection } from '../../ai/correction';
import { currentData } from '../../pipeline/draft';
import { createReportVersion } from '../../pipeline/versions';
import type { Session } from '../session';

/** §F8 — "edit Friday — Apex was 7 guys, not 6". */

export interface EditRequest {
  /** ISO date already resolved, or the words used ("Friday", "yesterday"). */
  dayReference: string | null;
  correctionText: string | null;
}

export async function handleEditRequest(
  s: Session,
  req: EditRequest,
  rawText: string,
): Promise<void> {
  const { ctx } = s;
  const date =
    req.dayReference && /^\d{4}-\d{2}-\d{2}$/.test(req.dayReference)
      ? req.dayReference
      : resolveDayReference(req.dayReference ?? rawText, s.now, s.tz);
  if (!date) {
    await s.reply(waCopy.noReportFound(), undefined, { kind: 'edit_no_report' });
    return;
  }
  const correctionText = (
    req.correctionText ??
    stripDayReference(rawText.replace(/^(edit|edita|change|fix)\b/i, '').trim())
  ).trim();
  const candidates = await ctx.db.findReportsByDate(
    s.sites.map((x) => x.id),
    date,
  );
  if (candidates.length === 0) {
    await s.reply(waCopy.noReportFound(), undefined, { kind: 'edit_no_report' });
    return;
  }
  if (candidates.length > 1) {
    await s.setState('editing', {
      editing: { report_id: '', correction_text: correctionText || null, date } as never,
    });
    await s.reply(
      waCopy.editCandidates(),
      ButtonSets.editCandidates(
        candidates.map((r) => ({
          id: r.id,
          label: truncateTitle(`${s.siteById(r.site_id)?.name ?? r.report_no}`),
        })),
      ),
      { kind: 'edit_candidates' },
    );
    return;
  }
  await proceedWithReport(s, candidates[0]!, correctionText);
}

export async function handleEditCandidate(s: Session, reportId: string): Promise<void> {
  const report = await s.ctx.db.getReport(reportId);
  if (!report) return;
  const editing = (s.context.editing ?? {}) as { correction_text?: string | null };
  await proceedWithReport(s, report, editing.correction_text ?? '');
}

async function proceedWithReport(
  s: Session,
  report: ReportRow,
  correctionText: string,
): Promise<void> {
  const data = await currentData(s.ctx, report);
  const site = s.siteById(report.site_id);
  const today = localDate(s.now, site?.timezone ?? s.tz);
  if (!data || !isWithinEditWindow(data.reportDate, today)) {
    await s.setState('idle', { editing: null });
    await s.reply(waCopy.lockedReport(), undefined, { kind: 'locked' });
    return;
  }
  if (!correctionText) {
    await s.setState('editing', { editing: { report_id: report.id } });
    await s.reply(waCopy.fixPrompt(), undefined, { kind: 'fix_prompt', reportId: report.id });
    return;
  }
  await applyEdit(s, report, correctionText, s.message.id);
}

/** State `editing`: the next text / voice note is the correction. */
export async function handleEditingText(s: Session, text: string): Promise<void> {
  const editing = s.context.editing;
  if (!editing?.report_id) {
    await s.setState('idle', { editing: null });
    return;
  }
  const report = await s.ctx.db.getReport(editing.report_id);
  if (!report) {
    await s.setState('idle', { editing: null });
    return;
  }
  await applyEdit(s, report, text, s.message.id);
}

/** apply_correction → patch → new version → re-render + email + reply (§F8 steps 3–5). */
export async function applyEdit(
  s: Session,
  report: ReportRow,
  correctionText: string,
  messageId: string,
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
      messageId,
      defaultShiftHours: Number(site.settings.default_shift_hours),
      companies: site.companies.map((c) => ({ id: c.id, name: c.name, aliases: c.aliases })),
    },
    ctx.log,
  );
  ctx.metrics.add({ tokens: res.usage, estCostUsd: res.estCostUsd });
  if (res.data.needsClarification || res.data.operations.length === 0) {
    await s.setState('editing', { editing: { report_id: report.id } });
    await s.reply(
      waCopy.questionGeneric(res.data.needsClarification ?? waCopy.fixPrompt()),
      undefined,
      { kind: 'edit_clarify', reportId: report.id },
    );
    return;
  }
  const patched = applyPatch(data, res.data.operations);
  const { entries } = recomputeManpowerTotals(patched.manpower);
  const next = DailyReportDataV1Schema.parse({ ...patched, manpower: entries });
  const result = await createReportVersion(ctx, report, next, {
    changeNote: res.data.changeNote,
    author: 'reporter',
    authorMessageId: messageId,
    emailRecipients: true,
  });
  await s.setState('idle', { editing: null });
  await s.reply(
    waCopy.editApplied(weekdayName(next.reportDate), res.data.changeNote, result.version.version),
    undefined,
    { kind: 'edit_applied', reportId: report.id },
  );
}
