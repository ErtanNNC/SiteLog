import type { DailyReportData, MessageRow, ReportRow, TranscriptRow } from '@sitelog/shared';
import { quickClassify } from '../ai/classify';
import type { Ctx } from '../context';
import { allAudioTranscribed, sendProgressIfSlow } from '../pipeline/progress';
import { handleDayOffText } from './handlers/dayoff';
import { handleReplyText } from './handlers/reply';
import { onTestTranscript } from './handlers/test';
import { createSession } from './session';

/**
 * What happens once a voice note is transcribed: test notes get their echo, intake audio goes to
 * extraction (unless it turns out to be a short command like "rained out"), replies go to parse_reply.
 */
export async function afterTranscription(
  ctx: Ctx,
  message: MessageRow,
  transcript: TranscriptRow,
  payload: { reportId?: string; testMode?: boolean },
): Promise<void> {
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
    await ctx.db.enqueueJob(
      'parse_reply',
      { messageId: message.id, reportId: report.id },
      { dedupeKey: `parse_reply:${message.id}` },
    );
    return;
  }

  // A short "report" may really be a command: "rained out, sent everyone home at 11", "no work today".
  const words = transcript.text.trim().split(/\s+/).filter(Boolean).length;
  if (report.status === 'collecting' && report.kind === 'daily' && words > 0 && words < 25) {
    const session = await createSession(ctx, message);
    if (session) {
      const quick = quickClassify(transcript.text, session.now, session.tz);
      const intent = quick?.intent ?? (await classifyShort(session, transcript.text));
      if (
        intent === 'no_work' ||
        intent === 'weather_day' ||
        intent === 'edit_request' ||
        intent === 'help' ||
        intent === 'stop'
      ) {
        await voidReport(ctx, report.id);
        await session.setState('idle', { active_report_id: null, pending_question_id: null });
        await handleReplyText(session, transcript.text, true);
        return;
      }
    }
  }
  // §F5 step 3: transcription alone took > 10 s → progress bubble now (once all notes are in).
  await sendProgressIfSlow(ctx, report.id, async () =>
    (await allAudioTranscribed(ctx, report.id)) ? { transcribed: true } : null,
  );
  await ctx.db.enqueueJob(
    'extract_report',
    { reportId: report.id, reason: `sources:${sources.length}` },
    { dedupeKey: `extract:${report.id}:${sources.length}` },
  );
}

async function classifyShort(
  session: Awaited<ReturnType<typeof createSession>>,
  text: string,
): Promise<string | null> {
  if (!session || !session.ctx.ai.claude) return null;
  const { classifyWithModel } = await import('../ai/classify');
  try {
    const res = await classifyWithModel(
      session.ctx.ai.claude,
      session.ctx.config.CLAUDE_MODEL_FAST,
      { state: 'idle', lastOutbound: null, text, isVoice: true },
      session.ctx.log,
    );
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
  if (siteDay && siteDay.status === 'processing')
    await ctx.db.updateSiteDay(siteDay.id, { status: 'pending' });
  await ctx.db.logAudit({
    org_id: report.org_id,
    actor_type: 'agent',
    action: 'report.voided',
    entity: 'report',
    entity_id: report.id,
  });
}

/** No crew and no work in the draft: the note described a day off rather than a workday. */
export function looksLikeDayOff(data: DailyReportData): boolean {
  return data.workPerformed.length === 0 && data.manpower.every((m) => m.workers === 0);
}

/**
 * §F10 for long notes: "No work today, the city closed the street… crew back at seven tomorrow"
 * is too long for the short-command check in afterTranscription, so it is extracted like a report
 * and would then be asked for a headcount. When the draft shows nobody worked, the daily report is
 * voided and the note goes through the weather-day / no-work flow instead. Returns true when it did.
 */
export async function rerouteDayOff(
  ctx: Ctx,
  report: ReportRow,
  data: DailyReportData,
): Promise<boolean> {
  if (report.kind !== 'daily' || report.status !== 'collecting' || !looksLikeDayOff(data))
    return false;
  const sources = (await ctx.db.listReportSources(report.id)).filter(
    (s) => s.kind === 'audio' || s.kind === 'text',
  );
  if (sources.length === 0) return false;
  const transcripts = await ctx.db.listTranscripts(
    sources.filter((s) => s.kind === 'audio').map((s) => s.message_id),
  );
  const text = sources
    .map((s) =>
      s.kind === 'audio'
        ? transcripts.find((t) => t.message_id === s.message_id)?.text
        : (s.body ?? undefined),
    )
    .filter((t): t is string => Boolean(t?.trim()))
    .join('\n');
  const last = sources[sources.length - 1]!;
  const message = await ctx.db.getMessage(last.message_id);
  if (!text || !message) return false;
  const session = await createSession(ctx, message);
  const site = session?.siteById(report.site_id);
  if (!session || !site) return false;
  ctx.log.info('draft describes a day off; rerouting to F10', { report_id: report.id });
  await voidReport(ctx, report.id);
  await session.setState('idle', { active_report_id: null, pending_question_id: null });
  const hint = data.weather.periods.some((p) => p.fullDay || (p.lostHours ?? 0) > 0)
    ? 'weather_day'
    : 'no_work';
  await handleDayOffText(session, site, text, message.id, hint);
  return true;
}
