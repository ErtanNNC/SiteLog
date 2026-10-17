"""W3-12: the call recording on synthetic stereo, and its upload (spec §9.4 "Recording").

The recorder is LiveKit's `RecorderIO` behind `CallRecorder`: fed here with a synthetic reporter
(a 440 Hz tone for a second, then silence) and a synthetic agent (an 880 Hz tone in the second
second, as played), on a fake wall clock. The file must be OGG/Opus with the reporter on the left
and the agent on the right, each where it spoke; then the upload asks field-api for the signed URL
with the file's size and length and PUTs the bytes there.
"""

from __future__ import annotations

import math
import types
from array import array
from collections.abc import AsyncIterator
from pathlib import Path
from typing import Any

import av
import httpx
import numpy as np
import pytest
from livekit import rtc
from livekit.agents.voice import io

from sitelog_voice.field_api import FieldApi
from sitelog_voice.recording import (
    CallRecorder,
    RecordingError,
    check_recording,
    probe_recording,
    tone_frames,
    tone_samples,
    upload_recording,
)
from tests.conftest import load_call_fixture
from tests.fakes.field_api import BASE_URL, SECRET, FakeFieldApi

FRAME_S = 0.02
SIGNED = "https://storage.test/storage/v1/object/upload/sign/calls/org/call.ogg?token=abc"


class FakeWallClock:
    def __init__(self, t: float = 1_000.0) -> None:
        self.t = t

    def time(self) -> float:
        return self.t


def _tone(hz: float, seconds: float, rate: int) -> list[rtc.AudioFrame]:
    n = int(FRAME_S * rate)
    frames = []
    for k in range(int(seconds / FRAME_S)):
        samples = array(
            "h",
            (
                int(12_000 * math.sin(2 * math.pi * hz * (k * n + i) / rate)) if hz else 0
                for i in range(n)
            ),
        )
        frames.append(
            rtc.AudioFrame(
                data=samples.tobytes(), sample_rate=rate, num_channels=1, samples_per_channel=n
            )
        )
    return frames


class ScriptedInput(io.AudioInput):
    """The reporter's track: frames delivered in real time on the fake clock."""

    def __init__(self, frames: list[rtc.AudioFrame], clock: FakeWallClock) -> None:
        super().__init__(label="scripted")
        self._frames = iter(frames)
        self._clock = clock

    async def __anext__(self) -> rtc.AudioFrame:
        frame = next(self._frames, None)
        if frame is None:
            raise StopAsyncIteration
        self._clock.t += frame.duration
        return frame


async def _record(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> Path:
    from livekit.agents.voice.recorder_io import recorder_io

    clock = FakeWallClock()
    monkeypatch.setattr(recorder_io, "time", types.SimpleNamespace(time=clock.time))
    recorder = CallRecorder(directory=tmp_path)
    reporter = _tone(440, 1.0, 16_000) + _tone(0, 1.0, 16_000)
    agent = _tone(880, 1.0, 24_000)
    wrapped_in, wrapped_out = recorder.wrap(ScriptedInput(reporter, clock), None)
    await recorder.start()

    heard: list[rtc.AudioFrame] = []
    started = clock.t
    async for frame in wrapped_in:
        heard.append(frame)
        if len(heard) == 50:  # one second in: the agent answers, played over the next second
            for f in agent:
                await wrapped_out.capture_frame(f)
            wrapped_out.flush()
            wrapped_out.on_playback_started(created_at=clock.t)
            started = clock.t
        if len(heard) == 100:
            wrapped_out.on_playback_finished(playback_position=clock.t - started, interrupted=False)
    path = await recorder.stop()
    assert path is not None
    return path


def _lanes(path: Path) -> tuple[np.ndarray, np.ndarray, int]:
    with av.open(str(path)) as container:
        stream = container.streams.audio[0]
        chunks = [f.to_ndarray() for f in container.decode(stream)]
        rate = stream.codec_context.sample_rate
    pcm = np.concatenate(chunks, axis=1)  # planar: (channels, samples)
    return pcm[0], pcm[1], rate


def _rms(lane: np.ndarray, rate: int, start: float, end: float) -> float:
    part = lane[int(start * rate) : int(end * rate)].astype(np.float64)
    return float(np.sqrt(np.mean(part**2)))


async def test_reporter_left_agent_right_ogg_opus(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    path = await _record(tmp_path, monkeypatch)
    info = probe_recording(path)
    check_recording(info)
    assert info.channels == 2 and info.codec in ("opus", "libopus")
    assert "ogg" in info.container
    assert 1.8 <= info.duration_s <= 2.3

    left, right, rate = _lanes(path)
    # The reporter spoke in the first second, the agent in the second; each on its own side.
    assert _rms(left, rate, 0.1, 0.9) > 0.1
    assert _rms(left, rate, 1.1, 1.9) < 0.01
    assert _rms(right, rate, 0.1, 0.9) < 0.01
    assert _rms(right, rate, 1.1, 1.9) > 0.1


def test_check_refuses_what_the_post_call_job_cannot_split(tmp_path: Path) -> None:
    mono = tmp_path / "mono.ogg"
    with av.open(str(mono), mode="w", format="ogg") as container:
        stream: Any = container.add_stream("libopus", rate=48_000, layout="mono")
        frame = av.AudioFrame.from_ndarray(
            np.zeros((1, 960), dtype=np.float32), format="fltp", layout="mono"
        )
        frame.sample_rate = 48_000
        for packet in stream.encode(frame):
            container.mux(packet)
        for packet in stream.encode(None):
            container.mux(packet)
    with pytest.raises(RecordingError, match="1 channels"):
        check_recording(probe_recording(mono))


async def test_upload_asks_for_the_signed_url_then_puts_the_bytes(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    path = await _record(tmp_path, monkeypatch)
    fixture = load_call_fixture("northgate-call-en")
    fixture["routes"]["recording_upload"] = [
        {"bucket": "calls", "path": "org/call.ogg", "signedUrl": SIGNED, "token": "abc"}
    ]
    with FakeFieldApi(fixture) as fake:
        put = fake.router.put(SIGNED).mock(return_value=httpx.Response(200, json={}))
        api = FieldApi(base_url=BASE_URL, tool_secret=SECRET, timeout_s=2, retry_delay_s=0)
        try:
            auth, _ = await api.calls_start(
                room=fixture["start"]["request"]["room"],
                transport="web",
                call_id=fixture["start"]["request"]["callId"],
            )
            stored = await upload_recording(api, auth, path)
        finally:
            await api.aclose()
    assert stored == "org/call.ogg"
    (asked,) = fake.seen("recording_upload")
    assert asked.body["mime"] == "audio/ogg"
    assert asked.body["bytes"] == path.stat().st_size
    assert 1.8 <= asked.body["durationS"] <= 2.3
    assert put.call_count == 1
    sent = put.calls[0].request
    assert sent.headers["content-type"] == "audio/ogg"
    assert sent.content == path.read_bytes()


async def test_a_refused_upload_or_a_bad_file_leaves_no_recording(tmp_path: Path) -> None:
    fixture = load_call_fixture("northgate-call-en")
    junk = tmp_path / "junk.ogg"
    junk.write_bytes(b"not audio")
    with FakeFieldApi(fixture) as fake:
        api = FieldApi(base_url=BASE_URL, tool_secret=SECRET, timeout_s=2, retry_delay_s=0)
        try:
            auth, _ = await api.calls_start(
                room=fixture["start"]["request"]["room"],
                transport="web",
                call_id=fixture["start"]["request"]["callId"],
            )
            assert await upload_recording(api, auth, junk) is None
            assert fake.seen("recording_upload") == []  # nothing asked for a file off contract
        finally:
            await api.aclose()


def test_the_fallback_tone() -> None:
    samples = tone_samples()
    assert len(samples) == int(0.4 * 24_000)
    assert samples[0] == 0 and max(samples) > 9_000  # faded in, a third of full scale


async def test_tone_frames_cover_the_tone() -> None:
    frames: AsyncIterator[rtc.AudioFrame] = tone_frames()
    total = 0
    async for frame in frames:
        assert frame.sample_rate == 24_000 and frame.num_channels == 1
        total += frame.samples_per_channel
    assert total == len(tone_samples())
