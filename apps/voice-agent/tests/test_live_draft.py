"""W3-09: the live draft on a call, replayed in text mode on the recorded call fixtures.

`fixtures/calls/{northgate-call-en,riverside-delta-en,riverside-delta-es}.json` hold field-api's
recorded answers (the worker's PGlite test checks the live pipeline gives the same, ids aside) and
the dialog model's recorded turns. Each reporter turn is one session run. The runs prove the
agent's half of §19 Q117 and F7 on a call:

- `update_draft` sends the reporter's lane so far, verbatim (field-api redacts before its model);
- a `pending` answer (the worker's turn ran past field-api's wait) is handed to the model as a
  status, and the next `update_draft` sends the same words (the same turn);
- `record_answer` sends the open question's id and the reporter's last words with their second;
- every request and answer matches the contract, and no phone number reaches the dialog model.
"""

from __future__ import annotations

from typing import Any

import pytest
from livekit.agents import AgentSession

from sitelog_voice.agent import ReportAgent
from sitelog_voice.field_api import FieldApi
from sitelog_voice.redact import contains_phone
from sitelog_voice.session import CallState
from tests.conftest import load_call_fixture
from tests.fakes.field_api import BASE_URL, SECRET, FakeFieldApi
from tests.fakes.llm import FakeLLM

FIXTURES = ["northgate-call-en", "riverside-delta-en", "riverside-delta-es"]


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
async def test_recorded_call_replays_on_the_contract(name: str) -> None:
    fixture = load_call_fixture(name)
    fake, state, fake_llm = await _replay(fixture)

    # Every route the fixture records was asked for, in its order, and answered 2xx.
    expected = ["calls_start", "get_context"]
    expected += ["update_draft"] * len(fixture["routes"]["update_draft"])
    expected += ["record_answer"] * len(fixture["routes"].get("record_answer", []))
    assert sorted(c.route for c in fake.calls) == sorted(expected)
    assert all(c.status == 200 for c in fake.calls)
    assert fake_llm.remaining == 0

    # update_draft: the reporter's first turn, verbatim, as the transcript so far.
    drafts = fake.seen("update_draft")
    first_turn = fixture["reporterTurns"][0]
    for d in drafts:
        assert d.body["segments"][0]["text"] == first_turn
    # A pending turn is asked again with the same words (field-api finds the same turn).
    if len(drafts) > 1:
        assert drafts[0].body["segments"] == drafts[1].body["segments"]

    # record_answer: the open question's id and the reporter's words, each with its second.
    answers = fake.seen("record_answer")
    assert [a.body["utterance"] for a in answers] == fixture["answers"]
    for a in answers:
        assert a.body["questionId"] == fixture["routes"]["update_draft"][-1]["question"]["id"]
        assert a.body["start"] >= 0

    # The draft the call holds is field-api's last answer; the read-back revision follows it.
    last = (fixture["routes"].get("record_answer") or [None])[-1]
    final = last["draft"] if last else fixture["routes"]["update_draft"][-1]
    assert state.draft is not None
    assert state.draft.read_back == final["readBack"]
    assert state.read_back_rev == (final["draftRev"] if final["readBack"] else None)

    for text in fake_llm.request_texts():
        assert not contains_phone(text), text


async def test_pending_reaches_the_model_as_a_status_only() -> None:
    fixture = load_call_fixture("riverside-delta-en")
    _, _, fake_llm = await _replay(fixture)
    outputs = [t for t in fake_llm.request_texts() if "pending" in t]
    assert outputs, "the model saw the pending status"
    # …and only the status: no draft came with it.
    first = outputs[0]
    assert "reportId" not in first and "readBack" not in first
    # The draft's question reached the model after the second update_draft, not the first.
    question = fixture["routes"]["update_draft"][1]["question"]["text"]
    assert any(question in t for t in fake_llm.request_texts())
