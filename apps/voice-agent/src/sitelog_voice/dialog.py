"""Spec §7.3 "Call dialog states" as a pure state machine: no I/O, no clock of its own.

The agent feeds it events (what happened on the call) and the time (`now`, seconds since the call
connected); it answers with the new state and the actions code must take (say a copy line, call a
tool, end the call). Timers are checked on `tick(now)`:

- silence: 8 s without speech → "Are you still there?"; a second silence → save the draft and end
  (`draft_saved`, the link message is field-api's / the worker's job, §7.2);
- back-channel after 3 s of silence while the reporter is mid-report (§9.4 rule 1);
- call length: warning at 10 min, end at 12 min;
- two failed understandings in a row → the F6 simple recording mode (§9.4 rule 9).

Filing is never the model's decision (CLAUDE.md, §19 Q119): `filed` is reached only from `confirm`
on `Event.CONFIRMED`, which the agent raises after field-api's `file_report` answered `filed`
(code there checks the verbatim utterance against §9.5's confirm words).

W3-02 lays the machine and its table down; W3-12 drives it from `agent.py`.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from enum import StrEnum


class State(StrEnum):
    CONNECTING = "connecting"
    NOT_REACHED = "not_reached"
    DISCLOSURE = "disclosure"
    IDENTIFY = "identify"
    PICK_SITE = "pick_site"
    LISTENING = "listening"
    CLARIFYING = "clarifying"
    READ_BACK = "read_back"
    CONFIRM = "confirm"
    FIXING = "fixing"
    SPECIAL = "special"
    FILED = "filed"
    FALLBACK_RECORDING = "fallback_recording"
    GOODBYE = "goodbye"


class Event(StrEnum):
    ANSWERED = "answered"  # a person answered (outbound) or the call connected (inbound, web)
    NO_ANSWER = "no_answer"  # no answer / busy / voicemail (outbound)
    DISCLOSURE_PLAYED = "disclosure_played"
    SITE_KNOWN = "site_known"
    SEVERAL_SITES = "several_sites"
    SITE_PICKED = "site_picked"
    MISSING_ITEM = "missing_item"  # update_draft returned a question
    ANSWER_HEARD = "answer_heard"
    NOTHING_MISSING = "nothing_missing"  # update_draft returned a read-back
    READ_BACK_DONE = "read_back_done"
    CONFIRMED = "confirmed"  # file_report answered `filed` (code decided, §19 Q119)
    CHANGE_REQUESTED = "change_requested"
    CHANGE_APPLIED = "change_applied"
    SPECIAL_INTENT = "special_intent"  # no work / rained out / call me later / edit Friday
    SPECIAL_DONE = "special_done"
    FILED_MESSAGE_SENT = "filed_message_sent"
    NOT_UNDERSTOOD = "not_understood"  # STT or the dialog failed to make sense of a turn
    UNDERSTOOD = "understood"  # any turn that made sense resets the failure count
    AGENT_ERROR = "agent_error"
    SPEECH = "speech"  # the reporter spoke (resets the silence clock)
    AGENT_SPOKE = "agent_spoke"  # the agent finished a line (the silence clock starts again)
    HANG_UP = "hang_up"


#: §7.3's diagram, edge by edge. Events not listed for a state are ignored there.
TRANSITIONS: dict[State, dict[Event, State]] = {
    State.CONNECTING: {Event.ANSWERED: State.DISCLOSURE, Event.NO_ANSWER: State.NOT_REACHED},
    State.DISCLOSURE: {Event.DISCLOSURE_PLAYED: State.IDENTIFY},
    State.IDENTIFY: {Event.SITE_KNOWN: State.LISTENING, Event.SEVERAL_SITES: State.PICK_SITE},
    State.PICK_SITE: {Event.SITE_PICKED: State.LISTENING},
    State.LISTENING: {
        Event.MISSING_ITEM: State.CLARIFYING,
        Event.NOTHING_MISSING: State.READ_BACK,
        Event.SPECIAL_INTENT: State.SPECIAL,
    },
    State.CLARIFYING: {Event.ANSWER_HEARD: State.LISTENING},
    State.READ_BACK: {Event.READ_BACK_DONE: State.CONFIRM},
    State.CONFIRM: {Event.CONFIRMED: State.FILED, Event.CHANGE_REQUESTED: State.FIXING},
    State.FIXING: {Event.CHANGE_APPLIED: State.READ_BACK},
    State.SPECIAL: {Event.SPECIAL_DONE: State.GOODBYE},
    State.FILED: {Event.FILED_MESSAGE_SENT: State.GOODBYE},
    State.FALLBACK_RECORDING: {Event.HANG_UP: State.GOODBYE},
}

#: States in which the reporter is expected to talk (the silence clock runs).
LISTENING_STATES = frozenset(
    {
        State.IDENTIFY,
        State.PICK_SITE,
        State.LISTENING,
        State.CLARIFYING,
        State.CONFIRM,
        State.FIXING,
    }
)
#: States the §7.3 diagram sends to the simple recording mode on two failures or an agent error.
#: The diagram draws the edge from `listening`; a failure while clarifying or confirming is the same
#: call going wrong, so they share it.
FALLBACK_FROM = frozenset({State.LISTENING, State.CLARIFYING, State.CONFIRM, State.FIXING})
TERMINAL = frozenset({State.GOODBYE, State.NOT_REACHED})


@dataclass(frozen=True)
class Limits:
    """§7.3 "Limits". Named so a pack or W3-16's latency run can tune them."""

    max_call_s: float = 12 * 60
    warning_s: float = 10 * 60
    silence_s: float = 8.0
    backchannel_s: float = 3.0
    max_failed_understandings: int = 2


@dataclass(frozen=True)
class Say:
    """Speak the copy line `key` (copy/*.json)."""

    key: str


@dataclass(frozen=True)
class CallTool:
    name: str


@dataclass(frozen=True)
class EndCall:
    """Hang up with this `calls.outcome` (contract `tool_end_call_request.outcome`)."""

    outcome: str


Action = Say | CallTool | EndCall


@dataclass
class Dialog:
    limits: Limits = field(default_factory=Limits)
    state: State = State.CONNECTING
    last_activity: float = 0.0
    silences: int = 0
    backchannelled: bool = False
    warned: bool = False
    failed_understandings: int = 0
    history: list[tuple[float, State, Event, State]] = field(default_factory=list)

    # ─────────────────────────── events ───────────────────────────

    def on(self, event: Event, now: float) -> list[Action]:
        if self.state in TERMINAL:
            return []
        actions: list[Action] = []

        if event is Event.SPEECH:
            self._activity(now)
            return actions
        if event is Event.AGENT_SPOKE:
            self.last_activity = now
            self.backchannelled = False
            return actions
        if event is Event.UNDERSTOOD:
            self.failed_understandings = 0
            return actions
        if event is Event.HANG_UP and self.state is not State.FALLBACK_RECORDING:
            # A hang-up before the yes saves the draft (§7.2, §19 Q122); after filing it is filed.
            outcome = _hang_up_outcome(self.state)
            self._go(State.GOODBYE, event, now)
            return [EndCall(outcome)]
        if event in (Event.NOT_UNDERSTOOD, Event.AGENT_ERROR):
            if event is Event.NOT_UNDERSTOOD:
                self.failed_understandings += 1
            if self.state in FALLBACK_FROM and (
                event is Event.AGENT_ERROR
                or self.failed_understandings >= self.limits.max_failed_understandings
            ):
                self._go(State.FALLBACK_RECORDING, event, now)
                return [Say("fallback"), CallTool("start_fallback_recording")]
            return actions

        target = TRANSITIONS.get(self.state, {}).get(event)
        if target is None:
            return actions
        self._go(target, event, now)
        if target in LISTENING_STATES:
            self.last_activity = now
        if target is State.NOT_REACHED:
            actions.append(EndCall("not_reached"))
        elif target is State.CONFIRM:
            actions.append(Say("confirm_ask"))
        elif target is State.GOODBYE and event is Event.FILED_MESSAGE_SENT:
            actions.append(Say("goodbye_filed"))
            actions.append(EndCall("filed"))
        elif target is State.GOODBYE and event is Event.HANG_UP:
            actions.append(EndCall("fallback_recording"))
        return actions

    # ─────────────────────────── timers ───────────────────────────

    def tick(self, now: float) -> list[Action]:
        if self.state in TERMINAL or self.state is State.CONNECTING:
            return []
        actions: list[Action] = []
        if now >= self.limits.max_call_s:
            outcome = (
                "fallback_recording"
                if self.state is State.FALLBACK_RECORDING
                else _hang_up_outcome(self.state)
            )
            self._go(State.GOODBYE, Event.HANG_UP, now)
            return [Say(_goodbye_key(outcome)), EndCall(outcome)]
        if not self.warned and now >= self.limits.warning_s:
            self.warned = True
            actions.append(Say("time_warning"))
        if self.state in LISTENING_STATES:
            quiet = now - self.last_activity
            if quiet >= self.limits.silence_s:
                self.silences += 1
                self.last_activity = now
                if self.silences >= 2:
                    outcome = _hang_up_outcome(self.state)
                    self._go(State.GOODBYE, Event.HANG_UP, now)
                    actions += [Say("silence_goodbye"), EndCall(outcome)]
                else:
                    actions.append(Say("silence_prompt"))
            elif (
                quiet >= self.limits.backchannel_s
                and self.state is State.LISTENING
                and not self.backchannelled
                and self.silences == 0
            ):
                self.backchannelled = True
                actions.append(Say("backchannel"))
        return actions

    # ─────────────────────────── internals ───────────────────────────

    def _activity(self, now: float) -> None:
        self.last_activity = now
        self.silences = 0
        self.backchannelled = False

    def _go(self, target: State, event: Event, now: float) -> None:
        self.history.append((now, self.state, event, target))
        self.state = target


def _hang_up_outcome(state: State) -> str:
    """The outcome of a call that ends in `state` without a yes (§7.2: the draft is kept)."""
    if state in (State.CONNECTING, State.DISCLOSURE, State.IDENTIFY, State.PICK_SITE):
        return "abandoned"
    if state is State.FILED:
        return "filed"
    return "draft_saved"


def _goodbye_key(outcome: str) -> str:
    return f"goodbye_{outcome}"
