import * as Sentry from '@sentry/node';
import type { JobRow, ReportCostRow } from '@sitelog/shared';
import type { Ctx } from './context';
import type { ReportCostBaseline, ReportCostInputs } from './db';

/**
 * §15 cost guardrail: "Track AI + WhatsApp cost per report; alert if a single report exceeds
 * 3× median".
 *
 * Cost of a report = AI + WhatsApp (+ the per-channel messaging cost of W2-15: its texts ×
 * COST_SMS_USD and its Twilio WhatsApp templates × COST_WHATSAPP_TEMPLATE_USD), stored in integer cents in `report_costs` when the report is
 * filed and refreshed whenever a later job that references it finishes (edits, re-renders):
 *  - AI: the `estCostUsd` (or `costUsdTotal` across retries) every job records in
 *    jobs.payload.metrics — Claude tokens and transcription minutes (ai/cost.ts) — summed over
 *    the jobs whose payload references the report or one of its source messages.
 *  - WhatsApp: outbound template messages tagged with the report or its site-day ×
 *    COST_WA_TEMPLATE_USD. Free-form messages inside the 24 h window cost nothing.
 *
 * Alert: a report whose cost exceeds COST_ALERT_MULTIPLIER × the median of the reports of the same
 * kind filed in the COST_BASELINE_DAYS before it — once the baseline holds COST_ALERT_MIN_SAMPLE
 * reports — is flagged (`report_costs.outlier`, listed on /ops), logged as a structured warning
 * and sent to Sentry when SENTRY_DSN is set. A report alerts once, when it first crosses.
 */

export const COST_ALERT_MULTIPLIER = 3;
export const COST_ALERT_MIN_SAMPLE = 20;
export const COST_BASELINE_DAYS = 30;

/** Median of a list (mean of the two middle values for an even count); null when empty. */
export function median(values: readonly number[]): number | null {
  if (values.length === 0) return null;
  const s = [...values].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid]! : (s[mid - 1]! + s[mid]!) / 2;
}

/** USD → integer cents (money is stored in integer cents). */
export function usdToCents(usd: number): number {
  if (!Number.isFinite(usd) || usd <= 0) return 0;
  return Math.round(usd * 100);
}

export interface CostRates {
  /** USD per outbound v1.0 Meta template message. */
  waTemplateUsd: number;
  /** W2-15: USD per text (COST_SMS_USD). */
  smsUsd?: number;
  /** W2-15: USD per Twilio WhatsApp template (COST_WHATSAPP_TEMPLATE_USD). */
  whatsappTemplateUsd?: number;
}

export interface ReportCostEstimate {
  costCents: number;
  aiUsd: number;
  waUsd: number;
  /** W2-15: the report's texts and WhatsApp templates (per-channel messaging cost, D49 (5)). */
  messagingUsd: number;
}

export function estimateReportCost(
  inputs: Pick<ReportCostInputs, 'aiUsd' | 'jobCount' | 'waTemplates'> &
    Partial<Pick<ReportCostInputs, 'smsMessages' | 'whatsappTemplates'>>,
  rates: CostRates,
): ReportCostEstimate {
  const aiUsd = Math.max(0, inputs.aiUsd);
  const waUsd = Math.max(0, inputs.waTemplates) * rates.waTemplateUsd;
  const messagingUsd =
    Math.max(0, inputs.smsMessages ?? 0) * (rates.smsUsd ?? 0) +
    Math.max(0, inputs.whatsappTemplates ?? 0) * (rates.whatsappTemplateUsd ?? 0);
  return { costCents: usdToCents(aiUsd + waUsd + messagingUsd), aiUsd, waUsd, messagingUsd };
}

export interface OutlierRule {
  multiplier: number;
  minSample: number;
}

/**
 * True when the cost is strictly above `multiplier × median` of a baseline with at least
 * `minSample` reports. A zero median (all-free reports) never alerts: any cost would be "∞×".
 */
export function isCostOutlier(
  costCents: number,
  baseline: ReportCostBaseline,
  rule: OutlierRule = { multiplier: COST_ALERT_MULTIPLIER, minSample: COST_ALERT_MIN_SAMPLE },
): boolean {
  if (baseline.sample < rule.minSample) return false;
  if (baseline.medianCents === null || baseline.medianCents <= 0) return false;
  return costCents > rule.multiplier * baseline.medianCents;
}

export interface RecordedCost {
  row: ReportCostRow;
  /** True when this call flagged the report (it was not an outlier before). */
  alerted: boolean;
  /** False when the cost was unchanged and nothing was written. */
  changed: boolean;
}

/**
 * Estimate and store the cost of a filed report; alert the first time it is an outlier.
 * Returns null for reports that are not filed (yet). Database errors propagate; job code paths
 * call `recordReportCostSafely` so cost tracking can never fail filing or delivery.
 */
export async function recordReportCost(ctx: Ctx, reportId: string): Promise<RecordedCost | null> {
  const report = await ctx.db.getReport(reportId);
  if (!report || !report.filed_at) return null;
  if (report.status !== 'filed' && report.status !== 'signed_off') return null;

  const inputs = await ctx.db.reportCostInputs(report.id);
  const est = estimateReportCost(inputs, {
    waTemplateUsd: ctx.config.COST_WA_TEMPLATE_USD,
    smsUsd: ctx.config.COST_SMS_USD,
    whatsappTemplateUsd: ctx.config.COST_WHATSAPP_TEMPLATE_USD,
  });
  const prev = await ctx.db.getReportCost(report.id);
  if (prev && prev.cost_cents === est.costCents)
    return { row: prev, alerted: false, changed: false };

  const baseline = await ctx.db.reportCostBaseline({
    kind: report.kind,
    before: report.filed_at,
    excludeReportId: report.id,
    days: COST_BASELINE_DAYS,
  });
  const outlier = isCostOutlier(est.costCents, baseline);
  const enough = baseline.sample >= COST_ALERT_MIN_SAMPLE;
  const row = await ctx.db.upsertReportCost({
    report_id: report.id,
    org_id: report.org_id,
    kind: report.kind,
    filed_at: prev?.filed_at ?? report.filed_at,
    cost_cents: est.costCents,
    median_cents: enough ? baseline.medianCents : null,
    sample: baseline.sample,
    outlier,
    detail: {
      aiUsd: round6(est.aiUsd),
      waTemplates: inputs.waTemplates,
      waTemplateUsd: ctx.config.COST_WA_TEMPLATE_USD,
      jobs: inputs.jobCount,
      // W2-15: present once the report has a text or a WhatsApp template a provider took.
      ...(inputs.smsMessages || inputs.whatsappTemplates
        ? {
            smsMessages: inputs.smsMessages,
            whatsappTemplates: inputs.whatsappTemplates,
            messagingUsd: round6(est.messagingUsd),
          }
        : {}),
    },
  });
  const alerted = outlier && !prev?.outlier;
  if (alerted) {
    const fields = {
      org_id: report.org_id,
      report_id: report.id,
      report_no: report.report_no,
      kind: report.kind,
      cost_cents: est.costCents,
      median_cents: baseline.medianCents,
      sample: baseline.sample,
      multiplier: COST_ALERT_MULTIPLIER,
      ai_usd: round6(est.aiUsd),
      wa_templates: inputs.waTemplates,
      jobs: inputs.jobCount,
    };
    ctx.log.warn('report cost outlier', fields);
    if (ctx.config.SENTRY_DSN) {
      Sentry.captureMessage(`Report cost outlier: ${report.report_no}`, {
        level: 'warning',
        tags: { alert: 'report_cost_outlier', report_kind: report.kind },
        extra: fields,
      });
    }
  }
  return { row, alerted, changed: true };
}

/** recordReportCost for job code paths: logs and swallows errors. */
export async function recordReportCostSafely(
  ctx: Ctx,
  reportId: string,
): Promise<RecordedCost | null> {
  try {
    return await recordReportCost(ctx, reportId);
  } catch (err) {
    ctx.log.warn('report cost not recorded', { err, report_id: reportId });
    return null;
  }
}

/**
 * After any job that references a report (its metrics are saved by then): refresh the cost of
 * that report if it is filed. Jobs for reports still being collected are skipped cheaply.
 */
export async function refreshCostAfterJob(ctx: Ctx, job: JobRow): Promise<void> {
  const p = job.payload;
  const reportId =
    p && typeof p === 'object' && !Array.isArray(p) && typeof p.reportId === 'string'
      ? p.reportId
      : null;
  if (reportId) await recordReportCostSafely(ctx, reportId);
}

/**
 * Cost of every attempt of a job: the previous attempts' total (or their last estCostUsd) plus
 * this attempt's. jobs.payload.metrics only keeps the latest attempt's snapshot otherwise.
 */
export function costUsdAcrossAttempts(job: JobRow, attemptUsd: number): number | null {
  if (job.attempts <= 1) return null;
  const p = job.payload;
  const prev =
    p && typeof p === 'object' && !Array.isArray(p) && p.metrics && typeof p.metrics === 'object'
      ? (p.metrics as Record<string, unknown>)
      : null;
  const before =
    typeof prev?.costUsdTotal === 'number'
      ? prev.costUsdTotal
      : typeof prev?.estCostUsd === 'number'
        ? prev.estCostUsd
        : 0;
  return round6(before + (attemptUsd || 0));
}

function round6(n: number): number {
  return Math.round(n * 1e6) / 1e6;
}
