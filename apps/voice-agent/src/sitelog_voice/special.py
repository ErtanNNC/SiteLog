"""W3-14: the parts of a call code drives without the dialog model.

- **Consent on a call** (spec F3 step 2, §19 Q120): a reporter without the `recording` and
  `data_processing` consents hears, after the disclosure, F3's sentence (`consent_ask`). Their next
  turn goes to code, never to the model: field-api reads it (`record_consent`, a whole yes or a
  whole no, `callYesNo`). Yes → the consents are stored by voice and the report goes ahead; no →
  nothing more is processed, the call ends `abandoned` with no reporter line in its log; an unclear
  answer is asked once more (`consent_repeat`), a second one ends the call as a no would, without
  storing anything.
- **Unknown callers** (F13, §19 Q124): after the disclosure and F13's line, the caller's first turn
  is their message: `leave_message` keeps a 160-character snippet for the office's Team alert, the
  agent says `unknown_goodbye` and the call ends. No tool of the report is offered; the recording
  is capped at `UNKNOWN_CALLER_MAX_RECORDING_S` (the recorder, W3-12, stops there).
"""

from __future__ import annotations

import time
from collections.abc import AsyncIterable, AsyncIterator, Callable
from typing import Any

from livekit.agents import Agent, ModelSettings, llm

from .copy import Language, VoiceCopy, default_copy
from .field_api import CallAuth, FieldApi, FieldApiError
from .metrics import CallMetrics
from .session import CallState

#: §19 Q124: an unknown caller leaves at most this much recording.
UNKNOWN_CALLER_MAX_RECORDING_S = 60

#: Unclear answers to the consent question before the call ends without consent.
CONSENT_MAX_TRIES = 2


def needs_consent(state: CallState) -> bool:
    """§19 Q120: the reporter has not given both consents a call report needs."""
    ctx = state.context
    return ctx is not None and not (ctx.consents.recording and ctx.consents.data_processing)


def next_step_line(state: CallState, copy: VoiceCopy) -> str:
    """After the yes: go ahead with the report, or the site question first (F14)."""
    lang = state.language
    ctx = state.context
    if ctx is None or ctx.site_id is not None or len(ctx.sites) == 1:
        return copy.line("go_ahead", lang)
    names = [s.name for s in ctx.sites]
    if 1 < len(names) <= 3:
        joined = f"{', '.join(names[:-1])} {copy.line('or', lang)} {names[-1]}"
        return copy.line("pick_site", lang, sites=joined)
    return copy.line("pick_site_by_name", lang)


async def end_without_report(state: CallState) -> None:
    """Ends the call `abandoned` (nothing filed); after a no, the log keeps the agent's lines."""
    if state.ended:
        return
    await state.api.end_call(
        state.auth,
        outcome="abandoned",
        dialog_log=state.end_log(),
        metrics=state.metrics.to_contract(),
    )
    state.ended = "abandoned"


async def consent_turn(state: CallState, copy: VoiceCopy | None = None) -> str:
    """The reporter's answer to the consent question, read by code; the line to say next."""
    copy = copy or default_copy()
    lang = state.language
    last = state.last_utterance
    if last is None:
        return copy.line("consent_ask", lang)
    try:
        data = await state.api.tool(
            "record_consent", state.auth, utterance=last.text, at=last.start
        )
    except FieldApiError:
        # field-api could not record it: nothing is processed without the consent; end politely.
        state.consent_needed = False
        await end_without_report(state)
        return copy.line("goodbye_abandoned", lang)
    status = data["status"]
    if status == "given":
        state.consent_needed = False
        if state.context is not None:
            state.context = state.context.model_copy(
                update={
                    "consents": state.context.consents.model_copy(
                        update={"recording": True, "data_processing": True, "sms": True}
                    )
                }
            )
        return f"{data['confirmation']} {next_step_line(state, copy)}"
    if status == "declined":
        state.consent_needed = False
        state.consent_declined = True
        await end_without_report(state)
        return str(data["confirmation"])
    state.consent_tries += 1
    if state.consent_tries >= CONSENT_MAX_TRIES:
        # Unclear twice: nothing was consented; the call ends with nothing kept of the reporter.
        state.consent_needed = False
        state.consent_declined = True
        await end_without_report(state)
        return copy.line("consent_declined", lang)
    return str(data["confirmation"])


def consent_reply(state: CallState, copy: VoiceCopy | None = None) -> AsyncIterable[str]:
    """`consent_turn` as an `llm_node` answer: code's line instead of the model's."""

    async def run() -> AsyncIterator[str]:
        yield await consent_turn(state, copy)

    return run()


# ─────────────────────────────── F13: an unknown caller ───────────────────────────────


class UnknownCallerAgent(Agent):
    """F13 on a call (§19 Q124): no model, no report tool. The caller's first turn is their
    message for the office; code keeps its snippet, says goodbye and ends the call."""

    def __init__(
        self,
        api: FieldApi,
        auth: CallAuth,
        locale: str,
        *,
        clock: Callable[[], float] = time.monotonic,
    ) -> None:
        super().__init__(instructions="An unknown caller: code answers; no model, no tools.")
        self.api = api
        self.auth = auth
        self.locale = locale
        self._clock = clock
        self._started = clock()
        self._seen: set[str] = set()
        self.heard: list[tuple[float, str]] = []
        self.log: list[dict[str, Any]] = []
        self.ended = False

    @property
    def language(self) -> Language:
        from .copy import language_of

        return language_of(self.locale)

    def now(self) -> float:
        return round(min(max(self._clock() - self._started, 0.0), 3600.0), 2)

    def said(self, text: str, at: float) -> None:
        self.log.append({"t": at, "speaker": "agent", "text": text[:4000]})

    def llm_node(
        self,
        chat_ctx: llm.ChatContext,
        tools: list[llm.Tool],
        model_settings: ModelSettings,
    ) -> AsyncIterable[llm.ChatChunk | str | Any]:
        for item in chat_ctx.items:
            if item.type != "message" or item.role != "user" or item.id in self._seen:
                continue
            self._seen.add(item.id)
            text = (item.text_content or "").strip()
            if text:
                at = self.now()
                self.heard.append((at, text))
                self.log.append({"t": at, "speaker": "reporter", "text": text[:4000]})
        return self._message()

    async def _message(self) -> AsyncIterator[str]:
        line = await self.leave_message()
        if line:
            yield line

    async def leave_message(self) -> str | None:
        """The caller's words to the office, once; then the goodbye and the end of the call."""
        if self.ended:
            return None
        copy = default_copy()
        goodbye = copy.line("unknown_goodbye", self.language)
        if self.heard:
            text = " ".join(t for _, t in self.heard)[:4000]
            try:
                data = await self.api.tool(
                    "leave_message", self.auth, utterance=text, start=self.heard[0][0]
                )
                goodbye = str(data["confirmation"])
            except FieldApiError:
                pass  # the call still ends; the office sees the call, not a message
        self.ended = True
        self.said(goodbye, self.now())
        await self.api.end_call(
            self.auth,
            outcome="abandoned",
            dialog_log=self.log[-2000:],
            metrics=CallMetrics(turns=len(self.heard)).to_contract(),
        )
        return goodbye
