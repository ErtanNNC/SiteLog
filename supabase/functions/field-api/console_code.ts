import {
  deliverableChannels,
  languageOf,
  renderSms,
  smsRenderOptions,
  type MessageChannel,
  type NotifyOutcome,
} from '@sitelog/shared';
import { logAudit } from '../_shared/audit.ts';
import type { AppClient } from '../_shared/supabase.ts';
import type { SendVerifyCode, VerifyCodeMessage } from './app.ts';

/**
 * The W1-07 sender of `verify_code`: the decision the Notifier will make (spec §4.5:
 * `deliverableChannels`, so SMS only, and never to a reporter who opted out or, after any consent
 * answer, refused texts), then the `console` transport: a `messages` row (channel 'sms', provider
 * 'console', the §9.2 text in the reporter's language with the pack's variant) that the panel's
 * Demo phone shows, and its audit row. Nothing reaches a real phone: W1-08 replaces this with the
 * Notifier and the pack's driver (`pickMessageTransport`), which sends through Twilio or
 * İletimerkezi once the pack has a sender id in that database.
 *
 * Demo orgs only (`orgs.is_demo`). A console text is a `messages` row that the org's admin, pm and
 * ops read; for a real org it would hand them the reporter's code and never reach the reporter,
 * so an office user could verify a device as the reporter (docs/AUDIT_BACKLOG.md). A real org gets
 * `no_channel` (409 `code_undeliverable`) and no row until W1-08's drivers reach the phone.
 */

/** Whether `verify_code` may go out, and on which channel (always SMS: SMS_ONLY_KEYS). */
export function verifyCodeChannel(message: VerifyCodeMessage): NotifyOutcome | { channel: 'sms' } {
  const optedOut = new Set<MessageChannel>(message.reporter.status === 'opted_out' ? ['sms'] : []);
  const channels = deliverableChannels({
    pack: message.pack,
    key: 'verify_code',
    preferred: message.reporter.message_channel,
    consents: message.consents.held,
    revoked: message.consents.revoked,
    optedOut,
  });
  if (channels.includes('sms')) return { channel: 'sms' };
  return { channel: null, reason: optedOut.size > 0 ? 'opted_out' : 'no_consent' };
}

/** The text of the code in the reporter's language and the pack's variant. */
export function verifyCodeText(message: VerifyCodeMessage): string {
  return renderSms(
    'verify_code',
    languageOf(message.reporter.locale),
    { code: message.code },
    smsRenderOptions(message.pack),
  );
}

export function consoleVerifyCodeSender(admin: AppClient): SendVerifyCode {
  return async (message) => {
    if (!message.org.is_demo) return { channel: null, reason: 'no_channel' };
    const decision = verifyCodeChannel(message);
    if (decision.channel === null) return decision as NotifyOutcome;
    const id = crypto.randomUUID();
    await admin
      .from('messages')
      .insert({
        id,
        org_id: message.reporter.org_id,
        reporter_id: message.reporter.id,
        phone_e164: message.reporter.phone_e164,
        channel: 'sms',
        direction: 'out',
        provider: 'console',
        provider_message_id: `console:${id}`,
        copy_key: 'verify_code',
        body: verifyCodeText(message),
        status: 'sent',
      })
      .throwOnError();
    await logAudit(admin, {
      orgId: message.reporter.org_id,
      actorType: 'system',
      action: 'sms.sent',
      entity: 'message',
      entityId: id,
      diff: { copy_key: 'verify_code', provider: 'console' },
    });
    return { channel: 'sms', messageId: id };
  };
}
