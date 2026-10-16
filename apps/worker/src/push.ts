import webpush from 'web-push';
import {
  isAllowedPushEndpoint,
  MessageSendError,
  PUSH_DRIVER,
  pushChannelSpec,
  pushPayload,
  pushResult,
  type ChannelRegistration,
  type MessageTransport,
  type PushSubscriptionRow,
} from '@sitelog/shared';
import type { Config } from './config';
import type { Db } from './db';

/**
 * Web push (W2-14; spec §4.4, §4.5, §5.1, §9.3, §19 Q27): the `push` message channel registered
 * with the worker's Notifier. Standard Web Push with the VAPID key pair from env, no provider.
 *
 * - Keys: `PUSH_KEYS` only (question_ready, draft_ready, filed, the ladder's), in the reporter's
 *   language with the pack's variant: the §9.2 text SMS would carry (`pushPayload`).
 * - Reachable only with a `push` consent (the Notifier's consent check) and a live subscription of
 *   the reporter from a device still signed in (`reachable`), and, for a real org, a key pair in
 *   this environment: without one a real org's push leaves the order, so the next channel (SMS)
 *   carries the message (spec §19 Q84's rule for a channel with no sender here). A demo org always
 *   gets `console` (the Demo phone shows the row; nothing is sent).
 * - The `messages` row has `channel 'push'`, no phone, provider `webpush` or `console`.
 * - Every live subscription of the reporter gets the notification (two phones, two notifications).
 *   The push service's answer per subscription (`pushResult`): 2xx sent; 404 / 410 gone (the row is
 *   revoked `gone`, audited); 429 / 5xx retry; anything else refused. One sent: the message went
 *   out. None sent: a retry when any may pass later (the job retries this channel), otherwise an
 *   `undeliverable` refusal, so the Notifier falls back to the next channel (W2-01, §19 Q22).
 */

/** How long a push service keeps a notification for a phone that is offline (RFC 8030 TTL). */
export const PUSH_TTL_SECONDS = 4 * 60 * 60;

export type VapidConfig = Pick<Config, 'VAPID_PUBLIC_KEY' | 'VAPID_PRIVATE_KEY' | 'VAPID_SUBJECT'>;

/** All three VAPID values set (the key pair and its contact). */
export function vapidConfigured(config: VapidConfig): boolean {
  return (
    config.VAPID_PUBLIC_KEY.trim() !== '' &&
    config.VAPID_PRIVATE_KEY.trim() !== '' &&
    config.VAPID_SUBJECT.trim() !== ''
  );
}

export type PushStore = Pick<Db, 'listLivePushSubscriptions' | 'pushSubscriptionGone'>;
type Subscription = Pick<PushSubscriptionRow, 'id' | 'endpoint' | 'p256dh' | 'auth'>;

export interface PushDeps {
  config: VapidConfig;
  store: PushStore;
  fetch: typeof fetch;
  randomUUID: () => string;
  warn?: (message: string, fields: Record<string, unknown>) => void;
}

/** The `console` push: nothing leaves the worker; the Notifier writes the row (Demo phone). */
export function consolePushTransport(randomUUID: () => string): MessageTransport {
  return {
    channel: 'push',
    driver: 'console',
    send: () => Promise.resolve({ providerId: `console-push-${randomUUID()}` }),
  };
}

/** The real push transport: one encrypted request per live subscription of the reporter. */
export function webPushTransport(deps: PushDeps): MessageTransport {
  const { config } = deps;
  const vapidDetails = {
    subject: config.VAPID_SUBJECT.trim(),
    publicKey: config.VAPID_PUBLIC_KEY.trim(),
    privateKey: config.VAPID_PRIVATE_KEY.trim(),
  };
  // A malformed pair fails here, before a row is queued (the Notifier records a config failure).
  webpush.getVapidHeaders(
    'https://push.example',
    vapidDetails.subject,
    vapidDetails.publicKey,
    vapidDetails.privateKey,
    'aes128gcm',
  );
  const refusal = (message: string, retryable: boolean, code: string | null) =>
    new MessageSendError(message, 'push', {
      driver: PUSH_DRIVER,
      retryable,
      undeliverable: !retryable,
      code,
    });

  async function sendOne(
    sub: Subscription,
    body: string,
  ): Promise<{ status: number; id: string | null }> {
    // Only the known push services (spec §19 Q115; the database's check on a live row): never a
    // request to a host a client chose. Refused without a request.
    if (!isAllowedPushEndpoint(sub.endpoint)) return { status: 0, id: null };
    const request = webpush.generateRequestDetails(
      { endpoint: sub.endpoint, keys: { p256dh: sub.p256dh, auth: sub.auth } },
      body,
      { vapidDetails, TTL: PUSH_TTL_SECONDS, urgency: 'high', contentEncoding: 'aes128gcm' },
    );
    const res = await deps.fetch(request.endpoint, {
      method: request.method,
      headers: Object.fromEntries(
        Object.entries(request.headers).map(([name, value]) => [name, String(value)]),
      ),
      body: request.body ? new Uint8Array(request.body) : null,
      // A push service answers; it never redirects. A 3xx is refused (`pushResult`), never followed
      // to wherever it points.
      redirect: 'manual',
    });
    // The service's id of the message (RFC 8030 §5: the Location of the push message resource).
    return { status: res.status, id: res.headers.get('location') };
  }

  return {
    channel: 'push',
    driver: PUSH_DRIVER,
    async send(message) {
      if (!message.reporterId) throw refusal('push: no reporter', false, null);
      const subs = await deps.store.listLivePushSubscriptions(message.reporterId);
      if (subs.length === 0) throw refusal('push: no live subscription', false, 'no_subscription');
      const body = JSON.stringify(pushPayload(message));
      let sent = false;
      let providerId: string | null = null;
      let retry: string | null = null;
      let last = '';
      for (const sub of subs) {
        let outcome: { status: number; id: string | null };
        try {
          outcome = await sendOne(sub, body);
        } catch (err) {
          // A network failure or a subscription whose keys cannot be used.
          const text = err instanceof Error ? err.message : String(err);
          const network =
            err instanceof TypeError || /fetch|network|ECONN|ETIMEDOUT|abort/i.test(text);
          if (network) retry = text;
          last = text;
          deps.warn?.('push: send failed', { subscription_id: sub.id, error: text.slice(0, 200) });
          continue;
        }
        const result = pushResult(outcome.status);
        if (result === 'sent') {
          sent = true;
          providerId ??= outcome.id;
        } else if (result === 'gone') {
          await deps.store.pushSubscriptionGone(sub.id, outcome.status);
          last = `push: subscription gone (${outcome.status})`;
        } else if (result === 'retry') {
          retry = `push: service answered ${outcome.status}`;
        } else {
          last = `push: service refused (${outcome.status})`;
          deps.warn?.('push: refused', { subscription_id: sub.id, status: outcome.status });
        }
      }
      if (sent) return { providerId: providerId ?? `webpush-${deps.randomUUID()}` };
      if (retry) throw refusal(retry, true, null);
      throw refusal(last || 'push: not delivered', false, 'gone');
    },
  };
}

/**
 * The push channel for the worker's Notifier. `console` for demo orgs (pickMessageTransport) and
 * when no key pair is set; a real org without a key pair is unreachable here (its push leaves the
 * order), so `console_real_org` never applies to push.
 */
export function createPushRegistration(deps: PushDeps): ChannelRegistration {
  const configured = vapidConfigured(deps.config);
  let real: MessageTransport | null = null;
  return {
    spec: pushChannelSpec(configured),
    transport(driver) {
      if (driver === 'console') return consolePushTransport(deps.randomUUID);
      if (driver !== PUSH_DRIVER) throw new Error(`push: unknown driver ${driver}`);
      real ??= webPushTransport(deps);
      return real;
    },
    async reachable(recipient) {
      if (!recipient.org.isDemo && !configured) return false;
      return (await deps.store.listLivePushSubscriptions(recipient.reporter.id)).length > 0;
    },
    // The push text has no SMS limits: the pack's variant, links always allowed.
  };
}
