"""W3-17: outbound calls in the agent (spec F6 step 1, §9.4 "Calls policy", §19 Q128, Q216).

- The voicemail classifier as a table: the callee's first utterance, per call language, decides
  whether an outbound call goes on to the opening or hangs up with no message left.
- `ReportCall.screen_outbound`: a machine ends the call `not_reached` with `answeredBy: machine`,
  says nothing and marks no disclosure; a person goes on.
- `schedule_callback` once field-api queues it: code's goodbye with the time, and the call may end
  `callback_requested` (only then, `settle_outcome`).
"""

from __future__ import annotations

import copy
import json
from pathlib import Path
from typing import Any

import pytest

from sitelog_voice.agent import ReportCall
from sitelog_voice.copy import default_copy
from sitelog_voice.field_api import FieldApi
from sitelog_voice.session import CallState, settle_outcome
from sitelog_voice.voicemail import (
    UNKNOWN_IS_MACHINE,
    OutboundGate,
    classify_first_utterance,
    outbound_decision,
)
from tests.fakes.field_api import BASE_URL, SECRET, FakeFieldApi
from tests.harness import StepClock, replay_call, start_kwargs

FIXTURES = Path(__file__).resolve().parents[3] / "fixtures" / "calls"


def load(name: str) -> dict[str, Any]:
    return json.loads((FIXTURES / f"{name}.json").read_text())


# ── the classifier, as a table ──


@pytest.mark.parametrize(
    ("text", "lang", "verdict", "decision"),
    [
        # People pick up.
        ("Hello?", "en", "human", "begin"),
        ("Yeah, Kevin here.", "en", "human", "begin"),
        ("Hi, who's this?", "en", "human", "begin"),
        ("¿Bueno?", "es", "human", "begin"),
        ("Sí, dígame.", "es", "human", "begin"),
        ("Alo, buyrun.", "tr", "human", "begin"),
        # Silence after the pick-up: a person who waits (the agent speaks first).
        (None, "en", None, "begin"),
        ("", "en", "unknown", "begin"),
        # Voicemail greetings: hang up, leave nothing.
        (
            "You've reached Kevin, please leave a message after the tone.",
            "en",
            "machine",
            "hang_up",
        ),
        ("Hi, I can't come to the phone right now.", "en", "machine", "hang_up"),
        ("The person you are calling is not available.", "en", "machine", "hang_up"),
        ("Your call has been forwarded to voice mail.", "en", "machine", "hang_up"),
        ("Deje su mensaje después del tono.", "es", "machine", "hang_up"),
        ("Hola, soy Marco, no puedo atender, deja un mensaje.", "es", "machine", "hang_up"),
        ("Aradığınız kişiye şu anda ulaşılamıyor.", "tr", "machine", "hang_up"),
        ("Lütfen sinyal sesinden sonra mesajınızı bırakın.", "tr", "machine", "hang_up"),
        # An English greeting on a Spanish call is still a greeting.
        ("Leave a message after the beep.", "es", "machine", "hang_up"),
        # A long monologue with no greeting phrase (§19 Q216: UNKNOWN_IS_MACHINE).
        (
            "Hi this is Kevin O'Brien with Kestrel Build Group on the Northgate job and I am "
            "out on the deck right now so I will get back to you as soon as I can thanks",
            "en",
            "unknown",
            "hang_up",
        ),
    ],
)
def test_first_utterance_table(
    text: str | None, lang: str, verdict: str | None, decision: str
) -> None:
    if text is not None:
        assert classify_first_utterance(text, lang) == verdict
    assert outbound_decision(text, lang) == decision


def test_unknown_is_machine_is_the_recommended_default() -> None:
    assert UNKNOWN_IS_MACHINE is True


def test_the_gate_decides_once() -> None:
    gate = OutboundGate("en")
    assert gate.first("Leave a message after the tone.") == "hang_up"
    # A later "Hello?" (the person picking up the machine) changes nothing: the call ended.
    assert gate.first("Hello?") == "hang_up"


# ── the call ──


async def _open(fixture: dict[str, Any], fake: FakeFieldApi) -> tuple[FieldApi, ReportCall]:
    api = FieldApi(base_url=BASE_URL, tool_secret=SECRET, timeout_s=2, retry_delay_s=0)
    auth, started = await api.calls_start(**start_kwargs(fixture))
    assert started.reporter is not None
    call = await ReportCall.open(api, auth, started.reporter, clock=StepClock())
    return api, call


async def test_a_voicemail_greeting_ends_not_reached_with_no_message() -> None:
    fixture = load("northgate-callback-en")
    fake = FakeFieldApi(fixture)
    with fake:
        api, call = await _open(fixture, fake)
        try:
            went_on = await call.screen_outbound(
                "Hi, you've reached Kevin. Leave a message after the beep."
            )
            await call.settle()
        finally:
            await call.aclose()
            await api.aclose()
    assert went_on is False
    [end] = fake.seen("end_call")
    assert end.body["outcome"] == "not_reached"
    assert end.body["metrics"]["answeredBy"] == "machine"
    # Nothing was said on the line (no message left) and the disclosure was never played.
    assert [e for e in call.state.log if e["speaker"] == "agent"] == []
    assert fake.seen("disclosure") == []
    # The greeting is not kept as a reporter line either.
    assert [e for e in call.state.log if e["speaker"] == "reporter"] == []


async def test_a_person_goes_on_to_the_opening() -> None:
    fixture = load("northgate-callback-en")
    fake = FakeFieldApi(fixture)
    with fake:
        api, call = await _open(fixture, fake)
        try:
            assert await call.screen_outbound("Hello?") is True
        finally:
            await call.aclose()
            await api.aclose()
    assert fake.seen("end_call") == []
    assert call.state.metrics.to_contract()["answeredBy"] == "human"


# ── the callback ──


def _callback_fixture() -> dict[str, Any]:
    fixture = copy.deepcopy(load("northgate-callback-en"))
    fixture["queue"] = [
        {
            "route": "schedule_callback",
            "status": 200,
            "body": {"status": "scheduled", "at": "2026-10-12T23:15:00.000Z", "localTime": "18:15"},
        }
    ]
    fixture["reporterTurns"] = [
        "Can you call me back in half an hour? We're in the middle of a pour."
    ]
    fixture["agentTurns"] = [
        {"toolCalls": [{"name": "get_context", "args": {}}]},
        {"toolCalls": [{"name": "schedule_callback", "args": {"minutes": 30}}]},
        {
            "text": "OK, I'll call you back at six fifteen p.m. Goodbye.",
            "toolCalls": [{"name": "end_call", "args": {"outcome": "callback_requested"}}],
        },
        {},
    ]
    return fixture


async def test_a_queued_callback_ends_callback_requested_with_codes_time() -> None:
    replay = await replay_call(_callback_fixture())
    [cb] = replay.fake.seen("schedule_callback")
    assert cb.body["minutes"] == 30
    assert replay.state is not None and replay.state.callback_requested is True
    [end] = replay.fake.seen("end_call")
    assert end.body["outcome"] == "callback_requested"
    # Code's goodbye with field-api's time (the tool's `say`), the time in words (W4-07).
    assert (
        default_copy().line("goodbye_callback_requested", "en", time="18:15")
        == "OK, I'll call you back at six fifteen p.m. Goodbye."
    )


@pytest.mark.parametrize(
    ("body", "line"),
    [
        ({"status": "outside_window", "windowEnd": "20:00"}, "I can only call until 20:00."),
        ({"status": "limit_reached"}, "I can only call you back once a day."),
    ],
)
async def test_a_callback_not_planned_is_said_and_never_claimed(
    body: dict[str, Any], line: str
) -> None:
    fixture = _callback_fixture()
    fixture["queue"] = [{"route": "schedule_callback", "status": 200, "body": body}]
    fixture["agentTurns"][2] = {
        "text": line,
        "toolCalls": [{"name": "end_call", "args": {"outcome": "callback_requested"}}],
    }
    replay = await replay_call(fixture)
    assert replay.state is not None and replay.state.callback_requested is False
    [end] = replay.fake.seen("end_call")
    # The model's word for it does not stand: nothing was queued.
    assert end.body["outcome"] in ("abandoned", "draft_saved")


def test_settle_outcome_keeps_a_callback_only_once_queued() -> None:
    state = CallState(api=None, auth=None, locale="en-US")  # type: ignore[arg-type]
    state.segments.append(object())  # type: ignore[arg-type]
    assert settle_outcome(state, "callback_requested") != "callback_requested"
    state.callback_requested = True
    assert settle_outcome(state, "callback_requested") == "callback_requested"
