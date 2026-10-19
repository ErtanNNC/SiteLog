import type { MsgStatus } from '../enums.ts';
import { isE164, type E164 } from '../format.ts';

/**
 * Twilio webhooks (spec §4.4, §9.1; W1-08): the `X-Twilio-Signature` check, and the form fields
 * of an inbound SMS and of a delivery-status callback. WebCrypto only, so sms-webhook (Deno), the
 * replay script (Node) and the tests share it.
 */

type FormParams = URLSearchParams | Iterable<[string, string]> | Record<string, string>;

function entries(params: FormParams): Array<[string, string]> {
  if (params instanceof URLSearchParams) {
    const out: Array<[string, string]> = [];
    params.forEach((value, name) => out.push([name, value]));
    return out;
  }
  if (Symbol.iterator in Object(params)) return [...(params as Iterable<[string, string]>)];
  return Object.entries(params as Record<string, string>);
}

/**
 * The string Twilio signs: the full URL it requested (scheme, host, path, query), then every POST
 * parameter, sorted by name, as name + value with no separator (a repeated name: each value, in
 * value order).
 */
export function twilioSignedPayload(url: string, params: FormParams): string {
  const byName = new Map<string, string[]>();
  for (const [name, value] of entries(params)) {
    const list = byName.get(name) ?? [];
    list.push(value);
    byName.set(name, list);
  }
  const names = [...byName.keys()].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  let out = url;
  for (const name of names) {
    for (const value of [...byName.get(name)!].sort()) out += name + value;
  }
  return out;
}

/** `X-Twilio-Signature`: base64 of HMAC-SHA1 over `twilioSignedPayload`, keyed by the auth token. */
export async function twilioSignature(
  url: string,
  params: FormParams,
  authToken: string,
): Promise<string> {
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey(
    'raw',
    enc.encode(authToken),
    { name: 'HMAC', hash: 'SHA-1' },
    false,
    ['sign'],
  );
  const sig = new Uint8Array(
    await crypto.subtle.sign('HMAC', key, enc.encode(twilioSignedPayload(url, params))),
  );
  let binary = '';
  for (const b of sig) binary += String.fromCharCode(b);
  return btoa(binary);
}

/**
 * Whether `header` signs these parameters for one of the URLs Twilio may have used. A request is
 * signed for the public URL configured at Twilio, which an edge function cannot always see
 * (`req.url` may name an internal host), so callers pass the configured URL and `req.url`; a port
 * that is the scheme's default is also tried without it, and the other way round, as Twilio's own
 * libraries do. Constant-time comparison; an empty token or header never passes.
 */
export async function verifyTwilioSignature(
  urls: readonly string[],
  params: FormParams,
  header: string | null | undefined,
  authToken: string,
): Promise<boolean> {
  if (!header || !authToken) return false;
  const list = entries(params);
  for (const url of new Set(urls.flatMap(urlVariants))) {
    if (timingSafeEqual(await twilioSignature(url, list, authToken), header.trim())) return true;
  }
  return false;
}

function urlVariants(url: string): string[] {
  try {
    const u = new URL(url);
    const defaultPort = u.protocol === 'https:' ? '443' : u.protocol === 'http:' ? '80' : '';
    if (u.port) return [url];
    const withPort = `${u.protocol}//${u.username ? `${u.username}:${u.password}@` : ''}${u.hostname}:${defaultPort}${u.pathname}${u.search}`;
    return defaultPort ? [url, withPort] : [url];
  } catch {
    return [url];
  }
}

function timingSafeEqual(a: string, b: string): boolean {
  const enc = new TextEncoder();
  const ab = enc.encode(a);
  const bb = enc.encode(b);
  if (ab.length !== bb.length) return false;
  let diff = 0;
  for (let i = 0; i < ab.length; i++) diff |= ab[i]! ^ bb[i]!;
  return diff === 0;
}

/** An inbound SMS as Twilio posts it to the messaging webhook. */
export interface TwilioInboundSms {
  messageSid: string;
  from: E164;
  /** The receiving sender id: the pack's `sms_sender_id` (F13). */
  to: string;
  body: string;
  /** Twilio's Advanced Opt-Out classification (STOP, START, HELP), when it handled a keyword. */
  optOutType: string | null;
  numMedia: number;
}

/**
 * The fields of an inbound SMS, or null when they are not one (no SID, a sender that is not an
 * E.164 number, e.g. a `whatsapp:` address, which is week 2's).
 */
export function parseTwilioInbound(params: URLSearchParams): TwilioInboundSms | null {
  const messageSid = params.get('MessageSid') ?? params.get('SmsSid');
  const from = params.get('From')?.trim() ?? '';
  const to = params.get('To')?.trim() ?? '';
  if (!messageSid || !isE164(from) || !to || to.includes(':')) return null;
  const numMedia = Number.parseInt(params.get('NumMedia') ?? '0', 10);
  return {
    messageSid,
    from,
    to,
    body: params.get('Body') ?? '',
    optOutType: params.get('OptOutType')?.trim().toUpperCase() || null,
    numMedia: Number.isFinite(numMedia) ? numMedia : 0,
  };
}

/** A medium sent with an inbound WhatsApp message (Twilio keeps it at `url`, behind the account). */
export interface TwilioInboundMedia {
  url: string;
  contentType: string | null;
}

/** An inbound WhatsApp message as Twilio posts it (W2-16): `whatsapp:` addresses. */
export interface TwilioInboundWhatsapp {
  messageSid: string;
  /** The person's number, without `whatsapp:`. */
  from: E164;
  /** The receiving sender, without `whatsapp:`: the pack's `whatsapp_sender_id`. */
  to: E164;
  body: string;
  numMedia: number;
  media: TwilioInboundMedia[];
}

/** Whether the form is a WhatsApp message (`From` is a `whatsapp:` address). */
export function isTwilioWhatsappForm(params: URLSearchParams): boolean {
  return (params.get('From') ?? '').trim().startsWith('whatsapp:');
}

/**
 * The fields of an inbound WhatsApp message, or null when they are not one. Its media (voice
 * notes, photos; spec §19 Q85) are listed by URL and type; the sender's WhatsApp profile name is
 * never read (no personal data TalkOlog does not need).
 */
export function parseTwilioWhatsappInbound(params: URLSearchParams): TwilioInboundWhatsapp | null {
  const messageSid = params.get('MessageSid') ?? params.get('SmsSid');
  const from = /^whatsapp:(\+[1-9]\d{6,14})$/.exec(params.get('From')?.trim() ?? '')?.[1];
  const to = /^whatsapp:(\+[1-9]\d{6,14})$/.exec(params.get('To')?.trim() ?? '')?.[1];
  if (!messageSid || !from || !to) return null;
  const parsed = Number.parseInt(params.get('NumMedia') ?? '0', 10);
  const numMedia = Number.isFinite(parsed) && parsed > 0 ? Math.min(parsed, 10) : 0;
  const media: TwilioInboundMedia[] = [];
  for (let i = 0; i < numMedia; i++) {
    const url = params.get(`MediaUrl${i}`)?.trim();
    if (url && /^https:\/\//.test(url))
      media.push({ url, contentType: params.get(`MediaContentType${i}`)?.trim() || null });
  }
  return {
    messageSid,
    from: from as E164,
    to: to as E164,
    body: params.get('Body') ?? '',
    numMedia,
    media,
  };
}

/** A delivery-status callback (`StatusCallback` of a message TalkOlog sent). */
export interface TwilioStatusCallback {
  messageSid: string;
  status: string;
  errorCode: string | null;
}

export function parseTwilioStatus(params: URLSearchParams): TwilioStatusCallback | null {
  const messageSid = params.get('MessageSid') ?? params.get('SmsSid');
  const status = (params.get('MessageStatus') ?? params.get('SmsStatus'))?.trim().toLowerCase();
  if (!messageSid || !status) return null;
  return { messageSid, status, errorCode: params.get('ErrorCode')?.trim() || null };
}

/**
 * A Twilio message status as `messages.status` (§6.2 `msg_status`), or null for the steps before
 * the carrier (`accepted`, `scheduled`, `queued`, `sending`), which change nothing.
 */
export function msgStatusFromTwilio(status: string): MsgStatus | null {
  switch (status) {
    case 'sent':
      return 'sent';
    case 'delivered':
      return 'delivered';
    case 'read':
      return 'read';
    case 'undelivered':
      return 'undeliverable';
    case 'failed':
    case 'canceled':
      return 'failed';
    default:
      return null;
  }
}

const RANK: Partial<Record<MsgStatus, number>> = { queued: 0, sent: 1, delivered: 2, read: 3 };

/**
 * The status a message moves to when a callback reports `incoming`, or null to leave it: callbacks
 * can arrive out of order, so a message never moves back (`sent` after `delivered`), and a failure
 * does not overwrite a delivery the carrier already confirmed.
 */
export function nextMessageStatus(current: MsgStatus, incoming: MsgStatus): MsgStatus | null {
  if (current === incoming) return null;
  const from = RANK[current];
  const to = RANK[incoming];
  if (to !== undefined) return from === undefined || to > from ? incoming : null;
  // A failure: only before the carrier confirmed delivery.
  if (current === 'delivered' || current === 'read') return null;
  if (current === 'failed' || current === 'undeliverable') return null;
  return incoming;
}

/** An empty TwiML answer: Twilio sends nothing back; replies go through the driver. */
export const EMPTY_TWIML = '<?xml version="1.0" encoding="UTF-8"?><Response></Response>';
