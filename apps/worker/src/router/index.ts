import { reportDateForInbound, type MessageRow } from '@sitelog/shared';
import type { Ctx } from '../context';
import { handleHelp, handleLanguage, handleStop } from './handlers/commands';
import { handleWeatherButton, handleWeatherFollowupPhoto } from './handlers/dayoff';
import { confirmReport, requestFix } from './handlers/draft';
import { handleEditCandidate } from './handlers/edit';
import {
  continueWithSite,
  dayFromText,
  handleContent,
  handleDayChoice,
  handleSiteChoice,
  mergeIntoActive,
  sendSitePicker,
} from './handlers/intake';
import { handleQuestionButton } from './handlers/question';
import { handleReminderButton } from './handlers/reminder';
import { handleReplyText } from './handlers/reply';
import { handleTestButton, handleTestContent } from './handlers/test';
import { handleUnknownSender } from './handlers/unknown';
import { handleFirstReply } from './handlers/welcome';
import { isThumbsUp, looksLikeReportText } from './inbound';
import { createSession, workingDaysOf, type Session } from './session';
import { quickClassify } from '../ai/classify';
import { matchSiteByText } from '../ai/site-guess';

/**
 * §7.2 conversation state machine, driven by the inbound_message job. Every inbound message is
 * routed exactly once (messages.status becomes 'read' after a successful pass).
 */
export async function routeInbound(ctx: Ctx, message: MessageRow): Promise<void> {
  if (message.direction !== 'in') return;
  if (message.status === 'read') {
    ctx.log.debug('message already routed', { message_id: message.id });
    return;
  }
  const convo = await ctx.db.getConversation(message.conversation_id);
  if (!convo) throw new Error(`conversation ${message.conversation_id} not found`);
  if (message.wa_message_id) await ctx.wa.markRead(message.wa_message_id);

  const session = await createSession(ctx, message, convo);
  if (!session) {
    await handleUnknownSender(ctx, convo, message);
  } else {
    await dispatch(session);
  }
  await ctx.db.updateMessage(message.id, { status: 'read' });
}

async function dispatch(s: Session): Promise<void> {
  const { inbound } = s;
  const state = s.convo.state;
  s.ctx.log.info('routing inbound', {
    conversation_id: s.convo.id,
    state,
    kind: inbound.kind,
    reporter_id: s.reporter.id,
  });

  if (inbound.kind === 'reaction') {
    await handleReaction(s);
    return;
  }
  if (inbound.kind === 'unsupported') {
    s.ctx.log.info('unsupported inbound type ignored', {
      message_id: s.message.id,
      type: s.message.type,
    });
    return;
  }

  // Welcome: the first reply of any kind verifies the reporter (§F3).
  if (state === 'new' || state === 'welcome_sent') {
    await handleFirstReply(s);
    return;
  }

  if (inbound.kind === 'button') {
    await handleButton(s);
    return;
  }

  if (inbound.kind === 'text') {
    await handleText(s, inbound.text);
    return;
  }

  // audio / image / document
  await handleMedia(s);
}

async function handleButton(s: Session): Promise<void> {
  if (s.inbound.kind !== 'button') return;
  const p = s.inbound.parsed;
  switch (p.kind) {
    case 'welcome':
      if (p.action === 'wrong_site') await handleFirstReply(s);
      return;
    case 'test':
      await handleTestButton(s, p.action);
      return;
    case 'question':
      await handleQuestionButton(s, p.questionId, p.option);
      return;
    case 'draft':
      if (p.action === 'ok') await confirmReport(s, p.reportId);
      else await requestFix(s, p.reportId);
      return;
    case 'reminder':
      await handleReminderButton(s, p.siteDayId, p.action);
      return;
    case 'weather':
      await handleWeatherButton(s, p.reportId, p.action);
      return;
    case 'site':
      await handleSiteChoice(s, p.siteId);
      return;
    case 'day':
      await handleDayChoice(s, p.date);
      return;
    case 'edit':
      await handleEditCandidate(s, p.reportId);
      return;
    case 'reinvite':
      await handleFirstReply(s);
      return;
    default:
      s.ctx.log.warn('unknown button id', { id: s.inbound.id });
  }
}

async function handleText(s: Session, text: string): Promise<void> {
  const state = s.convo.state;
  const c = s.context;

  if (state === 'test_mode') {
    const quick = quickClassify(text, s.now, s.tz);
    if (quick?.intent === 'help') {
      await handleHelp(s);
      return;
    }
    await handleTestContent(s);
    return;
  }

  // Global commands first (§7.2): help · stop · language · no work · edit <day>.
  const quick = quickClassify(text, s.now, s.tz);
  if (
    quick &&
    (quick.intent === 'help' || quick.intent === 'stop' || quick.intent === 'language')
  ) {
    if (quick.intent === 'help') await handleHelp(s);
    else if (quick.intent === 'stop') await handleStop(s);
    else await handleLanguage(s, quick.entities?.language ?? 'en');
    return;
  }

  // Waiting for a site or day choice: accept the answer as text too.
  if (state === 'selecting_site' || c.pending?.awaiting === 'site') {
    const guess = matchSiteByText(
      text,
      s.activeSites.map((x) => ({ id: x.id, name: x.name, projectCode: x.project_code })),
    );
    if (guess.siteId && guess.confidence >= 0.85) {
      await handleSiteChoice(s, guess.siteId);
      return;
    }
    if (quick && (quick.intent === 'no_work' || quick.intent === 'edit_request')) {
      await handleReplyText(s, text, false);
      return;
    }
    await sendSitePicker(
      s,
      c.pending?.message_ids ?? [],
      (c.pending as { intent?: 'report' | 'no_work' | 'weather_day' } | null)?.intent ?? 'report',
    );
    return;
  }
  if (c.pending?.awaiting === 'day' && c.pending.site_id) {
    const site = s.siteById(c.pending.site_id);
    if (site) {
      const settings = await s.ctx.db.getOrgSettings(site.org_id);
      const info = reportDateForInbound(s.now, site.timezone, workingDaysOf(settings));
      const date = dayFromText(text, info);
      if (date) {
        await handleDayChoice(s, date);
        return;
      }
      if (!quick) {
        // Not an answer to the prompt: treat it as more content for the pending report.
        await s.setState(null, {
          pending: { ...c.pending, message_ids: [...c.pending.message_ids, s.message.id] },
        });
        return;
      }
    }
  }

  if (state === 'idle' && !quick && looksLikeReportText(text) && !c.weather_followup) {
    await handleContent(s);
    return;
  }
  await handleReplyText(s, text, false);
}

async function handleMedia(s: Session): Promise<void> {
  const state = s.convo.state;
  const c = s.context;
  const { inbound } = s;
  if (state === 'test_mode') {
    await handleTestContent(s);
    return;
  }
  if (state === 'selecting_site' || c.pending) {
    await handleContent(s); // parks the message with the pending ones
    return;
  }
  if (
    state === 'idle' &&
    c.weather_report_id &&
    (inbound.kind === 'image' ||
      (inbound.kind === 'document' && (inbound.mime ?? '').startsWith('image/')))
  ) {
    const report = await s.ctx.db.getReport(c.weather_report_id);
    if (report && report.kind === 'weather_day') {
      await handleWeatherFollowupPhoto(s, report);
      return;
    }
  }
  if (
    (state === 'processing' || state === 'awaiting_answer' || state === 'awaiting_confirmation') &&
    c.active_report_id
  ) {
    const report = await s.ctx.db.getReport(c.active_report_id);
    if (
      report &&
      report.status !== 'filed' &&
      report.status !== 'signed_off' &&
      report.status !== 'void'
    ) {
      if (inbound.kind === 'audio' && state !== 'processing') {
        // A voice note while a question or draft is pending may be an answer, a fix or more content:
        // transcribe first, then parse_reply decides (§F6 step 4, §7.2 merge rule).
        await storeForReply(s, report.site_id);
        await s.ctx.db.enqueueJob(
          'transcribe_audio',
          { messageId: s.message.id, reportId: report.id },
          { dedupeKey: `transcribe:${s.message.id}` },
        );
        return;
      }
      await mergeIntoActive(s, report);
      return;
    }
  }
  if (state === 'editing' && c.editing?.report_id) {
    const report = await s.ctx.db.getReport(c.editing.report_id);
    if (report && inbound.kind === 'audio') {
      await storeForReply(s, report.site_id);
      await s.ctx.db.enqueueJob(
        'transcribe_audio',
        { messageId: s.message.id, reportId: report.id },
        { dedupeKey: `transcribe:${s.message.id}` },
      );
      return;
    }
  }
  if (
    state === 'idle' &&
    c.weather_report_id &&
    c.weather_followup === 'voice' &&
    inbound.kind === 'audio'
  ) {
    const report = await s.ctx.db.getReport(c.weather_report_id);
    if (report) {
      await storeForReply(s, report.site_id);
      await s.ctx.db.enqueueJob(
        'transcribe_audio',
        { messageId: s.message.id, reportId: report.id },
        { dedupeKey: `transcribe:${s.message.id}` },
      );
      return;
    }
  }
  await handleContent(s);
}

async function storeForReply(s: Session, siteId: string): Promise<void> {
  const { ensureMediaStored } = await import('./media');
  const { localDate } = await import('@sitelog/shared');
  const site = s.siteById(siteId) ?? (await s.ctx.db.getSite(siteId));
  if (!site) return;
  await ensureMediaStored(s.ctx, s.message, {
    orgId: site.org_id,
    siteId: site.id,
    date: localDate(new Date(s.message.created_at), site.timezone),
  });
}

/** A thumbs-up on the draft message files it (§F7 step 3). Other reactions are ignored. */
async function handleReaction(s: Session): Promise<void> {
  if (s.inbound.kind !== 'reaction') return;
  const c = s.context;
  if (!isThumbsUp(s.inbound.emoji)) return;
  if (s.convo.state !== 'awaiting_confirmation' || !c.active_report_id) return;
  if (
    s.inbound.toWaMessageId &&
    c.draft_wa_message_id &&
    s.inbound.toWaMessageId !== c.draft_wa_message_id
  )
    return;
  await confirmReport(s, c.active_report_id);
}

export { continueWithSite };
