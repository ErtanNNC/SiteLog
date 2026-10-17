"""W3-12: the live session per call language, the settled outcome, the turn metrics, and the
disclosure mark at field-api (built ahead of its route)."""

from __future__ import annotations

import json
import shutil
from pathlib import Path
from typing import Any

import pytest

from sitelog_voice.config import MissingSettingError, Settings
from sitelog_voice.contract import CONTRACT_DIR, Contract, DraftState
from sitelog_voice.field_api import DISCLOSURE_ROUTE, CallAuth, FieldApi
from sitelog_voice.metrics import CallMetrics, TurnTimer
from sitelog_voice.session import (
    BARGE_IN_MIN_SPEECH_S,
    END_OF_TURN_LONG_S,
    END_OF_TURN_MIN_S,
    CallState,
    Segment,
    build_live_session,
    noise_cancellation,
    room_options,
    settle_outcome,
    turn_handling,
)
from tests.conftest import load_call_fixture
from tests.fakes.field_api import BASE_URL, SECRET, FakeFieldApi

KEYS: dict[str, Any] = {
    "DEEPGRAM_API_KEY": "dg-placeholder",
    "ANTHROPIC_API_KEY": "sk-placeholder",
    "CLAUDE_MODEL_FAST": "model-from-env",
    "AZURE_SPEECH_KEY": "az-placeholder",
}


def _settings(**env: Any) -> Settings:
    return Settings(_env_file=None, **env)  # type: ignore[call-arg]


@pytest.mark.filterwarnings("ignore:A test tried to use socket")
@pytest.mark.parametrize(
    ("locale", "stt_language", "tts"),
    [("en-US", "multi", "deepgram"), ("es-US", "multi", "deepgram"), ("tr-TR", "tr", "azure")],
)
async def test_live_session_assembles_per_language_without_a_network(
    locale: str, stt_language: str, tts: str
) -> None:
    session = build_live_session(
        _settings(**KEYS), locale=locale, keyterms=["Apex Concrete", "post-tension"]
    )
    assert type(session.tts).__module__.split(".")[2] == tts
    assert session.stt is not None and session.llm is not None
    stt_opts = session.stt._opts  # type: ignore[union-attr]
    assert stt_opts.language == stt_language
    assert stt_opts.keyterm == ["Apex Concrete", "post-tension"]
    assert session.llm.model == "model-from-env"  # type: ignore[union-attr]
    handling: dict[str, Any] = dict(session.options.turn_handling)
    assert handling["endpointing"]["mode"] == "dynamic"
    assert handling["interruption"]["enabled"] is True
    assert handling["preemptive_generation"]["enabled"] is False


@pytest.mark.parametrize(
    ("missing", "locale"),
    [
        ("DEEPGRAM_API_KEY", "en-US"),
        ("ANTHROPIC_API_KEY", "en-US"),
        ("CLAUDE_MODEL_FAST", "es-US"),
        ("AZURE_SPEECH_KEY", "tr-TR"),
    ],
)
def test_no_provider_is_built_without_its_key(missing: str, locale: str) -> None:
    env = {k: v for k, v in KEYS.items() if k != missing}
    with pytest.raises(MissingSettingError, match=missing):
        build_live_session(_settings(**env), locale=locale, keyterms=[])


def test_turn_handling_follows_section_9_4() -> None:
    handling: dict[str, Any] = dict(turn_handling())
    assert handling["endpointing"] == {
        "mode": "dynamic",
        "min_delay": END_OF_TURN_MIN_S,
        "max_delay": END_OF_TURN_LONG_S,
    }
    assert (END_OF_TURN_MIN_S, END_OF_TURN_LONG_S) == (1.5, 2.5)
    assert handling["interruption"]["min_duration"] == BARGE_IN_MIN_SPEECH_S < 0.3


def test_noise_cancellation_is_optional_until_livekit_cloud() -> None:
    # `livekit-plugins-noise-cancellation` is not in the lock (§19 Q204): the room's own input.
    assert noise_cancellation("pstn") is None
    assert noise_cancellation("web") is None


def test_the_room_closes_with_the_caller_and_drops_the_line_with_the_agent() -> None:
    options = room_options("pstn")
    assert options.close_on_disconnect is True
    assert options.delete_room_on_close is True


# ─────────────────────────────── the settled outcome ───────────────────────────────


def _state(**kw: Any) -> CallState:
    state = CallState(api=None, auth=CallAuth("c", "t"), locale="en-US")  # type: ignore[arg-type]
    for k, v in kw.items():
        setattr(state, k, v)
    return state


DRAFT = DraftState(report_id="r", draft_rev=1, missing=[], question=None, read_back="x")
HEARD = [Segment(1, 2, "Apex had three.")]


@pytest.mark.parametrize(
    ("kw", "asked", "settled"),
    [
        ({}, "filed", "abandoned"),
        ({"segments": HEARD}, "filed", "draft_saved"),
        ({"filed": True}, "draft_saved", "filed"),  # a hang-up right after the yes
        ({"filed": True}, "abandoned", "filed"),
        ({"draft": DRAFT}, "weather_day", "draft_saved"),
        ({}, "weather_day", "abandoned"),
        ({"day_logged": "weather_day"}, "draft_saved", "weather_day"),
        ({}, "edit_applied", "abandoned"),
        ({"edit_saved": True}, "abandoned", "edit_applied"),
        ({"draft": DRAFT}, "callback_requested", "draft_saved"),
        ({"fallback": True}, "draft_saved", "fallback_recording"),
        ({"consent_declined": True, "segments": HEARD}, "draft_saved", "abandoned"),
        ({"segments": HEARD}, "abandoned", "abandoned"),
    ],
)
def test_settle_outcome(kw: dict[str, Any], asked: str, settled: str) -> None:
    assert settle_outcome(_state(**kw), asked) == settled


# ─────────────────────────────── turn metrics ───────────────────────────────


def test_turn_timer_latency_and_barge_in() -> None:
    m = CallMetrics()
    timer = TurnTimer(m)
    timer.reporter_started(1.0)
    timer.reporter_stopped(9.0)
    timer.agent_started(9.8)  # 800 ms
    timer.reporter_started(10.5)  # barge-in
    timer.agent_stopped(10.6)
    timer.reporter_stopped(12.0)
    timer.agent_started(12.6)  # 600 ms
    timer.agent_stopped(14.0)
    timer.agent_started(40.0)  # a silence prompt, not an answer
    out = m.to_contract()
    assert out["latencyP50Ms"] == 600 and out["latencyP95Ms"] == 800
    assert out["interruptions"] == 1


# ───────────────── the disclosure mark (§19 Q205: field-api's half to come) ─────────────────


async def test_mark_disclosure_waits_for_its_route(tmp_path: Path) -> None:
    fixture = load_call_fixture("northgate-call-en")
    call_id = fixture["start"]["request"]["callId"]
    # Today's contract has no such route: nothing is sent.
    with FakeFieldApi(fixture) as fake:
        api = FieldApi(base_url=BASE_URL, tool_secret=SECRET, timeout_s=2, retry_delay_s=0)
        auth, _ = await api.calls_start(room=f"call-{call_id}", transport="web", call_id=call_id)
        assert await api.mark_disclosure(auth) is False
        await api.aclose()
    assert [c.route for c in fake.calls] == ["calls_start"]

    # A contract with the route (as `pnpm voice:contract` would write it): sent with the token.
    shutil.copytree(CONTRACT_DIR, tmp_path / "contract")
    index_path = tmp_path / "contract" / "index.json"
    index = json.loads(index_path.read_text())
    index["routes"][DISCLOSURE_ROUTE] = {
        "method": "POST",
        "path": "/voice/calls/{callId}/disclosure",
        "request": "tool_get_context_request",
        "response": "tool_end_call_response",
        "callToken": True,
    }
    index_path.write_text(json.dumps(index))
    contract = Contract(tmp_path / "contract")
    fixture = {**fixture, "routes": {**fixture["routes"], DISCLOSURE_ROUTE: [{"ok": True}]}}
    with FakeFieldApi(fixture, contract=contract) as fake:
        api = FieldApi(
            base_url=BASE_URL, tool_secret=SECRET, timeout_s=2, retry_delay_s=0, contract=contract
        )
        auth, _ = await api.calls_start(room=f"call-{call_id}", transport="web", call_id=call_id)
        assert await api.mark_disclosure(auth) is True
        await api.aclose()
    (mark,) = fake.seen(DISCLOSURE_ROUTE)
    assert mark.body == {"callId": call_id}
    assert mark.headers["x-call-token"]
