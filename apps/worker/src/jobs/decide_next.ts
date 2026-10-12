import { currentData, sendDraft } from '../pipeline/draft';
import { fileReport } from '../pipeline/file';
import { selectNextQuestion, validateDraft } from '../pipeline/validate';
import { rerouteDayOff } from '../router/continue';
import { sendQuestion } from '../router/handlers/question';
import { PermanentJobError, type JobHandler } from './types';

/** §10.1 decide_next: one question at a time (§F6) or the draft card (§F7); weather/no-work reports file directly. */
export const decideNext: JobHandler<'decide_next'> = async (ctx, payload) => {
  const report = await ctx.db.getReport(payload.reportId);
  if (!report) throw new PermanentJobError(`report ${payload.reportId} not found`);
  if (report.status === 'filed' || report.status === 'signed_off' || report.status === 'void')
    return;
  const data = await currentData(ctx, report);
  if (!data) throw new PermanentJobError(`report ${report.id} has no draft`);
  if (report.kind !== 'daily') {
    await fileReport(ctx, report.id, {
      trigger: report.kind === 'weather_day' ? 'weather_day' : 'no_work',
      silent: true,
    });
    return;
  }
  const site = await ctx.db.siteContext(report.site_id);
  if (!site) throw new PermanentJobError(`site ${report.site_id} not found`);
  const reporter = report.reporter_id ? await ctx.db.getReporter(report.reporter_id) : null;
  const convo = reporter ? await ctx.db.getConversationByPhone(reporter.phone_e164) : null;
  if (!convo) throw new PermanentJobError(`report ${report.id} has no conversation`);

  const questions = await ctx.db.listQuestions(report.id);
  // §F10: a long note saying nobody worked goes to the day-off flow, not a headcount question.
  if (questions.length === 0 && (await rerouteDayOff(ctx, report, data))) return;

  const sources = await ctx.db.listReportSources(report.id);
  const photoCount = sources.filter((s) => s.kind === 'photo').length;
  const validation = validateDraft(data, site.settings, photoCount);

  // An open question whose gap a re-extraction closed is resolved; otherwise keep waiting for it.
  const open = questions.find((q) => !q.answered_at);
  if (open) {
    const path = ((open.target ?? {}) as { path?: string }).path ?? open.field;
    const stillGap = validation.gaps.some((g) => g.path === path);
    if (stillGap) {
      ctx.log.info('question still open; waiting', { report_id: report.id, question_id: open.id });
      return;
    }
    await ctx.db.updateQuestion(open.id, {
      answered_at: ctx.now(),
      answer: { resolved_by: 'extraction' },
    });
    open.answered_at = ctx.now().toISOString();
  }

  const spec = selectNextQuestion(data, validation, questions, site.settings, site.companies);
  if (spec) {
    await sendQuestion(ctx, convo, report, spec);
    return;
  }
  await sendDraft(ctx, convo, report, site, data);
};
