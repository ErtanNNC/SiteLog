import { z } from 'zod';
import type { CallStatus } from '../enums.ts';
import { VOICE_ROOM_RE } from '../voice.ts';

/**
 * LiveKit webhooks (W3-04; spec §4.2 `voice-events`, §5.1, §7.3): the signature check, the event
 * shape, and what an event means for a `calls` row. WebCrypto only, so `voice-events` (Deno), the
 * replay script (Node) and the tests share it.
 *
 * LiveKit posts each event as JSON (`Content-Type: application/webhook+json`) with an
 * `Authorization` header holding a JWT signed HS256 with the project's API secret: its `iss` is
 * the API key, and its `sha256` claim is the base64 SHA-256 of the exact body. The token lives a
 * few minutes (`exp`), so a captured request cannot be replayed later; within that window a
 * redelivery carries the same event `id`, and `voice-events` stores each id once.
 *
 * The participant's identity and attributes carry the caller's number (`sip.phoneNumber`): none of
 * it leaves `toVoiceEvent` except the SIP call status and the disconnect reason (§10.12).
 */

/** How long a webhook token may be off the server clock (both ways). */
export const LIVEKIT_WEBHOOK_LEEWAY_S = 60;
/** The lifetime `signLiveKitWebhook` gives a token (LiveKit's own is 5 minutes). */
export const LIVEKIT_WEBHOOK_TTL_S = 300;

export type LiveKitVerifyFailure =
  | 'missing'
  | 'malformed'
  | 'algorithm'
  | 'signature'
  | 'issuer'
  | 'expired'
  | 'not_yet_valid'
  | 'body_hash';

export type LiveKitVerifyResult =
  { ok: true; claims: Record<string, unknown> } | { ok: false; reason: LiveKitVerifyFailure };

const enc = new TextEncoder();

function base64(bytes: Uint8Array): string {
  let binary = '';
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary);
}

function base64url(bytes: Uint8Array): string {
  return base64(bytes).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function fromBase64url(text: string): Uint8Array<ArrayBuffer> | null {
  if (!/^[A-Za-z0-9_-]*$/.test(text)) return null;
  const padded =
    text.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - (text.length % 4)) % 4);
  try {
    const binary = atob(padded);
    const out = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i);
    return out;
  } catch {
    return null;
  }
}

function jsonPart(text: string): Record<string, unknown> | null {
  const bytes = fromBase64url(text);
  if (!bytes) return null;
  try {
    const value = JSON.parse(new TextDecoder().decode(bytes)) as unknown;
    return value && typeof value === 'object' && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

async function hmacKey(secret: string, usage: 'sign' | 'verify'): Promise<CryptoKey> {
  return await crypto.subtle.importKey(
    'raw',
    enc.encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    [usage],
  );
}

/** The `sha256` claim of a body: base64 (standard, padded) of its SHA-256. */
export async function liveKitBodyHash(body: string): Promise<string> {
  return base64(new Uint8Array(await crypto.subtle.digest('SHA-256', enc.encode(body))));
}

/**
 * A webhook token as LiveKit makes one: HS256 over `{iss: apiKey, nbf, exp, sha256}`. For tests
 * and `pnpm replay-webhook` (a local secret); never used with a real secret in a browser.
 */
export async function signLiveKitWebhook(
  body: string,
  opts: { apiKey: string; apiSecret: string; now?: Date; ttlS?: number; sha256?: string },
): Promise<string> {
  const now = Math.floor((opts.now ?? new Date()).getTime() / 1000);
  const header = base64url(enc.encode(JSON.stringify({ alg: 'HS256', typ: 'JWT' })));
  const payload = base64url(
    enc.encode(
      JSON.stringify({
        iss: opts.apiKey,
        nbf: now,
        exp: now + (opts.ttlS ?? LIVEKIT_WEBHOOK_TTL_S),
        sha256: opts.sha256 ?? (await liveKitBodyHash(body)),
      }),
    ),
  );
  const signature = new Uint8Array(
    await crypto.subtle.sign(
      'HMAC',
      await hmacKey(opts.apiSecret, 'sign'),
      enc.encode(`${header}.${payload}`),
    ),
  );
  return `${header}.${payload}.${base64url(signature)}`;
}

/**
 * Checks a webhook's `Authorization` header (the bare token, or `Bearer <token>`) against the
 * exact body: HS256 with the API secret (WebCrypto's constant-time verify), `iss` = the API key,
 * `exp` and `nbf` within `LIVEKIT_WEBHOOK_LEEWAY_S`, and `sha256` = the body's hash.
 */
export async function verifyLiveKitWebhook(
  body: string,
  authorization: string | null,
  opts: { apiKey: string; apiSecret: string; now?: Date; leewayS?: number },
): Promise<LiveKitVerifyResult> {
  const token = authorization
    ?.trim()
    .replace(/^Bearer\s+/i, '')
    .trim();
  if (!token) return { ok: false, reason: 'missing' };
  const parts = token.split('.');
  if (parts.length !== 3) return { ok: false, reason: 'malformed' };
  const [h, p, s] = parts as [string, string, string];
  const header = jsonPart(h);
  const claims = jsonPart(p);
  const signature = fromBase64url(s);
  if (!header || !claims || !signature) return { ok: false, reason: 'malformed' };
  if (header.alg !== 'HS256') return { ok: false, reason: 'algorithm' };
  const valid = await crypto.subtle.verify(
    'HMAC',
    await hmacKey(opts.apiSecret, 'verify'),
    signature,
    enc.encode(`${h}.${p}`),
  );
  if (!valid) return { ok: false, reason: 'signature' };
  if (claims.iss !== opts.apiKey) return { ok: false, reason: 'issuer' };
  const now = Math.floor((opts.now ?? new Date()).getTime() / 1000);
  const leeway = opts.leewayS ?? LIVEKIT_WEBHOOK_LEEWAY_S;
  if (typeof claims.exp !== 'number' || claims.exp + leeway < now) {
    return { ok: false, reason: 'expired' };
  }
  if (typeof claims.nbf === 'number' && claims.nbf - leeway > now) {
    return { ok: false, reason: 'not_yet_valid' };
  }
  if (typeof claims.sha256 !== 'string' || claims.sha256 !== (await liveKitBodyHash(body))) {
    return { ok: false, reason: 'body_hash' };
  }
  return { ok: true, claims };
}

// ───────────────────────────── The event ─────────────────────────────

/** protojson writes int64 as a string and enums by name; older senders write numbers. */
const int64 = z.union([z.string(), z.number()]);
const protoEnum = z.union([z.string(), z.number()]);

/** A LiveKit `WebhookEvent` as JSON (only the fields SiteLog reads; the rest is kept loose). */
export const LiveKitWebhookEventSchema = z
  .object({
    event: z.string().min(1).max(64),
    id: z.string().min(1).max(128),
    createdAt: int64.optional(),
    room: z.looseObject({ name: z.string().max(256), sid: z.string().optional() }).optional(),
    participant: z
      .looseObject({
        sid: z.string().optional(),
        identity: z.string().optional(),
        kind: protoEnum.optional(),
        attributes: z.record(z.string(), z.string()).optional(),
        disconnectReason: protoEnum.optional(),
      })
      .optional(),
  })
  .loose();
export type LiveKitWebhookEvent = z.infer<typeof LiveKitWebhookEventSchema>;

/** The events `voice-events` acts on (`livekit_events.event`); every other one is acknowledged. */
export const VOICE_EVENT_NAMES = [
  'room_started',
  'participant_joined',
  'track_published',
  'participant_left',
  'room_finished',
] as const;
export type VoiceEventName = (typeof VOICE_EVENT_NAMES)[number];

/** ParticipantInfo.Kind: 3 is SIP (protojson: "SIP"). */
function isSip(kind: string | number | undefined): boolean {
  return kind === 'SIP' || kind === 3;
}

function participantKind(kind: string | number | undefined): 'sip' | 'agent' | 'standard' {
  if (isSip(kind)) return 'sip';
  if (kind === 'AGENT' || kind === 4) return 'agent';
  return 'standard';
}

/** DisconnectReason by name (protojson) or number (11, 12, 13). */
const DISCONNECT_REASONS: Record<number, string> = {
  11: 'USER_UNAVAILABLE',
  12: 'USER_REJECTED',
  13: 'SIP_TRUNK_FAILURE',
};

function disconnectReason(value: string | number | undefined): string | null {
  if (value === undefined) return null;
  if (typeof value === 'number') return DISCONNECT_REASONS[value] ?? String(value);
  return value;
}

/**
 * The line status a SIP participant's event says (§4.2 "SIP status for outbound calls"; LiveKit's
 * `sip.callStatus` attribute and the participant's disconnect reason):
 *
 * - joined while `dialing`, `ringing` or `call_incoming` → `ringing`; joined `active` or
 *   `automation`, or its audio track published (media flows once the callee answered) →
 *   `in_progress`;
 * - left with `USER_UNAVAILABLE` → `no_answer`, `USER_REJECTED` → `busy`, `SIP_TRUNK_FAILURE` →
 *   `failed`; any other leave is a hang-up, `completed` (the database makes it `failed` for a call
 *   nobody answered).
 *
 * Other participants (the agent, a Talk now browser) change no status: the agent's own requests
 * do (`voice_call_start`, `end_call`), and `room_finished` is the backstop.
 */
export function sipCallStatus(
  event: VoiceEventName,
  participant: LiveKitWebhookEvent['participant'],
): CallStatus | null {
  if (!participant || !isSip(participant.kind)) return null;
  const sip = participant.attributes?.['sip.callStatus'] ?? null;
  if (event === 'participant_joined') {
    if (sip === 'dialing' || sip === 'ringing' || sip === 'call_incoming') return 'ringing';
    if (sip === 'active' || sip === 'automation') return 'in_progress';
    return null;
  }
  if (event === 'track_published') return sip === 'hangup' ? null : 'in_progress';
  if (event === 'participant_left') {
    const reason = disconnectReason(participant.disconnectReason);
    if (reason === 'USER_UNAVAILABLE') return 'no_answer';
    if (reason === 'USER_REJECTED') return 'busy';
    if (reason === 'SIP_TRUNK_FAILURE') return 'failed';
    return 'completed';
  }
  return null;
}

/** What `voice_call_event()` is given: no identity, no number, no attribute but the SIP status. */
export interface VoiceEvent {
  eventId: string;
  event: VoiceEventName;
  room: string;
  /** The event's time (`createdAt`, unix seconds), else the receipt time. */
  at: string;
  status: CallStatus | null;
  detail: {
    participant?: 'sip' | 'agent' | 'standard';
    sipCallStatus?: string;
    disconnectReason?: string;
  };
}

/**
 * A webhook event as `voice-events` handles it, or null when there is nothing to do: an event it
 * does not act on, or a room that is not a call's (`call-{uuid}`).
 */
export function toVoiceEvent(raw: LiveKitWebhookEvent, receivedAt: Date): VoiceEvent | null {
  if (!(VOICE_EVENT_NAMES as readonly string[]).includes(raw.event)) return null;
  const event = raw.event as VoiceEventName;
  const room = raw.room?.name;
  if (!room || !VOICE_ROOM_RE.test(room)) return null;
  const seconds = raw.createdAt === undefined ? NaN : Number(raw.createdAt);
  const at = Number.isFinite(seconds) && seconds > 0 ? new Date(seconds * 1000) : receivedAt;
  const p = event === 'room_started' || event === 'room_finished' ? undefined : raw.participant;
  const detail: VoiceEvent['detail'] = {};
  if (p) {
    detail.participant = participantKind(p.kind);
    const sip = p.attributes?.['sip.callStatus'];
    if (detail.participant === 'sip' && sip && /^[a-z_]{1,32}$/.test(sip)) {
      detail.sipCallStatus = sip;
    }
    const reason = disconnectReason(p.disconnectReason);
    if (event === 'participant_left' && reason && /^[A-Z_0-9]{1,40}$/.test(reason)) {
      detail.disconnectReason = reason;
    }
  }
  return {
    eventId: raw.id,
    event,
    room,
    at: at.toISOString(),
    status: sipCallStatus(event, p),
    detail,
  };
}

/** What `voice_call_event()` answers. */
export interface VoiceEventResult {
  /** The event id was stored before: nothing ran again. */
  duplicate: boolean;
  /** The call the room is, or null (no row: an inbound call whose agent never started). */
  callId: string | null;
  /** The status or the answer time changed (audited `call.updated`). */
  changed: boolean;
  /** `room_finished` ended a call the agent never ended (audited `call.ended`, the backstop). */
  ended: boolean;
  outcome: string | null;
  /** The call's `post_call_reconcile` job (`post_call:<call>`), when the backstop ended it. */
  jobId: number | null;
}
