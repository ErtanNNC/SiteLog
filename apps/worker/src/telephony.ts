import {
  LiveKitApiError,
  OUTBOUND_CALL_POLICY,
  createSipParticipantBody,
  liveKitConfigFrom,
  liveKitTwirp,
  outboundRoomMetadata,
  unansweredStatusOf,
  type LiveKitConfig,
  type TelephonyDriver,
  type UnansweredStatus,
} from '@sitelog/shared';
import type { Config } from './config';

/**
 * How the worker places an outbound call (W3-17; spec §9.4 "How a call starts": "Worker creates
 * the room, dispatches the agent, then dials"; §19 Q125, Q126, Q132). Two drivers:
 *
 * - `livekit`: a real org's call on its pack's outbound trunk. LiveKit's Twirp API (the shared
 *   client, no SDK): `RoomService/CreateRoom` (`call-{callId}`, the call id in its metadata),
 *   `AgentDispatchService/CreateDispatch` (LIVEKIT_AGENT_NAME, which starts the call with
 *   `calls/start {callId}` once the reporter answers and listens for a voicemail greeting first,
 *   F6 step 1), then `SIP/CreateSIPParticipant` with `wait_until_answered`: the answer, or the SIP
 *   status of a dial that never reached the reporter (busy, no answer, failed).
 * - `console`: a demo org's call (§19 Q132): nothing leaves TalkOlog. The call rings in the panel's
 *   Demo phone for CONSOLE_CALL_RING_S, then counts as not answered. Answering it in the browser
 *   (LiveKit, like Talk now) is spec §19 Q215.
 */

export interface DialInput {
  callId: string;
  /** `call-{callId}` (§19 Q157). */
  room: string;
  /** The reporter's number (E.164); it goes to LiveKit only, never into a log line. */
  to: string;
  /** The caller id: the pack's voice number (§19 Q126). */
  from: string | null;
  /** The pack's outbound trunk (§19 Q125); null for `console`. */
  trunkId: string | null;
}

export type DialResult =
  /** The reporter picked up: the agent takes the call from here. */
  | { kind: 'answered' }
  /** The phone is ringing and nothing will say when it stops: settle it after this long. */
  | { kind: 'ringing'; settleAfterS: number }
  /** The dial never reached the reporter. `reason` is audited (no phone number in it). */
  | { kind: 'unanswered'; status: UnansweredStatus; reason: string };

export interface Telephony {
  readonly driver: TelephonyDriver;
  dial(input: DialInput): Promise<DialResult>;
}

/** The drivers this worker has: `console` always, `livekit` with the LIVEKIT_* values. */
export interface TelephonyRegistry {
  get(driver: TelephonyDriver): Telephony | null;
}

/** A demo org's call: it rings the Demo phone and nothing else (§19 Q132). */
export function createConsoleTelephony(ringS: number): Telephony {
  return {
    driver: 'console',
    dial: () => Promise.resolve({ kind: 'ringing', settleAfterS: ringS }),
  };
}

export interface LiveKitTelephonyOptions {
  agentName: string;
  ringTimeoutS: number;
  maxCallS?: number;
  fetch?: typeof fetch;
  now?: () => Date;
}

/** A real org's call on its pack's trunk through LiveKit (Twirp, server tokens, no SDK). */
export function createLiveKitTelephony(
  cfg: LiveKitConfig,
  opts: LiveKitTelephonyOptions,
): Telephony {
  const call = liveKitTwirp(cfg, {
    ...(opts.fetch ? { fetch: opts.fetch } : {}),
    ...(opts.now ? { now: opts.now } : {}),
  });
  const maxCallS = opts.maxCallS ?? OUTBOUND_CALL_POLICY.maxCallS;
  return {
    driver: 'livekit',
    async dial(input) {
      if (!input.trunkId) return { kind: 'unanswered', status: 'failed', reason: 'no_trunk' };
      const metadata = outboundRoomMetadata(input.callId);
      try {
        await call(
          'RoomService',
          'CreateRoom',
          // Long enough for the ring and the agent's join; an unanswered room then closes.
          { name: input.room, metadata, empty_timeout: opts.ringTimeoutS + 60 },
          { video: { roomCreate: true } },
        );
        await call(
          'AgentDispatchService',
          'CreateDispatch',
          { room: input.room, agent_name: opts.agentName, metadata },
          { video: { roomAdmin: true, room: input.room } },
        );
      } catch (err) {
        return { kind: 'unanswered', status: 'failed', reason: liveKitReason(err) };
      }
      try {
        await call(
          'SIP',
          'CreateSIPParticipant',
          createSipParticipantBody({
            trunkId: input.trunkId,
            to: input.to,
            from: input.from,
            room: input.room,
            callId: input.callId,
            ringTimeoutS: opts.ringTimeoutS,
            maxCallS,
          }),
          { video: { roomAdmin: true, room: input.room }, sip: { call: true } },
          // wait_until_answered: the request lasts as long as the phone rings.
          { timeoutMs: (opts.ringTimeoutS + 20) * 1000 },
        );
        return { kind: 'answered' };
      } catch (err) {
        if (err instanceof LiveKitApiError && err.sipStatus !== null) {
          return {
            kind: 'unanswered',
            status: unansweredStatusOf(err.sipStatus),
            reason: `sip_${err.sipStatus}`,
          };
        }
        // A timeout waiting for the answer is a phone nobody picked up.
        if (err instanceof Error && err.name === 'TimeoutError') {
          return { kind: 'unanswered', status: 'no_answer', reason: 'ring_timeout' };
        }
        return { kind: 'unanswered', status: 'failed', reason: liveKitReason(err) };
      }
    },
  };
}

function liveKitReason(err: unknown): string {
  if (err instanceof LiveKitApiError) return `livekit_${err.status}`;
  return 'livekit_unreachable';
}

/** The worker's drivers from its config (`console` always; `livekit` with LiveKit configured). */
export function createTelephony(
  config: Pick<
    Config,
    | 'LIVEKIT_URL'
    | 'LIVEKIT_API_KEY'
    | 'LIVEKIT_API_SECRET'
    | 'LIVEKIT_AGENT_NAME'
    | 'VOICE_RING_TIMEOUT_S'
    | 'CONSOLE_CALL_RING_S'
  >,
  opts: { fetch?: typeof fetch; now?: () => Date } = {},
): TelephonyRegistry {
  const consoleDriver = createConsoleTelephony(config.CONSOLE_CALL_RING_S);
  const cfg = liveKitConfigFrom((name) => {
    const v = (config as Record<string, unknown>)[name];
    return typeof v === 'string' && v ? v : undefined;
  });
  const livekit = cfg
    ? createLiveKitTelephony(cfg, {
        agentName: config.LIVEKIT_AGENT_NAME || 'sitelog-voice',
        ringTimeoutS: config.VOICE_RING_TIMEOUT_S,
        ...opts,
      })
    : null;
  return { get: (driver) => (driver === 'console' ? consoleDriver : livekit) };
}
