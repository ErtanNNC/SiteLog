"""W4-05 (spec P12, §19 Q232, Q350): Settings' Call me now on the agent's side.

`calls/start` answers `settingsTest` for an admin's test call; the agent says the disclosure, the
test line with the company and goodbye from code (no model, no tool), marks the disclosure with no
recording-notice version (nothing is recorded), and ends the call once with its lines as the log.
A hang-up during the script still ends the call once.
"""

from __future__ import annotations

from typing import Any

from livekit.agents import AgentSession

from sitelog_voice.copy import default_copy
from sitelog_voice.field_api import FieldApi
from sitelog_voice.special import SettingsTestAgent, run_settings_test, settings_test_lines
from tests.fakes.field_api import BASE_URL, SECRET, FakeFieldApi
from tests.fakes.llm import FakeLLM

CALL = "c0530000-0000-4000-8000-000000000001"


def fixture(locale: str = "en-US", company: str = "Kestrel Build Group") -> dict[str, Any]:
    return {
        "start": {
            "request": {"room": f"call-{CALL}", "callId": CALL, "transport": "pstn"},
            "response": {
                "callId": CALL,
                "callToken": "derived-by-the-fake",
                "settingsTest": {"company": company},
                "locale": locale,
            },
        },
        "routes": {"disclosure": [{"ok": True}], "end_call": [{"ok": True}]},
    }


async def _start(fake_fixture: dict[str, Any], said: list[str], hang_up_at: int | None = None):
    with FakeFieldApi(fake_fixture) as fake:
        api = FieldApi(base_url=BASE_URL, tool_secret=SECRET, timeout_s=2, retry_delay_s=0)
        try:
            auth, started = await api.calls_start(
                room=f"call-{CALL}", transport="pstn", call_id=CALL
            )
            assert started.settings_test is not None
            assert started.reporter is None and started.unknown is None

            async def say(line: str) -> None:
                if hang_up_at is not None and len(said) == hang_up_at:
                    raise RuntimeError("hung up")
                said.append(line)

            log = await run_settings_test(
                api, auth, started.locale or "en-US", started.settings_test.company, say
            )
        finally:
            await api.aclose()
    return fake, log


def test_the_script_is_the_disclosure_one_line_and_goodbye_in_each_language() -> None:
    copy = default_copy()
    assert settings_test_lines("en", "Kestrel Build Group", copy) == [
        "Hi, it's the SiteLog assistant. This call is not recorded.",
        "This is a test call from SiteLog for Kestrel Build Group. "
        "Your phone is set up to receive SiteLog calls.",
        "That's all for this test. Goodbye.",
    ]
    tr = settings_test_lines("tr", "Demir Yapı A.Ş.", copy)
    assert tr[0] == "Merhaba, ben SiteLog asistanı. Bu görüşme kaydedilmiyor."
    assert "Demir Yapı A.Ş." in tr[1]
    assert len(settings_test_lines("es", "Kestrel", copy)) == 3


async def test_a_test_call_says_its_script_and_ends_once_with_no_report_tool() -> None:
    said: list[str] = []
    fake, log = await _start(fixture(), said)
    assert said == settings_test_lines("en", "Kestrel Build Group")
    assert [e["text"] for e in log] == said
    assert all(e["speaker"] == "agent" for e in log)
    # The disclosure is marked played, with no recording notice version: nothing is recorded.
    (disclosure,) = fake.seen("disclosure")
    assert "noticeVersion" not in disclosure.body
    (end,) = fake.seen("end_call")
    assert end.body["outcome"] == "abandoned"
    assert [e["text"] for e in end.body["dialogLog"]] == said
    # Only the start, the disclosure and the end: no context, no report tool, no recording.
    assert {c.route for c in fake.calls} == {"calls_start", "disclosure", "end_call"}


async def test_a_test_call_in_turkish_names_the_company() -> None:
    said: list[str] = []
    await _start(fixture(locale="tr-TR", company="Demir Yapı A.Ş."), said)
    assert said == settings_test_lines("tr", "Demir Yapı A.Ş.")


async def test_a_hang_up_during_the_script_still_ends_the_call_once() -> None:
    said: list[str] = []
    fake, log = await _start(fixture(), said, hang_up_at=1)
    assert len(said) == 1 and len(log) == 1
    (end,) = fake.seen("end_call")
    assert end.body["outcome"] == "abandoned"


async def test_the_test_call_agent_never_reaches_a_model() -> None:
    fake_llm = FakeLLM([])
    async with AgentSession(llm=fake_llm) as session:
        await session.start(SettingsTestAgent())
        await session.run(user_input="Hello? Who is this?")
    assert fake_llm.requests == []
