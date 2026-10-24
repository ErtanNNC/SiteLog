"""`FakeLLM`: replays recorded agent turns (text and tool calls) in order, one per model request.

Every request's context is kept (`requests`), flattened to text by `request_texts()`, so a test can
assert what the dialog model saw: no phone number in any request (§10.12), the system prompt, the
redacted reporter turns. Nothing leaves the process.

A recorded turn is `{"text": "..."}`, `{"toolCalls": [{"name": "...", "args": {...}}]}`, or both.
When the recording runs out the fake answers an empty turn, so a run always ends.
"""

from __future__ import annotations

import itertools
import json
from collections import deque
from typing import Any

from livekit.agents import llm
from livekit.agents.types import (
    DEFAULT_API_CONNECT_OPTIONS,
    NOT_GIVEN,
    APIConnectOptions,
    NotGivenOr,
)

_ids = itertools.count(1)


class FakeLLM(llm.LLM):
    def __init__(self, turns: list[dict[str, Any]]) -> None:
        super().__init__()
        self._turns: deque[dict[str, Any]] = deque(turns)
        self.requests: list[llm.ChatContext] = []
        self.tool_names: list[list[str]] = []

    @property
    def model(self) -> str:
        return "fake"

    @property
    def provider(self) -> str:
        return "fake"

    @property
    def remaining(self) -> int:
        return len(self._turns)

    def chat(
        self,
        *,
        chat_ctx: llm.ChatContext,
        tools: list[llm.Tool] | None = None,
        conn_options: APIConnectOptions = DEFAULT_API_CONNECT_OPTIONS,
        parallel_tool_calls: NotGivenOr[bool] = NOT_GIVEN,
        tool_choice: NotGivenOr[llm.ToolChoice] = NOT_GIVEN,
        extra_kwargs: NotGivenOr[dict[str, Any]] = NOT_GIVEN,
    ) -> llm.LLMStream:
        self.requests.append(chat_ctx.copy())
        self.tool_names.append(
            [t.info.name for t in (tools or []) if isinstance(t, llm.FunctionTool)]
        )
        turn = self._turns.popleft() if self._turns else {}
        return _FakeStream(
            self, chat_ctx=chat_ctx, tools=tools or [], conn_options=conn_options, turn=turn
        )

    def request_texts(self) -> list[str]:
        """Every request as one string: instructions, messages, tool calls and tool outputs."""
        out: list[str] = []
        for ctx in self.requests:
            parts: list[str] = []
            for item in ctx.items:
                if item.type == "message":
                    parts.extend(c for c in item.content if isinstance(c, str))
                elif item.type == "function_call":
                    parts.append(f"{item.name}({item.arguments})")
                elif item.type == "function_call_output":
                    parts.append(item.output)
            out.append("\n".join(parts))
        return out


class _FakeStream(llm.LLMStream):
    def __init__(self, fake: FakeLLM, *, turn: dict[str, Any], **kwargs: Any) -> None:
        super().__init__(fake, **kwargs)
        self._turn = turn

    async def _run(self) -> None:
        chunk_id = f"fake-{next(_ids)}"
        text = self._turn.get("text")
        if text:
            self._event_ch.send_nowait(
                llm.ChatChunk(id=chunk_id, delta=llm.ChoiceDelta(role="assistant", content=text))
            )
        calls = [
            llm.FunctionToolCall(
                name=c["name"],
                arguments=json.dumps(c.get("args", {})),
                call_id=f"call_{next(_ids)}",
            )
            for c in self._turn.get("toolCalls", [])
        ]
        if calls:
            self._event_ch.send_nowait(
                llm.ChatChunk(
                    id=chunk_id, delta=llm.ChoiceDelta(role="assistant", tool_calls=calls)
                )
            )
