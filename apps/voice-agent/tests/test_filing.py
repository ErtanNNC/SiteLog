"""W3-10: the read-back, a correction and the spoken yes on a call, replayed in text mode.

`fixtures/calls/{northgate-file-en,northgate-stale-en,riverside-fix-en}.json` hold field-api's
recorded answers (field-api's Deno test replays each `filing` step through the confirm grammar,
the worker's PGlite test checks the live pipeline for `riverside-fix-en`) and the dialog model's
recorded turns. The runs prove the agent's half of §19 Q119 and F8 on a call:

- `file_report` sends the reporter's verbatim last words and the revision that was read back;
  the model passes no "yes" of its own;
- a refusal (`not_confirmed`) reaches the model with code's "Shall I file it? Say yes or no.";
- `draft_changed` hands the model the new read-back, and the next yes names the new revision;
- `pending` is asked again with the same words; the call is `filed` only on field-api's `filed`;
- `apply_correction` sends the reporter's words and their second, and the yes after it names the
  revision of the change it read back;
- no phone number reaches the dialog model.
"""

from __future__ import annotations

from typing import Any

import pytest
from livekit.agents import AgentSession

from sitelog_voice.agent import ReportAgent
from sitelog_voice.copy import default_copy
from sitelog_voice.field_api import FieldApi
from sitelog_voice.redact import contains_phone
from sitelog_voice.session import CallState
from tests.conftest import load_call_fixture
from tests.fakes.field_api import BASE_URL, SECRET, FakeFieldApi
from tests.fakes.llm import FakeLLM

FIXTURES = ["northgate-file-en", "northgate-stale-en", "riverside-fix-en"]


async def _replay(fixture: dict[str, Any]) -> tuple[FakeFieldApi, CallState, FakeLLM]:
    start = fixture["start"]["request"]
    with FakeFieldApi(fixture) as fake:
        api = FieldApi(base_url=BASE_URL, tool_secret=SECRET, timeout_s=2, retry_delay_s=0)
        try:
            auth, started = await api.calls_start(
                room=start["room"], transport=start["transport"], call_id=start["callId"]
            )
            assert started.reporter is not None
            state = CallState(api=api, auth=auth, locale=started.reporter.locale)
            fake_llm = FakeLLM(fixture["agentTurns"])
            clock = iter(float(i) for i in range(0, 10_000, 5))
            async with AgentSession(llm=fake_llm) as session:
                await session.start(ReportAgent(state, clock=lambda: next(clock)))
                for turn in fixture["reporterTurns"]:
                    await session.run(user_input=turn)
        finally:
            await api.aclose()
    return fake, state, fake_llm


@pytest.mark.parametrize("name", FIXTURES)
async def test_filing_replays_on_the_contract(name: str) -> None:
    fixture = load_call_fixture(name)
    fake, state, fake_llm = await _replay(fixture)

    # Every file_report carries the reporter's words as heard and a revision field-api read back.
    filings = fake.seen("file_report")
    assert [f.body["utterance"] for f in filings] == [s["utterance"] for s in fixture["filing"]]
    assert [f.body["draftRev"] for f in filings] == [s["draftRev"] for s in fixture["filing"]]
    assert all(set(f.body) == {"callId", "reportId", "draftRev", "utterance"} for f in filings)

    # apply_correction: the reporter's words with their second.
    fixes = fake.seen("apply_correction")
    assert [f.body["utterance"] for f in fixes] == fixture["corrections"]
    assert all(f.body["start"] >= 0 for f in fixes)

    # Filed only on field-api's `filed`, and the call ends `filed`.
    assert state.filed is True
    ends = fake.seen("end_call")
    assert [e.body["outcome"] for e in ends] == ["filed"]
    assert fake_llm.remaining == 0
    for text in fake_llm.request_texts():
        assert not contains_phone(text), text


async def test_a_refused_yes_reaches_the_model_as_codes_line() -> None:
    fixture = load_call_fixture("northgate-file-en")
    _, _, fake_llm = await _replay(fixture)
    ask_again = default_copy().line("confirm_repeat", "en")
    outputs = [t for t in fake_llm.request_texts() if "not_confirmed" in t]
    assert outputs and ask_again in outputs[0]
    # The pending filing was asked again, and only the second answer filed.
    goodbye = default_copy().line("goodbye_filed", "en")
    assert any(goodbye in t for t in fake_llm.request_texts())


async def test_draft_changed_hands_over_the_new_read_back() -> None:
    fixture = load_call_fixture("northgate-stale-en")
    _, state, fake_llm = await _replay(fixture)
    changed = fixture["routes"]["file_report"][0]["draft"]
    assert any("draft_changed" in t and changed["readBack"] in t for t in fake_llm.request_texts())
    assert state.read_back_rev == changed["draftRev"]


async def test_the_yes_after_a_correction_names_the_corrected_revision() -> None:
    fixture = load_call_fixture("riverside-fix-en")
    fake, _, fake_llm = await _replay(fixture)
    fixed = fixture["routes"]["apply_correction"][0]
    assert fake.seen("file_report")[0].body["draftRev"] == fixed["draft"]["draftRev"]
    # The model saw only the change read back, code's words.
    assert any(fixed["readBack"] in t for t in fake_llm.request_texts())


async def test_no_yes_without_a_read_back() -> None:
    """`file_report` before any read-back is refused by the agent itself (no request)."""
    fixture = load_call_fixture("northgate-file-en")
    fixture = {**fixture, "reporterTurns": [], "agentTurns": []}
    fake, state, _ = await _replay(fixture)
    assert state.read_back_rev is None
    assert fake.seen("file_report") == []
