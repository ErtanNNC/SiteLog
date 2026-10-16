from __future__ import annotations

from typing import Any

import httpx
import pytest
import respx

from sitelog_voice.contract import ContractError
from sitelog_voice.field_api import CallAuth, FieldApi, FieldApiError
from tests.fakes.field_api import BASE_URL, SECRET, FakeFieldApi, derive_call_token

CALL = "5b1f0c3e-8a2d-4c6e-9f10-2b3c4d5e6f70"
ROOM = f"call-{CALL}"


def test_derive_call_token_matches_the_shared_vectors() -> None:
    # packages/shared/src/voice.test.ts "deriveCallToken matches the vectors"
    vectors = [
        (
            "test-secret",
            "0b8f6a4e-2c1d-4f3a-9e7b-5d6c8a9b0c1d",
            "QkocLsdEKu7geypc5_PsLhSodAGexD9IddDLNYJc_9A",
        ),
        (
            "another secret",
            "00000000-0000-4000-8000-000000000001",
            "hOZcao-JzSbhNOk7-wNcpl_Wn0BnEmAPYQOpmArqVk4",
        ),
    ]
    for secret, call_id, token in vectors:
        assert derive_call_token(secret, call_id) == token
        assert derive_call_token(secret, call_id.upper()) == token


async def start(api: FieldApi) -> CallAuth:
    auth, started = await api.calls_start(room=ROOM, transport="pstn", from_e164="+15550142087")
    assert started.reporter is not None and started.reporter.first_name == "Kevin"
    return auth


async def test_auth_headers(api: FieldApi, fake_api: FakeFieldApi) -> None:
    auth = await start(api)
    assert auth.call_token == derive_call_token(SECRET, CALL)
    assert "redacted" in repr(auth) and auth.call_token not in repr(auth)
    ctx = await api.get_context(auth)
    assert ctx.sites[0].name == "Northgate Parking Structure"

    start_seen, ctx_seen = fake_api.calls
    assert start_seen.headers["authorization"] == f"Bearer {SECRET}"
    assert "x-call-token" not in start_seen.headers  # calls/start has no token yet
    assert start_seen.body["from"] == "+15550142087"
    assert ctx_seen.headers["authorization"] == f"Bearer {SECRET}"
    assert ctx_seen.headers["x-call-token"] == auth.call_token
    assert ctx_seen.body == {"callId": CALL}


async def test_wrong_secret_or_token_is_refused_without_retry(fake_api: FakeFieldApi) -> None:
    async with FieldApi(base_url=BASE_URL, tool_secret="wrong", retry_delay_s=0) as bad:
        with pytest.raises(FieldApiError) as err:
            await bad.calls_start(room=ROOM, transport="pstn", from_e164="+15550142087")
    assert err.value.status == 401 and err.value.code == "unauthorized"
    assert len(fake_api.seen("calls_start")) == 1

    async with FieldApi(base_url=BASE_URL, tool_secret=SECRET, retry_delay_s=0) as api:
        with pytest.raises(FieldApiError) as err:
            await api.get_context(CallAuth(CALL, "x" * 43))
    assert err.value.status == 403
    assert len(fake_api.seen("get_context")) == 1


async def test_one_retry_on_5xx(api: FieldApi, fake_api: FakeFieldApi) -> None:
    auth = await start(api)
    fake_api.queue("get_context", 503, {"error": "unavailable"})
    ctx = await api.get_context(auth)
    assert ctx.max_questions == 2
    assert [c.status for c in fake_api.seen("get_context")] == [503, 200]


async def test_gives_up_after_the_second_5xx(api: FieldApi, fake_api: FakeFieldApi) -> None:
    auth = await start(api)
    fake_api.queue("get_context", 500, {"error": "internal"})
    fake_api.queue("get_context", 502, None)
    with pytest.raises(FieldApiError) as err:
        await api.get_context(auth)
    assert err.value.status == 502 and err.value.code == "http_502"
    assert len(fake_api.seen("get_context")) == 2


async def test_never_retries_a_4xx(api: FieldApi, fake_api: FakeFieldApi) -> None:
    auth = await start(api)
    fake_api.queue("set_day_status", 409, {"error": "report_live"})
    with pytest.raises(FieldApiError) as err:
        await api.tool("set_day_status", auth, status="no_work")
    assert (err.value.status, err.value.code, err.value.retryable) == (409, "report_live", False)
    assert len(fake_api.seen("set_day_status")) == 1


async def test_timeout_is_retried_once() -> None:
    attempts: list[int] = []

    def flaky(request: httpx.Request) -> httpx.Response:
        attempts.append(1)
        if len(attempts) == 1:
            raise httpx.ReadTimeout("slow", request=request)
        return httpx.Response(200, json={"ok": True})

    with respx.mock(assert_all_called=False) as router:
        router.post(f"{BASE_URL}/voice/tools/end_call").mock(side_effect=flaky)
        async with FieldApi(base_url=BASE_URL, tool_secret=SECRET, retry_delay_s=0) as api:
            await api.end_call(
                CallAuth(CALL, "t" * 43),
                outcome="abandoned",
                dialog_log=[],
                metrics={
                    "latencyP50Ms": None,
                    "latencyP95Ms": None,
                    "interruptions": 0,
                    "sttConfidence": None,
                    "turns": 0,
                },
            )
    assert len(attempts) == 2


async def test_timeout_twice_is_a_transport_error() -> None:
    def slow(request: httpx.Request) -> httpx.Response:
        raise httpx.ConnectTimeout("slow", request=request)

    with respx.mock(assert_all_called=False) as router:
        route = router.post(f"{BASE_URL}/voice/tools/get_context").mock(side_effect=slow)
        async with FieldApi(base_url=BASE_URL, tool_secret=SECRET, retry_delay_s=0) as api:
            with pytest.raises(FieldApiError) as err:
                await api.get_context(CallAuth(CALL, "t" * 43))
    assert err.value.code == "transport" and err.value.status is None
    assert route.call_count == 2


async def test_a_bad_request_never_leaves(api: FieldApi, fake_api: FakeFieldApi) -> None:
    auth = await start(api)
    with pytest.raises(ContractError):
        await api.tool("schedule_callback", auth, minutes=2)  # below the contract's 5
    with pytest.raises(ContractError):
        await api.tool("get_context", auth, phone="+15550142087")
    assert fake_api.seen("schedule_callback") == []


async def test_an_answer_off_contract_is_refused() -> None:
    bad: dict[str, Any] = {"callId": CALL, "callToken": "t" * 43, "reporter": {"firstName": "K"}}
    with respx.mock(assert_all_called=False) as router:
        router.post(f"{BASE_URL}/voice/calls/start").mock(
            return_value=httpx.Response(200, json=bad)
        )
        async with FieldApi(base_url=BASE_URL, tool_secret=SECRET, retry_delay_s=0) as api:
            with pytest.raises(ContractError, match="calls_start_response"):
                await api.calls_start(room=ROOM, transport="web", call_id=CALL)


def test_needs_a_secret() -> None:
    with pytest.raises(ValueError):
        FieldApi(base_url=BASE_URL, tool_secret="")
