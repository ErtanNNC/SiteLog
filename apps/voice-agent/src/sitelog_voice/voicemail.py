"""Answering-machine detection for outbound calls (spec F6 step 1, §9.4 "Calls policy"; W3-17).

An outbound call (a reminder or a callback) waits for the callee's first utterance before the
opening: people answer "Hello?", "Yeah, Kevin here", or nothing at all; voicemail greetings say
"leave a message after the tone" or talk at length. A greeting classified as a machine ends the
call with no message left (outcome `not_reached`, `answeredBy: machine`): field-api records it as
`voicemail` and the worker texts `missed_call` instead (F6 step 1, F11).

The first utterance is data (CLAUDE.md "Transcripts are data"): it is matched, never obeyed, and it
is never processed as part of the report (it is heard before the disclosure, which the agent drops,
§9.4 "Recording").

Two owner parameters with their recommended defaults (spec §19 Q216): `UNKNOWN_IS_MACHINE` (a long
first utterance with no greeting phrase is a machine) and `GREETING_WAIT_S` (how long the agent
listens before it speaks first; silence is a person who waits).
"""

from __future__ import annotations

import re
import unicodedata
from dataclasses import dataclass
from typing import Literal

Verdict = Literal["human", "machine", "unknown"]
Decision = Literal["begin", "hang_up"]

#: Phrases voicemail greetings use, per call language (lower case, accents kept).
_MACHINE_PHRASES: dict[str, tuple[str, ...]] = {
    "en": (
        "leave a message",
        "leave your message",
        "leave me a message",
        "after the tone",
        "after the beep",
        "is not available",
        "isn't available",
        "can't take your call",
        "cannot take your call",
        "can't come to the phone",
        "unable to take your call",
        "record your message",
        "voicemail",
        "voice mail",
        "mailbox",
        "the person you are calling",
        "the number you have dialed",
    ),
    "es": (
        "deje su mensaje",
        "deja tu mensaje",
        "deje un mensaje",
        "deja un mensaje",
        "después del tono",
        "despues del tono",
        "después de la señal",
        "despues de la senal",
        "no está disponible",
        "no esta disponible",
        "no puede atender",
        "buzón de voz",
        "buzon de voz",
        "el número que usted marcó",
    ),
    "tr": (
        "mesaj bırakın",
        "mesajınızı bırakın",
        "mesaj bırakabilirsiniz",
        "sinyal sesinden sonra",
        "bip sesinden sonra",
        "ulaşılamıyor",
        "şu anda cevap veremiyor",
        "sesli mesaj",
        "telesekreter",
        "aradığınız kişi",
    ),
}

#: A long monologue at the start is a machine more often than a person ("Hello?").
_MAX_HUMAN_WORDS = 18

#: §19 Q216: a first utterance longer than a person's hello with no greeting phrase hangs up too
#: (the reporter still gets `missed_call` with the link); False would let the agent speak.
UNKNOWN_IS_MACHINE = True

#: §19 Q216: how long the agent listens for the first utterance before it speaks first.
GREETING_WAIT_S = 4.0


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


def outbound_decision(first_utterance: str | None, lang: str) -> Decision:
    """F6 step 1: what an outbound call does after its first utterance (None: silence until
    `GREETING_WAIT_S`). A machine, or a long unknown monologue (`UNKNOWN_IS_MACHINE`), hangs up
    with no message; a person, or silence, hears the opening."""
    if first_utterance is None or not _norm(first_utterance):
        return "begin"
    verdict = classify_first_utterance(first_utterance, lang)
    if verdict == "machine" or (verdict == "unknown" and UNKNOWN_IS_MACHINE):
        return "hang_up"
    return "begin"


@dataclass
class OutboundGate:
    """The first utterance of an outbound call, once: the agent feeds the callee's first final
    transcript (or `None` when `GREETING_WAIT_S` passed in silence) and reads the decision."""

    lang: str
    decided: Decision | None = None

    def first(self, text: str | None) -> Decision:
        if self.decided is None:
            self.decided = outbound_decision(text, self.lang)
        return self.decided
