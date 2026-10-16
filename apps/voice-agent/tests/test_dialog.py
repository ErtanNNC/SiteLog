"""§7.3 call dialog states: every edge of the diagram, the limits and the silences."""

from __future__ import annotations

import pytest

from sitelog_voice.copy import default_copy
from sitelog_voice.dialog import TRANSITIONS, CallTool, Dialog, EndCall, Event, Say, State


def walk(*events: Event, start: float = 0.0) -> Dialog:
    d = Dialog()
    t = start
    for e in events:
        t += 1
        d.on(e, t)
    return d


HAPPY = (
    Event.ANSWERED,
    Event.DISCLOSURE_PLAYED,
    Event.SITE_KNOWN,
    Event.MISSING_ITEM,
    Event.ANSWER_HEARD,
    Event.NOTHING_MISSING,
    Event.READ_BACK_DONE,
    Event.CHANGE_REQUESTED,
    Event.CHANGE_APPLIED,
    Event.READ_BACK_DONE,
    Event.CONFIRMED,
)


def test_every_edge_of_the_diagram() -> None:
    edges = {(s, e, t) for s, row in TRANSITIONS.items() for e, t in row.items()}
    assert (State.CONNECTING, Event.NO_ANSWER, State.NOT_REACHED) in edges
    assert (State.IDENTIFY, Event.SEVERAL_SITES, State.PICK_SITE) in edges
    assert (State.LISTENING, Event.SPECIAL_INTENT, State.SPECIAL) in edges
    assert (State.CONFIRM, Event.CONFIRMED, State.FILED) in edges
    assert (State.FIXING, Event.CHANGE_APPLIED, State.READ_BACK) in edges
    assert len(edges) == 17
    for state, event, target in edges:
        d = Dialog(state=state)
        d.on(event, 1.0)
        assert d.state is target


def test_happy_path_with_a_question_and_a_fix() -> None:
    d = walk(*HAPPY)
    assert d.state is State.FILED
    assert [h[3] for h in d.history] == [
        State.DISCLOSURE,
        State.IDENTIFY,
        State.LISTENING,
        State.CLARIFYING,
        State.LISTENING,
        State.READ_BACK,
        State.CONFIRM,
        State.FIXING,
        State.READ_BACK,
        State.CONFIRM,
        State.FILED,
    ]
    assert d.on(Event.FILED_MESSAGE_SENT, 30) == [Say("goodbye_filed"), EndCall("filed")]
    assert d.state is State.GOODBYE
    assert d.on(Event.SPEECH, 31) == [] and d.tick(999) == []


def test_filing_only_from_confirm() -> None:
    for state in State:
        if state in (State.CONFIRM, State.FILED):
            continue
        d = Dialog(state=state)
        d.on(Event.CONFIRMED, 1.0)
        assert d.state is not State.FILED


def test_entering_confirm_asks_to_file() -> None:
    d = walk(Event.ANSWERED, Event.DISCLOSURE_PLAYED, Event.SITE_KNOWN, Event.NOTHING_MISSING)
    assert d.on(Event.READ_BACK_DONE, 10) == [Say("confirm_ask")]


def test_not_reached_ends_the_call() -> None:
    d = Dialog()
    assert d.on(Event.NO_ANSWER, 5) == [EndCall("not_reached")]
    assert d.state is State.NOT_REACHED


def test_silence_then_second_silence_saves_the_draft() -> None:
    d = walk(Event.ANSWERED, Event.DISCLOSURE_PLAYED, Event.SITE_KNOWN)  # listening at t=3
    assert d.tick(5.9) == []
    assert d.tick(6.0) == [Say("backchannel")]  # 3 s quiet mid-report
    assert d.tick(7.0) == []  # once per quiet spell
    assert d.tick(11.0) == [Say("silence_prompt")]  # 8 s
    assert d.tick(18.9) == []
    assert d.tick(19.0) == [Say("silence_goodbye"), EndCall("draft_saved")]
    assert d.state is State.GOODBYE


def test_speech_resets_the_silences() -> None:
    d = walk(Event.ANSWERED, Event.DISCLOSURE_PLAYED, Event.SITE_KNOWN)  # listening at t=3
    assert d.tick(6.0) == [Say("backchannel")]
    assert d.tick(11.0) == [Say("silence_prompt")]
    d.on(Event.SPEECH, 12.0)
    assert d.silences == 0
    assert d.tick(15.0) == [Say("backchannel")]
    assert d.tick(20.0) == [Say("silence_prompt")]  # a first silence again, not the goodbye
    assert d.state is State.LISTENING


def test_silence_before_the_site_is_known_abandons() -> None:
    d = walk(Event.ANSWERED, Event.DISCLOSURE_PLAYED)  # identify at t=2
    d.tick(10)
    assert d.tick(18) == [Say("silence_goodbye"), EndCall("abandoned")]


def test_ten_minute_warning_and_twelve_minute_end() -> None:
    d = walk(Event.ANSWERED, Event.DISCLOSURE_PLAYED, Event.SITE_KNOWN)
    d.on(Event.SPEECH, 599.0)
    assert d.tick(600.0) == [Say("time_warning")]
    d.on(Event.SPEECH, 601.0)
    assert d.tick(602.0) == []
    d.on(Event.SPEECH, 719.0)
    assert d.tick(720.0) == [Say("goodbye_draft_saved"), EndCall("draft_saved")]


def test_two_failed_understandings_start_the_fallback() -> None:
    d = walk(Event.ANSWERED, Event.DISCLOSURE_PLAYED, Event.SITE_KNOWN)
    assert d.on(Event.NOT_UNDERSTOOD, 5) == []
    d.on(Event.UNDERSTOOD, 6)
    assert d.on(Event.NOT_UNDERSTOOD, 7) == []
    assert d.on(Event.NOT_UNDERSTOOD, 8) == [Say("fallback"), CallTool("start_fallback_recording")]
    assert d.state is State.FALLBACK_RECORDING
    assert d.tick(100) == []  # no silence prompts while recording
    assert d.on(Event.HANG_UP, 200) == [EndCall("fallback_recording")]
    assert d.state is State.GOODBYE


def test_agent_error_falls_back_at_once() -> None:
    d = walk(Event.ANSWERED, Event.DISCLOSURE_PLAYED, Event.SITE_KNOWN, Event.MISSING_ITEM)
    assert d.on(Event.AGENT_ERROR, 9) == [Say("fallback"), CallTool("start_fallback_recording")]


def test_fallback_hits_the_cap_with_its_own_outcome() -> None:
    d = walk(Event.ANSWERED, Event.DISCLOSURE_PLAYED, Event.SITE_KNOWN, Event.AGENT_ERROR)
    assert d.tick(720) == [Say("goodbye_fallback_recording"), EndCall("fallback_recording")]


@pytest.mark.parametrize(
    ("events", "outcome"),
    [
        ((Event.ANSWERED,), "abandoned"),
        ((Event.ANSWERED, Event.DISCLOSURE_PLAYED, Event.SITE_KNOWN), "draft_saved"),
        (HAPPY, "filed"),
    ],
)
def test_hang_up_outcome(events: tuple[Event, ...], outcome: str) -> None:
    d = walk(*events)
    assert d.on(Event.HANG_UP, 100) == [EndCall(outcome)]


def test_every_spoken_key_is_copy() -> None:
    keys = default_copy().keys("en")
    for key in (
        "backchannel",
        "silence_prompt",
        "silence_goodbye",
        "time_warning",
        "fallback",
        "confirm_ask",
        "goodbye_filed",
        "goodbye_draft_saved",
        "goodbye_abandoned",
        "goodbye_fallback_recording",
    ):
        assert key in keys
