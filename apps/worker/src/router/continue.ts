import type { MessageRow, TranscriptRow } from '@sitelog/shared';
import { quickClassify } from '../ai/classify';
import type { Ctx } from '../context';
import { handleReplyText } from './handlers/reply';
import { onTestTranscript } from './handlers/test';
import { createSession } from './session';

/**
 * What happens once a voice note is transcribed: test notes get their echo, intake audio goes to
 * extraction (unless it turns out to be a short command like "rained out"), replies go to parse_reply.
 */
export async function afterTranscription(ctx: Ctx, message: MessageRow, transcript: TranscriptRow, payload: { reportId?: string; testMode?: boolean }): Promise<void> {
  if (payload.testMode) {
    await onTestTranscript(ctx, message, transcript);
    return;
  }
  if (!payload.reportId) return;
  const report = await ctx.db.getReport(payload.reportId);
  if (!report) return;
  const sources = await ctx.db.listReportSources(report.id);
  const isSource = sources.some((s) => s.message_id === message.id && s.kind === 'audio');
  if (!isSource) {
    await ctx.db.enqueueJob('parse_reply', { messageId: message.id, reportId: report.id }, { dedupeKey: `parse_reply:${message.id}` });
    return;
  }

  // A short "report" may really be a command: "rained out, sent everyone home at 11", "no work today".
  const words = transcript.text.trim().split(/\s+/).filter(Boolean).length;
  if (report.status === 'collecting' && report.kind === 'daily' && words > 0 && words < 25) {
    const session = await createSession(ctx, message);
    if (session) {
      const quick = quickClassify(transcript.text, session.now, session.tz);
      const intent = quick?.intent ?? (await classifyShort(session, transcript.text));
      if (intent === 'no_work' || intent === 'weather_day' || intent === 'edit_request' || intent === 'help' || intent === 'stop') {
        await voidReport(ctx, report.id);
        await session.setState('idle', { active_report_id: null, pending_question_id: null });
        await handleReplyText(session, transcript.text, true);
        return;
      }
    }
  }
  await ctx.db.enqueueJob('extract_report', { reportId: report.id, reason: `sources:${sources.length}` }, { dedupeKey: `extract:${report.id}:${sources.length}` });
}

async function classifyShort(session: Awaited<ReturnType<typeof createSession>>, text: string): Promise<string | null> {
  if (!session || !session.ctx.ai.claude) return null;
  const { classifyWithModel } = await import('../ai/classify');
  try {
    const res = await classifyWithModel(session.ctx.ai.claude, session.ctx.config.CLAUDE_MODEL_FAST, { state: 'idle', lastOutbound: null, text, isVoice: true }, session.ctx.log);
    session.ctx.metrics.add({ tokens: res.usage, estCostUsd: res.estCostUsd });
    return res.data.confidence >= 0.7 ? res.data.intent : null;
  } catch (err) {
    session.ctx.log.warn('short transcript classification failed', { err });
    return null;
  }
}

/** A report created for content that turned out to be a command. */
export async function voidReport(ctx: Ctx, reportId: string): Promise<void> {
  const report = await ctx.db.getReport(reportId);
  if (!report || report.status === 'filed' || report.status === 'signed_off') return;
  await ctx.db.updateReport(report.id, { status: 'void' });
  const siteDay = await ctx.db.getSiteDay(report.site_day_id);
  if (siteDay && siteDay.status === 'processing') await ctx.db.updateSiteDay(siteDay.id, { status: 'pending' });
  await ctx.db.logAudit({ org_id: report.org_id, actor_type: 'agent', action: 'report.voided', entity: 'report', entity_id: report.id });
}
