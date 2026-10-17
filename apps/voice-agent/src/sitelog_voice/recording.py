"""The call recording (spec §9.4 "Recording"): dual channel, reporter left, agent right, Opus/OGG.

- **Capture and encoding** are LiveKit Agents' own `RecorderIO`: it wraps the session's audio input
  (the reporter's track, channel 0 = left) and output (the agent's audio as played, channel 1 =
  right), places both on one timeline (silence where nobody spoke, the agent's audio where it was
  heard, a barge-in cut where it was cut) and writes a stereo Opus/OGG file in a thread.
  `CallRecorder` starts it for the call and stops it at the end. LiveKit Cloud's own session
  recording stays off (`session.start(record=False)`): the audio goes to SiteLog's `calls` bucket
  only.
- **Upload** at the end of the call (`upload_recording`): the file is checked (OGG, Opus, two
  channels, within the contract's size and length), field-api's `POST /voice/calls/:id/recording`
  answers a signed upload URL for `calls/<org>/<call>.ogg` (W3-03), and the bytes are PUT there
  (`FieldApi.put_signed`). The worker's post-call job (W3-11) splits the lanes with ffmpeg.
- **Never uploaded:** a call whose reporter said no to the consent question, or never answered it
  (§19 Q120; field-api refuses it too); the local file is deleted either way.

The recording is processed only after the disclosure was played (`calls.disclosure_played`).
"""

from __future__ import annotations

import asyncio
import logging
import math
import shutil
import tempfile
from array import array
from collections.abc import AsyncIterator, Sequence
from dataclasses import dataclass
from pathlib import Path
from typing import TYPE_CHECKING, Any

import av
from av.error import FFmpegError

from .field_api import CallAuth, FieldApi, FieldApiError

if TYPE_CHECKING:
    from livekit import rtc
    from livekit.agents import AgentSession

log = logging.getLogger("sitelog_voice.recording")

RECORDING_MIME = "audio/ogg"
#: Contract `recording_upload_request`: at most 50 MiB and 3600 s.
MAX_RECORDING_BYTES = 50 * 1024 * 1024
MAX_RECORDING_S = 3600.0
#: The recording's sample rate (Opus's native rate).
RECORDING_SAMPLE_RATE = 48_000


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


# ─────────────────────────────── the file ───────────────────────────────


@dataclass(frozen=True)
class RecordingInfo:
    bytes: int
    duration_s: float
    channels: int
    codec: str
    container: str


class RecordingError(ValueError):
    """The file is not what the contract and the post-call job take."""


def probe_recording(path: Path) -> RecordingInfo:
    """What the file holds, read with PyAV (the library LiveKit's recorder writes it with)."""
    size = path.stat().st_size
    with av.open(str(path)) as container:
        streams = container.streams.audio
        if not streams:
            raise RecordingError("no audio stream")
        stream = streams[0]
        duration = 0.0
        if stream.duration is not None and stream.time_base is not None:
            duration = float(stream.duration * stream.time_base)
        elif container.duration is not None:
            duration = container.duration / av.time_base
        return RecordingInfo(
            bytes=size,
            duration_s=round(duration, 2),
            channels=stream.codec_context.channels,
            codec=stream.codec_context.name,
            container=container.format.name,
        )


def check_recording(info: RecordingInfo) -> None:
    """§9.4: OGG, Opus, reporter and agent as two channels; within the contract's limits."""
    if "ogg" not in info.container.split(","):
        raise RecordingError(f"container {info.container}")
    if info.codec not in ("opus", "libopus"):
        raise RecordingError(f"codec {info.codec}")
    if info.channels != 2:
        raise RecordingError(f"{info.channels} channels")
    if not 0 < info.bytes <= MAX_RECORDING_BYTES:
        raise RecordingError("size")
    if info.duration_s > MAX_RECORDING_S:
        raise RecordingError("length")


async def upload_recording(api: FieldApi, auth: CallAuth, path: Path) -> str | None:
    """Uploads the call's recording; returns its storage path, or None when it was not uploaded
    (a bad file, field-api refusing it: the call stays without a recording, W3-11 settles it)."""
    try:
        info = await asyncio.to_thread(probe_recording, path)
        check_recording(info)
        data = await asyncio.to_thread(path.read_bytes)
    except (OSError, FFmpegError, RecordingError) as exc:
        log.warning(
            "recording not uploaded: unreadable or off contract",
            extra={"call_id": auth.call_id, "reason": type(exc).__name__},
        )
        return None
    try:
        answer = await api.request(
            "recording_upload",
            {
                "callId": auth.call_id,
                "mime": RECORDING_MIME,
                "bytes": info.bytes,
                "durationS": min(info.duration_s, MAX_RECORDING_S),
            },
            auth,
        )
        await api.put_signed(answer["signedUrl"], data, mime=RECORDING_MIME)
    except FieldApiError as exc:
        log.warning("recording not uploaded", extra={"call_id": auth.call_id, "code": exc.code})
        return None
    log.info(
        "recording uploaded",
        extra={"call_id": auth.call_id, "bytes": info.bytes, "duration_s": info.duration_s},
    )
    return str(answer["path"])


# ─────────────────────────────── capture ───────────────────────────────


class CallRecorder:
    """One call's recording: LiveKit's `RecorderIO` on the session's audio, into a temp file."""

    def __init__(self, *, directory: Path | None = None, sample_rate: int = RECORDING_SAMPLE_RATE):
        self._dir = directory or Path(tempfile.mkdtemp(prefix="sitelog-call-"))
        self._owns_dir = directory is None
        self._sample_rate = sample_rate
        self._io: Any = None
        self.path = self._dir / "call.ogg"

    def wrap(
        self, audio_input: Any, audio_output: Any, session: AgentSession | None = None
    ) -> tuple[Any, Any]:
        """The recorder's wrappers around an audio input (reporter) and output (agent)."""
        from livekit.agents.voice.recorder_io import RecorderIO

        self._io = RecorderIO(agent_session=session, sample_rate=self._sample_rate)  # type: ignore[arg-type]
        return self._io.record_input(audio_input), self._io.record_output(audio_output)

    def attach(self, session: AgentSession) -> None:
        """After `session.start(room=…)`: record what the room hears and what the agent says."""
        if session.input.audio is None or session.output.audio is None:
            raise RuntimeError("the session has no audio input or output to record")
        session.input.audio, session.output.audio = self.wrap(
            session.input.audio, session.output.audio, session
        )

    async def start(self) -> None:
        if self._io is None:
            raise RuntimeError("wrap or attach the recorder first")
        await self._io.start(output_path=self.path)

    async def stop(self) -> Path | None:
        """Ends the recording and writes the file; None when nothing was written."""
        if self._io is None:
            return None
        await self._io.aclose()
        return self.path if self.path.exists() and self.path.stat().st_size > 0 else None

    def discard(self) -> None:
        """Deletes the local file (after the upload, or when it must not be kept)."""
        if self._owns_dir:
            shutil.rmtree(self._dir, ignore_errors=True)
        else:
            self.path.unlink(missing_ok=True)


# ─────────────────────────────── the fallback tone ───────────────────────────────

#: F6: "tell me everything after the tone": a short beep before the record-only mode.
TONE_HZ = 880.0
TONE_S = 0.4
TONE_SAMPLE_RATE = 24_000


def tone_samples(
    *, hz: float = TONE_HZ, seconds: float = TONE_S, sample_rate: int = TONE_SAMPLE_RATE
) -> array:
    """A sine beep at a third of full scale, faded in and out over 10 ms (no click)."""
    n = int(seconds * sample_rate)
    fade = max(1, int(0.01 * sample_rate))
    out = array("h", bytes(2 * n))
    for i in range(n):
        gain = min(1.0, i / fade, (n - 1 - i) / fade)
        out[i] = int(10_000 * gain * math.sin(2 * math.pi * hz * i / sample_rate))
    return out


async def tone_frames(frame_ms: int = 20) -> AsyncIterator[rtc.AudioFrame]:
    """The tone as LiveKit audio frames, for `session.say(…, audio=…)`."""
    from livekit import rtc

    samples = tone_samples()
    step = TONE_SAMPLE_RATE * frame_ms // 1000
    for i in range(0, len(samples), step):
        chunk = samples[i : i + step]
        yield rtc.AudioFrame(
            data=chunk.tobytes(),
            sample_rate=TONE_SAMPLE_RATE,
            num_channels=1,
            samples_per_channel=len(chunk),
        )
