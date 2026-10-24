from __future__ import annotations

import socket

import pytest
from pytest_socket import SocketBlockedError

from sitelog_voice.contract import default_contract
from sitelog_voice.tools import CODE_ROUTES, TOOL_NAMES


def test_every_tool_has_a_contract_route() -> None:
    routes = default_contract().routes
    assert set(TOOL_NAMES) <= set(routes)
    # calls/start, the disclosure mark (§19 Q205), the recording upload, the consent answer and
    # an unknown caller's message (W3-14) are code's, never the model's.
    assert set(routes) - set(TOOL_NAMES) == {
        "calls_start",
        "disclosure",
        "recording_upload",
        *CODE_ROUTES,
    }


@pytest.mark.filterwarnings("ignore:A test tried to use socket")
def test_the_network_is_blocked() -> None:
    """pytest-socket (pyproject addopts): a test that reaches for the network fails."""
    with pytest.raises(SocketBlockedError):
        socket.socket(socket.AF_INET, socket.SOCK_STREAM)


def test_every_tool_schema_is_one_anthropic_accepts() -> None:
    """The preview's Talk now (2026-10-19): Anthropic answered every turn 400, "Enum value 'link'
    does not match declared type ['string', 'null']" (set_preference's `Literal | None`), so the
    call fell back to the recording. The tools as the plugin sends them (strict schema): no enum
    on a type list, and every enum value of its declared type."""
    from livekit.agents import llm
    from livekit.agents.llm._provider_format.anthropic import to_fnc_ctx

    from sitelog_voice.field_api import CallAuth
    from sitelog_voice.session import CallState
    from sitelog_voice.tools import build_tools

    state = CallState(api=None, auth=CallAuth("c", "t"), locale="en-US")  # type: ignore[arg-type]
    schemas = to_fnc_ctx(llm.ToolContext(build_tools(state, now=lambda: 0.0)), strict=True)
    assert {s["name"] for s in schemas} == set(TOOL_NAMES)

    def walk(node: object, where: str) -> None:
        if isinstance(node, dict):
            if "enum" in node:
                kind = node.get("type")
                assert isinstance(kind, str), f"{where}: enum on type {kind!r}"
                py = {"string": str, "integer": int, "number": (int, float), "boolean": bool}[kind]
                assert all(isinstance(v, py) for v in node["enum"]), where
            for key, value in node.items():
                walk(value, f"{where}.{key}")
        elif isinstance(node, list):
            for i, value in enumerate(node):
                walk(value, f"{where}[{i}]")

    for schema in schemas:
        walk(schema["input_schema"], schema["name"])
