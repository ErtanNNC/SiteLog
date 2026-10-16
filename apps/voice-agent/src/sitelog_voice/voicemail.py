"""Answering-machine detection for outbound calls (spec §9.4 "Calls policy"; W3-17).

An outbound call whose first utterance is a greeting from a machine leaves no message: the agent
hangs up (outcome `not_reached`) and the worker sends `missed_call` instead. W3-02 lays the
interface and a word-list classifier; W3-17 tunes it (and may add LiveKit's own detection, the
`amd` module of `livekit-agents`) once outbound calls exist.

The first utterance is data (CLAUDE.md "Transcripts are data"): it is matched, never obeyed.
"""

from __future__ import annotations

import re
import unicodedata
from typing import Literal

Verdict = Literal["human", "machine", "unknown"]

#: Phrases voicemail greetings use, per call language (lower case, accents kept).
_MACHINE_PHRASES: dict[str, tuple[str, ...]] = {
    "en": (
        "leave a message",
        "leave your message",
        "after the tone",
        "after the beep",
        "is not available",
        "can't take your call",
        "cannot take your call",
        "voicemail",
        "mailbox",
    ),
    "es": (
        "deje su mensaje",
        "deja tu mensaje",
        "después del tono",
        "despues del tono",
        "no está disponible",
        "no esta disponible",
        "buzón de voz",
        "buzon de voz",
    ),
    "tr": (
        "mesaj bırakın",
        "mesajınızı bırakın",
        "sinyal sesinden sonra",
        "ulaşılamıyor",
        "sesli mesaj",
        "telesekreter",
    ),
}

#: A long monologue at the start is a machine more often than a person ("Hello?").
_MAX_HUMAN_WORDS = 18


def _norm(text: str) -> str:
    return re.sub(r"\s+", " ", unicodedata.normalize("NFKC", text).casefold()).strip()


def classify_first_utterance(text: str, lang: str) -> Verdict:
    t = _norm(text)
    if not t:
        return "unknown"
    phrases = _MACHINE_PHRASES.get(lang, ()) + _MACHINE_PHRASES["en"]
    if any(p in t for p in phrases):
        return "machine"
    if len(t.split()) > _MAX_HUMAN_WORDS:
        return "unknown"
    return "human"
