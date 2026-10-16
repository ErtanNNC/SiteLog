"""`FakeFieldApi`: field-api's `/voice/*` routes on respx, answering from a call fixture.

It behaves like the real server on everything the agent can get wrong:

- `Authorization: Bearer <secret>` on every route (401 otherwise);
- `X-Call-Token` = `derive_call_token(secret, callId)` on every route the contract marks (403);
- every request validated against `contract/` (400 `invalid_request`), and every answer the fake
  sends validated too, so a fixture that drifts from the contract fails the test that uses it;
- no phone number in any answer (the fake asserts it, §10.12).

Answers come from the fixture's `routes` (a list per route, used in order; the last one repeats),
or from `queue(route, status, body)` for error and retry tests. Every request is kept in `calls`.
"""

from __future__ import annotations

import base64
import hashlib
import hmac
import json
import re
from collections import defaultdict, deque
from dataclasses import dataclass
from typing import Any

import httpx
import respx

from sitelog_voice.contract import Contract, ContractError, default_contract
from sitelog_voice.redact import contains_phone

BASE_URL = "http://field-api.test/functions/v1/field-api"
SECRET = "test-tool-secret"


def derive_call_token(secret: str, call_id: str) -> str:
    """`deriveCallToken` of packages/shared/src/voice.ts: HMAC-SHA-256 of
    `sitelog/call_token/v1/<callId lower case>`, base64url without padding."""
    mac = hmac.new(
        secret.encode(), f"sitelog/call_token/v1/{call_id.lower()}".encode(), hashlib.sha256
    ).digest()
    return base64.urlsafe_b64encode(mac).rstrip(b"=").decode()


@dataclass
class Seen:
    route: str
    body: dict[str, Any]
    headers: dict[str, str]
    status: int


class FakeFieldApi:
    def __init__(
        self,
        fixture: dict[str, Any] | None = None,
        *,
        contract: Contract | None = None,
        secret: str = SECRET,
        base_url: str = BASE_URL,
    ) -> None:
        self.contract = contract or default_contract()
        self.secret = secret
        self.base_url = base_url
        self.calls: list[Seen] = []
        self._answers: dict[str, list[dict[str, Any]]] = {}
        self._queued: dict[str, deque[tuple[int, Any]]] = defaultdict(deque)
        if fixture:
            start = fixture.get("start")
            if start:
                # The token is derived, never recorded: the fake checks tools against it.
                response = dict(start["response"])
                response["callToken"] = derive_call_token(secret, response["callId"])
                self._answers["calls_start"] = [response]
            for name, answers in (fixture.get("routes") or {}).items():
                self._answers[name] = list(answers)
        self.router = respx.mock(assert_all_called=False)
        for name, route in self.contract.routes.items():
            pattern = re.escape(route.path).replace(re.escape("{callId}"), "[0-9a-f-]{36}")
            self.router.route(
                method=route.method, url__regex=f"^{re.escape(base_url)}{pattern}$"
            ).mock(side_effect=self._handler(name))

    # ─────────────────────────── control ───────────────────────────

    def queue(self, route: str, status: int, body: Any = None) -> None:
        """The next request to `route` gets this answer (before the fixture's)."""
        self._queued[route].append((status, body))

    def seen(self, route: str) -> list[Seen]:
        return [c for c in self.calls if c.route == route]

    def __enter__(self) -> FakeFieldApi:
        self.router.__enter__()
        return self

    def __exit__(self, *exc: Any) -> None:
        self.router.__exit__(*exc)

    # ─────────────────────────── the server ───────────────────────────

    def _handler(self, name: str):
        route = self.contract.route(name)

        def handle(request: httpx.Request, **_kw: Any) -> httpx.Response:
            headers = {k.lower(): v for k, v in request.headers.items()}
            try:
                body = json.loads(request.content or b"null")
            except ValueError:
                return self._answer(name, {}, headers, 400, {"error": "invalid_json"})
            if headers.get("authorization") != f"Bearer {self.secret}":
                return self._answer(name, body, headers, 401, {"error": "unauthorized"})
            try:
                self.contract.check_request(name, body)
            except ContractError as exc:
                return self._answer(
                    name, body, headers, 400, {"error": "invalid_request", "details": str(exc)}
                )
            if route.call_token:
                expected = derive_call_token(self.secret, body["callId"])
                if headers.get(self.contract.call_token_header.lower()) != expected:
                    return self._answer(name, body, headers, 403, {"error": "forbidden"})
            if self._queued[name]:
                status, payload = self._queued[name].popleft()
                return self._answer(name, body, headers, status, payload)
            answers = self._answers.get(name)
            if not answers:
                return self._answer(name, body, headers, 501, {"error": "no_fixture_answer"})
            payload = answers.pop(0) if len(answers) > 1 else answers[0]
            return self._answer(name, body, headers, 200, payload)

        return handle

    def _answer(
        self, name: str, body: Any, headers: dict[str, str], status: int, payload: Any
    ) -> httpx.Response:
        self.calls.append(Seen(name, body if isinstance(body, dict) else {}, headers, status))
        if status < 400 and payload is not None:
            self.contract.check_response(name, payload)  # a fixture must match the contract
            assert not contains_phone(json.dumps(payload)), f"phone number in {name} answer"
        if payload is None:
            return httpx.Response(status)
        return httpx.Response(status, json=payload)
