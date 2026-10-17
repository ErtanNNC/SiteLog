"""W3-12: the live session per call language, the settled outcome, the turn metrics, and the
disclosure mark at field-api (§19 Q205)."""

from __future__ import annotations

import json
import shutil
from pathlib import Path
from typing import Any

import pytest

from sitelog_voice.config import MissingSettingError, Settings
from sitelog_voice.contract import CONTRACT_DIR, Contract, DraftState
from sitelog_voice.field_api import DISCLOSURE_ROUTE, CallAuth, FieldApi
from sitelog_voice.metrics import MAX_SAMPLES, CallMetrics, TurnTimer
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
    # §19 Q226: every turn's latency and the barge-in's stop time, whole ms.
    assert out["latenciesMs"] == [800, 600]
    assert out["bargeInMs"] == [100]


def test_barge_in_stop_time_only_when_the_agent_stops_for_the_reporter() -> None:
    m = CallMetrics()
    timer = TurnTimer(m)
    # The uninterruptible disclosure: talked over, played to the end; an interruption, no stop.
    timer.agent_started(0.0, interruptible=False)
    timer.reporter_started(2.0)
    timer.agent_stopped(6.0)
    timer.reporter_stopped(6.5)
    # A cough too short to interrupt: the reporter stops first, the line plays on.
    timer.agent_started(7.2)
    timer.reporter_started(8.0)
    timer.reporter_stopped(8.6)
    timer.agent_stopped(11.0)
    # A real barge-in: the audio stops 280 ms after the reporter's speech started.
    timer.agent_started(20.0)
    timer.reporter_started(21.0)
    timer.agent_stopped(21.28)
    timer.reporter_stopped(23.0)
    # Speech that started before the agent's line is not a barge-in on it.
    timer.reporter_started(30.0)
    timer.agent_started(30.5)
    timer.agent_stopped(31.0)
    out = m.to_contract()
    assert out["interruptions"] == 3
    assert out["bargeInMs"] == [280]
    assert out["latenciesMs"] == [700]  # 6.5 → 7.2; the other answers came after a silence


def test_samples_are_capped_rounded_and_non_negative() -> None:
    m = CallMetrics()
    for i in range(MAX_SAMPLES + 50):
        m.agent_answered(end_of_speech_s=0.0, first_audio_s=0.5 + i / 1000)
    m.agent_answered(end_of_speech_s=5.0, first_audio_s=4.0)  # a clock going back: no sample
    m.barge_in_stopped(speech_start_s=1.0, audio_stopped_s=1.2504)
    m.barge_in_stopped(speech_start_s=1.0, audio_stopped_s=0.9)
    out = m.to_contract()
    assert len(out["latenciesMs"]) == MAX_SAMPLES
    assert out["latenciesMs"][:3] == [500, 501, 502]
    assert all(isinstance(v, int) and v >= 0 for v in out["latenciesMs"])
    assert out["bargeInMs"] == [250]
    # The percentiles still see every turn.
    assert out["latencyP95Ms"] == 737  # beyond the first 200 samples


def test_no_samples_are_empty_lists() -> None:
    out = CallMetrics().to_contract()
    assert out["latenciesMs"] == [] and out["bargeInMs"] == []
    assert out["latencyP50Ms"] is None


# ───────────────── the disclosure mark (§19 Q205: field-api's route) ─────────────────


async def test_mark_disclosure_is_sent_with_the_call_token_on_the_real_contract() -> None:
    fixture = load_call_fixture("northgate-call-en")
    call_id = fixture["start"]["request"]["callId"]
    contract = Contract(CONTRACT_DIR)
    assert contract.route(DISCLOSURE_ROUTE).path == "/voice/calls/{callId}/disclosure"
    assert contract.route(DISCLOSURE_ROUTE).call_token
    with FakeFieldApi(fixture, contract=contract) as fake:
        api = FieldApi(
            base_url=BASE_URL, tool_secret=SECRET, timeout_s=2, retry_delay_s=0, contract=contract
        )
        auth, _ = await api.calls_start(room=f"call-{call_id}", transport="web", call_id=call_id)
        assert await api.mark_disclosure(auth) is True
        await api.aclose()
    (mark,) = fake.seen(DISCLOSURE_ROUTE)
    assert mark.status == 200
    assert mark.body == {"callId": call_id}
    assert mark.headers["x-call-token"]


async def test_mark_disclosure_waits_for_its_route_on_an_older_contract(tmp_path: Path) -> None:
    fixture = load_call_fixture("northgate-call-en")
    call_id = fixture["start"]["request"]["callId"]
    # A contract written before the route existed: nothing is sent.
    shutil.copytree(CONTRACT_DIR, tmp_path / "contract")
    index_path = tmp_path / "contract" / "index.json"
    index = json.loads(index_path.read_text())
    del index["routes"][DISCLOSURE_ROUTE]
    index_path.write_text(json.dumps(index))
    contract = Contract(tmp_path / "contract")
    with FakeFieldApi(fixture, contract=contract) as fake:
        api = FieldApi(
            base_url=BASE_URL, tool_secret=SECRET, timeout_s=2, retry_delay_s=0, contract=contract
        )
        auth, _ = await api.calls_start(room=f"call-{call_id}", transport="web", call_id=call_id)
        assert await api.mark_disclosure(auth) is False
        await api.aclose()
    assert [c.route for c in fake.calls] == ["calls_start"]
