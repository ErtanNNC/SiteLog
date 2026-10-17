/**
 * LiveKit access tokens (W3-13; spec §9.4 "How a call starts", Appendix B `POST /field/voice/token`):
 * HS256 JWTs signed with the project's API secret, `iss` the API key, `sub` the identity, and a
 * `video` grant. WebCrypto only (no SDK), so field-api (Deno) and the tests (Node) share it. The
 * secret never leaves the server: the browser gets only the participant token for its own room.
 *
 * Two kinds are minted:
 * - the participant token of Talk now's browser: `roomJoin` to its one room, publish (the
 *   microphone) and subscribe (the agent), identity the call id (never a phone number);
 * - field-api's own short server tokens for LiveKit's Twirp API: `roomCreate` (RoomService
 *   CreateRoom) and `roomAdmin` of one room (AgentDispatchService CreateDispatch).
 */

/** The `video` grant of a LiveKit token (only the fields SiteLog uses). */
export interface LiveKitVideoGrant {
  roomCreate?: boolean;
  roomJoin?: boolean;
  roomAdmin?: boolean;
  room?: string;
  canPublish?: boolean;
  canSubscribe?: boolean;
  canPublishData?: boolean;
  canPublishSources?: string[];
}

export interface LiveKitTokenOptions {
  apiKey: string;
  apiSecret: string;
  /** `sub`: the participant identity (Talk now: the call id). Server tokens use none. */
  identity?: string;
  /** The participant's display name (Talk now: none; the agent sees the call id only). */
  name?: string;
  metadata?: string;
  video: LiveKitVideoGrant;
  /**
   * The `sip` grant (W3-17): `call` lets a server token place an outbound SIP call
   * (SIP.CreateSIPParticipant). Only the worker's server tokens carry it.
   */
  sip?: { call?: boolean; admin?: boolean };
  /** Lifetime in seconds. */
  ttlS: number;
  now?: Date;
}

/** Talk now's participant token lives this long: enough to join; LiveKit refreshes it in the room. */
export const TALK_NOW_TOKEN_TTL_S = 10 * 60;
/** field-api's server tokens for one Twirp call. */
export const LIVEKIT_SERVER_TOKEN_TTL_S = 60;

const enc = new TextEncoder();

function base64url(bytes: Uint8Array): string {
  let binary = '';
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/** A LiveKit access token (HS256 over `{iss, sub?, nbf, exp, jti?, name?, metadata?, video}`). */
export async function mintLiveKitToken(opts: LiveKitTokenOptions): Promise<string> {
  if (!opts.apiKey || !opts.apiSecret) throw new Error('LiveKit API key and secret are required');
  const now = Math.floor((opts.now ?? new Date()).getTime() / 1000);
  const claims: Record<string, unknown> = {
    iss: opts.apiKey,
    nbf: now,
    exp: now + opts.ttlS,
    video: opts.video,
  };
  if (opts.sip) claims.sip = opts.sip;
  if (opts.identity) {
    claims.sub = opts.identity;
    claims.jti = opts.identity;
  }
  if (opts.name) claims.name = opts.name;
  if (opts.metadata) claims.metadata = opts.metadata;
  const header = base64url(enc.encode(JSON.stringify({ alg: 'HS256', typ: 'JWT' })));
  const payload = base64url(enc.encode(JSON.stringify(claims)));
  const key = await crypto.subtle.importKey(
    'raw',
    enc.encode(opts.apiSecret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const signature = new Uint8Array(
    await crypto.subtle.sign('HMAC', key, enc.encode(`${header}.${payload}`)),
  );
  return `${header}.${payload}.${base64url(signature)}`;
}

/** Talk now's participant token: join its room, publish the microphone, hear the agent. */
export function talkNowParticipantToken(opts: {
  apiKey: string;
  apiSecret: string;
  room: string;
  callId: string;
  now?: Date;
}): Promise<string> {
  return mintLiveKitToken({
    apiKey: opts.apiKey,
    apiSecret: opts.apiSecret,
    identity: opts.callId,
    video: {
      roomJoin: true,
      room: opts.room,
      canPublish: true,
      canSubscribe: true,
      canPublishData: false,
      canPublishSources: ['microphone'],
    },
    ttlS: TALK_NOW_TOKEN_TTL_S,
    ...(opts.now ? { now: opts.now } : {}),
  });
}

/**
 * LiveKit's HTTP(S) origin for the Twirp API from `LIVEKIT_URL` (`wss://x.livekit.cloud` →
 * `https://x.livekit.cloud`); null when it is not a ws/wss/http/https URL.
 */
export function liveKitHttpOrigin(url: string): string | null {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }
  const scheme = { 'wss:': 'https:', 'https:': 'https:', 'ws:': 'http:', 'http:': 'http:' }[
    parsed.protocol
  ];
  if (!scheme) return null;
  return `${scheme}//${parsed.host}${parsed.pathname.replace(/\/+$/, '')}`;
}
