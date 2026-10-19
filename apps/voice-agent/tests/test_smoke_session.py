"""A text-mode call on fakes (no STT, no TTS, no key, no network): the W3-02 smoke session.

FakeFieldApi answers from `fixtures/calls/smoke-get-context.json`; FakeLLM replays its recorded
turns: `get_context`, then `end_call`, then a goodbye. The run proves the plumbing end to end:
calls/start → the call token on every tool → get_context → end_call with the dialog log and the
metrics, all validated against the contract, and no phone number in any model request even though
the reporter says one.
"""

from __future__ import annotations

from typing import Any

from livekit.agents import AgentSession

from sitelog_voice.agent import ReportAgent, redacted_context
from sitelog_voice.field_api import FieldApi
from sitelog_voice.redact import contains_phone
from sitelog_voice.session import CallState
from sitelog_voice.tools import TOOL_NAMES
from tests.fakes.field_api import FakeFieldApi
from tests.fakes.llm import FakeLLM


async def test_text_mode_call_gets_context_and_ends(
    smoke_fixture: dict[str, Any], fake_api: FakeFieldApi, api: FieldApi
) -> None:
    start = smoke_fixture["start"]["request"]
    auth, started = await api.calls_start(
        room=start["room"],
        transport=start["transport"],
        from_e164=start["from"],
        to_e164=start["to"],
    )
    assert started.reporter is not None
    state = CallState(api=api, auth=auth, locale=started.reporter.locale)
    state.disclosure_played = True  # a bare agent: the call (ReportCall) plays it, W3-12
    fake_llm = FakeLLM(smoke_fixture["agentTurns"])
    clock = iter(float(i) for i in range(1000))

    async with AgentSession(llm=fake_llm) as session:
        await session.start(ReportAgent(state, clock=lambda: next(clock)))
        result = await session.run(user_input=smoke_fixture["reporterTurns"][0])

    result.expect.next_event().is_function_call(name="get_context")
    result.expect.next_event().is_function_call_output()
    result.expect.next_event().is_function_call(name="end_call", arguments={"outcome": "abandoned"})
    result.expect.next_event().is_function_call_output()
    result.expect.next_event().is_message(role="assistant")
    result.expect.no_more_events()

    # field-api saw the tools in order, each with the call token (the fake refuses otherwise).
    assert [(c.route, c.status) for c in fake_api.calls] == [
        ("calls_start", 200),
        ("get_context", 200),
        ("end_call", 200),
    ]
    end = fake_api.seen("end_call")[0].body
    assert end["outcome"] == "abandoned"
    assert end["dialogLog"][0]["speaker"] == "reporter"
    assert end["metrics"]["turns"] == 1
    assert state.context is not None and state.context.sites[0].name.startswith("Northgate")
    assert state.ended == "abandoned"

    # The dialog model saw the tools, the §9.4 prompt, and never a phone number.
    assert fake_llm.remaining == 0
    assert set(fake_llm.tool_names[0]) == set(TOOL_NAMES)
    texts = fake_llm.request_texts()
    assert texts and "SiteLog voice assistant" in texts[0]
    assert "[phone]" in texts[0]
    for text in texts:
        assert not contains_phone(text), text
        assert start["from"] not in text


async def test_end_call_cannot_claim_filed(
    smoke_fixture: dict[str, Any], fake_api: FakeFieldApi, api: FieldApi
) -> None:
    """The model saying `filed` does not file: only field-api's `filed` answer does (Q119)."""
    start = smoke_fixture["start"]["request"]
    auth, _ = await api.calls_start(
        room=start["room"], transport="pstn", from_e164=start["from"], to_e164=start["to"]
    )
    state = CallState(api=api, auth=auth, locale="en-US")
    state.disclosure_played = True
    turns = [
        {"toolCalls": [{"name": "file_report", "args": {}}]},
        {"toolCalls": [{"name": "end_call", "args": {"outcome": "filed"}}]},
        {"text": "Goodbye."},
    ]
    async with AgentSession(llm=FakeLLM(turns)) as session:
        await session.start(ReportAgent(state))
        result = await session.run(user_input="yes file it")

    result.expect.next_event().is_function_call(name="file_report")
    output = result.expect.next_event().is_function_call_output().event().item.output
    assert "read_back_first" in output  # no read-back yet: nothing is sent to field-api
    assert fake_api.seen("file_report") == []
    assert fake_api.seen("end_call")[0].body["outcome"] == "draft_saved"


def test_redacted_context_covers_every_item() -> None:
    from livekit.agents import llm

    ctx = llm.ChatContext()
    ctx.add_message(role="user", content="my number is 555 014 2087")
    ctx.insert(
        llm.FunctionCall(
            call_id="c1", name="load_report", arguments='{"dayReference": "+15550142087"}'
        )
    )
    ctx.insert(
        llm.FunctionCallOutput(
            call_id="c1", name="load_report", output="ring 5550142087", is_error=False
        )
    )
    out = redacted_context(ctx)
    message, call, output = out.items
    assert isinstance(message, llm.ChatMessage)
    assert isinstance(call, llm.FunctionCall)
    assert isinstance(output, llm.FunctionCallOutput)
    assert message.text_content == "my number is [phone]"
    assert call.arguments == '{"dayReference": "[phone]"}'
    assert output.output == "ring [phone]"
    # the original is untouched (the verbatim transcript stays with code)
    original = ctx.items[0]
    assert isinstance(original, llm.ChatMessage)
    assert "555 014 2087" in (original.text_content or "")


def test_the_model_context_never_ends_with_an_agent_line() -> None:
    """Preview Talk now (2026-10-19): "Still working on it, one moment." said while update_draft
    ran ended the context, and Anthropic refused it ("does not support assistant message
    prefill"); the call fell back to the recording. Code's trailing lines are not sent."""
    from livekit.agents import llm

    ctx = llm.ChatContext()
    ctx.add_message(role="assistant", content="Go ahead with today's report.")
    ctx.add_message(role="user", content="Four painters all day.")
    ctx.insert(llm.FunctionCall(call_id="c1", name="update_draft", arguments="{}"))
    ctx.insert(
        llm.FunctionCallOutput(call_id="c1", name="update_draft", output="{}", is_error=False)
    )
    ctx.add_message(role="assistant", content="Still working on it, one moment.")
    ctx.add_message(role="assistant", content="Mm-hm, go on.")
    out = redacted_context(ctx).items
    assert [i.type for i in out] == ["message", "message", "function_call", "function_call_output"]
    # The opening before the reporter's turn stays; the session's own context keeps every line.
    assert len(ctx.items) == 6
