import { progressSteps, waCopy, type ProgressFacts } from '@sitelog/shared';
import type { Ctx } from '../context';
import { contextOf } from '../router/context';
import { sendFreeForm } from '../wa/send';

/**
 * §F5 step 3 — the progress bubble ("Writing your report…" + the steps done so far).
 *
 * The WhatsApp Cloud API cannot edit a sent message, so ticking steps off live would mean one
 * message per step. Instead the agent sends at most ONE bubble per report (guarded by
 * `conversations.context.progress_sent_for`), at the first pipeline checkpoint where more than
 * 10 s have passed since the note arrived (`reports.received_at`):
 *   1. after transcription (once every voice note of the report is transcribed),
 *   2. when extraction starts (queue latency, text-only reports),
 *   3. after extraction, before decide_next sends the question or the draft card.
 * It lists what is complete at that moment and ends with the pending hours check. It is never
 * sent once a question or the draft card has gone out (report no longer `collecting`), nor when
 * the conversation has moved on from processing this report.
 */
export const PROGRESS_AFTER_MS = 10_000;

export { progressSteps, type ProgressFacts };

/** True when the report has at least one voice note and every one of them is transcribed. */
/** A voice note of the report has no transcript yet (its transcription will continue the pipeline). */
export async function audioPending(ctx: Ctx, reportId: string): Promise<boolean> {
  const audio = (await ctx.db.listReportSources(reportId)).filter((s) => s.kind === 'audio');
  if (audio.length === 0) return false;
  const ids = [...new Set(audio.map((s) => s.message_id))];
  const done = new Set((await ctx.db.listTranscripts(ids)).map((t) => t.message_id));
  return ids.some((id) => !done.has(id));
}

export async function allAudioTranscribed(ctx: Ctx, reportId: string): Promise<boolean> {
  const audio = (await ctx.db.listReportSources(reportId)).filter((s) => s.kind === 'audio');
  if (audio.length === 0) return false;
  const ids = new Set(audio.map((s) => s.message_id));
  const done = await ctx.db.listTranscripts([...ids]);
  return done.filter((t) => ids.has(t.message_id)).length >= ids.size;
}

/**
 * Sends the progress bubble when this checkpoint is the first one past 10 s. `facts` is only
 * evaluated once every cheap guard passed; it may return null for "not a reportable point yet"
 * (e.g. a second voice note is still being transcribed). Returns true when a bubble went out.
 * Best-effort: a failed send is logged, never fails the job, and is not retried.
 */
export async function sendProgressIfSlow(
  ctx: Ctx,
  reportId: string,
  facts: () => Promise<ProgressFacts | null>,
): Promise<boolean> {
  const report = await ctx.db.getReport(reportId);
  if (!report || report.kind !== 'daily' || report.status !== 'collecting') return false;
  if (!report.received_at) return false;
  const elapsed = ctx.now().getTime() - new Date(report.received_at).getTime();
  if (elapsed <= PROGRESS_AFTER_MS) return false;
  const reporter = report.reporter_id ? await ctx.db.getReporter(report.reporter_id) : null;
  const convo = reporter ? await ctx.db.getConversationByPhone(reporter.phone_e164) : null;
  if (!convo) return false;
  const c = contextOf(convo);
  if (c.progress_sent_for === report.id) return false;
  if (convo.state !== 'processing' || c.active_report_id !== report.id) return false;

  const f = await facts();
  if (!f) return false;
  const text = waCopy.progressLines(progressSteps(f));
  // Claim before sending so a retry or a concurrent job never sends a second bubble.
  await ctx.db.updateConversation(convo.id, { context: { ...c, progress_sent_for: report.id } });
  try {
    await sendFreeForm(ctx, convo, text, undefined, { kind: 'progress', reportId: report.id });
  } catch (err) {
    ctx.log.warn('progress bubble not sent', { err, report_id: report.id });
    return false;
  }
  ctx.log.info('progress bubble sent', { report_id: report.id, elapsed_ms: elapsed });
  return true;
}
