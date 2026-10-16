"""Call-quality numbers for `end_call` (contract `call_metrics`; spec §5 "Monitoring", §17 Voice).

- turn latency: the reporter's end of speech → the agent's first audio, per turn, p50 and p95 in ms;
- interruptions: barge-ins (the reporter talking over the agent's speech);
- STT confidence: the mean of the final transcripts' confidences (0–1), `null` without any;
- turns: the reporter turns heard.

Pure: the agent (W3-12) feeds it from the session's events; nothing here reads a clock.
"""

from __future__ import annotations

import math
from dataclasses import dataclass, field
from typing import Any


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
    confidences: list[float] = field(default_factory=list)
    interruptions: int = 0
    turns: int = 0
    sip_call_id: str | None = None

    def reporter_turn(self, *, confidence: float | None = None) -> None:
        self.turns += 1
        if confidence is not None:
            self.confidences.append(min(1.0, max(0.0, confidence)))

    def agent_answered(self, *, end_of_speech_s: float, first_audio_s: float) -> None:
        if first_audio_s >= end_of_speech_s:
            self.latencies_ms.append((first_audio_s - end_of_speech_s) * 1000)

    def interrupted(self) -> None:
        self.interruptions += 1

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
        }
        if self.sip_call_id:
            out["sipCallId"] = self.sip_call_id
        return out
