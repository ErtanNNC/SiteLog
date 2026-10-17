"""One call: its state, the system prompt per language, and the AgentSession's providers.

`CallState` is what code knows about the call (the call id and token, `get_context`'s answer, the
reporter's turns with their times, the last draft and its read-back revision, the dialog log, the
metrics). Tools read their arguments from it rather than from the model wherever the model could get
them wrong or make them up: the transcript segments of `update_draft`, the question id of
`record_answer`, the verbatim utterance and the read-back's revision of `file_report` (§19 Q119).

`build_live_session` assembles §9.4's runtime per call language: Deepgram streaming STT (`multi` for
EN/ES, `tr` for Turkish, §10.2), the dialog model from `CLAUDE_MODEL_FAST`, Deepgram Aura-2 TTS for
EN/ES or Azure for TR, Silero VAD and LiveKit's turn detector, with §9.4's adaptive end of turn
(`turn_handling()`: LiveKit's dynamic endpointing between 1.5 s and 2.5 s, which lengthens the wait
for a speaker who pauses long, as in a long report) and barge-in (`BARGE_IN_MIN_SPEECH_S`, so TTS
stops within §9.4's 300 ms). Each provider is constructed only when its key is set; without one the
builder names the missing variable (`MissingSettingError`). Tests run text-mode sessions instead
(`AgentSession(llm=FakeLLM(...))`, no STT, no TTS), and one test builds the live session with
placeholder keys to prove it assembles without a network.

Noise suppression on the inbound channel (§9.4) is LiveKit Cloud's enhanced noise cancellation
(`livekit-plugins-noise-cancellation`, BVC for the browser, BVC telephony for SIP): used when that
package is installed (W3-16, with LiveKit Cloud, §19 Q204), otherwise the room's own input.
"""

from __future__ import annotations

import importlib
import logging
from dataclasses import dataclass, field
from importlib import resources
from typing import TYPE_CHECKING, Any

from .config import MissingSettingError, Settings
from .contract import DraftState, GetContextResponse
from .copy import Language, language_of
from .dialog import Dialog
from .field_api import CallAuth, FieldApi
from .metrics import CallMetrics
from .redact import redact_phones

if TYPE_CHECKING:
    from livekit.agents import AgentSession
    from livekit.agents.voice.turn import TurnHandlingOptions

log = logging.getLogger("sitelog_voice.session")

#: §9.4 "Turn-taking": end of turn starts at 1.5 s and extends to 2.5 s during long reports.
END_OF_TURN_MIN_S = 1.5
END_OF_TURN_LONG_S = 2.5
#: §9.4 "barge-in stops TTS ≤ 300 ms": the reporter's speech this long interrupts the agent (VAD
#: needs the rest of the budget to hear it).
BARGE_IN_MIN_SPEECH_S = 0.25
#: The key terms the streaming STT takes per call (get_context's list, most important first).
STT_MAX_KEYTERMS = 100

_LANGUAGE_NAMES: dict[Language, str] = {"en": "English", "es": "Spanish", "tr": "Turkish"}


# ─────────────────────────────── prompts ───────────────────────────────


def prompt_template(lang: Language) -> str:
    """`prompts/<lang>.md`: §9.4's dialog policy verbatim, then the language's own notes."""
    return resources.files("sitelog_voice").joinpath(f"prompts/{lang}.md").read_text("utf-8")


def system_prompt(*, locale: str, max_questions: int) -> str:
    """The dialog model's instructions for one call. Nothing about the reporter but the language:
    no name, no number (the first name is in the copy lines code speaks, not here)."""
    lang = language_of(locale)
    return (
        prompt_template(lang)
        .replace("{reporter_locale}", f"{_LANGUAGE_NAMES[lang]} ({locale})")
        .replace("{max_questions}", str(max_questions))
    )


def stt_language(locale: str) -> str:
    """§10.2 / §19 Q56 by locale: `tr` for Turkish, `multi` for EN/ES (code-switching)."""
    return "tr" if language_of(locale) == "tr" else "multi"


# ─────────────────────────────── call state ───────────────────────────────


@dataclass
class Segment:
    start: float
    end: float
    text: str


@dataclass
class CallState:
    api: FieldApi
    auth: CallAuth
    locale: str
    context: GetContextResponse | None = None
    segments: list[Segment] = field(default_factory=list)
    draft: DraftState | None = None
    #: The draft revision the last read-back was built from: `file_report` sends it (§19 Q119).
    read_back_rev: int | None = None
    #: A filed report loaded by `load_report` (F10): `apply_correction` acts on it.
    loaded_report_id: str | None = None
    #: field-api answered `file_report` with `filed` (only then may the call end as `filed`).
    filed: bool = False
    #: W3-14 (F12 call): the day off read back and waiting for the reporter's yes: its status,
    #: details, field-api's `confirmKey` and how many reporter turns had been heard when it was
    #: read back (a later turn is the answer).
    day_off: dict[str, Any] | None = None
    #: W3-14: the day off field-api logged (`no_work` / `weather_day`); the only such outcomes.
    day_logged: str | None = None
    #: W3-14 (F10 call): the change of a filed report read back with "Save it?": report and
    #: correction ids, and the reporter turns heard by then.
    pending_change: dict[str, Any] | None = None
    #: W3-14 (F10 call): field-api saved a change (only then may the call end `edit_applied`).
    edit_saved: bool = False
    #: W3-14 (F3 call, §19 Q120): the consent question is open; every turn goes to code until the
    #: reporter's yes or no. `consent_tries` counts unclear answers.
    consent_needed: bool = False
    consent_tries: int = 0
    #: W3-14: the reporter said no to the consent question (the dialog log keeps no reporter line).
    consent_declined: bool = False
    #: W3-17 (§19 Q128): field-api queued the callback the reporter asked for (only then may the
    #: call end `callback_requested`).
    callback_requested: bool = False
    #: W3-12 (§9.4 "Recording", §15.2): the opening with the recording notice was played to the
    #: end. No tool that processes the reporter's speech runs before it (`tools.SPEECH_TOOLS`).
    disclosure_played: bool = False
    #: W3-12 (F6 failure handling): the simple recording mode; the dialog model is not asked again.
    fallback: bool = False
    #: The outcome `end_call` sent; None while the call runs.
    ended: str | None = None
    dialog: Dialog = field(default_factory=Dialog)
    metrics: CallMetrics = field(default_factory=CallMetrics)
    log: list[dict[str, Any]] = field(default_factory=list)
    #: The clock reading when the call connected (0: not set yet; `ReportAgent` sets it).
    started_at: float = 0.0

    @property
    def language(self) -> Language:
        return language_of(self.locale)

    @property
    def last_utterance(self) -> Segment | None:
        return self.segments[-1] if self.segments else None

    def heard(self, text: str, *, start: float, end: float) -> None:
        """A final reporter turn. Kept verbatim for field-api (which redacts before its model
        calls, §10.12); the dialog model gets the redacted text (`ReportAgent`)."""
        self.segments.append(Segment(_t(start), _t(end), text))
        self.log.append({"t": _t(start), "speaker": "reporter", "text": text[:4000]})

    def said(self, text: str, *, at: float, tool: str | None = None) -> None:
        entry: dict[str, Any] = {"t": _t(at), "speaker": "agent", "text": text[:4000]}
        if tool:
            entry["tool"] = tool
        self.log.append(entry)

    def end_log(self) -> list[dict[str, Any]]:
        """The dialog log `end_call` sends: after a "no" to the consent question nothing the
        reporter said is kept (§19 Q120), only the agent's lines."""
        log = self.log[-2000:]
        if self.consent_declined:
            return [e for e in log if e["speaker"] == "agent"]
        return log

    def segments_payload(self) -> list[dict[str, Any]]:
        return [{"start": s.start, "end": s.end, "text": s.text} for s in self.segments]


def _t(seconds: float) -> float:
    """A call offset as the contract takes it: 0–3600 s (a call ends at 12 min, §7.3)."""
    return round(min(max(seconds, 0.0), 3600.0), 2)


def for_model(text: str) -> str:
    """A reporter's words as the dialog model may see them: phone numbers out (§10.12)."""
    return redact_phones(text)


# ─────────────────────────────── live providers ───────────────────────────────


def build_live_session(settings: Settings, *, locale: str, keyterms: list[str]) -> AgentSession:
    """§9.4's runtime for one call language. Needs the keys; refuses without them (by name)."""
    from livekit.agents import AgentSession, inference
    from livekit.plugins import anthropic, azure, deepgram, silero

    if settings.deepgram_api_key is None:
        raise MissingSettingError("DEEPGRAM_API_KEY")
    if settings.anthropic_api_key is None:
        raise MissingSettingError("ANTHROPIC_API_KEY")
    if not settings.claude_model_fast:
        raise MissingSettingError("CLAUDE_MODEL_FAST")
    lang = language_of(locale)
    dg_key = settings.deepgram_api_key.get_secret_value()

    stt = deepgram.STT(
        model=settings.stt_model,
        language=stt_language(locale),
        # get_context's key terms (§19 Q143: companies, confirmed glossary terms), for Nova-3.
        keyterm=keyterms[:STT_MAX_KEYTERMS] if keyterms else [],
        api_key=dg_key,
    )
    llm = anthropic.LLM(
        model=settings.claude_model_fast,
        api_key=settings.anthropic_api_key.get_secret_value(),
    )
    if lang == "tr":
        if settings.azure_speech_key is None:
            raise MissingSettingError("AZURE_SPEECH_KEY")
        tts: Any = azure.TTS(
            voice=settings.tts_voice_tr,
            speech_key=settings.azure_speech_key.get_secret_value(),
            speech_region=settings.azure_speech_region,
        )
    else:
        voice = settings.tts_voice_es if lang == "es" else settings.tts_voice_en
        tts = deepgram.TTS(model=voice, api_key=dg_key)

    handling = turn_handling()
    handling["turn_detection"] = inference.TurnDetector()
    return AgentSession(stt=stt, llm=llm, tts=tts, vad=silero.VAD.load(), turn_handling=handling)


def turn_handling() -> TurnHandlingOptions:
    """§9.4 "Turn-taking & audio" as LiveKit's turn options (the turn detector is added by the
    live builder): end of turn adaptive from 1.5 s to 2.5 s (LiveKit's dynamic endpointing learns
    the speaker's pauses within those bounds), barge-in on, short enough to stop TTS in 300 ms;
    no preemptive reply (the model answers final turns only)."""
    return {
        "endpointing": {
            "mode": "dynamic",
            "min_delay": END_OF_TURN_MIN_S,
            "max_delay": END_OF_TURN_LONG_S,
        },
        "interruption": {"enabled": True, "min_duration": BARGE_IN_MIN_SPEECH_S},
        # No reply drafted on a turn not yet final: `ReportAgent` records every turn the model
        # sees as heard (the transcript update_draft sends), so it sees final turns only.
        "preemptive_generation": {"enabled": False},
    }


def noise_cancellation(transport: str) -> Any | None:
    """§9.4 "noise suppression on the inbound channel": LiveKit Cloud's BVC (telephony-tuned for
    SIP) when `livekit-plugins-noise-cancellation` is installed; None (the room's input as it is)
    otherwise. Imported by name so the package stays optional until W3-16 (§19 Q204)."""
    try:
        nc = importlib.import_module("livekit.plugins.noise_cancellation")
    except ImportError:
        return None
    return nc.BVCTelephony() if transport == "pstn" else nc.BVC()


def room_options(transport: str) -> Any:
    """The room input for a call: the caller's audio with noise suppression where available; the
    session closes when the caller leaves (the hang-up, `ReportCall.hang_up`), and the room is
    deleted when the session closes (the agent's end of the call drops the caller's line too)."""
    from livekit.agents import room_io

    return room_io.RoomOptions(
        audio_input=room_io.AudioInputOptions(noise_cancellation=noise_cancellation(transport)),
        close_on_disconnect=True,
        delete_room_on_close=True,
    )


# ─────────────────────────────── outcomes ───────────────────────────────


def settle_outcome(state: CallState, outcome: str) -> str:
    """The outcome a call may end with: what field-api did, never the model's (or a timer's)
    word for it. `filed` only after field-api's `filed` (§19 Q119), a day off or a saved change
    only when field-api logged it (W3-14), a callback only when field-api queued it (W3-17, §19
    Q128); a call field-api
    filed ends `filed` whatever ended it (a hang-up right after the yes)."""
    if state.consent_declined:
        return "abandoned"
    if state.fallback:
        return "fallback_recording"
    if state.filed:
        return "filed"
    if state.day_logged is not None:
        return state.day_logged
    if state.edit_saved:
        return "edit_applied"
    if outcome == "callback_requested" and state.callback_requested:
        return outcome
    if outcome == "filed":
        outcome = "draft_saved"
    elif outcome in ("no_work", "weather_day", "callback_requested", "edit_applied"):
        outcome = "draft_saved" if state.draft else "abandoned"
    if outcome == "draft_saved" and state.draft is None and not state.segments:
        return "abandoned"
    return outcome
