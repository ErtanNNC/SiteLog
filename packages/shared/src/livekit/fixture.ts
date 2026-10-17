import { VOICE_ROOM_RE } from '../voice.ts';

/**
 * `fixtures/livekit/*.json` (W3-04): recorded LiveKit webhook bodies with placeholders, filled the
 * same way by `pnpm replay-webhook`, the `voice-events` Deno tests and the PGlite tests.
 *
 *   {{room}}       the call's room: `call-{uuid}`, or (an inbound phone call, §19 Q227) the name
 *                  LiveKit's dispatch rule gave it, `{prefix}_{caller}_{random}`
 *   {{room_sid}}   the room sid's suffix (`roomSid`), else one derived from the room (stable per
 *                  room)
 *   {{id}}         the event id: `{prefix}{file}` when given, else a fresh one per fill
 *   {{ts}}         the call's start, unix seconds; {{ts+N}} is N seconds later
 *   {{phone}}      the SIP caller / callee (E.164; fictional 555 numbers only)
 *   {{to}}         the pack's voice number or trunk number
 */
export interface LiveKitFixtureVars {
  room: string;
  /** The room sid's suffix (`RM_{{room_sid}}`); default derived from the room. */
  roomSid?: string;
  /** Unix seconds. */
  ts: number;
  phone: string;
  to: string;
  /** The event id; default a fresh `EV_…`. */
  id?: string;
}

export function fillLiveKitFixture(template: string, vars: LiveKitFixtureVars): string {
  const id = vars.id ?? `EV_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 10)}`;
  // A `call-{uuid}` room: its uuid's first 12 hex digits. Any other room (a dispatch rule's,
  // `{prefix}_{caller}_{random}`): its last 12 letters and digits, the random suffix, never the
  // caller's number.
  const alnum = vars.room.replace(/^call-/, '').replace(/[^A-Za-z0-9]/g, '');
  const roomSid =
    vars.roomSid ?? (VOICE_ROOM_RE.test(vars.room) ? alnum.slice(0, 12) : alnum.slice(-12));
  return template
    .replace(/\{\{room\}\}/g, vars.room)
    .replace(/\{\{room_sid\}\}/g, roomSid)
    .replace(/\{\{id\}\}/g, id)
    .replace(/\{\{ts(?:\+(\d+))?\}\}/g, (_m, plus: string | undefined) =>
      String(vars.ts + (plus ? Number(plus) : 0)),
    )
    .replace(/\{\{phone\}\}/g, vars.phone)
    .replace(/\{\{to\}\}/g, vars.to);
}
