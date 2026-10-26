import {
  applyAnswer,
  ButtonSets,
  parseQuickAnswer,
  waCopy,
  LOW_CONFIDENCE_THRESHOLD,
  type AnswerValue,
  type Button,
  type ConversationRow,
  type DailyReportDataV1,
  type QuestionField,
  type QuestionRow,
  type QuestionSpec,
  type ReportRow,
} from '@sitelog/shared';
import { parseAnswerWithModel } from '../../ai/answer';
import type { Ctx } from '../../context';
import type { Json, SiteContext } from '../../db';
import { currentData, storeDraft } from '../../pipeline/draft';
import { sendFreeForm } from '../../wa/send';
import { contextOf } from '../context';
import type { Session } from '../session';

/** §F6 — one question at a time with ≤ 3 tap-able answers. */

export const MAX_REASKS = 1;

export async function sendQuestion(
  ctx: Ctx,
  convo: ConversationRow,
  report: ReportRow,
  spec: QuestionSpec,
): Promise<QuestionRow> {
  const q = await ctx.db.insertQuestion({
    report_id: report.id,
    field: spec.field,
    target: { ...spec.target, path: spec.path },
    prompt: spec.prompt,
    options: null,
  });
  // WhatsApp buttons carry the labels (and "Other…"); the web's [{id,label}] are W1-12's.
  const buttons = ButtonSets.question(
    q.id,
    spec.options.map((o) => o.label),
  );
  await ctx.db.updateQuestion(q.id, { options: buttons as unknown as Json });
  const msg = await sendFreeForm(ctx, convo, waCopy.questionGeneric(spec.prompt), buttons, {
    kind: 'question',
    reportId: report.id,
    questionId: q.id,
  });
  await ctx.db.updateQuestion(q.id, { asked_message_id: msg.id, asked_at: ctx.now() });
  await ctx.db.updateReport(report.id, { status: 'awaiting_answer' });
  await ctx.db.updateConversation(convo.id, {
    state: 'awaiting_answer',
    context: { ...contextOf(convo), active_report_id: report.id, pending_question_id: q.id },
  });
  await ctx.db.logAudit({
    org_id: report.org_id,
    actor_type: 'agent',
    action: 'report.question_asked',
    entity: 'report',
    entity_id: report.id,
    diff: { question_id: q.id, field: spec.field },
  });
  return { ...q, options: buttons as unknown as QuestionRow['options'], asked_message_id: msg.id };
}

function optionsOf(q: QuestionRow): Button[] {
  if (Array.isArray(q.options)) return q.options as unknown as Button[];
  return [];
}

export async function handleQuestionButton(
  s: Session,
  questionId: string,
  option: number | 'other',
): Promise<void> {
  const q = await s.ctx.db.getQuestion(questionId);
  if (!q || q.answered_at) return;
  if (option === 'other') {
    await s.setState('awaiting_answer', {
      pending_question_id: q.id,
      active_report_id: q.report_id,
    });
    await s.reply(waCopy.answerOther(), undefined, { kind: 'answer_other', questionId: q.id });
    return;
  }
  const buttons = optionsOf(q);
  const title =
    (buttons[option]?.title ?? s.inbound.kind === 'button')
      ? (s.inbound as { title: string | null }).title
      : null;
  if (!title) return;
  await handleAnswer(s, q, title, 'button');
}

async function siteContextFor(s: Session, report: ReportRow): Promise<SiteContext> {
  const site = await s.ctx.db.siteContext(report.site_id);
  if (!site) throw new Error(`site ${report.site_id} not found`);
  return site;
}

/** Parse (quick → model) and apply an answer to the open question, then continue the pipeline. */
export async function handleAnswer(
  s: Session,
  q: QuestionRow,
  text: string,
  via: 'button' | 'text' | 'voice',
): Promise<void> {
  const { ctx } = s;
  const report = await ctx.db.getReport(q.report_id);
  if (!report) return;
  const site = await siteContextFor(s, report);
  const data = await currentData(ctx, report);
  if (!data) return;
  const field = q.field as QuestionField;
  const target = (q.target ?? {}) as QuestionSpec['target'] & { path?: string };
  const companies = site.companies.map((c) => ({ id: c.id, name: c.name, aliases: c.aliases }));

  let value: AnswerValue | null = parseQuickAnswer(field, text);
  let confidence = 1;
  if (!value && ctx.ai.claude) {
    const parsed = await parseAnswerWithModel(
      ctx.ai.claude,
      ctx.config.CLAUDE_MODEL_FAST,
      {
        question: { field, prompt: q.prompt, options: optionsOf(q).map((b) => b.title), target },
        replyText: text,
        companies,
        defaultShiftHours: Number(site.settings.default_shift_hours),
        via: via === 'voice' ? 'voice' : 'text',
      },
      ctx.log,
    );
    ctx.metrics.add({ tokens: parsed.usage, estCostUsd: parsed.estCostUsd });
    confidence = parsed.data.confidence;
    value = parsed.data.value;
    if (confidence < LOW_CONFIDENCE_THRESHOLD) {
      await reaskOrGiveUp(s, q, report, text);
      return;
    }
  }
  // A headcount question is only answered by a headcount ("they were here all day" is not one).
  if (!value || (field === 'manpower.workers' && value.workers == null)) {
    await reaskOrGiveUp(s, q, report, text);
    return;
  }

  const reasons: string[] = [];
  if (field === 'company.unknown' && value.companyAction === 'add') {
    const name = (
      value.companyName ??
      target.companyName ??
      target.companyNameHeard ??
      'Unknown company'
    ).trim();
    const company = await ctx.db.insertCompany(site.org.id, name, 'unconfirmed');
    value = { ...value, companyAction: 'map', companyId: company.id, companyName: company.name };
    companies.push({ id: company.id, name: company.name, aliases: [] });
    reasons.push(`unknown_company:${company.name}`);
    await ctx.db.logAudit({
      org_id: site.org.id,
      actor_type: 'reporter',
      actor_id: s.reporter.id,
      action: 'company.added_unconfirmed',
      entity: 'company',
      entity_id: company.id,
      diff: { report_id: report.id },
    });
  }

  const applied = applyAnswer(data, { field, target }, value, {
    defaultShiftHours: Number(site.settings.default_shift_hours),
    workingHours: site.site.working_hours,
    // v1 data (the WhatsApp worker, step 22): the reply message is the source.
    source: { type: 'reply', messageId: s.message.id },
    confidence,
    companies,
  });
  let next: DailyReportDataV1 = applied.data;
  if (
    field === 'company.unknown' &&
    value.companyAction === 'map' &&
    value.companyId !== undefined &&
    target.manpowerIndex !== undefined
  ) {
    const entry = next.manpower[target.manpowerIndex];
    if (entry) entry.companyId = value.companyId;
  }
  next = { ...next, manpower: next.manpower.map((m) => ({ ...m })) };
  await storeDraft(ctx, report, next, { authorMessageId: s.message.id });
  await ctx.db.updateQuestion(q.id, {
    answered_message_id: s.message.id,
    answered_at: s.now,
    answer: { ...value, text, via },
  });
  if (reasons.length) {
    const merged = Array.from(new Set([...report.review_reasons, ...reasons]));
    await ctx.db.updateReport(report.id, { review_reasons: merged, needs_review: true });
  }
  await ctx.db.logAudit({
    org_id: report.org_id,
    actor_type: 'reporter',
    actor_id: s.reporter.id,
    action: 'report.question_answered',
    entity: 'report',
    entity_id: report.id,
    diff: { question_id: q.id, field, via },
  });
  await s.setState('processing', { pending_question_id: null, active_report_id: report.id });
  const ack =
    applied.ackText ??
    (field === 'company.unknown' && value.companyName
      ? `Thanks — logged as ${value.companyName}.`
      : null);
  if (ack) await s.reply(ack, undefined, { kind: 'answer_ack', questionId: q.id });
  await ctx.db.enqueueJob(
    'decide_next',
    { reportId: report.id },
    { dedupeKey: `decide:${report.id}:${q.id}` },
  );
}

/** Below 0.7 confidence: re-ask once with the options; the second miss is recorded as unanswered. */
async function reaskOrGiveUp(
  s: Session,
  q: QuestionRow,
  report: ReportRow,
  text: string,
): Promise<void> {
  const { ctx } = s;
  const reask = { ...(s.context.reask ?? {}) };
  const n = reask[q.id] ?? 0;
  if (n < MAX_REASKS) {
    reask[q.id] = n + 1;
    const buttons = optionsOf(q);
    const msg = await s.reply(
      waCopy.questionGeneric(q.prompt),
      buttons.length ? buttons : undefined,
      { kind: 'question', reportId: report.id, questionId: q.id },
    );
    await ctx.db.updateQuestion(q.id, { asked_message_id: msg.id, asked_at: s.now });
    await s.setState('awaiting_answer', {
      reask,
      pending_question_id: q.id,
      active_report_id: report.id,
    });
    return;
  }
  await ctx.db.updateQuestion(q.id, {
    answered_message_id: s.message.id,
    answered_at: s.now,
    answer: { text, unanswered: true },
  });
  await s.setState('processing', { pending_question_id: null, active_report_id: report.id });
  await ctx.db.enqueueJob(
    'decide_next',
    { reportId: report.id },
    { dedupeKey: `decide:${report.id}:${q.id}` },
  );
}
