import { currentData, sendDraft, syncDraftPhotos } from '../pipeline/draft';
import { fileReport } from '../pipeline/file';
import { selectNextQuestion, validateDraft } from '../pipeline/validate';
import { decideNextWeb, isWebReport } from '../pipeline/web';
import { rerouteDayOff } from '../router/continue';
import { sendQuestion } from '../router/handlers/question';
import { PermanentJobError, type JobHandler } from './types';

/**
 * §10.1 decide_next: one question at a time (§F6) or the draft card (§F7); weather/no-work reports
 * file directly. A web recorder report goes to `decideNextWeb` (W1-12: state changes, then one
 * `notify` job, 30 s later while the reporter's device was seen in the last 30 s, D25, Q61) and its
 * §7.2 timeouts (W2-07: `payload.timeout`, the delayed steps it scheduled); the rest of this handler
 * is the WhatsApp worker's until step 22.
 */
export const decideNext: JobHandler<'decide_next'> = async (ctx, payload, job) => {
  const report = await ctx.db.getReport(payload.reportId);
  if (!report) throw new PermanentJobError(`report ${payload.reportId} not found`);
  if (report.status === 'filed' || report.status === 'signed_off' || report.status === 'void')
    return;
  if (isWebReport(report)) return decideNextWeb(ctx, report, job, payload.timeout);
  const draft = await currentData(ctx, report);
  if (!draft) throw new PermanentJobError(`report ${report.id} has no draft`);
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
  if (questions.length === 0 && (await rerouteDayOff(ctx, report, draft))) return;

  const sources = await ctx.db.listReportSources(report.id);
  const data = await syncDraftPhotos(ctx, report, draft, sources);
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
