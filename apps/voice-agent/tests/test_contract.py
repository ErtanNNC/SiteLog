from __future__ import annotations

from typing import Any

import pytest
from jsonschema import Draft202012Validator

from sitelog_voice.contract import (
    TYPED_VIEWS,
    ContractError,
    default_contract,
)

CALL = "0b8f6a4e-2c1d-4f3a-9e7b-5d6c8a9b0c1d"


def test_every_schema_is_valid_json_schema() -> None:
    contract = default_contract()
    names = contract.schema_names()
    assert len(names) >= 30
    for name in names:
        Draft202012Validator.check_schema(contract.schema(name))


def test_every_route_names_existing_schemas() -> None:
    contract = default_contract()
    names = set(contract.schema_names())
    assert contract.call_token_header == "X-Call-Token"
    for route in contract.routes.values():
        assert route.method == "POST"
        assert route.request in names and route.response in names
        assert route.call_token == (route.name != "calls_start")


def _at(schema: dict[str, Any], pointer: tuple[str, ...]) -> dict[str, Any]:
    node = schema
    for key in pointer:
        node = node[key]
    return node


@pytest.mark.parametrize("model", list(TYPED_VIEWS), ids=lambda m: m.__name__)
def test_typed_views_match_the_contract(model: Any) -> None:
    """The pydantic views must name exactly the schema's properties and required set."""
    schema_name, pointer = TYPED_VIEWS[model]
    node = _at(default_contract().schema(schema_name), pointer)
    aliases = {f.alias or name: f for name, f in model.model_fields.items()}
    assert set(aliases) == set(node["properties"])
    required = {alias for alias, f in aliases.items() if f.is_required()}
    assert required == set(node.get("required", []))


def test_request_validation_and_refinements() -> None:
    c = default_contract()
    c.check_request(
        "calls_start",
        {"room": f"call-{CALL}", "transport": "pstn", "from": "+15550142087", "to": "+15550142290"},
    )
    c.check_request("calls_start", {"room": f"call-{CALL}", "transport": "web", "callId": CALL})
    with pytest.raises(ContractError, match="from and to"):
        c.check_request("calls_start", {"room": f"call-{CALL}", "transport": "pstn"})
    # W3-03: a SIP start names the number it called too.
    with pytest.raises(ContractError, match="from and to"):
        c.check_request(
            "calls_start", {"room": f"call-{CALL}", "transport": "pstn", "from": "+15550142087"}
        )
    with pytest.raises(ContractError, match="web call passes callId"):
        c.check_request(
            "calls_start", {"room": f"call-{CALL}", "transport": "web", "from": "+15550142087"}
        )
    with pytest.raises(ContractError, match=r"details\.since"):
        c.check_request("set_day_status", {"callId": CALL, "status": "weather_day"})
    c.check_request(
        "set_day_status", {"callId": CALL, "status": "weather_day", "details": {"since": "11:00"}}
    )
    with pytest.raises(ContractError, match="contactPref or noCallsToday"):
        c.check_request("set_preference", {"callId": CALL})
    with pytest.raises(ContractError, match="Additional properties"):
        c.check_request("get_context", {"callId": CALL, "phone": "+15550142087"})


def test_response_refinement_reporter_or_unknown() -> None:
    c = default_contract()
    token = "A" * 43
    c.check_response("calls_start", {"callId": CALL, "callToken": token, "unknown": True})
    with pytest.raises(ContractError, match="exactly one"):
        c.check_response("calls_start", {"callId": CALL, "callToken": token})
    # W4-05 (§19 Q232, Q350): Settings' test call, with its locale, never beside a reporter.
    test = {"callId": CALL, "callToken": token, "settingsTest": {"company": "Kestrel"}}
    c.check_response("calls_start", {**test, "locale": "en-US"})
    with pytest.raises(ContractError, match="with locale"):
        c.check_response("calls_start", test)
    with pytest.raises(ContractError, match="exactly one"):
        c.check_response("calls_start", {**test, "locale": "en-US", "unknown": True})


def test_contract_errors_never_quote_a_value() -> None:
    c = default_contract()
    with pytest.raises(ContractError) as err:
        c.check_request(
            "calls_start", {"room": f"call-{CALL}", "transport": "pstn", "from": "555-014-2087 x"}
        )
    assert "555" not in str(err.value)
    assert err.value.path == "from"
