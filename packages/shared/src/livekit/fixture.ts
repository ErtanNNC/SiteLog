/**
 * `fixtures/livekit/*.json` (W3-04): recorded LiveKit webhook bodies with placeholders, filled the
 * same way by `pnpm replay-webhook`, the `voice-events` Deno tests and the PGlite tests.
 *
 *   {{room}}       the call's room, `call-{uuid}`
 *   {{room_sid}}   a room sid suffix derived from the room (stable per room)
 *   {{id}}         the event id: `{prefix}{file}` when given, else a fresh one per fill
 *   {{ts}}         the call's start, unix seconds; {{ts+N}} is N seconds later
 *   {{phone}}      the SIP caller / callee (E.164; fictional 555 numbers only)
 *   {{to}}         the pack's voice number or trunk number
 */
export interface LiveKitFixtureVars {
  room: string;
  /** Unix seconds. */
  ts: number;
  phone: string;
  to: string;
  /** The event id; default a fresh `EV_…`. */
  id?: string;
}

export function fillLiveKitFixture(template: string, vars: LiveKitFixtureVars): string {
  const id = vars.id ?? `EV_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 10)}`;
  const roomSid = vars.room
    .replace(/^call-/, '')
    .replace(/-/g, '')
    .slice(0, 12);
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
