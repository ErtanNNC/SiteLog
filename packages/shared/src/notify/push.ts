import type { OutboundMessage } from '../channels.ts';

/**
 * Web push (W2-14; spec §4.4, §9.3, §19 Q27): what a notification carries, shared by the worker's
 * transport (`apps/worker/src/push.ts`) and the field app's service worker (`apps/field/src/sw.ts`).
 *
 * The body is the §9.2 text of the key in the reporter's language with the pack's variant, the same
 * text SMS would carry (`renderSms`). Spec §15.2: no personal data in the payload beyond the
 * message text. A tap opens the message's link (`link`, or `pdf_link` for `filed`) in the app.
 */

/** The notification's title: the product name, the same in every language. */
export const PUSH_TITLE = 'SiteLog';

/** The JSON payload a push carries (encrypted to the subscription by the transport). */
export interface PushNotificationData {
  title: string;
  body: string;
  /** The §9.2 key: the notification's tag, so a newer one of the same key replaces it. */
  tag: string;
  /** The language of the body (`en`, `es`, `tr`). */
  lang: string;
  /** What a tap opens: the message's link, or null (the app's start page). */
  url: string | null;
}

/** The link a message carries, if any (`link`, else `pdf_link`). */
export function messageLink(vars: Readonly<Record<string, unknown>>): string | null {
  for (const name of ['link', 'pdf_link']) {
    const value = vars[name];
    if (typeof value === 'string' && /^https?:\/\//.test(value)) return value;
  }
  return null;
}

export function pushPayload(message: OutboundMessage): PushNotificationData {
  return {
    title: PUSH_TITLE,
    body: message.body,
    tag: message.key,
    lang: message.language,
    url: messageLink(message.vars),
  };
}

/**
 * A push payload as the service worker reads it: anything else (a test push from DevTools, a
 * malformed body) becomes a plain notification that opens the app.
 */
export function readPushData(raw: unknown): PushNotificationData {
  const o = (typeof raw === 'object' && raw !== null ? raw : {}) as Record<string, unknown>;
  const str = (v: unknown) => (typeof v === 'string' && v.length > 0 ? v : null);
  const url = str(o.url);
  return {
    title: str(o.title) ?? PUSH_TITLE,
    body: str(o.body) ?? (typeof raw === 'string' ? raw : ''),
    tag: str(o.tag) ?? 'sitelog',
    lang: str(o.lang) ?? 'en',
    url: url && /^https?:\/\//.test(url) ? url : null,
  };
}

/**
 * What a push service's answer means for one subscription (RFC 8030): `sent` (201, or any 2xx);
 * `gone` (404, 410: the subscription expired or was removed: revoke it and fall back, W2-01);
 * `retry` (429, 5xx: later, same channel); `refused` (anything else, e.g. 400 a bad payload, 403 a
 * key pair that does not match the subscription, 413 too large: this subscription cannot carry it).
 */
export type PushResult = 'sent' | 'gone' | 'retry' | 'refused';

export function pushResult(status: number): PushResult {
  if (status >= 200 && status < 300) return 'sent';
  if (status === 404 || status === 410) return 'gone';
  if (status === 429 || status >= 500) return 'retry';
  return 'refused';
}

/**
 * The push services a subscription may name (W2-14 review, spec §19 Q115): the worker posts to the
 * endpoint a browser handed over, so any other host would let a field client point the worker at
 * an address of its choosing. Chrome, Edge on Android, Samsung Internet and Opera use FCM
 * (`fcm.googleapis.com`), Firefox `*.push.services.mozilla.com`, Edge on Windows
 * `*.notify.windows.com`, Safari `web.push.apple.com` (`*.push.apple.com`).
 *
 * The same pattern is the database's check on a live `push_subscriptions` row
 * (20261016000260_push_endpoint_hosts.sql, `~*`): https, one of those hosts, no user info and no
 * port, then a path or nothing.
 */
export const PUSH_ENDPOINT_HOSTS = [
  'fcm.googleapis.com',
  '*.push.services.mozilla.com',
  '*.notify.windows.com',
  'web.push.apple.com',
  '*.push.apple.com',
] as const;

export const PUSH_ENDPOINT_RE =
  /^https:\/\/(fcm\.googleapis\.com|([a-z0-9-]+\.)+push\.services\.mozilla\.com|([a-z0-9-]+\.)+notify\.windows\.com|([a-z0-9-]+\.)+push\.apple\.com)(\/[^\s]*)?$/i;

/** A subscription endpoint on one of the known push services (`PUSH_ENDPOINT_HOSTS`). */
export function isAllowedPushEndpoint(endpoint: string): boolean {
  return endpoint.length <= 2048 && PUSH_ENDPOINT_RE.test(endpoint);
}
