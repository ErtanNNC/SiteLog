"""One call: its state, the system prompt per language, and the AgentSession's providers.

`CallState` is what code knows about the call (the call id and token, `get_context`'s answer, the
reporter's turns with their times, the last draft and its read-back revision, the dialog log, the
metrics). Tools read their arguments from it rather than from the model wherever the model could get
them wrong or make them up: the transcript segments of `update_draft`, the question id of
`record_answer`, the verbatim utterance and the read-back's revision of `file_report` (§19 Q119).

`build_live_session` assembles §9.4's runtime per call language: Deepgram streaming STT (`multi` for
EN/ES, `tr` for Turkish, §10.2), the dialog model from `CLAUDE_MODEL_FAST`, Deepgram Aura-2 TTS for
EN/ES or Azure for TR, Silero VAD and LiveKit's turn detector, with §9.4's adaptive end of turn.
Tests never call it: they build a text-mode `AgentSession(llm=FakeLLM(...))` (no STT, no TTS).
"""

from __future__ import annotations

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

#: §9.4 "Turn-taking": end of turn starts at 1.5 s and extends to 2.5 s during long reports.
END_OF_TURN_MIN_S = 1.5
END_OF_TURN_LONG_S = 2.5

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
        keyterm=keyterms[:100] if keyterms else [],
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

    return AgentSession(
        stt=stt,
        llm=llm,
        tts=tts,
        vad=silero.VAD.load(),
        turn_handling={
            "turn_detection": inference.TurnDetector(),
            "endpointing": {"min_delay": END_OF_TURN_MIN_S, "max_delay": END_OF_TURN_LONG_S},
        },
    )
