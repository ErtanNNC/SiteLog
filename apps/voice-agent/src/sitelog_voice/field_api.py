"""The agent's client for `field-api`'s voice routes (spec §4.2, §9.4, Appendix B).

Server to server: `Authorization: Bearer VOICE_AGENT_TOOL_SECRET` on every route, plus the
per-call token (`X-Call-Token`, from `calls/start`) on every route the contract marks. Every request
is checked against `contract/` before it leaves and every answer before it is used, both ways
(`ContractError`). One retry on a 5xx or a transport error (a timeout, a reset), never on a 4xx:
field-api's tools are idempotent per call (W3-03), and a 4xx is an answer, not a fault.

Logs carry the route, the status and the call id, never a phone number, a token or the reporter's
words (§10.12; CLAUDE.md "Never send phone numbers to an LLM", transcripts are data).
"""

from __future__ import annotations

import asyncio
import logging
from dataclasses import dataclass
from typing import Any

import httpx

from .contract import (
    CallsStartResponse,
    Contract,
    DraftState,
    GetContextResponse,
    default_contract,
)

log = logging.getLogger("sitelog_voice.field_api")

#: Back-off before the single retry.
RETRY_DELAY_S = 0.25


class FieldApiError(RuntimeError):
    """field-api refused a request (4xx) or failed twice (5xx / transport).

    `code` is field-api's `{error}` (e.g. `forbidden`, `wrong_state`), or `transport` / `http_<n>`.
    """

    def __init__(self, route: str, status: int | None, code: str) -> None:
        super().__init__(f"field-api {route}: {status or '-'} {code}")
        self.route = route
        self.status = status
        self.code = code

    @property
    def retryable(self) -> bool:
        return self.status is None or self.status >= 500


@dataclass
class CallAuth:
    """What `calls/start` hands back: the call's id and token, used on every later request."""

    call_id: str
    call_token: str

    def __repr__(self) -> str:  # never print the token
        return f"CallAuth(call_id={self.call_id!r}, call_token=<redacted>)"


class FieldApi:
    def __init__(
        self,
        *,
        base_url: str,
        tool_secret: str,
        timeout_s: float = 20.0,
        contract: Contract | None = None,
        client: httpx.AsyncClient | None = None,
        retry_delay_s: float = RETRY_DELAY_S,
    ) -> None:
        if not tool_secret:
            raise ValueError("FieldApi needs VOICE_AGENT_TOOL_SECRET")
        self._base = base_url.rstrip("/")
        self._secret = tool_secret
        self._contract = contract or default_contract()
        self._client = client or httpx.AsyncClient(timeout=httpx.Timeout(timeout_s))
        self._owns_client = client is None
        self._retry_delay_s = retry_delay_s

    async def aclose(self) -> None:
        if self._owns_client:
            await self._client.aclose()

    async def __aenter__(self) -> FieldApi:
        return self

    async def __aexit__(self, *_exc: object) -> None:
        await self.aclose()

    # ───────────────────────────── the one request path ─────────────────────────────

    async def request(
        self, route_name: str, body: dict[str, Any], auth: CallAuth | None = None
    ) -> Any:
        """POST `body` to the route, validated both ways; returns the parsed answer."""
        route = self._contract.route(route_name)
        self._contract.check_request(route_name, body)
        headers = {"Authorization": f"Bearer {self._secret}"}
        if route.call_token:
            if auth is None:
                raise ValueError(f"route {route_name} needs the call token")
            headers[self._contract.call_token_header] = auth.call_token
        call_id = body.get("callId") or (auth.call_id if auth else None)
        url = f"{self._base}{route.url_path(call_id)}"

        last: FieldApiError | None = None
        for attempt in (1, 2):
            try:
                response = await self._client.request(route.method, url, json=body, headers=headers)
            except httpx.TransportError as exc:
                last = FieldApiError(route_name, None, "transport")
                log.warning(
                    "field-api transport error",
                    extra={
                        "route": route_name,
                        "call_id": call_id,
                        "attempt": attempt,
                        "error": type(exc).__name__,
                    },
                )
            else:
                if response.status_code < 400:
                    data = response.json()
                    self._contract.check_response(route_name, data)
                    log.debug(
                        "field-api ok",
                        extra={
                            "route": route_name,
                            "call_id": call_id,
                            "status": response.status_code,
                        },
                    )
                    return data
                last = FieldApiError(route_name, response.status_code, _error_code(response))
                log.warning(
                    "field-api error",
                    extra={
                        "route": route_name,
                        "call_id": call_id,
                        "attempt": attempt,
                        "status": response.status_code,
                        "code": last.code,
                    },
                )
                if not last.retryable:
                    raise last
            if attempt == 1:
                await asyncio.sleep(self._retry_delay_s)
        raise last or FieldApiError(route_name, None, "transport")

    # ───────────────────────────── typed helpers ─────────────────────────────

    async def calls_start(
        self,
        *,
        room: str,
        transport: str,
        from_e164: str | None = None,
        call_id: str | None = None,
    ) -> tuple[CallAuth, CallsStartResponse]:
        """The agent's first request in a room. `from_e164` goes to field-api only (stored server
        side, §9.4) and is never kept on the agent beyond this call."""
        body: dict[str, Any] = {"room": room, "transport": transport}
        if from_e164 is not None:
            body["from"] = from_e164
        if call_id is not None:
            body["callId"] = call_id
        data = await self.request("calls_start", body)
        started = CallsStartResponse.model_validate(data)
        return CallAuth(started.call_id, started.call_token), started

    async def get_context(self, auth: CallAuth) -> GetContextResponse:
        data = await self.request("get_context", {"callId": auth.call_id}, auth)
        return GetContextResponse.model_validate(data)

    async def update_draft(self, auth: CallAuth, segments: list[dict[str, Any]]) -> DraftState:
        data = await self.request(
            "update_draft", {"callId": auth.call_id, "segments": segments}, auth
        )
        return DraftState.model_validate(data)

    async def tool(self, name: str, auth: CallAuth, **fields: Any) -> Any:
        """Any other tool route: `{callId, **fields}`, the answer as the contract's JSON."""
        return await self.request(name, {"callId": auth.call_id, **fields}, auth)

    async def end_call(
        self,
        auth: CallAuth,
        *,
        outcome: str,
        dialog_log: list[dict[str, Any]],
        metrics: dict[str, Any],
    ) -> None:
        await self.request(
            "end_call",
            {
                "callId": auth.call_id,
                "outcome": outcome,
                "dialogLog": dialog_log,
                "metrics": metrics,
            },
            auth,
        )


def _error_code(response: httpx.Response) -> str:
    try:
        data = response.json()
    except ValueError:
        return f"http_{response.status_code}"
    if isinstance(data, dict) and isinstance(data.get("error"), str):
        return data["error"][:64]
    return f"http_{response.status_code}"
