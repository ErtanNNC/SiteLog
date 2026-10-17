"""Every recorded call in `fixtures/calls/*.json`, end to end in text mode (W3-12, W3-15).

Generic over the directory: a new script in the existing format (`start`, `routes`,
`reporterTurns`, `agentTurns`; optional `filing`, `corrections`, `answers`) is replayed without a
change here. Each runs through the agent's own call code (`tests/harness.py` → `ReportCall`) on
`FakeFieldApi` and `FakeLLM`, and must hold, whatever the call is about:

- **disclosure first**: the first thing said is the opening with the recording notice, and no
  request but `calls/start` and `get_context` reached field-api before it had been played;
- **no phone number** in any request to the dialog model, nor the caller's number anywhere in
  them, nor in a line the agent's own loggers wrote;
- **filed only after a yes**: every `file_report` carries the reporter's words verbatim (their last
  turn, never the model's) and a revision field-api read back earlier; the call is `filed` exactly
  when field-api answered `filed`, and only then ends `filed`;
- every `record_answer` answers a question field-api asked on this call;
- the script ran to its end (every recorded model turn used) and the call ended once.
"""

from __future__ import annotations

import json
import logging
from pathlib import Path
from typing import Any

import pytest

from sitelog_voice.copy import default_copy, language_of
from sitelog_voice.redact import contains_phone
from tests.conftest import CALL_FIXTURES
from tests.harness import Replay, replay_call

FIXTURES = sorted(CALL_FIXTURES.glob("*.json"))
SPEECH_ROUTES_OK_BEFORE_DISCLOSURE = {"calls_start", "get_context"}


def _load(path: Path) -> dict[str, Any]:
    return json.loads(path.read_text(encoding="utf-8"))


@pytest.fixture(params=FIXTURES, ids=[p.stem for p in FIXTURES])
async def run(request: pytest.FixtureRequest) -> Replay:
    return await replay_call(_load(request.param))


def test_the_directory_has_scripts() -> None:
    assert len(FIXTURES) >= 10  # W3-09 … W3-14's recorded calls; W3-15 adds more


def test_disclosure_first(run: Replay) -> None:
    locale = run.fixture["start"]["response"].get("reporter", {}).get("locale") or run.fixture[
        "start"
    ]["response"].get("locale", "en-US")
    notice = default_copy().line("recording_notice", language_of(locale))
    assert notice in run.opening
    log = run.state.log if run.state else (run.unknown.log if run.unknown else [])
    assert log and log[0]["speaker"] == "agent" and notice in log[0]["text"]
    if run.state is not None:
        assert run.state.disclosure_played
    early = {c.route for c in run.fake.calls[: run.requests_before_disclosure]}
    assert early <= SPEECH_ROUTES_OK_BEFORE_DISCLOSURE


def test_no_phone_number_reaches_the_model_or_the_logs(run: Replay) -> None:
    caller = run.fixture["start"]["request"].get("from")
    for text in run.llm.request_texts():
        assert not contains_phone(text), text
        if caller:
            assert caller not in text and caller.lstrip("+") not in text
    for record in run.logs:
        if not record.name.startswith("sitelog_voice"):
            continue
        line = f"{record.getMessage()} {_extras(record)}"
        assert not contains_phone(line), line
        if caller:
            assert caller not in line


def _extras(record: logging.LogRecord) -> str:
    skip = set(vars(logging.makeLogRecord({})))
    return json.dumps({k: str(v) for k, v in vars(record).items() if k not in skip})


def test_filed_only_after_a_yes(run: Replay) -> None:
    turns: list[str] = run.fixture.get("reporterTurns", [])
    read_back_revs: set[int] = set()
    filed = False
    for seen in run.fake.calls:
        answer = seen.answer if isinstance(seen.answer, dict) else {}
        draft = answer.get("draft") if seen.route != "update_draft" else answer
        if isinstance(draft, dict) and draft.get("readBack"):
            read_back_revs.add(draft["draftRev"])
        if seen.route == "apply_correction" and answer.get("readBack") and draft:
            read_back_revs.add(draft["draftRev"])
        if seen.route == "file_report":
            # The reporter's own words, as heard, and a revision that was read back to them.
            assert seen.body["utterance"] in turns
            assert seen.body["draftRev"] in read_back_revs
            if answer.get("status") == "filed":
                filed = True
    if run.state is not None:
        assert run.state.filed is filed
    ends = [s.body["outcome"] for s in run.fake.seen("end_call")]
    assert ("filed" in ends) is filed
    if "filing" in run.fixture:
        filings = run.fake.seen("file_report")
        assert [f.body["utterance"] for f in filings] == [
            s["utterance"] for s in run.fixture["filing"]
        ]
    if "corrections" in run.fixture:
        fixes = run.fake.seen("apply_correction")
        assert [f.body["utterance"] for f in fixes] == run.fixture["corrections"]


def test_answers_go_to_questions_this_call_asked(run: Replay) -> None:
    asked: set[str] = set()
    for seen in run.fake.calls:
        answer = seen.answer if isinstance(seen.answer, dict) else {}
        draft = answer.get("draft") if seen.route != "update_draft" else answer
        if seen.route == "record_answer":
            assert seen.body["questionId"] in asked
            assert seen.body["utterance"] in run.fixture["reporterTurns"]
        if isinstance(draft, dict) and draft.get("question"):
            asked.add(draft["question"]["id"])
    if "answers" in run.fixture:
        got = [s.body["utterance"] for s in run.fake.seen("record_answer")]
        assert got == run.fixture["answers"]


def test_the_script_ran_to_its_end_and_the_call_ended_once(run: Replay) -> None:
    assert run.llm.remaining == 0
    assert len(run.fake.seen("end_call")) == 1
    assert all(c.status < 400 for c in run.fake.calls), [
        (c.route, c.status) for c in run.fake.calls
    ]
