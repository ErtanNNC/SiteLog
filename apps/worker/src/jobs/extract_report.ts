import { jobKeys, reapplyCrewFixes, type JobRow, type ReportRow } from '@sitelog/shared';
import { runExtraction, runReportExtraction } from '../ai/extract';
import type { Ctx } from '../context';
import {
  composeExtractionInput,
  composeReportExtractionInput,
  siteDayWeatherOf,
} from '../pipeline/compose';
import { skippedForConsent } from '../pipeline/consent';
import { currentData, isPlainPhoto, storeDraft } from '../pipeline/draft';
import { learnTerms } from '../pipeline/glossary';
import {
  appliedFixes,
  currentDraftV2,
  isWebReport,
  reapplyAnswers,
  storeWebDraft,
} from '../pipeline/web';
import { validateDraft } from '../pipeline/validate';
import { allAudioTranscribed, sendProgressIfSlow } from '../pipeline/progress';
import { PermanentJobError, type JobHandler } from './types';

/**
 * §4.3 step 5 — Claude extraction → draft version → decide_next. Re-runs when sources arrived
 * meanwhile. A web recorder report (channel 'web') takes extraction v2 (W1-12: prompt v2, data v2);
 * the WhatsApp worker's reports keep v1 until step 22.
 */
export const extractReport: JobHandler<'extract_report'> = async (ctx, payload, job) => {
  const report = await ctx.db.getReport(payload.reportId);
  if (!report) throw new PermanentJobError(`report ${payload.reportId} not found`);
  if (report.status === 'filed' || report.status === 'signed_off' || report.status === 'void') {
    ctx.log.info('extraction skipped: report is closed', {
      report_id: report.id,
      status: report.status,
    });
    return;
  }
  // F15, spec §19 Q95: nothing of the report goes to Claude once the reporter turned consent off.
  if (
    await skippedForConsent(ctx, {
      jobType: 'extract_report',
      reporterId: report.reporter_id,
      report,
    })
  )
    return;
  if (isWebReport(report)) return extractWebReport(ctx, report, job);
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
  const sourcesAtStart = new Set((await ctx.db.listReportSources(report.id)).map((s) => s.id));
  const sourceCountAtStart = sourcesAtStart.size;
  if (!ctx.ai.claude) throw new Error('ANTHROPIC_API_KEY is required for extraction');

  const result = await runExtraction(ctx.ai.claude, ctx.config.CLAUDE_MODEL, input, ctx.log);
  ctx.metrics.add({
    tokens: result.call.usage,
    estCostUsd: result.call.estCostUsd,
    extractionLatencyMs: result.call.latencyMs,
    extractionRetried: result.call.retried,
  });
  // Filed (or voided) while the model was working, e.g. "OK" on the previous draft: a draft
  // written now would collide with the frozen version and the job would retry for nothing.
  const latest = await ctx.db.getReport(report.id);
  if (
    !latest ||
    latest.status === 'filed' ||
    latest.status === 'signed_off' ||
    latest.status === 'void'
  ) {
    ctx.log.info('extraction discarded: report closed meanwhile', {
      report_id: report.id,
      status: latest?.status ?? null,
    });
    return;
  }
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

  const sourcesNow = await ctx.db.listReportSources(report.id);
  const sourceCountNow = sourcesNow.length;
  // Captionless photos that arrived meanwhile are added by decide_next (syncDraftPhotos) without
  // another model call (load test: 1.5 extractions per report when photos follow the voice note).
  const settled = sourcesNow.every((s) => sourcesAtStart.has(s.id) || isPlainPhoto(s));
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

/** Extraction v2 of a web recorder report (W1-12). */
async function extractWebReport(ctx: Ctx, report: ReportRow, job: JobRow): Promise<void> {
  const site = await ctx.db.siteContext(report.site_id);
  if (!site) throw new PermanentJobError(`site ${report.site_id} not found`);
  const siteDay = await ctx.db.getSiteDay(report.site_day_id);
  const reporter = report.reporter_id ? await ctx.db.getReporter(report.reporter_id) : null;
  const previousDraft = await currentDraftV2(ctx, report);
  const input = await composeReportExtractionInput(ctx, report, site, reporter, {
    previousDraft,
    reportDate:
      siteDay?.date ??
      previousDraft?.reportDate ??
      new Date(report.received_at ?? ctx.now()).toISOString().slice(0, 10),
    observedWeather: siteDayWeatherOf(siteDay?.weather),
  });
  const sourcesAtStart = new Set((await ctx.db.listReportSources(report.id)).map((s) => s.id));
  if (!ctx.ai.claude) throw new Error('ANTHROPIC_API_KEY is required for extraction');

  const result = await runReportExtraction(ctx.ai.claude, ctx.config.CLAUDE_MODEL, input, ctx.log);
  ctx.metrics.add({
    tokens: result.call.usage,
    estCostUsd: result.call.estCostUsd,
    extractionLatencyMs: result.call.latencyMs,
    extractionRetried: result.call.retried,
  });
  const latest = await ctx.db.getReport(report.id);
  if (!latest || latest.status !== 'processing') {
    // Filed, voided, or (never on the web path) moved on while the model worked: nothing to write.
    ctx.log.info('extraction discarded: report moved on meanwhile', {
      report_id: report.id,
      status: latest?.status ?? null,
    });
    return;
  }
  // The reporter's answers stand through a re-extraction (code re-applies them where needed).
  const sources = await ctx.db.listReportSources(report.id);
  const gaps = validateDraft(
    result.data,
    site.settings,
    sources.filter((s) => s.kind === 'photo').length,
  ).gaps;
  const answered = reapplyAnswers(
    result.data,
    await ctx.db.listQuestions(report.id),
    new Set(gaps.map((g) => g.path)),
    {
      defaultShiftHours: Number(site.settings.default_shift_hours),
      workingHours: site.site.working_hours,
    },
  );
  const reapplied = answered.reapplied;
  // W2-10, spec §19 Q96: the reporter's fixes of crew numbers stand where the new draft brought
  // back the number they replaced (a later clip that says otherwise wins).
  const fixed = reapplyCrewFixes(
    answered.data,
    appliedFixes(await ctx.db.listAppliedCorrections(report.id)),
  );
  const data = fixed.data;
  if (!(await storeWebDraft(ctx, latest, data))) return; // filed meanwhile: nothing to write
  await ctx.db.logAudit({
    org_id: report.org_id,
    actor_type: 'agent',
    action: 'report.extracted',
    entity: 'report',
    entity_id: report.id,
    diff: {
      model: result.call.model,
      schema_version: 2,
      sources: sourcesAtStart.size,
      discrepancies: result.discrepancies,
      dropped_sources: result.droppedSources,
      answers_reapplied: reapplied,
      fixes_reapplied: fixed.reapplied,
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
  const sourcesNow = await ctx.db.listReportSources(report.id);
  // Captionless photos that arrived meanwhile are added by decide_next without another model call.
  const settled = sourcesNow.every((s) => sourcesAtStart.has(s.id) || isPlainPhoto(s));
  if (!settled) {
    ctx.log.info('sources changed during extraction; re-extracting', { report_id: report.id });
    await ctx.db.enqueueJob(
      'extract_report',
      { reportId: report.id, reason: `sources:${sourcesNow.length}` },
      { dedupeKey: `extract:${report.id}:${sourcesNow.length}` },
    );
    return;
  }
  await ctx.db.enqueueJob(
    'decide_next',
    { reportId: report.id },
    { dedupeKey: jobKeys.decideAfterExtract(report.id, job.id) },
  );
}
