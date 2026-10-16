import {
  MessageSendError,
  QUESTION_FIELDS,
  answerConfirmation,
  applyAnswer,
  assertE164,
  fieldReportLinkUrl,
  orderInboundReporters,
  readReportData,
  toCountryPack,
  type AnswerValue,
  type InboundScope,
  type QuestionField,
  type QuestionRow,
  type QuestionSpec,
  type StoredReportData,
} from '@sitelog/shared';
import { answerRefusal, parseAnswerWithModel } from '../ai/answer';
import type { Json } from '../db';
import { skippedForConsent } from '../pipeline/consent';
import { personalLinkCode } from '../pipeline/web';
import { PermanentJobError, type JobHandler } from './types';

/**
 * §19 Q26 (W2-16): a WhatsApp text from a reporter that is no keyword, read as the answer to their
 * open web question (F7 over WhatsApp). `processInboundSms` queued it (`whatsapp_answer:<message>`,
 * under the phone's lock).
 *
 * 1. The newest open web question of the phone's reporters (a report awaiting its answer). None:
 *    the text stays a text (audited `whatsapp.answer_skipped`), no reply.
 * 2. The processing consent (spec §19 Q95): turned off, nothing goes to the model.
 * 3. `parse_answer` (the fast model; the text is data, phone numbers taken out by `callTool`,
 *    §10.12) reads `{field, value, confidence}`; code decides (`answerRefusal`, the rule of the
 *    web's spoken answer): applied in code (`applyAnswer`, totals recomputed, the source the
 *    answer) through field_answer_question() with `field_channel 'whatsapp'` and the message, which
 *    audits `report.question_answered` and enqueues decide_next; or, unclear, the question's link
 *    again on WhatsApp (`question_ready`, spec §19 Q113), and the question stays open (its web
 *    timeout still runs).
 *
 * The model never files and never decides: it only reads the answer. A question answered
 * meanwhile (a tap, the timeout) changes nothing.
 */
export const whatsappAnswerJob: JobHandler<'whatsapp_answer'> = async (ctx, payload) => {
  const message = await ctx.db.getMessage(payload.messageId);
  if (!message) throw new PermanentJobError(`message ${payload.messageId} not found`);
  if (message.channel !== 'whatsapp' || message.direction !== 'in' || !message.phone_e164) {
    throw new PermanentJobError(`message ${message.id} is not an inbound WhatsApp message`);
  }
  const meta = (message.payload ?? {}) as { pack?: string };
  const packRow = meta.pack ? await ctx.db.getCountry(meta.pack) : null;
  if (!packRow) throw new PermanentJobError(`message ${message.id} names no country pack`);
  const pack = toCountryPack(packRow);
  const scope: InboundScope | null =
    message.provider === 'twilio'
      ? { realOnly: true }
      : message.org_id
        ? { orgId: message.org_id }
        : null;
  if (!scope) throw new PermanentJobError(`message ${message.id} has no org to answer in`);
  const phone = assertE164(message.phone_e164);
  const log = ctx.log.child({ message_id: message.id, pack: pack.code });
  const reporters = orderInboundReporters(
    await ctx.db.listInboundReporters(phone, pack.code, scope),
  );
  const text = (message.body ?? '').trim();
  const open = text ? await ctx.db.openWebQuestions(reporters.map((r) => r.id)) : [];
  const target = open[0];
  const skipped = async (reason: string, extra: Record<string, unknown> = {}) => {
    const reporter = reporters[0];
    await ctx.db.logAudit({
      org_id: reporter?.orgId ?? message.org_id,
      actor_type: reporter ? 'reporter' : 'system',
      actor_id: reporter?.id ?? null,
      action: 'whatsapp.answer_skipped',
      entity: 'message',
      entity_id: message.id,
      diff: { reason, channel: 'whatsapp', ...extra },
    });
    log.info('whatsapp_answer: not an answer', { reason });
  };
  if (!target) return skipped('no_open_question');
  const reporter = reporters.find((r) => r.id === target.reporter_id) ?? reporters[0]!;

  const [report, question] = await Promise.all([
    ctx.db.getReport(target.report_id),
    ctx.db.getQuestion(target.question_id),
  ]);
  if (!report || !question || question.report_id !== report.id) {
    return skipped('no_open_question');
  }
  if (!(QUESTION_FIELDS as readonly string[]).includes(question.field)) {
    return skipped('not_a_field', { question_id: question.id });
  }
  if (question.answered_at || report.status !== 'awaiting_answer') {
    return skipped('stale', { question_id: question.id });
  }
  // F15, spec §19 Q95: nothing goes to the model once the reporter turned consent off.
  if (
    await skippedForConsent(ctx, {
      jobType: 'whatsapp_answer',
      reporterId: report.reporter_id,
      report,
      detail: { question_id: question.id, message_id: message.id },
    })
  ) {
    return;
  }

  const site = await ctx.db.siteContext(report.site_id);
  if (!site) throw new Error(`site ${report.site_id} not found`);
  const version = await ctx.db.getVersion(report.id, report.current_version || 1);
  if (!version?.data) throw new Error(`report ${report.id} has no draft`);
  const draft = readReportData(version.data as StoredReportData);
  if (!ctx.ai.claude) throw new Error('ANTHROPIC_API_KEY is required for whatsapp_answer');
  const field = question.field as QuestionField;
  const qTarget = (question.target ?? {}) as QuestionSpec['target'];
  const companies = site.companies.map((c) => ({ id: c.id, name: c.name, aliases: c.aliases }));
  const defaultShiftHours = Number(site.settings.default_shift_hours);
  const parsed = await parseAnswerWithModel(
    ctx.ai.claude,
    ctx.config.CLAUDE_MODEL_FAST,
    {
      question: {
        field,
        prompt: question.prompt,
        options: optionLabels(question.options),
        target: qTarget,
      },
      replyText: text,
      companies,
      defaultShiftHours,
      via: 'text',
    },
    log,
  );
  ctx.metrics.add({ tokens: parsed.usage, estCostUsd: parsed.estCostUsd });

  const unclear = async (reason: string) => {
    await ctx.db.logAudit({
      org_id: report.org_id,
      actor_type: 'reporter',
      actor_id: reporter.id,
      action: 'report.answer_unclear',
      entity: 'report',
      entity_id: report.id,
      diff: {
        question_id: question.id,
        message_id: message.id,
        channel: 'whatsapp',
        reason,
        confidence: parsed.data.confidence,
      },
    });
    // §19 Q113: the question's link again, on WhatsApp (the window the text opened is open).
    const { base, code } = await personalLinkCode(ctx, reporter.id, reporter.orgId);
    try {
      await ctx.notifier.reply({
        pack,
        org: { id: reporter.orgId, isDemo: reporter.orgIsDemo },
        reporterId: reporter.id,
        phone,
        locale: reporter.locale,
        key: 'question_ready',
        vars: { link: fieldReportLinkUrl(base, code, report.id) },
        channel: 'whatsapp',
        dedupeKey: `whatsapp_answer:${message.id}:unclear`,
      });
    } catch (err) {
      if (!(err instanceof MessageSendError) || err.retryable) throw err;
    }
    log.info('whatsapp_answer: unclear', { reason });
  };

  const refusal = answerRefusal(field, parsed.data, text);
  if (refusal) return unclear(refusal);
  const value: AnswerValue = parsed.data.value;
  let newCompany: { name: string; manpowerIndex: number } | null = null;
  if (field === 'company.unknown') {
    const known = value.companyId ? companies.find((c) => c.id === value.companyId) : undefined;
    if (value.companyAction === 'map' && !known && !qTarget.closestCompanyId) {
      return unclear('unknown_company');
    }
    if (value.companyAction === 'add') {
      const index = qTarget.manpowerIndex;
      const entry = index !== undefined ? draft.manpower[index] : undefined;
      const name = (value.companyName ?? entry?.companyName ?? qTarget.companyName ?? '').trim();
      if (index === undefined || !entry || !name) return unclear('unknown_company');
      newCompany = { name, manpowerIndex: index };
    }
  }
  const applied = applyAnswer(draft, { field, target: qTarget }, value, {
    defaultShiftHours,
    workingHours: site.site.working_hours,
    source: { type: 'answer', questionId: question.id },
    confidence: parsed.data.confidence,
    companies,
  });
  const confirmation = answerConfirmation(field, qTarget, applied.data, value);
  try {
    const res = await ctx.db.answerQuestionByWhatsapp({
      reportId: report.id,
      questionId: question.id,
      reporterId: reporter.id,
      messageId: message.id,
      base: version.data as Json,
      data: applied.data as unknown as Json,
      answer: {
        text,
        parsed: value,
        confidence: parsed.data.confidence,
        confirmation,
        via: 'whatsapp',
      } as unknown as Json,
      newCompany: newCompany as unknown as Json | null,
    });
    ctx.metrics.add({ answerOutcome: `whatsapp:${res.status}` });
    log.info('whatsapp_answer: applied', {
      report_id: report.id,
      question_id: question.id,
      ...res,
    });
  } catch (err) {
    const m = String((err as Error).message);
    // A tap or the timeout answered it meanwhile: nothing to do. A draft that changed under the
    // parse (a voice note's re-extraction): the job runs again on the new one.
    if (/question_closed|wrong_state/.test(m))
      return skipped('stale', { question_id: question.id });
    throw err;
  }
};

/** The labels of a question's stored options (`[{id, label, value?}]`), for the model. */
function optionLabels(options: QuestionRow['options']): string[] {
  if (!Array.isArray(options)) return [];
  return options.flatMap((o) =>
    o && typeof o === 'object' && !Array.isArray(o) && typeof o.label === 'string' ? [o.label] : [],
  );
}
