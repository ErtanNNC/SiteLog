import { waCopy, type ConversationRow } from '@sitelog/shared';
import type { Ctx } from '../context';
import { sendFreeForm } from '../wa/send';
import { contextOf } from './context';

/**
 * §7.2 timeouts, run by the 60-second sweep:
 * - awaiting_answer > 60 min → the open question is recorded as unanswered and the draft goes out
 *   (decide_next flags `unanswered:<field>` for the office).
 * - awaiting_confirmation → nudge at +30 min, file at +2 h with `unconfirmed`;
 *   with filing_mode = 'auto_15min' file at +15 min.
 * - processing > 10 min without a draft → "taking a little longer" once.
 */
export const ANSWER_TIMEOUT_MS = 60 * 60_000;
export const CONFIRM_NUDGE_MS = 30 * 60_000;
export const CONFIRM_FILE_MS = 2 * 60 * 60_000;
export const AUTO_FILE_MS = 15 * 60_000;
export const PROCESSING_DELAYED_MS = 10 * 60_000;

export interface SweepResult {
  answered: number;
  nudged: number;
  filed: number;
  delayed: number;
}

export async function runTimeoutSweep(ctx: Ctx): Promise<SweepResult> {
  const now = ctx.now();
  const result: SweepResult = { answered: 0, nudged: 0, filed: 0, delayed: 0 };
  const convos = await ctx.db.listConversationsByState([
    'awaiting_answer',
    'awaiting_confirmation',
    'processing',
  ]);
  for (const convo of convos) {
    try {
      const changed = new Date(convo.state_changed_at).getTime();
      const age = now.getTime() - changed;
      if (convo.state === 'awaiting_answer' && age >= ANSWER_TIMEOUT_MS) {
        if (await answerTimedOut(ctx, convo)) result.answered++;
      } else if (convo.state === 'awaiting_confirmation') {
        const r = await confirmationTimedOut(ctx, convo, age);
        if (r === 'nudged') result.nudged++;
        if (r === 'filed') result.filed++;
      } else if (convo.state === 'processing' && age >= PROCESSING_DELAYED_MS) {
        if (await processingDelayed(ctx, convo)) result.delayed++;
      }
    } catch (err) {
      ctx.log.error('timeout sweep failed for conversation', { err, conversation_id: convo.id });
    }
  }
  return result;
}

async function answerTimedOut(ctx: Ctx, convo: ConversationRow): Promise<boolean> {
  const c = contextOf(convo);
  if (!c.pending_question_id || !c.active_report_id) return false;
  const q = await ctx.db.getQuestion(c.pending_question_id);
  if (q && !q.answered_at) {
    await ctx.db.updateQuestion(q.id, {
      answered_at: ctx.now(),
      answer: { unanswered: true, timeout: true },
    });
  }
  await ctx.db.updateConversation(convo.id, {
    state: 'processing',
    context: { ...c, pending_question_id: null },
  });
  const report = await ctx.db.getReport(c.active_report_id);
  if (report) {
    await ctx.db.logAudit({
      org_id: report.org_id,
      actor_type: 'system',
      action: 'report.question_timeout',
      entity: 'report',
      entity_id: report.id,
      diff: { question_id: q?.id ?? null },
    });
  }
  await ctx.db.enqueueJob(
    'decide_next',
    { reportId: c.active_report_id },
    { dedupeKey: `decide:${c.active_report_id}:timeout:${q?.id ?? 'none'}` },
  );
  return true;
}

async function confirmationTimedOut(
  ctx: Ctx,
  convo: ConversationRow,
  age: number,
): Promise<'nudged' | 'filed' | null> {
  const c = contextOf(convo);
  if (!c.active_report_id) return null;
  const report = await ctx.db.getReport(c.active_report_id);
  if (!report || report.status !== 'awaiting_confirmation') return null;
  const settings = await ctx.db.getOrgSettings(report.org_id);
  const sentAt = c.draft_sent_at
    ? new Date(c.draft_sent_at).getTime()
    : new Date(convo.state_changed_at).getTime();
  const sinceDraft = ctx.now().getTime() - sentAt;
  const auto = settings?.filing_mode === 'auto_15min';
  if (auto && sinceDraft >= AUTO_FILE_MS) {
    await ctx.db.enqueueJob(
      'file_report',
      { reportId: report.id, trigger: 'auto' },
      { dedupeKey: `file:${report.id}` },
    );
    await ctx.db.updateConversation(convo.id, { state: 'processing', context: c });
    return 'filed';
  }
  if (!auto && sinceDraft >= CONFIRM_FILE_MS) {
    await ctx.db.enqueueJob(
      'file_report',
      { reportId: report.id, trigger: 'timeout' },
      { dedupeKey: `file:${report.id}` },
    );
    await ctx.db.updateConversation(convo.id, { state: 'processing', context: c });
    return 'filed';
  }
  if (
    !auto &&
    sinceDraft >= CONFIRM_NUDGE_MS &&
    c.nudged_for !== report.id &&
    age >= CONFIRM_NUDGE_MS
  ) {
    await sendFreeForm(ctx, convo, waCopy.draftNudge(), undefined, {
      kind: 'draft_nudge',
      reportId: report.id,
    });
    await ctx.db.updateConversation(convo.id, { context: { ...c, nudged_for: report.id } });
    return 'nudged';
  }
  return null;
}

async function processingDelayed(ctx: Ctx, convo: ConversationRow): Promise<boolean> {
  const c = contextOf(convo);
  if (!c.active_report_id || c.delayed_notified_for === c.active_report_id) return false;
  const report = await ctx.db.getReport(c.active_report_id);
  if (
    !report ||
    report.status === 'filed' ||
    report.status === 'signed_off' ||
    report.status === 'void'
  ) {
    // Stale processing state (e.g. a voided report): release the conversation.
    await ctx.db.updateConversation(convo.id, {
      state: 'idle',
      context: { ...c, active_report_id: null },
    });
    return false;
  }
  await sendFreeForm(ctx, convo, waCopy.processingDelayed(), undefined, {
    kind: 'processing_delayed',
    reportId: report.id,
  });
  await ctx.db.updateConversation(convo.id, { context: { ...c, delayed_notified_for: report.id } });
  await ctx.db.notifyOrg(
    report.org_id,
    'processing_delayed',
    `${report.report_no} is taking longer than usual`,
    null,
    `/reports/${report.id}`,
  );
  return true;
}
