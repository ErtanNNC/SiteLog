from __future__ import annotations

import pytest

from sitelog_voice.config import MissingSettingError, Settings


def settings(**env: str) -> Settings:
    return Settings(_env_file=None, **env)  # type: ignore[call-arg]


def test_defaults_match_env_example(monkeypatch: pytest.MonkeyPatch) -> None:
    for name in ("LIVEKIT_AGENT_NAME", "STT_MODEL", "TTS_VOICE_EN", "CLAUDE_MODEL_FAST"):
        monkeypatch.delenv(name, raising=False)
    s = settings()
    assert s.livekit_agent_name == "sitelog-voice"
    assert s.stt_model == "nova-3"
    assert s.tts_voice_en == "aura-2-thalia-en"
    assert s.tts_voice_es == "aura-2-nestor-es"
    assert s.tts_voice_tr == "tr-TR-EmelNeural"
    assert s.azure_speech_region == "westeurope"
    # No model name in code: the dialog model comes from env only.
    assert s.claude_model_fast is None


def test_reads_env(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("FIELD_API_URL", "http://127.0.0.1:54321/functions/v1/field-api/")
    monkeypatch.setenv("VOICE_AGENT_TOOL_SECRET", "s3cret-value")
    monkeypatch.setenv("CLAUDE_MODEL_FAST", "fast-model-from-env")
    monkeypatch.setenv("FIELD_API_TIMEOUT_S", "12.5")
    s = settings()
    assert s.field_api_base() == "http://127.0.0.1:54321/functions/v1/field-api"
    assert s.tool_secret() == "s3cret-value"
    assert s.claude_model_fast == "fast-model-from-env"
    assert s.field_api_timeout_s == 12.5


def test_empty_values_are_unset(monkeypatch: pytest.MonkeyPatch) -> None:
    for name in (
        "FIELD_API_URL",
        "VOICE_AGENT_TOOL_SECRET",
        "DEEPGRAM_API_KEY",
        "CLAUDE_MODEL_FAST",
    ):
        monkeypatch.setenv(name, "")
    s = settings()
    assert s.field_api_url is None
    assert s.voice_agent_tool_secret is None
    assert s.deepgram_api_key is None
    assert s.claude_model_fast is None
    with pytest.raises(MissingSettingError, match="FIELD_API_URL"):
        s.field_api_base()
    with pytest.raises(MissingSettingError, match="VOICE_AGENT_TOOL_SECRET"):
        s.tool_secret()


def test_secrets_never_print(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("VOICE_AGENT_TOOL_SECRET", "tool-secret-value")
    monkeypatch.setenv("ANTHROPIC_API_KEY", "anthropic-key-value")
    monkeypatch.setenv("DEEPGRAM_API_KEY", "deepgram-key-value")
    s = settings()
    shown = repr(s) + str(s) + repr(s.safe_summary())
    for secret in ("tool-secret-value", "anthropic-key-value", "deepgram-key-value"):
        assert secret not in shown
    assert s.safe_summary()["anthropic"] is True


def test_rejects_bad_timeout(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("FIELD_API_TIMEOUT_S", "0")
    with pytest.raises(ValueError):
        settings()
