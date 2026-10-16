"""metrics.py, redact.py, voicemail.py, recording.py, observability.py."""

from __future__ import annotations

import logging

import pytest

from sitelog_voice.contract import default_contract
from sitelog_voice.metrics import CallMetrics, percentile
from sitelog_voice.observability import PhoneRedactingFilter, before_send
from sitelog_voice.recording import interleave_stereo, split_stereo
from sitelog_voice.redact import contains_phone, redact_phones
from sitelog_voice.voicemail import classify_first_utterance

# ── redact: the vectors of packages/shared/src/redact.test.ts ──


def test_redacts_us_international_turkish_and_bare_numbers() -> None:
    assert (
        redact_phones("Pump truck driver Mike 555-014-3378 arrived 9:10")
        == "Pump truck driver Mike [phone] arrived 9:10"
    )
    assert (
        redact_phones("call me on +1 555 014 3378, at Riverside")
        == "call me on [phone], at Riverside"
    )
    assert redact_phones("(555) 014-3378") == "[phone]"
    assert redact_phones("Ahmet bey 0532 123 45 67 aradı") == "Ahmet bey [phone] aradı"
    assert redact_phones("number 905321234567 please") == "number [phone] please"


def test_leaves_ids_dates_times_and_quantities() -> None:
    text = (
        "VOICE NOTE uploadId=11111111-0000-4000-8000-000000000101\n"
        "[18.9–26.1] sixty-eight yards, 68 yd³ at 2026-10-09T22:31:40Z, 07:00–15:30, 3.5 h, 1200 m²"
    )
    assert redact_phones(text) == text
    assert not contains_phone(text)
    assert contains_phone("ring 555 014 3378")


# ── metrics ──


def test_percentile_nearest_rank() -> None:
    assert percentile([], 50) is None
    assert percentile([300, 100, 200], 50) == 200
    assert percentile(list(range(1, 101)), 95) == 95
    with pytest.raises(ValueError):
        percentile([1], 101)


def test_metrics_to_contract() -> None:
    m = CallMetrics()
    for start, first_audio in ((10.0, 10.6), (20.0, 20.9), (30.0, 31.4)):
        m.agent_answered(end_of_speech_s=start, first_audio_s=first_audio)
    m.agent_answered(end_of_speech_s=5.0, first_audio_s=4.0)  # out of order: ignored
    m.reporter_turn(confidence=0.9)
    m.reporter_turn(confidence=0.8)
    m.reporter_turn()
    m.interrupted()
    out = m.to_contract()
    assert out == {
        "latencyP50Ms": 900,
        "latencyP95Ms": 1400,
        "interruptions": 1,
        "sttConfidence": 0.85,
        "turns": 3,
    }
    default_contract().check("call_metrics", out)
    empty = CallMetrics(sip_call_id="SCL_abc").to_contract()
    assert empty["latencyP50Ms"] is None and empty["sipCallId"] == "SCL_abc"
    default_contract().check("call_metrics", empty)


# ── voicemail (W3-17 tunes it) ──


@pytest.mark.parametrize(
    ("text", "lang", "verdict"),
    [
        ("Hello?", "en", "human"),
        ("Yeah, Kevin here.", "en", "human"),
        ("You've reached Kevin, please leave a message after the tone.", "en", "machine"),
        ("Deje su mensaje después del tono.", "es", "machine"),
        ("Aradığınız kişiye şu anda ulaşılamıyor.", "tr", "machine"),
        ("", "en", "unknown"),
    ],
)
def test_voicemail_first_utterance(text: str, lang: str, verdict: str) -> None:
    assert classify_first_utterance(text, lang) == verdict


# ── recording: reporter left, agent right ──


def test_stereo_interleave_pads_and_splits_back() -> None:
    stereo = interleave_stereo([1, 2, 3], [-1, -2])
    assert list(stereo) == [1, -1, 2, -2, 3, 0]
    left, right = split_stereo(stereo)
    assert list(left) == [1, 2, 3] and list(right) == [-1, -2, 0]
    with pytest.raises(ValueError):
        split_stereo([1, 2, 3])


# ── observability: no phone number in logs or Sentry ──


def test_log_filter_redacts_phone_numbers() -> None:
    record = logging.LogRecord(
        "sitelog_voice", logging.INFO, __file__, 1, "caller %s said %s", ("+15550142087", 7), None
    )
    PhoneRedactingFilter().filter(record)
    assert record.getMessage() == "caller [phone] said 7"


def test_sentry_before_send_drops_bodies_and_redacts() -> None:
    event = {
        "request": {"data": {"from": "+15550142087"}},
        "breadcrumbs": {"values": [{"message": "x", "data": {"body": "555 014 2087"}}]},
        "exception": {
            "values": [
                {
                    "value": "failed for +1 555 014 2087",
                    "stacktrace": {
                        "frames": [{"function": "f", "vars": {"phone": "+15550142087"}}]
                    },
                }
            ]
        },
        "extra": {"note": "call 5550142087"},
    }
    out = before_send(event, {})
    assert out is not None
    text = repr(out)
    assert "555" not in text
    assert "request" not in out
