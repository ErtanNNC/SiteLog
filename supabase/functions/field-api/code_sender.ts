import {
  SmsSendError,
  type NotifyOutcome,
  type NotifyRecipient,
  type SmsNotifier,
} from '@sitelog/shared';
import type { SendVerifyCode, VerifyCodeMessage } from './app.ts';

/**
 * `device/send-code` (F4 step 2) through the Notifier (spec §4.5; W1-08): `verify_code` goes by
 * SMS whatever the channel order (SMS_ONLY_KEYS), before any consent answer but never after an
 * opt-out or a refused SMS consent (spec §19 Q25), in the reporter's language, through the pack's
 * driver (`pickMessageTransport`: the pack's provider once its sender id is set here, else
 * `console`). The Notifier writes the `messages` row and its audit.
 *
 * Demo orgs only get a console code (the Demo phone shows it): `console` on a real org reaches no
 * phone and the stored text would hand the office the reporter's code, so the Notifier answers
 * `no_channel` (409 `code_undeliverable`) and writes nothing (docs/AUDIT_BACKLOG.md). A real
 * provider's text is stored with the code masked. A number the provider cannot reach is
 * `no_channel` too; any other send failure is thrown (500 `internal`, the client may retry).
 */

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
      if (err instanceof SmsSendError && err.undeliverable) {
        return { channel: null, reason: 'no_channel' };
      }
      throw err;
    }
  };
}
