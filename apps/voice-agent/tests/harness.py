"""Text-mode calls on fakes, through the agent's own call code (`agent.ReportCall`).

`replay_call(fixture)` runs a `fixtures/calls/*.json` script as the entrypoint runs a room, minus
the room: `calls/start` with the fixture's request, then for a known reporter `ReportCall.open`
(`get_context`, the consent check), a text-mode `AgentSession(llm=FakeLLM(agentTurns))`, the
disclosure first (`ReportCall.begin`), one session run per reporter turn, and the hang-up when the
script ends without `end_call`; for an unknown caller (F13) the `UnknownCallerAgent` with its
opening. Nothing needs a key or a network: `FakeFieldApi` answers from the fixture's `routes`,
and first with the refusals of its `queue` (W3-15: `[{route, status, body}]`).
"""

from __future__ import annotations

import contextlib
import logging
from collections.abc import Iterator
from dataclasses import dataclass, field
from typing import Any

from livekit.agents import AgentSession

from sitelog_voice.agent import ReportCall, unknown_opening
from sitelog_voice.copy import default_copy
from sitelog_voice.dialog import Limits
from sitelog_voice.field_api import FieldApi
from sitelog_voice.session import CallState
from sitelog_voice.special import UnknownCallerAgent
from tests.fakes.field_api import BASE_URL, SECRET, FakeFieldApi
from tests.fakes.llm import FakeLLM


class StepClock:
    """A monotonic clock that moves `step` seconds each time it is read."""

    def __init__(self, step: float = 1.0) -> None:
        self.t = 0.0
        self.step = step

    def __call__(self) -> float:
        self.t += self.step
        return self.t


@dataclass
class Replay:
    fixture: dict[str, Any]
    fake: FakeFieldApi
    llm: FakeLLM
    opening: str
    state: CallState | None = None
    call: ReportCall | None = None
    unknown: UnknownCallerAgent | None = None
    #: How many requests field-api had seen when the disclosure had been played.
    requests_before_disclosure: int = 0
    logs: list[logging.LogRecord] = field(default_factory=list)


class _Capture(logging.Handler):
    def __init__(self) -> None:
        super().__init__(level=logging.DEBUG)
        self.records: list[logging.LogRecord] = []

    def emit(self, record: logging.LogRecord) -> None:
        self.records.append(record)


@contextlib.contextmanager
def _capture_logs() -> Iterator[_Capture]:
    handler = _Capture()
    root = logging.getLogger()
    old = root.level
    root.addHandler(handler)
    root.setLevel(logging.DEBUG)
    try:
        yield handler
    finally:
        root.removeHandler(handler)
        root.setLevel(old)


def start_kwargs(fixture: dict[str, Any]) -> dict[str, Any]:
    start = fixture["start"]["request"]
    return {
        "room": start["room"],
        "transport": start["transport"],
        "from_e164": start.get("from"),
        "to_e164": start.get("to"),
        "call_id": start.get("callId"),
    }


async def replay_call(
    fixture: dict[str, Any],
    *,
    limits: Limits | None = None,
    fake: FakeFieldApi | None = None,
) -> Replay:
    if fake is None:
        fake = FakeFieldApi(fixture)
        # W3-15: field-api's refusals the script records (`queue`), served before `routes`.
        for refusal in fixture.get("queue", []):
            fake.queue(refusal["route"], refusal["status"], refusal["body"])
    fake_llm = FakeLLM(fixture.get("agentTurns", []))
    turns: list[str] = fixture.get("reporterTurns", [])
    with _capture_logs() as logs, fake:
        api = FieldApi(base_url=BASE_URL, tool_secret=SECRET, timeout_s=2, retry_delay_s=0)
        try:
            auth, started = await api.calls_start(**start_kwargs(fixture))
            clock = StepClock()
            if started.reporter is None:
                unknown = UnknownCallerAgent(api, auth, started.locale or "en-US", clock=clock)
                opening = unknown_opening(unknown.language, default_copy())
                async with AgentSession(llm=fake_llm) as session:
                    await session.start(unknown)
                    unknown.said(opening, 0.0)
                    await session.say(opening, allow_interruptions=False)
                    await api.mark_disclosure(auth, default_copy().own_notice_version)
                    before = len(fake.calls)
                    for turn in turns:
                        await session.run(user_input=turn)
                    # The script is over: the message is left (the 60 s cap or the hang-up).
                    await unknown.leave_message()
                return Replay(
                    fixture,
                    fake,
                    fake_llm,
                    opening,
                    unknown=unknown,
                    requests_before_disclosure=before,
                    logs=logs.records,
                )

            call = await ReportCall.open(api, auth, started.reporter, clock=clock, limits=limits)
            async with AgentSession(llm=fake_llm) as session:
                await session.start(call.agent)
                call.bind(session)
                opening = await call.begin(first_name=started.reporter.first_name)
                before = len(fake.calls)
                for turn in turns:
                    await session.run(user_input=turn)
                    await call.settle()
                # The script is over: the caller hangs up (the session's close is the same).
                if not call.state.ended:
                    await call.hang_up()
            await call.aclose()
        finally:
            await api.aclose()
    return Replay(
        fixture,
        fake,
        fake_llm,
        opening,
        state=call.state,
        call=call,
        requests_before_disclosure=before,
        logs=logs.records,
    )
