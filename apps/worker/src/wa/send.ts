import {
  buildTemplatePayload,
  renderTemplateText,
  sendMode,
  templateButtons,
  type Button,
  type ConversationRow,
  type MessageRow,
  type TemplateName,
} from '@sitelog/shared';
import type { Ctx } from '../context';
import type { DocumentInput, ListOption } from './client';

/**
 * Outbound messaging (§9.2 send logic). Every outbound message is stored in `messages`
 * (direction 'out', template_name, status) and bumps conversations.last_outbound_at.
 */

export interface OutboundMeta {
  /** Stable key for the message purpose (draft, question, ack, …) stored in payload.kind. */
  kind?: string;
  reportId?: string;
  questionId?: string;
}

async function record(
  ctx: Ctx,
  convo: ConversationRow,
  input: {
    type: NonNullable<MessageRow['type']>;
    body: string | null;
    payload: Record<string, unknown>;
    template_name?: string | null;
    waMessageId: string | null;
    error?: string | null;
  },
): Promise<MessageRow> {
  const row = await ctx.db.insertOutboundMessage({
    conversation_id: convo.id,
    type: input.type,
    body: input.body,
    payload: input.payload,
    wa_message_id: input.waMessageId,
    template_name: input.template_name ?? null,
    status: input.error ? 'failed' : 'sent',
    error: input.error ?? null,
  });
  if (!input.error) await ctx.db.updateConversation(convo.id, { last_outbound_at: ctx.now() });
  return row;
}

async function attempt<T>(
  ctx: Ctx,
  convo: ConversationRow,
  fn: () => Promise<T>,
  onError: (message: string) => Promise<void>,
): Promise<T> {
  try {
    return await fn();
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    ctx.log.error('whatsapp send failed', { err, conversation_id: convo.id });
    await onError(message);
    throw err;
  }
}

/** Free-form text (and optional ≤ 3 reply buttons). Use inside the 24 h window (replies). */
export async function sendFreeForm(
  ctx: Ctx,
  convo: ConversationRow,
  text: string,
  buttons?: Button[],
  meta: OutboundMeta = {},
): Promise<MessageRow> {
  const to = convo.phone_e164;
  const payload = { ...meta, text, buttons: buttons ?? [] };
  const type = buttons && buttons.length ? 'interactive' : 'text';
  const res = await attempt(
    ctx,
    convo,
    () =>
      buttons && buttons.length ? ctx.wa.sendButtons(to, text, buttons) : ctx.wa.sendText(to, text),
    (error) =>
      record(ctx, convo, { type, body: text, payload, waMessageId: null, error }).then(
        () => undefined,
      ),
  );
  return record(ctx, convo, { type, body: text, payload, waMessageId: res.waMessageId });
}

/** List message for 4–10 options (§9.4). */
export async function sendListMessage(
  ctx: Ctx,
  convo: ConversationRow,
  body: string,
  options: ListOption[],
  buttonText = 'Choose',
  meta: OutboundMeta = {},
): Promise<MessageRow> {
  const payload = { ...meta, text: body, options };
  const res = await attempt(
    ctx,
    convo,
    () => ctx.wa.sendList(convo.phone_e164, body, options, buttonText),
    (error) =>
      record(ctx, convo, { type: 'interactive', body, payload, waMessageId: null, error }).then(
        () => undefined,
      ),
  );
  return record(ctx, convo, { type: 'interactive', body, payload, waMessageId: res.waMessageId });
}

/** Buttons when ≤ 3, a list message otherwise. */
export async function sendChoice(
  ctx: Ctx,
  convo: ConversationRow,
  body: string,
  options: ListOption[],
  meta: OutboundMeta = {},
): Promise<MessageRow> {
  if (options.length <= 3) {
    return sendFreeForm(
      ctx,
      convo,
      body,
      options.map((o) => ({ id: o.id, title: o.title })),
      meta,
    );
  }
  return sendListMessage(ctx, convo, body, options.slice(0, 10), 'Choose', meta);
}

export async function sendDocumentMessage(
  ctx: Ctx,
  convo: ConversationRow,
  doc: DocumentInput,
  meta: OutboundMeta = {},
): Promise<MessageRow> {
  const payload = { ...meta, filename: doc.filename, caption: doc.caption ?? null };
  const res = await attempt(
    ctx,
    convo,
    () => ctx.wa.sendDocument(convo.phone_e164, doc),
    (error) =>
      record(ctx, convo, {
        type: 'document',
        body: doc.caption ?? doc.filename,
        payload,
        waMessageId: null,
        error,
      }).then(() => undefined),
  );
  return record(ctx, convo, {
    type: 'document',
    body: doc.caption ?? doc.filename,
    payload,
    waMessageId: res.waMessageId,
  });
}

export interface BusinessInitiatedOptions {
  /** Buttons for the free-form variant / payloads for the template quick replies. */
  buttons?: Button[];
  siteDayId?: string;
  meta?: OutboundMeta;
  /** Force the template even inside the window (e.g. the welcome must be the approved template). */
  forceTemplate?: boolean;
}

/**
 * §9.2: inside the 24 h customer-service window a free-form equivalent MAY be sent,
 * otherwise the approved template MUST be used.
 */
export async function sendBusinessInitiated(
  ctx: Ctx,
  convo: ConversationRow,
  templateName: TemplateName,
  vars: string[],
  freeFormText: string | null,
  opts: BusinessInitiatedOptions = {},
): Promise<MessageRow> {
  const mode = opts.forceTemplate ? 'template' : sendMode(convo.last_inbound_at, ctx.now());
  const buttons = opts.buttons ?? templateButtons(templateName, { siteDayId: opts.siteDayId });
  if (mode === 'free_form') {
    const text = freeFormText ?? renderTemplateText(templateName, vars);
    return sendFreeForm(ctx, convo, text, buttons.length ? buttons : undefined, {
      ...opts.meta,
      kind: opts.meta?.kind ?? templateName,
    });
  }
  const template = buildTemplatePayload(templateName, vars, buttons);
  const body = renderTemplateText(templateName, vars);
  // siteDayId: billable templates (reminders) count towards that day's report cost (src/cost.ts).
  const payload = {
    ...opts.meta,
    kind: opts.meta?.kind ?? templateName,
    ...(opts.siteDayId ? { siteDayId: opts.siteDayId } : {}),
    template,
    text: body,
    buttons,
  };
  const res = await attempt(
    ctx,
    convo,
    () => ctx.wa.sendTemplate(convo.phone_e164, template),
    (error) =>
      record(ctx, convo, {
        type: 'template',
        body,
        payload,
        template_name: templateName,
        waMessageId: null,
        error,
      }).then(() => undefined),
  );
  return record(ctx, convo, {
    type: 'template',
    body,
    payload,
    template_name: templateName,
    waMessageId: res.waMessageId,
  });
}
