import {
  MessageSendError,
  type NotifyOutcome,
  type Notifier,
  type NotifyRecipient,
  type SmsNotifier,
} from '@sitelog/shared';
import type { SendDailyLink, SendVerifyCode, VerifyCodeMessage } from './app.ts';

/**
 * `device/send-code` (F4 step 2) through the Notifier (spec §4.5; W1-08): `verify_code` follows
 * the person's channel order kept to SMS and WhatsApp (spec §19 Q372: WhatsApp by its
 * authentication template where the pack orders it first and the template is approved here, else
 * SMS, which every order ends with for this key), with or without the channel's consent (the
 * person asks for it; a consent declined at F4 or turned off in Settings does not stop it:
 * `CONSENT_FREE_KEYS`, spec §19 Q25, W2-02) but never after an opt-out (SMS STOP; on WhatsApp a
 * revoked WhatsApp consent, which is what its STOP records), in the reporter's language, through
 * the pack's driver (`pickMessageTransport`: the pack's provider once its sender is set here, else
 * `console`). A WhatsApp refusal for good falls back to SMS (§19 Q22). The Notifier writes the
 * `messages` row and its audit.
 *
 * Demo orgs only get a console code (the Demo phone shows it): `console` on a real org reaches no
 * phone and the stored text would hand the office the reporter's code, so the Notifier answers
 * `no_channel` (409 `code_undeliverable`) and writes nothing (docs/AUDIT_BACKLOG.md). A real
 * provider's text is stored with the code masked. A number the provider cannot reach is
 * `no_channel` too; any other send failure is thrown (500 `internal`, the client may retry).
 */

/**
 * A refusal that is final on the channel that made it (W2-15/16 review): an SMS number the
 * provider cannot reach, or the last channel of the order (WhatsApp on the US order) refusing for
 * good. The Notifier throws it once no channel is left; it is `no_channel`, never a 500. A
 * retryable one (429, 5xx, network) is thrown on.
 */
export function finalRefusal(err: unknown): boolean {
  return err instanceof MessageSendError && !err.retryable && err.undeliverable;
}

/** The Notifier's view of the person a code is for. */
export function recipientOf(message: VerifyCodeMessage): NotifyRecipient {
  return {
    reporter: message.reporter,
    org: { id: message.org.id, isDemo: message.org.is_demo },
    pack: message.pack,
    consents: message.consents,
  };
}

export function notifierCodeSender(notifier: SmsNotifier): SendVerifyCode {
  return async (message): Promise<NotifyOutcome> => {
    try {
      return await notifier.deliver(recipientOf(message), 'verify_code', { code: message.code });
    } catch (err) {
      if (finalRefusal(err)) return { channel: null, reason: 'no_channel' };
      throw err;
    }
  };
}

/**
 * `expired/daily-link` (F16 "Send me today's link"; W2-03) through the Notifier: `daily_link` on
 * the reporter's channel order with its consent and opt-out rules (the Notifier audits a skip),
 * once per dedupe key. A refusal final on the last channel tried (`finalRefusal`: an SMS number
 * the provider cannot reach, a WhatsApp template refused for good) is `no_channel`; any other
 * send failure is thrown (500 `internal`, the button may be tapped again under the same key).
 */
export function notifierDailyLinkSender(notifier: Pick<Notifier, 'send'>): SendDailyLink {
  return async (input): Promise<NotifyOutcome> => {
    try {
      // The key is app.ts's (`expired_daily_link:<link>:<date>`), passed through.
      return await notifier.send(input.reporterId, 'daily_link', input.vars, {
        dedupeKey: input.dedupeKey,
      });
    } catch (err) {
      if (finalRefusal(err)) return { channel: null, reason: 'no_channel' };
      throw err;
    }
  };
}
