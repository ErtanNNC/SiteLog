import type { ConsentRow } from '@sitelog/shared';
import type { Ctx } from '../context';

/**
 * Work in flight when a reporter turns off a processing consent in Settings (F15; spec §19 Q95,
 * decided 2026-10-16): a queued transcription, extraction or spoken-answer parse of their report
 * sends no audio or text to the providers (Deepgram, Claude) once `recording` or
 * `data_processing` is off, and the web timeout files no such report. The office was told by the
 * `reporter_consent_revoked` notice when the consent was turned off.
 */

export const PROCESSING_CONSENTS = ['recording', 'data_processing'] as const;
export type ProcessingConsent = (typeof PROCESSING_CONSENTS)[number];

/**
 * The processing consents the reporter turned off: a revoked row and no live one of that type. A
 * consent never given (a reporter of the v1.0 WhatsApp flow, the seed) is not "turned off". Pure.
 */
export function turnedOffConsents(
  rows: ReadonlyArray<Pick<ConsentRow, 'type' | 'revoked_at'>>,
): ProcessingConsent[] {
  return PROCESSING_CONSENTS.filter(
    (t) =>
      rows.some((r) => r.type === t && r.revoked_at !== null) &&
      !rows.some((r) => r.type === t && r.revoked_at === null),
  );
}

/** The reporter's turned-off processing consents (none without a reporter). */
export async function revokedProcessingConsents(
  ctx: Ctx,
  reporterId: string | null,
): Promise<ProcessingConsent[]> {
  if (!reporterId) return [];
  return turnedOffConsents(await ctx.db.listConsents(reporterId));
}

/**
 * At a job's start: true, with an audit row (`report.processing_skipped`, reason
 * `consent_revoked`) and the report flagged for review, when the reporter turned a processing
 * consent off; the caller then sends nothing to a provider and finishes. False otherwise.
 */
export async function skippedForConsent(
  ctx: Ctx,
  input: {
    jobType: string;
    reporterId: string | null;
    report: { id: string; org_id: string; review_reasons: string[] } | null;
    detail?: Record<string, unknown>;
    /** Flag the report for review (default true; a filed report's caption is not flagged). */
    flag?: boolean;
  },
): Promise<boolean> {
  const revoked = await revokedProcessingConsents(ctx, input.reporterId);
  if (revoked.length === 0) return false;
  ctx.log.info('job skipped: the reporter turned off a processing consent', {
    job_type: input.jobType,
    report_id: input.report?.id ?? null,
    consents: revoked,
  });
  if (input.report) {
    if (input.flag !== false && !input.report.review_reasons.includes(CONSENT_REVIEW_REASON)) {
      await ctx.db.updateReport(input.report.id, {
        needs_review: true,
        review_reasons: [...input.report.review_reasons, CONSENT_REVIEW_REASON],
      });
    }
    await ctx.db.logAudit({
      org_id: input.report.org_id,
      actor_type: 'system',
      action: 'report.processing_skipped',
      entity: 'report',
      entity_id: input.report.id,
      diff: {
        job_type: input.jobType,
        reason: 'consent_revoked',
        consents: revoked,
        reporter_id: input.reporterId,
        ...input.detail,
      },
    });
  }
  return true;
}

/** The review reason of a report whose reporter turned a processing consent off. */
export const CONSENT_REVIEW_REASON = 'consent_revoked';
