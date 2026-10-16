"""The call recording (spec §9.4 "Recording"): dual channel, reporter left, agent right.

W3-02 holds the interface and the pieces that need no codec: the frame interleaving (both tracks at
the same sample rate, the shorter padded with silence) and the upload through field-api's signed URL
(`POST /voice/calls/:id/recording`, contract `recording_upload_*`). W3-12 adds the Opus/OGG encoder
behind `Encoder` (PyAV, which `livekit-agents` already brings) and wires the tracks from the room.

The recording is processed only after the disclosure was played (`calls.disclosure_played`).
"""

from __future__ import annotations

from array import array
from collections.abc import Sequence
from typing import Protocol

RECORDING_MIME = "audio/ogg"


def interleave_stereo(left: Sequence[int], right: Sequence[int]) -> array:
    """16-bit PCM: `left` (reporter) and `right` (agent) as one interleaved stereo buffer."""
    n = max(len(left), len(right))
    out = array("h", bytes(4 * n))
    for i in range(n):
        out[2 * i] = left[i] if i < len(left) else 0
        out[2 * i + 1] = right[i] if i < len(right) else 0
    return out


def split_stereo(frames: Sequence[int]) -> tuple[array, array]:
    """The inverse of `interleave_stereo` (for tests; the worker splits with ffmpeg, W3-11)."""
    if len(frames) % 2:
        raise ValueError("an interleaved stereo buffer has an even number of samples")
    return array("h", frames[0::2]), array("h", frames[1::2])


class Encoder(Protocol):
    """Stereo PCM → an OGG/Opus file's bytes (W3-12)."""

    def encode(self, stereo: array, *, sample_rate: int) -> bytes: ...
