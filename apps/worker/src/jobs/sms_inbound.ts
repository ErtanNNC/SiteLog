import { randomUUID } from 'node:crypto';
import { assertE164, processInboundSms, toCountryPack } from '@sitelog/shared';
import { workerInboundStore } from '../messaging';
import { PermanentJobError, type JobHandler } from './types';

/**
 * §9.5 `sms_inbound(messageId)` (W1-08): a Twilio text sms-webhook stored (`messages`, channel
 * sms, direction in) and handed over, so the keywords (STOP, START, HELP, CALL, TEXT), the F13
 * unknown contact, the office notice of an opt-out and the one reply run here, durably, whatever
 * Twilio's retry policy does with the webhook. The row's `payload` names the pack (the sender id
 * that received the text) and Twilio's `OptOutType`; `payload.handled_at` marks a text handled to
 * the end, so a second run (a redelivery, a retry after a crash) is a no-op. Real orgs only: a
 * demo org is reached through the Demo phone, which sms-webhook handles inline.
 */
export const smsInbound: JobHandler<'sms_inbound'> = async (ctx, payload) => {
  const message = await ctx.db.getMessage(payload.messageId);
  if (!message) throw new PermanentJobError(`message ${payload.messageId} not found`);
  if (message.channel !== 'sms' || message.direction !== 'in' || !message.phone_e164) {
    throw new PermanentJobError(`message ${message.id} is not an inbound SMS`);
  }
  if (message.provider !== 'twilio') {
    throw new PermanentJobError(`message ${message.id} (${message.provider}) is handled inline`);
  }
  const meta = (message.payload ?? {}) as {
    handled_at?: string;
    pack?: string;
    opt_out_type?: string | null;
  };
  if (meta.handled_at) {
    ctx.log.info('inbound sms already handled', { message_id: message.id, at: meta.handled_at });
    return;
  }
  const packRow = meta.pack ? await ctx.db.getCountry(meta.pack) : null;
  if (!packRow) throw new PermanentJobError(`message ${message.id} names no country pack`);
  // Configuration, not data, and only the HELP reply's link needs it, so a STOP is never held
  // up by it: retried with backoff, then dead and in Sentry.
  const required = (name: 'LINK_SIGNING_SECRET' | 'FIELD_APP_URL') => () => {
    const value = ctx.config[name];
    if (!value) throw new Error(`${name} is not set`);
    return value;
  };

  const result = await processInboundSms(
    {
      store: workerInboundStore(ctx.db),
      notifier: ctx.notifier,
      linkSecret: required('LINK_SIGNING_SECRET'),
      fieldAppUrl: required('FIELD_APP_URL'),
      now: ctx.now,
      randomUUID,
    },
    {
      text: {
        messageId: message.id,
        from: assertE164(message.phone_e164),
        body: message.body ?? '',
        optOutType: meta.opt_out_type ?? null,
      },
      pack: toCountryPack(packRow),
      scope: { realOnly: true },
      applyPhoneOptOut: true,
    },
  );
  ctx.log.info('inbound sms handled', {
    message_id: message.id,
    keyword: result.keyword,
    changes: result.changes.length,
    unknown: result.unknownContact,
    reply: result.replyId !== null,
    pack: packRow.code,
  });
};
