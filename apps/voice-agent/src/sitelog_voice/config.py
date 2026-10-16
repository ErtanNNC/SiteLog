"""Environment of the voice agent (spec §5.1), read once with pydantic-settings.

Secrets are `SecretStr`, so neither `repr()` nor a log line shows them; `Settings.safe_summary()`
is the only view meant for logs. Model names come from env (`CLAUDE_MODEL_FAST`), never from code
(CLAUDE.md, providers). A missing provider key is not an error here: the session builder
(`session.py`) refuses to build a live session without it, and tests run on fakes.

Outside production a local run reads the repo's root `.env`, then `apps/voice-agent/.env`, whose
values win (like the worker's `dotenv.ts`); tests pass `_env_file=None`.
"""

from __future__ import annotations

from pathlib import Path
from typing import Literal

from pydantic import AnyHttpUrl, Field, SecretStr, field_validator
from pydantic_settings import BaseSettings, SettingsConfigDict

_AGENT_DIR = Path(__file__).resolve().parents[2]
_ROOT_ENV = _AGENT_DIR.parent.parent / ".env"
_AGENT_ENV = _AGENT_DIR / ".env"


class Settings(BaseSettings):
    model_config = SettingsConfigDict(
        env_file=(_ROOT_ENV, _AGENT_ENV),
        env_file_encoding="utf-8",
        extra="ignore",
        case_sensitive=False,
    )

    # ── field-api (the agent's only backend, §4.2) ──
    field_api_url: AnyHttpUrl | None = Field(default=None, alias="FIELD_API_URL")
    voice_agent_tool_secret: SecretStr | None = Field(default=None, alias="VOICE_AGENT_TOOL_SECRET")
    field_api_timeout_s: float = Field(default=20.0, gt=0, le=60, alias="FIELD_API_TIMEOUT_S")
    """Per request. `update_draft` waits for the worker's `voice_turn` (§19 Q117, ≤ 15 s)."""

    # ── LiveKit (§5.1) ──
    livekit_url: str | None = Field(default=None, alias="LIVEKIT_URL")
    livekit_api_key: SecretStr | None = Field(default=None, alias="LIVEKIT_API_KEY")
    livekit_api_secret: SecretStr | None = Field(default=None, alias="LIVEKIT_API_SECRET")
    livekit_agent_name: str = Field(default="sitelog-voice", alias="LIVEKIT_AGENT_NAME")

    # ── Speech ──
    deepgram_api_key: SecretStr | None = Field(default=None, alias="DEEPGRAM_API_KEY")
    stt_model: str = Field(default="nova-3", alias="STT_MODEL")
    tts_voice_en: str = Field(default="aura-2-thalia-en", alias="TTS_VOICE_EN")
    tts_voice_es: str = Field(default="aura-2-nestor-es", alias="TTS_VOICE_ES")
    tts_voice_tr: str = Field(default="tr-TR-EmelNeural", alias="TTS_VOICE_TR")
    azure_speech_key: SecretStr | None = Field(default=None, alias="AZURE_SPEECH_KEY")
    azure_speech_region: str = Field(default="westeurope", alias="AZURE_SPEECH_REGION")

    # ── Claude (dialog turns use the fast model, §9.4) ──
    anthropic_api_key: SecretStr | None = Field(default=None, alias="ANTHROPIC_API_KEY")
    claude_model_fast: str | None = Field(default=None, alias="CLAUDE_MODEL_FAST")

    # ── Monitoring ──
    sentry_dsn: SecretStr | None = Field(default=None, alias="SENTRY_DSN")
    sentry_environment: str = Field(default="development", alias="SENTRY_ENVIRONMENT")

    # ── Runtime ──
    node_env: Literal["development", "test", "production"] = Field(
        default="development", alias="NODE_ENV"
    )

    @field_validator(
        "voice_agent_tool_secret",
        "livekit_api_key",
        "livekit_api_secret",
        "deepgram_api_key",
        "azure_speech_key",
        "anthropic_api_key",
        "sentry_dsn",
        mode="before",
    )
    @classmethod
    def _empty_secret_is_none(cls, value: object) -> object:
        # `.env.example` leaves keys empty (`KEY=`): that is "not set", not an empty secret.
        if isinstance(value, str) and not value.strip():
            return None
        return value

    @field_validator("field_api_url", "livekit_url", "claude_model_fast", mode="before")
    @classmethod
    def _empty_is_none(cls, value: object) -> object:
        if isinstance(value, str) and not value.strip():
            return None
        return value

    def field_api_base(self) -> str:
        """`FIELD_API_URL` without a trailing slash; raises when unset (a live run needs it)."""
        if self.field_api_url is None:
            raise MissingSettingError("FIELD_API_URL")
        return str(self.field_api_url).rstrip("/")

    def tool_secret(self) -> str:
        if self.voice_agent_tool_secret is None:
            raise MissingSettingError("VOICE_AGENT_TOOL_SECRET")
        return self.voice_agent_tool_secret.get_secret_value()

    def safe_summary(self) -> dict[str, object]:
        """What a startup log line may say: which pieces are configured, never a value of a key."""
        return {
            "field_api": self.field_api_url is not None,
            "tool_secret": self.voice_agent_tool_secret is not None,
            "livekit": self.livekit_url is not None and self.livekit_api_key is not None,
            "agent_name": self.livekit_agent_name,
            "deepgram": self.deepgram_api_key is not None,
            "azure": self.azure_speech_key is not None,
            "anthropic": self.anthropic_api_key is not None,
            "claude_model_fast": self.claude_model_fast is not None,
            "sentry": self.sentry_dsn is not None,
        }


class MissingSettingError(RuntimeError):
    """A setting a live run needs is not set. The message names the variable, never a value."""

    def __init__(self, name: str) -> None:
        super().__init__(f"{name} is not set")
        self.name = name


def load_settings() -> Settings:
    return Settings()
