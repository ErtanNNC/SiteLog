import { TEMPLATE_NAMES, type TemplateName } from '@sitelog/shared';
import { sendBusinessInitiated, sendFreeForm } from '../wa/send';
import { PermanentJobError, type JobHandler } from './types';

/** Scheduler-initiated templates (reminders, heads-up, office edits). `vars` is {"1": …, "2": …}. */
export const sendTemplate: JobHandler<'send_template'> = async (ctx, payload) => {
  const convo = await ctx.db.getConversation(payload.conversationId);
  if (!convo) throw new PermanentJobError(`conversation ${payload.conversationId} not found`);
  const template = payload.template as TemplateName;
  if (!TEMPLATE_NAMES.includes(template))
    throw new PermanentJobError(`unknown template ${payload.template}`);
  const vars = Object.entries(payload.vars)
    .sort(([a], [b]) => Number(a) - Number(b))
    .map(([, v]) => v);
  await sendBusinessInitiated(ctx, convo, template, vars, payload.freeFormText ?? null, {
    buttons: payload.buttons,
    siteDayId: payload.siteDayId,
    meta: { kind: template },
  });
  if (payload.siteDayId && payload.stage !== undefined) {
    const siteDay = await ctx.db.getSiteDay(payload.siteDayId);
    if (siteDay && siteDay.reminder_stage < payload.stage)
      await ctx.db.updateSiteDay(siteDay.id, { reminder_stage: payload.stage });
  }
};

/** Free-form text + buttons to a conversation (inside the window). */
export const sendMessage: JobHandler<'send_message'> = async (ctx, payload) => {
  const convo = await ctx.db.getConversation(payload.conversationId);
  if (!convo) throw new PermanentJobError(`conversation ${payload.conversationId} not found`);
  await sendFreeForm(ctx, convo, payload.text, payload.buttons, { kind: 'send_message' });
};
