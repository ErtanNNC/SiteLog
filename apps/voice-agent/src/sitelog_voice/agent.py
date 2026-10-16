"""The voice agent's entrypoint (spec §4.2, §9.4): one LiveKit job per call room `call-{uuid}`.

Order of a call (§9.4 "How a call starts", §15.2 "disclosure in the first 5 s"):

1. `POST /voice/calls/start`: a SIP call passes the caller's number from the SIP participant (to
   field-api only; it never enters the model's context or a log line), a Talk now (web) or outbound
   call passes the call id from the room metadata. → the call id, the call token, the reporter's
   first name and locale, or `unknown` (F13, W3-14).
2. `get_context` (sites, companies, key terms for STT, consents, `maxQuestions`).
3. The disclosure first: the opening line (copy, with the pack's recording notice) before anything
   that processes speech; then the dialog model with §9.4's system prompt in the call language.

W3-02 lays this down with the providers behind `session.build_live_session` (keys from env) and the
dialog behind `ReportAgent`; W3-12 finishes it (the §7.3 machine driving the session, recording,
fallback, metrics from the session's events). Tests run `ReportAgent` in text mode on fakes.
"""

from __future__ import annotations

import json
import logging
import time
from collections.abc import AsyncIterable, Callable
from typing import Any

from livekit import rtc
from livekit.agents import Agent, AgentServer, JobContext, ModelSettings, cli, llm

from .config import Settings, load_settings
from .copy import VoiceCopy, default_copy
from .field_api import FieldApi
from .observability import init_sentry, setup_logging
from .redact import redact_phones
from .session import CallState, build_live_session, system_prompt
from .tools import build_tools

log = logging.getLogger("sitelog_voice.agent")


class ReportAgent(Agent):
    """The dialog: §9.4's system prompt and tools, with two guards code owns.

    - Every text the dialog model receives is phone-redacted first (`llm_node`), whatever path it
      came by: the reporter's turns, tool outputs, earlier turns (§10.12).
    - Each new reporter turn is recorded verbatim in `CallState` (the transcript for `update_draft`,
      the utterance `file_report` sends), before the model answers it.
    """

    def __init__(self, state: CallState, *, clock: Callable[[], float] = time.monotonic) -> None:
        self.state = state
        self._clock = clock
        self._seen: set[str] = set()
        if not state.started_at:
            state.started_at = clock()
        max_questions = state.context.max_questions if state.context else 2
        super().__init__(
            instructions=system_prompt(locale=state.locale, max_questions=max_questions),
            tools=list(build_tools(state, now=self.now)),
        )

    def now(self) -> float:
        return max(0.0, self._clock() - self.state.started_at)

    def _record_new_turns(self, chat_ctx: llm.ChatContext) -> None:
        for item in chat_ctx.items:
            if item.type != "message" or item.role != "user" or item.id in self._seen:
                continue
            self._seen.add(item.id)
            text = item.text_content or ""
            if text.strip():
                at = self.now()
                self.state.heard(text, start=at, end=at)
                self.state.metrics.reporter_turn(confidence=item.transcript_confidence)

    def llm_node(
        self,
        chat_ctx: llm.ChatContext,
        tools: list[llm.Tool],
        model_settings: ModelSettings,
    ) -> AsyncIterable[llm.ChatChunk | str | Any]:
        self._record_new_turns(chat_ctx)
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


# ─────────────────────────────── the job ───────────────────────────────


def _room_call_id(room: rtc.Room) -> str | None:
    """A web or outbound call's id, from the room metadata `{"callId": …}` (W3-13, W3-17)."""
    try:
        meta = json.loads(room.metadata or "{}")
    except ValueError:
        return None
    call_id = meta.get("callId") if isinstance(meta, dict) else None
    return call_id if isinstance(call_id, str) else None


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
    if ctx and ctx.call.direction == "outbound" and site:
        return copy.line(
            "opening_outbound", state.language, first=first_name, company=ctx.company, site=site
        )
    if site is None:
        return copy.line("opening_inbound_pick_site", state.language, first=first_name)
    return copy.line(entry, state.language, first=first_name, site=site)


server = AgentServer()


@server.rtc_session()
async def entrypoint(ctx: JobContext) -> None:
    settings = load_settings()
    copy = default_copy()
    await ctx.connect()
    room = ctx.room
    call_id = _room_call_id(room)
    from_e164: str | None = None
    participant = await ctx.wait_for_participant()
    is_sip = participant.kind == rtc.ParticipantKind.PARTICIPANT_KIND_SIP
    transport = "pstn" if is_sip else "web"
    if call_id is None and is_sip:
        # An inbound SIP call: field-api finds the reporter by the caller's number (§19 Q44).
        # An outbound call (W3-17) or Talk now names its call in the room metadata instead.
        from_e164 = participant.attributes.get("sip.phoneNumber")

    api = FieldApi(
        base_url=settings.field_api_base(),
        tool_secret=settings.tool_secret(),
        timeout_s=settings.field_api_timeout_s,
    )
    auth, started = await api.calls_start(
        room=room.name, transport=transport, from_e164=from_e164, call_id=call_id
    )
    from_e164 = None  # stored by field-api; the agent keeps no copy
    log.info("call started", extra={"call_id": auth.call_id, "transport": transport})

    if started.reporter is None:
        # F13 (unknown caller, §19 Q124: the line, ≤ 60 s recorded, a snippet for the office) is
        # W3-14. Until then the call is closed without processing anything the caller says.
        await api.end_call(
            auth,
            outcome="abandoned",
            dialog_log=[],
            metrics={
                "latencyP50Ms": None,
                "latencyP95Ms": None,
                "interruptions": 0,
                "sttConfidence": None,
                "turns": 0,
            },
        )
        await api.aclose()
        ctx.shutdown(reason="unknown caller (F13 comes with W3-14)")
        return

    state = CallState(
        api=api, auth=auth, locale=started.reporter.locale, started_at=time.monotonic()
    )
    state.context = await api.get_context(auth)
    session = build_live_session(settings, locale=state.locale, keyterms=state.context.keyterms)
    agent = ReportAgent(state)
    await session.start(agent=agent, room=room)
    # Disclosure first, uninterruptible, before any tool that processes speech (§9.4 "Recording").
    await session.say(
        opening_line(state, copy, first_name=started.reporter.first_name),
        allow_interruptions=False,
    )


def main() -> None:
    settings: Settings = load_settings()
    setup_logging()
    init_sentry(settings)
    log.info("voice agent starting", extra={"config": settings.safe_summary()})
    cli.run_app(server)


if __name__ == "__main__":
    main()
