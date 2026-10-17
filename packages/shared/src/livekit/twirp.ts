import {
  LIVEKIT_SERVER_TOKEN_TTL_S,
  liveKitHttpOrigin,
  mintLiveKitToken,
  type LiveKitVideoGrant,
} from './token.ts';

/**
 * LiveKit's server API over Twirp (`POST {origin}/twirp/livekit.<Service>/<Method>`, JSON) with
 * short server tokens minted here: no SDK, WebCrypto and `fetch` only, so field-api (Deno, Talk
 * now's room and dispatch, W3-13) and the worker (Node, outbound calls, W3-17) share it.
 *
 * The calls SiteLog makes: `RoomService/CreateRoom`, `AgentDispatchService/CreateDispatch` and,
 * for an outbound call, `SIP/CreateSIPParticipant` on the pack's outbound trunk (§9.4 "How a call
 * starts", §19 Q125, Q126). A refusal throws `LiveKitApiError` with LiveKit's Twirp error code and,
 * for a SIP dial that was not answered, the SIP status (`sip_status_code` in the error's meta).
 */

export interface LiveKitConfig {
  /** The project's WebSocket URL (`LIVEKIT_URL`); the Twirp origin is its http(s) twin. */
  url: string;
  apiKey: string;
  apiSecret: string;
}

/**
 * The LiveKit config from env, or null when any of the three is unset (no LiveKit here). A URL
 * that is not ws(s)/http(s) counts as unset.
 */
export function liveKitConfigFrom(env: (name: string) => string | undefined): LiveKitConfig | null {
  const url = env('LIVEKIT_URL');
  const apiKey = env('LIVEKIT_API_KEY');
  const apiSecret = env('LIVEKIT_API_SECRET');
  if (!url || !apiKey || !apiSecret || !liveKitHttpOrigin(url)) return null;
  return { url, apiKey, apiSecret };
}

export class LiveKitApiError extends Error {
  constructor(
    readonly method: string,
    readonly status: number,
    /** LiveKit's Twirp error code (`not_found`, `unavailable`, …), when the body had one. */
    readonly code: string | null = null,
    /** A SIP dial's final SIP status (`meta.sip_status_code`), when LiveKit gave one. */
    readonly sipStatus: number | null = null,
  ) {
    super(
      `LiveKit ${method}: HTTP ${status}${code ? ` ${code}` : ''}${sipStatus ? ` SIP ${sipStatus}` : ''}`,
    );
    this.name = 'LiveKitApiError';
  }
}

export interface TwirpOptions {
  fetch?: typeof fetch;
  now?: () => Date;
  /** Per request (default 8 s; a SIP dial that waits for the answer passes its ringing time). */
  timeoutMs?: number;
}

export type TwirpCall = (
  service: string,
  method: string,
  body: unknown,
  grants: { video: LiveKitVideoGrant; sip?: { call?: boolean; admin?: boolean } },
  opts?: { timeoutMs?: number },
) => Promise<unknown>;

/** Reads a Twirp error body leniently: `{code, msg, meta: {sip_status_code}}`. */
export function parseTwirpError(text: string): { code: string | null; sipStatus: number | null } {
  try {
    const body = JSON.parse(text) as {
      code?: unknown;
      meta?: Record<string, unknown> | null;
    };
    const code = typeof body.code === 'string' ? body.code : null;
    const raw = body.meta?.sip_status_code ?? body.meta?.['sip_status'];
    const n =
      typeof raw === 'number' ? raw : typeof raw === 'string' ? Number.parseInt(raw, 10) : NaN;
    return { code, sipStatus: Number.isInteger(n) && n >= 100 && n < 700 ? n : null };
  } catch {
    return { code: null, sipStatus: null };
  }
}

/** One Twirp call with a server token of the given grants; answers LiveKit's JSON body. */
export function liveKitTwirp(cfg: LiveKitConfig, opts: TwirpOptions = {}): TwirpCall {
  const origin = liveKitHttpOrigin(cfg.url);
  if (!origin) throw new Error('LIVEKIT_URL is not a ws(s) or http(s) URL');
  const doFetch = opts.fetch ?? fetch;
  const now = opts.now ?? (() => new Date());
  return async (service, method, body, grants, callOpts) => {
    const token = await mintLiveKitToken({
      apiKey: cfg.apiKey,
      apiSecret: cfg.apiSecret,
      video: grants.video,
      ...(grants.sip ? { sip: grants.sip } : {}),
      ttlS: LIVEKIT_SERVER_TOKEN_TTL_S,
      now: now(),
    });
    const res = await doFetch(`${origin}/twirp/livekit.${service}/${method}`, {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(callOpts?.timeoutMs ?? opts.timeoutMs ?? 8000),
    });
    const text = await res.text();
    if (!res.ok) {
      const err = parseTwirpError(text);
      throw new LiveKitApiError(method, res.status, err.code, err.sipStatus);
    }
    try {
      return text ? (JSON.parse(text) as unknown) : {};
    } catch {
      return {};
    }
  };
}

/**
 * `SIP/CreateSIPParticipant`'s body for an outbound call (W3-17): the trunk, the number called,
 * the caller id (the pack's voice number, §19 Q126), the call's room, an identity that is the call
 * id (never the phone number), and `wait_until_answered` so the answer's SIP status comes back.
 */
export function createSipParticipantBody(input: {
  trunkId: string;
  to: string;
  from: string | null;
  room: string;
  callId: string;
  ringTimeoutS: number;
  maxCallS: number;
}): Record<string, unknown> {
  return {
    sip_trunk_id: input.trunkId,
    sip_call_to: input.to,
    ...(input.from ? { sip_number: input.from } : {}),
    room_name: input.room,
    participant_identity: `sip-${input.callId}`,
    participant_name: 'Reporter',
    participant_metadata: JSON.stringify({ callId: input.callId }),
    wait_until_answered: true,
    play_dialtone: false,
    ringing_timeout: `${input.ringTimeoutS}s`,
    max_call_duration: `${input.maxCallS}s`,
  };
}
