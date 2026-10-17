"""W3-14: the special requests on a call, consent on a first call and unknown callers, in text
mode on fakes (`fixtures/calls/{hillcrest-weather-en, friday-edit-en, first-call-consent-en,
first-call-decline-en, unknown-caller-en}.json`).

- a weather day (F12 call): the read-back comes from code; the second `set_day_status` carries the
  reporter's verbatim yes and the read-back's key, the same details, and the seconds the details
  were said at; the call ends `weather_day` only once field-api logged it;
- F10 on a call: `load_report`, the change read back with "Save it?", `save_change` with the
  reporter's words (an unclear answer is asked again), the call ends `edit_applied`;
- consent (§19 Q120): the reporter's answers to the consent question go to `record_consent`, never
  to the model; after a no the call ends with no reporter line in its log;
- an unknown caller (F13, §19 Q124): their words go to `leave_message`, no model, no report tool;
- the model never claims an outcome code did not reach.
"""

from __future__ import annotations

from typing import Any

from livekit.agents import AgentSession

from sitelog_voice.agent import ReportAgent, opening_line
from sitelog_voice.copy import default_copy
from sitelog_voice.field_api import FieldApi
from sitelog_voice.redact import contains_phone
from sitelog_voice.session import CallState
from sitelog_voice.special import UnknownCallerAgent, needs_consent
from tests.conftest import load_call_fixture
from tests.fakes.field_api import BASE_URL, SECRET, FakeFieldApi
from tests.fakes.llm import FakeLLM


async def _replay(
    fixture: dict[str, Any],
) -> tuple[FakeFieldApi, CallState, FakeLLM, str]:
    start = fixture["start"]["request"]
    with FakeFieldApi(fixture) as fake:
        api = FieldApi(base_url=BASE_URL, tool_secret=SECRET, timeout_s=2, retry_delay_s=0)
        try:
            auth, started = await api.calls_start(
                room=start["room"],
                transport=start["transport"],
                from_e164=start.get("from"),
                to_e164=start.get("to"),
                call_id=start.get("callId"),
            )
            assert started.reporter is not None
            state = CallState(api=api, auth=auth, locale=started.reporter.locale)
            state.context = await api.get_context(auth)
            state.consent_needed = needs_consent(state)
            opening = opening_line(state, default_copy(), first_name=started.reporter.first_name)
            fake_llm = FakeLLM(fixture["agentTurns"])
            clock = iter(float(i) for i in range(0, 10_000, 5))
            async with AgentSession(llm=fake_llm) as session:
                await session.start(ReportAgent(state, clock=lambda: next(clock)))
                for turn in fixture["reporterTurns"]:
                    await session.run(user_input=turn)
        finally:
            await api.aclose()
    return fake, state, fake_llm, opening


async def test_a_weather_day_is_logged_only_on_the_yes_to_codes_read_back() -> None:
    fixture = load_call_fixture("hillcrest-weather-en")
    fake, state, fake_llm, _ = await _replay(fixture)
    first, second = (s.body for s in fake.seen("set_day_status"))
    # Step 1: the details as said, with their seconds; no yes yet.
    assert first["details"] == {"since": "11:00", "workersBefore": 12}
    assert "utterance" not in first and "confirmKey" not in first
    # Step 2: the reporter's own words, the read-back's key, the same details and seconds.
    key = fixture["routes"]["set_day_status"][0]["confirmKey"]
    assert second["utterance"] == "Yes."
    assert second["confirmKey"] == key
    assert second["details"] == first["details"]
    assert second["start"] == first["start"]
    # The model said code's read-back, and the call ends weather_day.
    read_back = fixture["routes"]["set_day_status"][0]["confirmation"]
    assert any(read_back in t for t in fake_llm.request_texts())
    assert state.day_logged == "weather_day"
    assert [e.body["outcome"] for e in fake.seen("end_call")] == ["weather_day"]
    for text in fake_llm.request_texts():
        assert not contains_phone(text)


async def test_friday_is_changed_on_a_call_only_after_the_yes_to_save_it() -> None:
    fixture = load_call_fixture("friday-edit-en")
    fake, state, fake_llm, _ = await _replay(fixture)
    load = fake.seen("load_report")[0].body
    assert load["dayReference"] == "Friday"
    fixes = [s.body for s in fake.seen("apply_correction")]
    # Asked again after `pending` with the same words, for the report load_report found.
    assert [f["utterance"] for f in fixes] == ["Apex was seven, not six."] * 2
    assert {f["reportId"] for f in fixes} == {"44444444-0000-4000-8000-000000000001"}
    saves = [s.body for s in fake.seen("save_change")]
    assert [s["utterance"] for s in saves] == ["I guess", "Yes."]
    assert {s["correctionId"] for s in saves} == {"cccccccc-0000-4000-8000-000000000001"}
    assert state.edit_saved is True
    assert [e.body["outcome"] for e in fake.seen("end_call")] == ["edit_applied"]
    # load_report handed the model code's summary and "What should I change?".
    assert any("What should I change?" in t for t in fake_llm.request_texts())


async def test_a_first_caller_is_asked_for_consent_and_code_reads_the_answer() -> None:
    fixture = load_call_fixture("first-call-consent-en")
    fake, state, fake_llm, opening = await _replay(fixture)
    copy = default_copy()
    # The disclosure, then F3's sentence; no report before the yes.
    assert copy.line("recording_notice", "en") in opening
    assert opening.endswith(copy.line("consent_ask", "en"))
    answers = [s.body for s in fake.seen("record_consent")]
    assert [a["utterance"] for a in answers] == ["What's this about?", "Yes."]
    assert all(a["at"] >= 0 for a in answers)
    assert state.consent_needed is False and state.consent_declined is False
    # The model saw nothing until the consent was given: one request, after the yes.
    assert len(fake_llm.requests) == 2
    assert [e.body["outcome"] for e in fake.seen("end_call")] == ["abandoned"]


async def test_a_no_to_the_consent_question_ends_the_call_with_nothing_of_the_reporter() -> None:
    fixture = load_call_fixture("first-call-decline-en")
    fake, state, fake_llm, _ = await _replay(fixture)
    assert [a.body["utterance"] for a in fake.seen("record_consent")] == ["No, thanks."]
    assert state.consent_declined is True
    assert fake_llm.requests == []  # never reached a model
    (end,) = fake.seen("end_call")
    assert end.body["outcome"] == "abandoned"
    assert all(e["speaker"] == "agent" for e in end.body["dialogLog"])
    assert fake.seen("update_draft") == []


async def test_an_unknown_caller_leaves_a_message_and_no_model_is_involved() -> None:
    fixture = load_call_fixture("unknown-caller-en")
    start = fixture["start"]["request"]
    with FakeFieldApi(fixture) as fake:
        api = FieldApi(base_url=BASE_URL, tool_secret=SECRET, timeout_s=2, retry_delay_s=0)
        try:
            auth, started = await api.calls_start(
                room=start["room"],
                transport="pstn",
                from_e164=start["from"],
                to_e164=start["to"],
            )
            assert started.unknown is True and started.locale == "en-US"
            fake_llm = FakeLLM([])
            agent = UnknownCallerAgent(api, auth, started.locale or "en-US")
            async with AgentSession(llm=fake_llm) as session:
                await session.start(agent)
                await session.run(user_input=fixture["reporterTurns"][0])
                # A second turn (or the 60-s cap) changes nothing: the message is left once.
                await agent.leave_message()
        finally:
            await api.aclose()
    (msg,) = fake.seen("leave_message")
    assert msg.body["utterance"] == fixture["reporterTurns"][0]
    (end,) = fake.seen("end_call")
    assert end.body["outcome"] == "abandoned"
    assert fake_llm.requests == []
    assert {c.route for c in fake.calls} == {"calls_start", "leave_message", "end_call"}


async def test_the_model_cannot_claim_a_day_off_or_a_saved_change() -> None:
    fixture = load_call_fixture("smoke-get-context")
    fixture = {
        **fixture,
        "agentTurns": [{"toolCalls": [{"name": "end_call", "args": {"outcome": "weather_day"}}]}],
    }
    fake, state, _, _ = await _replay(fixture)
    assert state.day_logged is None
    assert [e.body["outcome"] for e in fake.seen("end_call")] == ["abandoned"]
