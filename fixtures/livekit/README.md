# LiveKit webhook fixtures (W3-04)

LiveKit `WebhookEvent` bodies as `voice-events` receives them (spec §4.2, §7.3): JSON, with the
fields LiveKit sends (protojson: int64 as strings, enums by name). `pnpm replay-webhook --
fixtures/livekit/<event>.json` signs each one as LiveKit does (an HS256 JWT in `Authorization`, `iss`
`LIVEKIT_API_KEY`, the body's `sha256`) with `LIVEKIT_API_KEY` / `LIVEKIT_API_SECRET` (a local pair,
default `devkey` / `dev-livekit-secret`; never a real project's) and posts it to `--voice-url` or
`VOICE_EVENTS_URL` (default the local stack's `voice-events`). The same files drive the
`voice-events` Deno tests and the PGlite tests (`supabase/db-tests/src/voice-events.test.ts`), filled
by `fillLiveKitFixture` (`packages/shared/src/livekit/fixture.ts`).

Placeholders: `{{room}}` the call's room (`--room call-<uuid>`, the same for every file of a run;
default a fresh room that matches no call), `{{room_sid}}` the room sid after `RM_` (`--room-sid`;
default derived from the room), `{{id}}` a fresh event id,
`{{ts}}` the call's start (three minutes before the replay) and `{{ts+N}}` N seconds later,
`{{phone}}` the SIP caller or callee (`--phone`; fictional 555 numbers only) and `{{to}}` the trunk
number (`--to`).

| File                                | Event                                     | `calls` after it                               |
| ----------------------------------- | ----------------------------------------- | ---------------------------------------------- |
| `outbound-01-room-started.json`     | room_started                              | unchanged (stored once)                        |
| `outbound-02-agent-joined.json`     | participant_joined, the agent             | unchanged                                      |
| `outbound-03-sip-dialing.json`      | participant_joined, SIP `dialing`         | `ringing`                                      |
| `outbound-04-sip-answered.json`     | track_published by the SIP participant    | `in_progress`, `answered_at`                   |
| `outbound-05-sip-hangup.json`       | participant_left, SIP, `CLIENT_INITIATED` | `completed` (`failed` if nobody answered)      |
| `outbound-06-room-finished.json`    | room_finished                             | the backstop if the agent never ended the call |
| `no-answer-01-sip-dialing.json`     | participant_joined, SIP `dialing`         | `ringing`                                      |
| `no-answer-02-sip-unavailable.json` | participant_left, SIP, `USER_UNAVAILABLE` | `no_answer`                                    |
| `no-answer-03-room-finished.json`   | room_finished                             | backstop: `not_reached`                        |
| `busy-sip-rejected.json`            | participant_left, SIP, `USER_REJECTED`    | `busy`                                         |
| `inbound-01-room-started.json`      | room_started, a dispatch rule's room      | unchanged (stored once, by the room sid)       |
| `inbound-02-sip-joined.json`        | participant_joined, SIP `active` (caller) | `in_progress` (already, from `calls/start`)    |
| `inbound-03-sip-hangup.json`        | participant_left, SIP, `CLIENT_INITIATED` | `completed`                                    |
| `inbound-04-room-finished.json`     | room_finished                             | the backstop if the agent never ended the call |

On a local stack: `LIVEKIT_API_KEY` and `LIVEKIT_API_SECRET` in `supabase/functions/.env` (the same
pair the replay signs with), `supabase functions serve`, and a `calls` row whose
`provider_call_id` is the room (an outbound or Talk now call) or whose id is the room's uuid (an
inbound call); a room with no call row is acknowledged with `callId: null`. The outbound sequence
replayed on such a row moves it ringing → in progress → completed, and `room_finished` without the
agent's `end_call` ends it with one `post_call_reconcile` job:

```bash
pnpm replay-webhook -- --room call-<uuid> fixtures/livekit/outbound-0*.json
```

**An inbound phone call (spec §19 Q227).** LiveKit's SIP dispatch rule names the room itself
(`{prefix}_{caller}_{random}`; the `inbound-*` files carry `sip_{{phone}}_Xq7Lm2Pz9Kd4`), so the call
is keyed by the room's sid: the agent sends `RM_…` to `calls/start` and `voice-events` finds the call
by `provider_call_id` = the sid. The room name is dropped before anything is stored or logged.
Replayed on a `calls` row whose `provider_call_id` is `RM_<sid>`:

```bash
pnpm replay-webhook -- --room-sid RM_<sid> fixtures/livekit/inbound-0*.json
```
