"""Call-quality numbers for `end_call` (contract `call_metrics`; spec §5 "Monitoring", §17 Voice).

- turn latency: the reporter's end of speech → the agent's first audio, per turn, p50 and p95 in ms,
  and every turn's latency (`latenciesMs`, the first `MAX_SAMPLES`, §19 Q226);
- interruptions: barge-ins (the reporter talking over the agent's speech);
- barge-in stop time: the reporter starts speaking over an interruptible agent line → the agent's
  audio stops, per barge-in (`bargeInMs`, the first `MAX_SAMPLES`, §19 Q226; F6: ≤ 300 ms);
- STT confidence: the mean of the final transcripts' confidences (0–1), `null` without any;
- turns: the reporter turns heard.

Pure: the agent (W3-12, `TurnTimer`) feeds it from the session's speech states and the final
transcripts; nothing here reads a clock.
"""

from __future__ import annotations

import math
from dataclasses import dataclass, field
from typing import Any

#: §19 Q226: the per-turn and per-barge-in samples `end_call` carries, at most this many each (the
#: first ones; the percentiles still use every turn). The contract's `call_metrics` caps the same.
MAX_SAMPLES = 200


def percentile(values: list[float], p: float) -> float | None:
    """Nearest-rank percentile (`p` in 0–100); `None` for no values."""
    if not values:
        return None
    if not 0 <= p <= 100:
        raise ValueError("percentile p must be within 0–100")
    ordered = sorted(values)
    rank = max(1, math.ceil(p / 100 * len(ordered)))
    return ordered[rank - 1]


@dataclass
class CallMetrics:
    latencies_ms: list[float] = field(default_factory=list)
    barge_ins_ms: list[float] = field(default_factory=list)
    confidences: list[float] = field(default_factory=list)
    interruptions: int = 0
    turns: int = 0
    sip_call_id: str | None = None
    #: W3-17 (F6 step 1): who answered an outbound call, by its first utterance (`voicemail.py`).
    answered_by: str | None = None

    def reporter_turn(self, *, confidence: float | None = None) -> None:
        self.turns += 1
        if confidence is not None:
            self.confidences.append(min(1.0, max(0.0, confidence)))

    def agent_answered(self, *, end_of_speech_s: float, first_audio_s: float) -> None:
        if first_audio_s >= end_of_speech_s:
            self.latencies_ms.append((first_audio_s - end_of_speech_s) * 1000)

    def interrupted(self) -> None:
        self.interruptions += 1

    def barge_in_stopped(self, *, speech_start_s: float, audio_stopped_s: float) -> None:
        if audio_stopped_s >= speech_start_s:
            self.barge_ins_ms.append((audio_stopped_s - speech_start_s) * 1000)

    def to_contract(self) -> dict[str, Any]:
        """The `metrics` of `end_call`, as `call_metrics` expects it."""
        p50 = percentile(self.latencies_ms, 50)
        p95 = percentile(self.latencies_ms, 95)
        out: dict[str, Any] = {
            "latencyP50Ms": None if p50 is None else round(p50),
            "latencyP95Ms": None if p95 is None else round(p95),
            "interruptions": self.interruptions,
            "sttConfidence": (
                None
                if not self.confidences
                else round(sum(self.confidences) / len(self.confidences), 3)
            ),
            "turns": self.turns,
            "latenciesMs": _samples(self.latencies_ms),
            "bargeInMs": _samples(self.barge_ins_ms),
        }
        if self.sip_call_id:
            out["sipCallId"] = self.sip_call_id
        if self.answered_by in ("human", "machine"):
            out["answeredBy"] = self.answered_by
        return out


def _samples(values: list[float]) -> list[int]:
    """Whole, non-negative milliseconds, the first `MAX_SAMPLES`."""
    return [max(0, round(v)) for v in values[:MAX_SAMPLES]]


#: An agent's first audio this long after the reporter stopped is not an answer to that turn (a
#: silence prompt, a filler after a pause), so it is not a turn latency.
MAX_TURN_LATENCY_S = 10.0


@dataclass
class TurnTimer:
    """The session's speech states → `CallMetrics` (W3-12), fed with the call's clock.

    - the reporter stops speaking → the end of a turn; the agent's next first audio within
      `MAX_TURN_LATENCY_S` → one latency sample (end of speech → first audio, §5 "Monitoring");
    - the reporter starts speaking while the agent speaks → one interruption (a barge-in);
    - and when that line is interruptible and the agent's audio stops while the reporter is still
      speaking → one barge-in stop time (their speech start → the audio stopped, §19 Q226). A line
      that plays on until the reporter has stopped (their speech too short to interrupt it, or
      the uninterruptible disclosure and goodbyes) did not stop for them: no stop time.

    The speech start is the session's (VAD's) detection of it, so the stop time leaves out VAD's
    own onset delay; the audio stop is the agent leaving the speaking state (interrupted or
    paused by a possible false interruption).
    """

    metrics: CallMetrics
    _end_of_speech: float | None = None
    _agent_speaking: bool = False
    _agent_interruptible: bool = True
    _reporter_speaking: bool = False
    _barge_in_at: float | None = None

    def reporter_started(self, now: float) -> None:
        self._reporter_speaking = True
        if self._agent_speaking:
            self.metrics.interrupted()
            if self._agent_interruptible:
                self._barge_in_at = now
        self._end_of_speech = None

    def reporter_stopped(self, now: float) -> None:
        self._reporter_speaking = False
        self._barge_in_at = None  # the agent played on: not stopped by this speech
        self._end_of_speech = now

    def agent_started(self, now: float, *, interruptible: bool = True) -> None:
        self._agent_speaking = True
        self._agent_interruptible = interruptible
        self._barge_in_at = None
        if self._end_of_speech is not None and now - self._end_of_speech <= MAX_TURN_LATENCY_S:
            self.metrics.agent_answered(end_of_speech_s=self._end_of_speech, first_audio_s=now)
        self._end_of_speech = None

    def agent_stopped(self, now: float) -> None:
        self._agent_speaking = False
        if self._barge_in_at is not None and self._reporter_speaking:
            self.metrics.barge_in_stopped(speech_start_s=self._barge_in_at, audio_stopped_s=now)
        self._barge_in_at = None
