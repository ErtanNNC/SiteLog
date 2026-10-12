import { runExtraction } from '../ai/extract';
import { composeExtractionInput, siteDayWeatherOf } from '../pipeline/compose';
import { currentData, storeDraft } from '../pipeline/draft';
import { learnTerms } from '../pipeline/glossary';
import { allAudioTranscribed, sendProgressIfSlow } from '../pipeline/progress';
import { PermanentJobError, type JobHandler } from './types';

/** §4.3 step 5 — Claude extraction → draft version → decide_next. Re-runs when sources arrived meanwhile. */
export const extractReport: JobHandler<'extract_report'> = async (ctx, payload) => {
  const report = await ctx.db.getReport(payload.reportId);
  if (!report) throw new PermanentJobError(`report ${payload.reportId} not found`);
  if (report.status === 'filed' || report.status === 'signed_off' || report.status === 'void') {
    ctx.log.info('extraction skipped: report is closed', {
      report_id: report.id,
      status: report.status,
    });
    return;
  }
  const site = await ctx.db.siteContext(report.site_id);
  if (!site) throw new PermanentJobError(`site ${report.site_id} not found`);
  const siteDay = await ctx.db.getSiteDay(report.site_day_id);
  const reporter = report.reporter_id ? await ctx.db.getReporter(report.reporter_id) : null;

  // §F5 step 3: progress bubble if we are already past 10 s (queue latency, text-only reports).
  await sendProgressIfSlow(ctx, report.id, async () => ({
    transcribed: await allAudioTranscribed(ctx, report.id),
  }));

  const previousDraft = await currentData(ctx, report);
  const input = await composeExtractionInput(ctx, report, site, reporter, {
    previousDraft,
    reportDate:
      siteDay?.date ??
      previousDraft?.reportDate ??
      new Date(report.received_at ?? ctx.now()).toISOString().slice(0, 10),
    observedWeather: siteDayWeatherOf(siteDay?.weather),
  });
  const sourceCountAtStart = (await ctx.db.listReportSources(report.id)).length;
  if (!ctx.ai.claude) throw new Error('ANTHROPIC_API_KEY is required for extraction');

  const result = await runExtraction(ctx.ai.claude, ctx.config.CLAUDE_MODEL, input, ctx.log);
  ctx.metrics.add({
    tokens: result.call.usage,
    estCostUsd: result.call.estCostUsd,
    extractionLatencyMs: result.call.latencyMs,
    extractionRetried: result.call.retried,
  });
  await storeDraft(ctx, report, result.data);
  await ctx.db.logAudit({
    org_id: report.org_id,
    actor_type: 'agent',
    action: 'report.extracted',
    entity: 'report',
    entity_id: report.id,
    diff: {
      model: result.call.model,
      sources: sourceCountAtStart,
      discrepancies: result.discrepancies,
      languages: result.data.languageDetected,
      merged: !!previousDraft,
    },
  });
  await learnTerms(ctx, {
    orgId: report.org_id,
    siteId: report.site_id,
    reporterId: report.reporter_id,
    terms: result.data.newTerms,
    companies: site.companies,
    glossary: site.glossary,
  });

  const sourceCountNow = (await ctx.db.listReportSources(report.id)).length;
  const settled = sourceCountNow === sourceCountAtStart;
  // §F5 step 3: if extraction pushed us past 10 s, say what was found before the question/draft.
  await sendProgressIfSlow(ctx, report.id, async () => ({
    transcribed: await allAudioTranscribed(ctx, report.id),
    draft: settled ? result.data : null,
    selfPerformCompanyIds: new Set(
      site.companies.filter((c) => c.is_self_perform).map((c) => c.id),
    ),
  }));
  if (!settled) {
    ctx.log.info('sources changed during extraction; re-extracting', { report_id: report.id });
    await ctx.db.enqueueJob(
      'extract_report',
      { reportId: report.id, reason: `sources:${sourceCountNow}` },
      { dedupeKey: `extract:${report.id}:${sourceCountNow}` },
    );
    return;
  }
  await ctx.db.enqueueJob(
    'decide_next',
    { reportId: report.id },
    { dedupeKey: `decide:${report.id}:extract:${sourceCountNow}` },
  );
};
