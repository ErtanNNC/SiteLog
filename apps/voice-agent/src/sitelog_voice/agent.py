"""The voice agent's entrypoint (spec §4.2, §9.4): one LiveKit job per call room (`call-{uuid}`
for Talk now and outbound calls; an inbound phone call's room is named by the SIP dispatch rule and
keyed by its sid, §19 Q227).

Order of a call (§9.4 "How a call starts", §15.2 "disclosure in the first 5 s"):

1. `POST /voice/calls/start`: a SIP call passes the caller's number from the SIP participant (to
   field-api only; it never enters the model's context or a log line), a Talk now (web) or outbound
   call passes the call id from the room metadata. → the call id, the call token, the reporter's
   first name and locale, or `unknown` (F13, W3-14).
2. `get_context` (sites, companies, key terms for STT, consents, `maxQuestions`), and whether the
   consent question comes first (§19 Q120).
3. The session in the call language (`session.build_live_session`) with the recorder on the room's
   audio (`recording.CallRecorder`: reporter left, agent right).
4. **The disclosure first** (`ReportCall.begin`): the opening with the pack's recording notice,
   uninterruptible, played to the end before anything processes the reporter's speech; then
   `calls.disclosure_played` (`FieldApi.mark_disclosure`, §19 Q205) and the §7.3 machine moves to
   `identify`; with several sites the site question follows in the same breath (F14).
5. The dialog model with §9.4's system prompt in the call language (`ReportAgent`), its tools
   (`tools.py`), and code around it (`ReportCall`): the §7.3 machine (`dialog.py`) on the session's
   speech, the reporter's turns and the tools' answers; a timer every half second for the silences,
   the back-channel, fillers while a tool waits, the 10-minute warning and the 12-minute end; the
   simple recording mode after two turns not understood or an agent error (F6: the line, a tone,
   record-only until the hang-up); metrics for `end_call` (`metrics.TurnTimer`).
6. The end (`ReportCall.finish`): `end_call` once with the settled outcome (the model's goodbye, a
   timer, or the hang-up), then the recording uploaded and the room closed.

Tests drive the same `ReportCall` in text mode (no room, no STT/TTS) with fakes
(`tests/harness.py`).
"""

from __future__ import annotations

import asyncio
import contextlib
import json
import logging
import time
from collections.abc import AsyncIterable, AsyncIterator, Awaitable, Callable
from typing import TYPE_CHECKING, Any

from livekit import rtc
from livekit.agents import Agent, AgentServer, JobContext, ModelSettings, cli, llm

from .config import Settings, load_settings
from .contract import Reporter
from .copy import Language, VoiceCopy, default_copy
from .dialog import Action, CallTool, Dialog, EndCall, Event, Limits, Say, State
from .dialog import tool_events as dialog_tool_events
from .dialog import turn_events as dialog_turn_events
from .field_api import CallAuth, FieldApi, FieldApiError, room_key
from .metrics import TurnTimer
from .observability import init_sentry, setup_logging
from .recording import CallRecorder, tone_frames, upload_recording
from .redact import redact_phones
from .session import (
    CallState,
    build_live_session,
    room_options,
    settle_outcome,
    system_prompt,
)
from .special import (
    UNKNOWN_CALLER_MAX_RECORDING_S,
    UnknownCallerAgent,
    consent_reply,
    needs_consent,
    next_step_line,
)
from .tools import NoHooks, ToolHooks, ToolResult, build_tools, post_fallback, send_end_call
from .voicemail import GREETING_WAIT_S, OutboundGate

if TYPE_CHECKING:
    from livekit.agents import AgentSession

log = logging.getLogger("sitelog_voice.agent")

#: How often the §7.3 timers are checked.
TICK_S = 0.5


async def _nothing() -> AsyncIterator[str]:
    """An `llm_node` answer that says nothing (the simple recording mode, a call already over)."""
    return
    yield  # pragma: no cover


class ReportAgent(Agent):
    """The dialog: §9.4's system prompt and tools, with the guards code owns.

    - Every text the dialog model receives is phone-redacted first (`llm_node`), whatever path it
      came by: the reporter's turns, tool outputs, earlier turns (§10.12).
    - Each new reporter turn is recorded verbatim in `CallState` (the transcript for `update_draft`,
      the utterance `file_report` sends), before the model answers it; a turn heard before the
      disclosure ended is dropped (nothing is processed before it, §9.4 "Recording").
    - The model is not asked while the consent question is open (code reads the answer, §19 Q120),
      in the simple recording mode (F6), or after the call ended.
    """

    def __init__(
        self,
        state: CallState,
        *,
        clock: Callable[[], float] = time.monotonic,
        hooks: ToolHooks | None = None,
    ) -> None:
        self.state = state
        self._clock = clock
        self._hooks = hooks or NoHooks()
        self._seen: set[str] = set()
        if not state.started_at:
            state.started_at = clock()
        max_questions = state.context.max_questions if state.context else 2
        super().__init__(
            instructions=system_prompt(locale=state.locale, max_questions=max_questions),
            tools=list(build_tools(state, now=self.now, hooks=self._hooks)),
        )

    def now(self) -> float:
        return max(0.0, self._clock() - self.state.started_at)

    def _record_new_turns(self, chat_ctx: llm.ChatContext) -> int:
        new = 0
        for item in chat_ctx.items:
            if item.type != "message" or item.role != "user" or item.id in self._seen:
                continue
            self._seen.add(item.id)
            new += 1
            text = item.text_content or ""
            if not self.state.disclosure_played:
                continue  # said over the disclosure: never processed
            if text.strip():
                at = self.now()
                self.state.heard(text, start=at, end=at)
                self.state.metrics.reporter_turn(confidence=item.transcript_confidence)
            self._hooks.turn_heard(text, item.transcript_confidence)
        return new

    def llm_node(
        self,
        chat_ctx: llm.ChatContext,
        tools: list[llm.Tool],
        model_settings: ModelSettings,
    ) -> AsyncIterable[llm.ChatChunk | str | Any]:
        new_turns = self._record_new_turns(chat_ctx)
        if (
            not self.state.disclosure_played
            or self.state.fallback
            or self.state.dialog.state is State.FALLBACK_RECORDING
        ):
            return _nothing()
        if self.state.ended and new_turns:
            return _nothing()
        if self.state.consent_needed:
            # F3 on a call (§19 Q120, W3-14): the answer to the consent question goes to code,
            # never to the model; nothing of the reporter reaches a model before their yes.
            return consent_reply(self.state)
        return Agent.default.llm_node(self, redacted_context(chat_ctx), tools, model_settings)


def redacted_context(chat_ctx: llm.ChatContext) -> llm.ChatContext:
    """A copy of the context with every message text and tool output phone-redacted.

    `ChatContext.copy()` shares its items, so each changed item is copied, never edited: the
    session's own context (and the verbatim transcript code keeps) stays as heard."""
    ctx = chat_ctx.copy()
    items: list[llm.ChatItem] = []
    for item in ctx.items:
        if item.type == "message":
            content = [redact_phones(c) if isinstance(c, str) else c for c in item.content]
            items.append(item.model_copy(update={"content": content}))
        elif item.type == "function_call_output":
            items.append(item.model_copy(update={"output": redact_phones(item.output)}))
        elif item.type == "function_call":
            items.append(item.model_copy(update={"arguments": redact_phones(item.arguments)}))
        else:
            items.append(item)
    ctx.items = items
    return ctx


# ─────────────────────────────── openings ───────────────────────────────


def opening_line(state: CallState, copy: VoiceCopy, *, first_name: str) -> str:
    """The first thing the call says: the opening with the disclosure in it (§9.4, §15.2)."""
    ctx = state.context
    site = None
    if ctx is not None:
        if ctx.site_id is not None:
            site = next((s.name for s in ctx.sites if s.id == ctx.site_id), None)
        elif len(ctx.sites) == 1:
            site = ctx.sites[0].name
    entry = "opening_talk_now" if ctx and ctx.call.transport == "web" else "opening_inbound"
    if state.consent_needed:
        # F3 (§19 Q120, W3-14): the disclosure, then the consent question; no report before it.
        return " ".join(
            [
                copy.line("opening_inbound_pick_site", state.language, first=first_name),
                copy.line("consent_ask", state.language),
            ]
        )
    if ctx and ctx.call.direction == "outbound" and site:
        return copy.line(
            "opening_outbound", state.language, first=first_name, company=ctx.company, site=site
        )
    if site is None:
        # F14: the disclosure, then "Which site is this for — Riverside or Pier 9?".
        return " ".join(
            [
                copy.line("opening_inbound_pick_site", state.language, first=first_name),
                next_step_line(state, copy),
            ]
        )
    return copy.line(entry, state.language, first=first_name, site=site)


def unknown_opening(lang: Language, copy: VoiceCopy) -> str:
    """F13 (§19 Q124): the greeting, the recording notice, then the F13 line."""
    return " ".join(
        [
            copy.line("unknown_greeting", lang),
            copy.line("recording_notice", lang),
            copy.line("unknown_caller", lang),
        ]
    )


def goodbye_line(state: CallState, copy: VoiceCopy, outcome: str) -> str:
    """The goodbye for an outcome code reached (a timer's end of the call)."""
    lang = state.language
    if outcome in ("no_work", "weather_day"):
        ctx = state.context
        site = next((s.name for s in ctx.sites if s.id == ctx.site_id), None) if ctx else None
        if site is None:
            return copy.line("goodbye_abandoned", lang)
        return copy.line(f"goodbye_{outcome}", lang, site=site)
    if outcome in ("filed", "draft_saved", "edit_applied", "fallback_recording", "abandoned"):
        return copy.line(f"goodbye_{outcome}", lang)
    return copy.line("goodbye_abandoned", lang)


# ─────────────────────────────── the call ───────────────────────────────


class ReportCall:
    """A known reporter's call: `CallState` and the §7.3 machine around one `AgentSession`.

    It is the `ToolHooks` of its `ReportAgent`: tools tell it when they start and what they
    answered, the agent tells it each reporter turn. Lines code speaks (the opening, silence
    prompts, fillers, the fallback, a timer's goodbye) go through `say`, so they are in the dialog
    log and restart the silence clock. Work started from inside a tool or a model turn (a fallback,
    the end) runs as a task, never awaited there; `settle()` waits for them (tests)."""

    def __init__(
        self,
        state: CallState,
        *,
        copy: VoiceCopy | None = None,
        clock: Callable[[], float] = time.monotonic,
        limits: Limits | None = None,
        tone: bool = False,
    ) -> None:
        self.state = state
        self.copy = copy or default_copy()
        if limits is not None:
            state.dialog = Dialog(limits=limits)
        self.dialog = state.dialog
        self.timer = TurnTimer(state.metrics)
        self.agent = ReportAgent(state, clock=clock, hooks=self)
        self.session: AgentSession | None = None
        self.tone = tone
        #: Run once at the end, in order (the recording's upload, closing the room).
        self.on_finish: list[Callable[[], Awaitable[None]]] = []
        self._tasks: set[asyncio.Task[Any]] = set()
        self._finished = False
        self._ticker: asyncio.Task[None] | None = None

    @classmethod
    async def open(
        cls, api: FieldApi, auth: CallAuth, reporter: Reporter, **kwargs: Any
    ) -> ReportCall:
        """`get_context` and the consent check, before the session starts (its STT needs the key
        terms, its prompt the questions limit)."""
        state = CallState(api=api, auth=auth, locale=reporter.locale)
        state.context = await api.get_context(auth)
        state.consent_needed = needs_consent(state)
        return cls(state, **kwargs)

    def now(self) -> float:
        return self.agent.now()

    # ─────────────────────────── the session ───────────────────────────

    def bind(self, session: AgentSession) -> None:
        """After `session.start(agent=self.agent, …)`: the session's speech states feed the
        silence clock, the turn latency and the barge-ins; its close is the hang-up."""
        self.session = session

        @session.on("user_state_changed")
        def _user(ev: Any) -> None:
            now = self.now()
            if ev.new_state == "speaking":
                self.timer.reporter_started(now)
                self.dialog.on(Event.SPEECH, now)
            elif ev.old_state == "speaking":
                self.timer.reporter_stopped(now)

        @session.on("agent_state_changed")
        def _agent(ev: Any) -> None:
            now = self.now()
            if ev.new_state == "speaking":
                self.timer.agent_started(now)
            elif ev.old_state == "speaking":
                self.timer.agent_stopped(now)
                self.dialog.on(Event.AGENT_SPOKE, now)

        @session.on("error")
        def _error(ev: Any) -> None:
            if not getattr(ev.error, "recoverable", True):
                log.warning("session error", extra={"call_id": self.state.auth.call_id})
                self.agent_error()

        @session.on("close")
        def _close(_ev: Any) -> None:
            if not self._finished:
                self._spawn(self.hang_up())

    def start_ticker(self) -> None:
        async def run() -> None:
            while not self._finished:
                await asyncio.sleep(TICK_S)
                await self.tick()

        self._ticker = asyncio.get_running_loop().create_task(run())

    async def say(self, text: str, *, interruptible: bool = True) -> bool:
        """Speaks code's line; True when it was played to the end."""
        self.state.said(text, at=self.now())
        if self.session is None:
            return True
        try:
            handle = self.session.say(text, allow_interruptions=interruptible)
            await handle
        except RuntimeError:
            return False  # the session is closing (the caller hung up)
        self.dialog.on(Event.AGENT_SPOKE, self.now())
        return not handle.interrupted

    # ─────────────────────────── the start ───────────────────────────

    async def begin(self, *, first_name: str) -> str:
        """The disclosure first (§9.4 "Recording", §15.2), then `identify`. Returns the opening."""
        self.dialog.on(Event.ANSWERED, self.now())
        opening = opening_line(self.state, self.copy, first_name=first_name)
        if not await self.say(opening, interruptible=False):
            return opening  # cut off: nothing after it is processed
        await self.disclosure_played()
        self._identify()
        return opening

    async def screen_outbound(self, first_utterance: str | None) -> bool:
        """F6 step 1 (W3-17): an outbound call listens before it speaks. A voicemail greeting
        ends the call `not_reached` with no message (field-api: `voicemail`, then `missed_call`);
        a person, or silence, goes on to the opening. The words are matched, never processed.
        True when the call goes on."""
        decision = OutboundGate(self.state.language).first(first_utterance)
        if decision == "begin":
            self.state.metrics.answered_by = "human"
            return True
        self.state.metrics.answered_by = "machine"
        await self.run(self.dialog.on(Event.NO_ANSWER, self.now()))
        return False

    async def disclosure_played(self) -> None:
        self.state.disclosure_played = True
        self.dialog.on(Event.DISCLOSURE_PLAYED, self.now())
        try:
            await self.state.api.mark_disclosure(self.state.auth)
        except FieldApiError as exc:
            log.warning(
                "disclosure not marked",
                extra={"call_id": self.state.auth.call_id, "code": exc.code},
            )

    def _identify(self) -> None:
        """`identify` → `listening` (site known) or `pick_site` (F14), once the report may start:
        after the disclosure, and after the consent answer when it was asked (§19 Q120)."""
        if self.dialog.state is not State.IDENTIFY or self.state.consent_needed:
            return
        if self.state.consent_declined:
            return
        ctx = self.state.context
        known = ctx is not None and (ctx.site_id is not None or len(ctx.sites) == 1)
        self.dialog.on(Event.SITE_KNOWN if known else Event.SEVERAL_SITES, self.now())

    # ─────────────────────────── hooks (ToolHooks) ───────────────────────────

    def turn_heard(self, text: str, confidence: float | None) -> None:
        if self.state.fallback or self.state.ended:
            return
        self._identify()
        now = self.now()
        for event in dialog_turn_events(text, confidence, self.dialog.limits):
            self._run_soon(self.dialog.on(event, now), reason="stt_low_confidence")

    def tool_started(self, name: str) -> None:
        self.dialog.tool_started(self.now())

    def tool_done(self, name: str, result: ToolResult) -> None:
        now = self.now()
        self.dialog.tool_finished(now)
        self._identify()
        for event in dialog_tool_events(name, result, self.dialog.state):
            # The model says the tool's own line (code's words: the read-back, the goodbye), so
            # the dialog's lines for the same step are not said twice.
            self.dialog.on(event, now)

    def agent_error(self) -> None:
        self._run_soon(self.dialog.on(Event.AGENT_ERROR, self.now()), reason="agent_error")

    async def fallback(self, reason: str) -> None:
        """The model's `start_fallback_recording` (field-api told already): the line, the tone."""
        self.dialog.enter_fallback(self.now())
        self._spawn(self._fallback_media())

    async def ended(self, outcome: str) -> None:
        """The model's `end_call` (sent already): close once its goodbye has been said."""
        self.dialog.close(self.now())
        self._spawn(self.finish())

    # ─────────────────────────── code's actions ───────────────────────────

    def _run_soon(self, actions: list[Action], *, reason: str) -> None:
        if actions:
            self._spawn(self.run(actions, reason=reason))

    async def run(self, actions: list[Action], *, reason: str = "not_understood") -> None:
        """Carries out the dialog's actions in order."""
        for action in actions:
            if isinstance(action, Say):
                await self._say_key(action.key, actions)
            elif isinstance(action, CallTool) and action.name == "start_fallback_recording":
                await self._start_fallback(reason)
            elif isinstance(action, EndCall):
                await self.end(action.outcome)

    async def _say_key(self, key: str, actions: list[Action]) -> None:
        if key == "fallback":
            return  # said with the tone by _start_fallback
        if key.startswith("goodbye_"):
            # A timer ends the call: the goodbye of the outcome code reached, not the timer's.
            ending = next((a.outcome for a in actions if isinstance(a, EndCall)), "abandoned")
            text = goodbye_line(self.state, self.copy, settle_outcome(self.state, ending))
            await self.say(text, interruptible=False)
            return
        await self.say(self.copy.line(key, self.state.language))

    async def _start_fallback(self, reason: str) -> None:
        try:
            await post_fallback(self.state, reason, self.now())
        except FieldApiError as exc:
            # The call still records; W3-11 settles a fallback call field-api missed.
            log.warning(
                "fallback not marked", extra={"call_id": self.state.auth.call_id, "code": exc.code}
            )
        await self._fallback_media()

    async def _fallback_media(self) -> None:
        """F6: "tell me everything after the tone and hang up when you're done", then the tone;
        the call records until the hang-up (or the 12-minute end)."""
        await self.say(self.copy.line("fallback", self.state.language), interruptible=False)
        if self.tone and self.session is not None:
            with contextlib.suppress(RuntimeError):
                await self.session.say("", audio=tone_frames(), add_to_chat_ctx=False)

    async def tick(self) -> None:
        if self.state.ended or self._finished:
            return
        await self.run(self.dialog.tick(self.now()))

    async def end(self, outcome: str) -> None:
        """Ends the call with `outcome` settled against what field-api did (§19 Q119)."""
        self.dialog.close(self.now())
        if not self.state.ended:
            settled = settle_outcome(self.state, outcome)
            try:
                await send_end_call(self.state, settled)
            except FieldApiError as exc:
                # W3-04's backstop ends a call the agent could not (room_finished).
                log.warning(
                    "end_call failed", extra={"call_id": self.state.auth.call_id, "code": exc.code}
                )
        await self.finish()

    async def hang_up(self) -> None:
        """The caller left (or the room closed): a hang-up before the yes saves the draft (§7.2,
        §19 Q122); in the simple recording mode the recording is the report."""
        if self.state.ended:
            await self.finish()
            return
        actions = self.dialog.on(Event.HANG_UP, self.now())
        outcome = next((a.outcome for a in actions if isinstance(a, EndCall)), None)
        await self.end(outcome or ("fallback_recording" if self.state.fallback else "abandoned"))

    async def finish(self) -> None:
        """Once: the goodbye played out, then `on_finish` (the recording's upload, the room)."""
        if self._finished:
            return
        self._finished = True
        if self.session is not None and (speech := self.session.current_speech) is not None:
            with contextlib.suppress(Exception):
                await speech.wait_for_playout()
        for step in self.on_finish:
            try:
                await step()
            except Exception:
                log.exception("call finish step failed", extra={"call_id": self.state.auth.call_id})

    # ─────────────────────────── tasks ───────────────────────────

    def _spawn(self, coro: Awaitable[Any]) -> None:
        task = asyncio.ensure_future(coro)
        self._tasks.add(task)
        task.add_done_callback(self._tasks.discard)

    async def settle(self) -> None:
        """Waits for the work code started from inside a turn or a tool (tests, the end)."""
        while pending := [t for t in self._tasks if not t.done()]:
            await asyncio.gather(*pending, return_exceptions=True)
        self._tasks.clear()

    async def aclose(self) -> None:
        if self._ticker is not None:
            self._ticker.cancel()
            with contextlib.suppress(asyncio.CancelledError):
                await self._ticker
        await self.settle()


# ─────────────────────────────── the job ───────────────────────────────


def _room_call_id(room: rtc.Room) -> str | None:
    """A web or outbound call's id, from the room metadata `{"callId": …}` (W3-13, W3-17)."""
    try:
        meta = json.loads(room.metadata or "{}")
    except ValueError:
        return None
    call_id = meta.get("callId") if isinstance(meta, dict) else None
    return call_id if isinstance(call_id, str) else None


#: How long the agent waits for the room's sid (it comes with the connection, or just after it).
ROOM_SID_WAIT_S = 10.0


async def _room_key(room: rtc.Room) -> str:
    """The room's key for `calls/start` (§19 Q227): `call-{uuid}`, or the room's sid when the SIP
    dispatch rule named the room (its name carries the caller's number and is never sent, logged
    or kept)."""
    key = room_key(room.name, None)
    if key is None:
        key = room_key(None, await asyncio.wait_for(room.sid, ROOM_SID_WAIT_S))
    if key is None:
        raise RuntimeError("the room has neither a call name nor a sid")
    return key


def _room_is_outbound(room: rtc.Room) -> bool:
    """An outbound call's room (W3-17): `{"direction": "outbound"}` in its metadata."""
    try:
        meta = json.loads(room.metadata or "{}")
    except ValueError:
        return False
    return isinstance(meta, dict) and meta.get("direction") == "outbound"


def _keeps_recording(state: CallState) -> bool:
    """§19 Q120: no recording of a call whose reporter said no, or never answered the question;
    W3-17: none of a voicemail greeting (a third party's words, F6 step 1)."""
    return not (
        state.consent_declined or state.consent_needed or state.metrics.answered_by == "machine"
    )


async def _wait_answered(
    participant: rtc.RemoteParticipant, room: rtc.Room, timeout_s: float
) -> bool:
    """An outbound SIP participant joins while it rings (`sip.callStatus` `dialing`/`ringing`);
    the call starts only once it is `active` (answered). False: it never was (the worker settles
    the unanswered call)."""
    if participant.attributes.get("sip.callStatus", "active") == "active":
        return True
    answered: asyncio.Future[bool] = asyncio.get_running_loop().create_future()

    def changed(_changed: dict[str, str], p: rtc.Participant) -> None:
        active = p.attributes.get("sip.callStatus") == "active"
        if p.identity == participant.identity and active and not answered.done():
            answered.set_result(True)

    def left(p: rtc.RemoteParticipant) -> None:
        if p.identity == participant.identity and not answered.done():
            answered.set_result(False)

    room.on("participant_attributes_changed", changed)
    room.on("participant_disconnected", left)
    try:
        return await asyncio.wait_for(answered, timeout_s)
    except TimeoutError:
        return False
    finally:
        room.off("participant_attributes_changed", changed)
        room.off("participant_disconnected", left)


async def _first_utterance(session: AgentSession, timeout_s: float) -> str | None:
    """The callee's first final transcript, or None after `timeout_s` of silence (F6 step 1)."""
    heard: asyncio.Future[str] = asyncio.get_running_loop().create_future()

    def transcribed(ev: Any) -> None:
        if getattr(ev, "is_final", False) and not heard.done():
            heard.set_result(str(getattr(ev, "transcript", "") or ""))

    session.on("user_input_transcribed", transcribed)
    try:
        return await asyncio.wait_for(heard, timeout_s)
    except TimeoutError:
        return None
    finally:
        session.off("user_input_transcribed", transcribed)


server = AgentServer()


@server.rtc_session()
async def entrypoint(ctx: JobContext) -> None:
    settings = load_settings()
    copy = default_copy()
    # The job process's handlers (§19 Q227: LiveKit's own log lines carry the room name).
    setup_logging()
    await ctx.connect()
    room = ctx.room
    call_id = _room_call_id(room)
    from_e164: str | None = None
    to_e164: str | None = None
    participant = await ctx.wait_for_participant()
    is_sip = participant.kind == rtc.ParticipantKind.PARTICIPANT_KIND_SIP
    transport = "pstn" if is_sip else "web"
    outbound = is_sip and _room_is_outbound(room)
    if outbound and not await _wait_answered(participant, room, timeout_s=90):
        # Nobody picked up: the worker settles the call (no answer, busy) and texts missed_call.
        ctx.shutdown(reason="outbound call not answered")
        return
    if call_id is None and is_sip:
        # An inbound SIP call: field-api finds the reporter by the caller's number (§19 Q44).
        # An outbound call (W3-17) or Talk now names its call in the room metadata instead.
        from_e164 = participant.attributes.get("sip.phoneNumber")
        # The pack's number the caller dialled: field-api finds the pack by it (W3-03).
        to_e164 = participant.attributes.get("sip.trunkPhoneNumber")

    api = FieldApi(
        base_url=settings.field_api_base(),
        tool_secret=settings.tool_secret(),
        timeout_s=settings.field_api_timeout_s,
    )
    auth, started = await api.calls_start(
        room=await _room_key(room),
        transport=transport,
        from_e164=from_e164,
        to_e164=to_e164,
        call_id=call_id,
    )
    from_e164 = to_e164 = None  # stored by field-api; the agent keeps no copy
    log.info("call started", extra={"call_id": auth.call_id, "transport": transport})
    recorder = CallRecorder()
    uploaded = False

    async def upload(keep: bool) -> None:
        nonlocal uploaded
        if uploaded:
            return
        uploaded = True
        path = await recorder.stop()
        try:
            if path is not None and keep:
                await upload_recording(api, auth, path)
        finally:
            recorder.discard()

    if started.reporter is None:
        await _unknown_caller(
            ctx, settings, copy, api, auth, started.locale or "en-US", recorder, upload
        )
        return

    call = await ReportCall.open(api, auth, started.reporter, copy=copy, tone=True)
    state = call.state
    session = build_live_session(
        settings, locale=state.locale, keyterms=state.context.keyterms if state.context else []
    )
    await session.start(
        agent=call.agent, room=room, room_options=room_options(transport), record=False
    )
    recorder.attach(session)
    await recorder.start()
    call.bind(session)

    async def close_room() -> None:
        # The goodbye drains, then the room is deleted (the caller's line drops, §9.4).
        session.shutdown(drain=True)

    call.on_finish.append(lambda: upload(_keeps_recording(state)))
    call.on_finish.append(close_room)
    ctx.add_shutdown_callback(call.hang_up)
    if outbound and not await call.screen_outbound(
        await _first_utterance(session, GREETING_WAIT_S)
    ):
        return  # a voicemail greeting: ended not_reached, nothing left on it (F6 step 1)
    call.start_ticker()
    await call.begin(first_name=started.reporter.first_name)


async def _unknown_caller(
    ctx: JobContext,
    settings: Settings,
    copy: VoiceCopy,
    api: FieldApi,
    auth: CallAuth,
    locale: str,
    recorder: CallRecorder,
    upload: Callable[[bool], Awaitable[None]],
) -> None:
    """F13 (§19 Q124, W3-14): the disclosure and the F13 line in the pack's language, the
    caller's message (its snippet for the office), goodbye; at most 60 s of recording, uploaded
    through the same route (field-api files it outside every org's folder)."""
    unknown = UnknownCallerAgent(api, auth, locale)
    session = build_live_session(settings, locale=locale, keyterms=[])
    await session.start(agent=unknown, room=ctx.room, record=False)
    recorder.attach(session)
    await recorder.start()

    async def upload_message() -> None:
        await upload(True)

    ctx.add_shutdown_callback(upload_message)
    opening = unknown_opening(unknown.language, copy)
    unknown.said(opening, 0.0)
    try:
        await session.say(opening, allow_interruptions=False)
    except RuntimeError:
        return  # hung up during the disclosure
    with contextlib.suppress(FieldApiError):
        await api.mark_disclosure(auth)

    async def cap() -> None:
        await asyncio.sleep(UNKNOWN_CALLER_MAX_RECORDING_S)
        line = await unknown.leave_message()
        if line:
            with contextlib.suppress(RuntimeError):
                await session.say(line, allow_interruptions=False)
        await upload_message()
        ctx.shutdown(reason="unknown caller: 60 s")

    asyncio.get_running_loop().create_task(cap())


def main() -> None:
    settings: Settings = load_settings()
    setup_logging()
    init_sentry(settings)
    log.info("voice agent starting", extra={"config": settings.safe_summary()})
    cli.run_app(server)


if __name__ == "__main__":
    main()
