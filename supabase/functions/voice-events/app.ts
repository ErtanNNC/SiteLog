import {
  LiveKitWebhookEventSchema,
  toVoiceEvent,
  verifyLiveKitWebhook,
  type VoiceEventResult,
} from '@sitelog/shared';
import { error, HttpError, json, requireMethod, withHandler } from '../_shared/http.ts';
import { logInfo, logWarn } from '../_shared/log.ts';
import type { VoiceEventsStore } from './store.ts';

/**
 * voice-events (W3-04; spec §4.2, §5.1, §7.3; verify_jwt = false): LiveKit's webhooks for the
 * call rooms, keyed by their name when it is `call-{uuid}` (Talk now, outbound) and else by their
 * sid (`RM_…`: an inbound phone call's room, named by the SIP dispatch rule with the caller's
 * number in it; §19 Q227). That name is dropped by `toVoiceEvent` and never stored or logged.
 *
 *   POST /voice-events   LiveKit's webhook (application/webhook+json). The `Authorization` JWT is
 *                        checked first (HS256 with LIVEKIT_API_SECRET, `iss` LIVEKIT_API_KEY, its
 *                        `sha256` the body's): anything else is 401 and nothing is read. Then one
 *                        transaction per event (`voice_call_event()`): the event id once, the SIP
 *                        participant's line status (ringing, in progress, completed, no answer,
 *                        busy, failed; never backwards), and on `room_finished` for a call the
 *                        agent never ended the backstop (`not_reached`, `filed`, `draft_saved` or
 *                        `abandoned`, §19 Q122) with the call's one `post_call_reconcile` job
 *                        (`post_call:<call>`). Answers 200 fast; an event it does not act on, or
 *                        a room that is not a call's, is acknowledged and ignored.
 *
 * Nothing of the participant (identity, name, `sip.phoneNumber`) is stored or logged (§10.12).
 * A store error is a 500, and LiveKit delivers the event again; the transaction makes that safe.
 */

export interface VoiceEventsDeps {
  store: VoiceEventsStore;
  /** LIVEKIT_API_KEY: the token's issuer (throws EnvError when unset: 500, nothing unchecked). */
  apiKey: () => string;
  /** LIVEKIT_API_SECRET: the token's HS256 key. */
  apiSecret: () => string;
  now?: () => Date;
}

/** A LiveKit event is a few KB; anything far larger is not one. */
export const VOICE_EVENTS_MAX_BYTES = 256 * 1024;

export interface VoiceEventsAnswer extends Partial<VoiceEventResult> {
  received: true;
  ignored?: true;
}

export function createVoiceEvents(deps: VoiceEventsDeps): (req: Request) => Promise<Response> {
  const now = deps.now ?? (() => new Date());

  return withHandler('voice-events', async (req) => {
    requireMethod(req, 'POST');
    const length = Number(req.headers.get('content-length') ?? '0');
    if (length > VOICE_EVENTS_MAX_BYTES) throw new HttpError(413, 'Payload too large');
    const body = await req.text();
    if (body.length > VOICE_EVENTS_MAX_BYTES) throw new HttpError(413, 'Payload too large');

    const verdict = await verifyLiveKitWebhook(body, req.headers.get('authorization'), {
      apiKey: deps.apiKey(),
      apiSecret: deps.apiSecret(),
      now: now(),
    });
    if (!verdict.ok) {
      logWarn('voice.events.bad_signature', { reason: verdict.reason, bytes: body.length });
      return error(req, 401, 'invalid_signature');
    }

    let raw: unknown;
    try {
      raw = JSON.parse(body);
    } catch {
      throw new HttpError(400, 'Body must be valid JSON');
    }
    const parsed = LiveKitWebhookEventSchema.safeParse(raw);
    if (!parsed.success) throw new HttpError(400, 'Not a LiveKit webhook event');

    const event = toVoiceEvent(parsed.data, now());
    if (!event) {
      logInfo('voice.events.ignored', { event: parsed.data.event, eventId: parsed.data.id });
      const answer: VoiceEventsAnswer = { received: true, ignored: true };
      return json(req, answer);
    }

    const result = await deps.store.applyEvent(event);
    logInfo('voice.events.applied', {
      eventId: event.eventId,
      event: event.event,
      room: event.room,
      status: event.status,
      ...event.detail,
      ...result,
    });
    const answer: VoiceEventsAnswer = { received: true, ...result };
    return json(req, answer);
  });
}
