import { waCopy, type ClassifiedReply } from '@sitelog/shared';
import { classifyWithModel, quickClassify } from '../../ai/classify';
import type { Session } from '../session';
import { handleHelp, handleLanguage, handleStop } from './commands';
import { handleDayOffText, handleWeatherFollowupAnswer } from './dayoff';
import { applyFix, confirmReport } from './draft';
import { handleEditingText, handleEditRequest } from './edit';
import { handleContent, mergeIntoActive } from './intake';
import { handleAnswer } from './question';
import { singleSiteOrPicker } from './site-select';

/**
 * Free text (inbound) and voice transcripts (parse_reply) in every state: classify (§10.8),
 * then dispatch by intent (§9.5). Button replies never get here.
 */

async function lastOutboundText(s: Session): Promise<string | null> {
  const ctxt = s.context;
  const id = ctxt.draft_message_id;
  if (s.convo.state === 'awaiting_confirmation' && id) {
    const m = await s.ctx.db.getMessage(id);
    return m?.body ?? null;
  }
  if (ctxt.pending_question_id) {
    const q = await s.ctx.db.getQuestion(ctxt.pending_question_id);
    return q?.prompt ?? null;
  }
  return null;
}

/** Fallback when no model is configured: the state tells us what the reply most likely is. */
function stateFallback(s: Session): ClassifiedReply {
  switch (s.convo.state) {
    case 'awaiting_answer':
      return { intent: 'answer', confidence: 0.5 };
    case 'awaiting_confirmation':
      return { intent: 'fix', confidence: 0.5 };
    case 'editing':
      return { intent: 'fix', confidence: 0.5 };
    default:
      return { intent: 'other', confidence: 0.5 };
  }
}

export async function classifyText(
  s: Session,
  text: string,
  isVoice: boolean,
): Promise<ClassifiedReply> {
  const quick = quickClassify(text, s.now, s.tz);
  if (quick) return quick;
  if (!s.ctx.ai.claude) return stateFallback(s);
  const res = await classifyWithModel(
    s.ctx.ai.claude,
    s.ctx.config.CLAUDE_MODEL_FAST,
    { state: s.convo.state, lastOutbound: await lastOutboundText(s), text, isVoice },
    s.ctx.log,
  );
  s.ctx.metrics.add({ tokens: res.usage, estCostUsd: res.estCostUsd });
  return res.data;
}

export async function handleReplyText(s: Session, text: string, isVoice: boolean): Promise<void> {
  const { ctx } = s;
  const state = s.convo.state;
  const c = s.context;

  // The weather-day follow-up ("How many were on site this morning?") is answered in idle.
  if (state === 'idle' && c.weather_report_id && c.weather_followup === 'voice') {
    const report = await ctx.db.getReport(c.weather_report_id);
    if (report) {
      await handleWeatherFollowupAnswer(s, report, text);
      return;
    }
  }

  const cls = await classifyText(s, text, isVoice);
  switch (cls.intent) {
    case 'help':
      await handleHelp(s);
      return;
    case 'stop':
      await handleStop(s);
      return;
    case 'language':
      await handleLanguage(s, cls.entities?.language ?? 'en');
      return;
    case 'edit_request':
      await handleEditRequest(
        s,
        {
          dayReference: cls.entities?.dayReference ?? null,
          correctionText: cls.correctionText ?? null,
        },
        text,
      );
      return;
    case 'no_work':
    case 'weather_day': {
      const site = await singleSiteOrPicker(s, cls.intent);
      if (site) await handleDayOffText(s, site, text, s.message.id, cls.intent);
      return;
    }
    case 'confirm': {
      if (state === 'awaiting_confirmation' && c.active_report_id) {
        await confirmReport(s, c.active_report_id);
        return;
      }
      if (state === 'awaiting_answer' && c.pending_question_id) {
        const q = await ctx.db.getQuestion(c.pending_question_id);
        if (q && !q.answered_at) {
          await handleAnswer(s, q, text, isVoice ? 'voice' : 'text');
          return;
        }
      }
      return;
    }
    case 'answer': {
      if (c.pending_question_id) {
        const q = await ctx.db.getQuestion(c.pending_question_id);
        if (q && !q.answered_at) {
          await handleAnswer(s, q, text, isVoice ? 'voice' : 'text');
          return;
        }
      }
      if (state === 'awaiting_confirmation' && c.active_report_id) {
        const report = await ctx.db.getReport(c.active_report_id);
        if (report) await applyFix(s, report, cls.correctionText ?? text);
        return;
      }
      if (state === 'editing') {
        await handleEditingText(s, text);
        return;
      }
      return;
    }
    case 'fix': {
      if (state === 'editing') {
        await handleEditingText(s, text);
        return;
      }
      if (
        (state === 'awaiting_confirmation' ||
          state === 'awaiting_answer' ||
          state === 'processing') &&
        c.active_report_id
      ) {
        const report = await ctx.db.getReport(c.active_report_id);
        if (
          report &&
          (report.status === 'awaiting_confirmation' ||
            report.status === 'awaiting_answer' ||
            report.status === 'collecting')
        ) {
          await applyFix(s, report, cls.correctionText ?? text);
          return;
        }
      }
      if (state === 'idle' && c.last_filed_report_id) {
        // "Apex had 7 not 6" right after filing → edit today's report.
        await handleEditRequest(
          s,
          { dayReference: 'today', correctionText: cls.correctionText ?? text },
          text,
        );
        return;
      }
      return;
    }
    case 'new_report_content': {
      if (
        (state === 'processing' ||
          state === 'awaiting_answer' ||
          state === 'awaiting_confirmation') &&
        c.active_report_id
      ) {
        const report = await ctx.db.getReport(c.active_report_id);
        if (report && report.status !== 'filed' && report.status !== 'signed_off') {
          await mergeIntoActive(s, report);
          return;
        }
      }
      if (state === 'editing') {
        await handleEditingText(s, text);
        return;
      }
      await handleContent(s);
      return;
    }
    case 'other':
    default: {
      if (/\b(thanks|thank you|gracias|cheers|ta)\b/i.test(text)) {
        await s.reply(waCopy.youreWelcome(), undefined, { kind: 'one_liner' });
      }
      return;
    }
  }
}
