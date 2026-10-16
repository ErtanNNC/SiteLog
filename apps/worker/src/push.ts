import webpush from 'web-push';
import {
  isAllowedPushEndpoint,
  JOB_MAX_ATTEMPTS,
  MessageSendError,
  PUSH_DRIVER,
  pushChannelSpec,
  pushPayload,
  pushResult,
  type ChannelRegistration,
  type MessageTransport,
  type PushSubscriptionRow,
} from '@sitelog/shared';
import { currentAttempt, currentSignal } from './abort';
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
 *   The requests go out in parallel, each with its own timeout (`PUSH_REQUEST_TIMEOUT_MS`) as well
 *   as the job's signal, never following a redirect. The push service's answer per subscription
 *   (`pushResult`): 2xx sent; 404, 410, a 400 or 403 whose body names the subscription (another
 *   VAPID key, a bad device token), or keys web-push cannot use gone (the row is revoked `gone`,
 *   audited, so it is never tried again); 429 / 5xx, a network failure or a timeout retry;
 *   anything else refused, a bare 400 or 403 included (it may be SiteLog's VAPID JWT: one
 *   configuration error must not revoke every subscription). One sent: the message went out.
 *   None sent: a retry when any may pass later (the job retries this channel) until the
 *   message's `PUSH_MAX_ATTEMPTS`th push try (the row's send count) or the job's last run,
 *   otherwise an `undeliverable` refusal, so the Notifier falls back to the next channel once
 *   (W2-01, §19 Q22).
 */

/** How long a push service keeps a notification for a phone that is offline (RFC 8030 TTL). */
export const PUSH_TTL_SECONDS = 4 * 60 * 60;

/** How long one request to a push service may take (combined with the job's own signal). */
export const PUSH_REQUEST_TIMEOUT_MS = 10_000;

/**
 * How many push tries one message gets (a 429, a 5xx, a network failure or a timeout on every
 * phone; counted on its `messages` row, not by the job's attempt) before push counts as
 * undeliverable and the Notifier texts instead: the job's backoff makes that about two and a half
 * minutes (30 s, then 2 min).
 */
export const PUSH_MAX_ATTEMPTS = 3;

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
  /** The running job's attempt (default: the runner's, `currentAttempt`). */
  attempt?: () => number | undefined;
  /** Per-request timeout (default `PUSH_REQUEST_TIMEOUT_MS`). */
  timeoutMs?: number;
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
export function webPushTransport(input: PushDeps): MessageTransport {
  const deps = { ...input, attempt: input.attempt ?? currentAttempt };
  const { config } = deps;
  const timeoutMs = input.timeoutMs ?? PUSH_REQUEST_TIMEOUT_MS;
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
  ): Promise<{ status: number; id: string | null; reason: string }> {
    // Only the known push services (spec §19 Q115; the database's check on a live row): never a
    // request to a host a client chose. Refused without a request.
    if (!isAllowedPushEndpoint(sub.endpoint)) return { status: 0, id: null, reason: '' };
    let request: ReturnType<typeof webpush.generateRequestDetails>;
    try {
      request = webpush.generateRequestDetails(
        { endpoint: sub.endpoint, keys: { p256dh: sub.p256dh, auth: sub.auth } },
        body,
        { vapidDetails, TTL: PUSH_TTL_SECONDS, urgency: 'high', contentEncoding: 'aes128gcm' },
      );
    } catch (err) {
      // The subscription's keys cannot be used (web-push checks p256dh and auth): never will.
      throw new PushKeyError(err instanceof Error ? err.message : String(err));
    }
    const res = await deps.fetch(request.endpoint, {
      method: request.method,
      headers: Object.fromEntries(
        Object.entries(request.headers).map(([name, value]) => [name, String(value)]),
      ),
      body: request.body ? new Uint8Array(request.body) : null,
      // A push service answers; it never redirects. A 3xx is refused (`pushResult`), never followed
      // to wherever it points.
      redirect: 'manual',
      // Each request its own limit; the job's signal still aborts it (`abortableFetch`).
      signal: AbortSignal.timeout(timeoutMs),
    });
    // A 400 or 403 is the subscription's only when its body says so (`pushResult`): read a little.
    const reason =
      res.status === 400 || res.status === 403
        ? (await res.text().catch(() => '')).slice(0, 500)
        : '';
    // The service's id of the message (RFC 8030 §5: the Location of the push message resource).
    return { status: res.status, id: res.headers.get('location'), reason };
  }

  /** One subscription's outcome: sent (with the service's id), retry later, or not this one. */
  type Outcome =
    | { kind: 'sent'; id: string | null }
    | { kind: 'retry'; error: string }
    | { kind: 'failed'; error: string };

  async function deliver(sub: Subscription, body: string): Promise<Outcome> {
    let outcome: { status: number; id: string | null; reason: string };
    try {
      outcome = await sendOne(sub, body);
    } catch (err) {
      const text = err instanceof Error ? err.message : String(err);
      if (err instanceof PushKeyError) {
        // Revoked as a gone one (status 0: no request was made), so it is not tried again.
        await deps.store.pushSubscriptionGone(sub.id, 0);
        deps.warn?.('push: subscription keys unusable', { subscription_id: sub.id });
        return {
          kind: 'failed',
          error: `push: subscription keys unusable (${text.slice(0, 120)})`,
        };
      }
      // A network failure or a timeout may pass later; anything else is refused this time.
      const network =
        err instanceof TypeError ||
        (err instanceof Error && (err.name === 'TimeoutError' || err.name === 'AbortError')) ||
        /fetch|network|ECONN|ETIMEDOUT|abort|timeout/i.test(text);
      deps.warn?.('push: send failed', { subscription_id: sub.id, error: text.slice(0, 200) });
      if (network) return { kind: 'retry', error: text };
      return { kind: 'failed', error: text };
    }
    const result = pushResult(outcome.status, outcome.reason);
    if (result === 'sent') return { kind: 'sent', id: outcome.id };
    if (result === 'retry') {
      return { kind: 'retry', error: `push: service answered ${outcome.status}` };
    }
    if (result === 'gone') {
      await deps.store.pushSubscriptionGone(sub.id, outcome.status);
      return { kind: 'failed', error: `push: subscription gone (${outcome.status})` };
    }
    deps.warn?.('push: refused', { subscription_id: sub.id, status: outcome.status });
    return { kind: 'failed', error: `push: service refused (${outcome.status})` };
  }

  return {
    channel: 'push',
    driver: PUSH_DRIVER,
    async send(message, opts) {
      if (!message.reporterId) throw refusal('push: no reporter', false, null);
      const subs = await deps.store.listLivePushSubscriptions(message.reporterId);
      if (subs.length === 0) throw refusal('push: no live subscription', false, 'no_subscription');
      const body = JSON.stringify(pushPayload(message));
      // Every phone at once: one slow push service never holds up another.
      const settled = await Promise.allSettled(subs.map((sub) => deliver(sub, body)));
      const outcomes = settled.map((r): Outcome =>
        r.status === 'fulfilled' ? r.value : { kind: 'retry', error: errorText(r.reason) },
      );
      // The job itself was aborted (its timeout): that is the job's failure, not the channel's.
      const jobSignal = currentSignal();
      if (jobSignal?.aborted) throw jobSignal.reason;
      const sent = outcomes.find((o) => o.kind === 'sent');
      if (sent) return { providerId: sent.id ?? `webpush-${deps.randomUUID()}` };
      const retry = outcomes.find((o) => o.kind === 'retry');
      if (retry) {
        // Bounded: after PUSH_MAX_ATTEMPTS push tries of this message (the row's send count,
        // `opts.tries`, kept by the Notifier; the job's attempt when there is none), or on the
        // job's last run, push gives up for this message, so the Notifier falls back to the next
        // channel (SMS) once, instead of retrying push for the job's whole life and never
        // texting. A job run that failed before reaching push is not a push try (W2-15/16 review).
        const attempt = deps.attempt();
        const tries = opts.tries ?? attempt;
        const lastRun = attempt !== undefined && attempt >= JOB_MAX_ATTEMPTS;
        if ((tries !== undefined && tries >= PUSH_MAX_ATTEMPTS) || lastRun) {
          throw refusal(
            `${retry.error} (push try ${tries ?? '?'}${lastRun ? ', the job’s last run' : ''}: giving up)`,
            false,
            'retries_exhausted',
          );
        }
        throw refusal(retry.error, true, null);
      }
      const last = outcomes.at(-1);
      throw refusal(last && 'error' in last ? last.error : 'push: not delivered', false, 'gone');
    },
  };
}

/** web-push refused the subscription's keys before any request. */
class PushKeyError extends Error {
  override name = 'PushKeyError';
}

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
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
