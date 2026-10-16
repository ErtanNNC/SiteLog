"""The voice contract (spec Appendix B, "field-api voice routes"), loaded from `contract/*.json`.

`pnpm voice:contract` (W3-01) writes those files from `packages/shared/src/voice.ts`; this module
never holds a hand copy of a schema. Every request the agent sends and every answer it reads is
validated against them (`Contract.check_request` / `check_response`), plus the Zod refinements JSON
Schema cannot carry (each schema says its rule in its `description`; `_REFINEMENTS` below).

The pydantic models at the end are typed views of the few answers the agent reads field by field
(`calls/start`, `get_context`, the draft state). They are not the contract: `tests/test_contract.py`
compares each model's fields and required set with its JSON Schema, so a change in
`packages/shared` that the models miss fails the tests.
"""

from __future__ import annotations

import json
import os
from collections.abc import Callable, Mapping
from dataclasses import dataclass
from functools import cache
from pathlib import Path
from typing import Any, Literal

from jsonschema import Draft202012Validator
from jsonschema.exceptions import ValidationError
from pydantic import BaseModel, ConfigDict
from pydantic.alias_generators import to_camel

CONTRACT_DIR = Path(
    os.environ.get("VOICE_CONTRACT_DIR") or Path(__file__).resolve().parents[2] / "contract"
)


class ContractError(ValueError):
    """A request or an answer that does not match the contract.

    The message names the schema and the JSON path, never the offending value: a value may be a
    reporter's words (transcripts are data and stay out of logs).
    """

    def __init__(self, schema: str, path: str, reason: str) -> None:
        super().__init__(f"{schema}: {path or '<root>'}: {reason}")
        self.schema = schema
        self.path = path
        self.reason = reason


@dataclass(frozen=True)
class Route:
    name: str
    method: str
    path: str
    request: str
    response: str
    call_token: bool

    def url_path(self, call_id: str | None = None) -> str:
        if "{callId}" in self.path:
            if not call_id:
                raise ValueError(f"route {self.name} needs a call id")
            return self.path.replace("{callId}", call_id)
        return self.path


def _refine_calls_start_request(body: Mapping[str, Any]) -> str | None:
    if body.get("transport") == "web" and "callId" not in body:
        return "a web call passes callId"
    if "callId" not in body and ("from" not in body or "to" not in body):
        return "every call passes callId, or from and to"
    return None


def _refine_calls_start_response(body: Mapping[str, Any]) -> str | None:
    if ("reporter" in body) == ("unknown" in body):
        return "exactly one of reporter or unknown"
    return None


def _refine_set_day_status_request(body: Mapping[str, Any]) -> str | None:
    if body.get("status") == "weather_day" and "since" not in (body.get("details") or {}):
        return "a weather_day needs details.since"
    return None


def _refine_set_preference_request(body: Mapping[str, Any]) -> str | None:
    if "contactPref" not in body and "noCallsToday" not in body:
        return "contactPref or noCallsToday (or both)"
    return None


_REFINEMENTS: dict[str, Callable[[Mapping[str, Any]], str | None]] = {
    "calls_start_request": _refine_calls_start_request,
    "calls_start_response": _refine_calls_start_response,
    "tool_set_day_status_request": _refine_set_day_status_request,
    "tool_set_preference_request": _refine_set_preference_request,
}


class Contract:
    """The generated contract directory: routes (`index.json`) and one JSON Schema per shape."""

    def __init__(self, directory: Path = CONTRACT_DIR) -> None:
        self.directory = directory
        index = json.loads((directory / "index.json").read_text(encoding="utf-8"))
        self.call_token_header: str = index["callTokenHeader"]
        # W3-03: names a request, the same on its retry; field-api runs it once per call.
        self.request_id_header: str = index["requestIdHeader"]
        self.routes: dict[str, Route] = {
            name: Route(
                name=name,
                method=r["method"],
                path=r["path"],
                request=r["request"],
                response=r["response"],
                call_token=bool(r["callToken"]),
            )
            for name, r in index["routes"].items()
        }
        self._validators: dict[str, Draft202012Validator] = {}

    def schema_names(self) -> list[str]:
        return sorted(p.stem for p in self.directory.glob("*.json") if p.stem != "index")

    def schema(self, name: str) -> dict[str, Any]:
        return json.loads((self.directory / f"{name}.json").read_text(encoding="utf-8"))

    def validator(self, name: str) -> Draft202012Validator:
        if name not in self._validators:
            schema = self.schema(name)
            Draft202012Validator.check_schema(schema)
            self._validators[name] = Draft202012Validator(schema)
        return self._validators[name]

    def route(self, name: str) -> Route:
        try:
            return self.routes[name]
        except KeyError:
            raise KeyError(f"no voice route {name!r} in the contract") from None

    def check(self, schema: str, body: Any) -> None:
        errors = sorted(self.validator(schema).iter_errors(body), key=lambda e: list(e.path))
        if errors:
            raise _contract_error(schema, errors[0])
        refine = _REFINEMENTS.get(schema)
        if refine is not None and isinstance(body, Mapping):
            reason = refine(body)
            if reason:
                raise ContractError(schema, "", reason)

    def check_request(self, route: str, body: Any) -> None:
        self.check(self.route(route).request, body)

    def check_response(self, route: str, body: Any) -> None:
        self.check(self.route(route).response, body)


def _contract_error(schema: str, error: ValidationError) -> ContractError:
    path = "/".join(str(p) for p in error.absolute_path)
    # `error.message` quotes the instance (a reporter's words, a phone number) for most rules;
    # only `required` and `additionalProperties` name property names alone.
    if error.validator in ("required", "additionalProperties"):
        reason = error.message
    else:
        reason = f"fails '{error.validator}'"
    return ContractError(schema, path, reason)


@cache
def default_contract() -> Contract:
    return Contract()


# ─────────────────────────── Typed views (checked against the schemas) ───────────────────────────


class _View(BaseModel):
    model_config = ConfigDict(alias_generator=to_camel, populate_by_name=True, extra="forbid")


Locale = Literal["en-US", "es-US", "tr-TR"]


class Reporter(_View):
    first_name: str
    locale: Locale


class CallsStartResponse(_View):
    """`POST /voice/calls/start` → contract `calls_start_response`."""

    call_id: str
    call_token: str
    reporter: Reporter | None = None
    unknown: Literal[True] | None = None


class CallInfo(_View):
    direction: Literal["inbound", "outbound"]
    transport: Literal["pstn", "web"]
    purpose: Literal["daily_report", "reminder", "callback", "edit"] | None


class SiteInfo(_View):
    id: str
    name: str
    status: str | None
    deadline: str | None


class Company(_View):
    name: str
    aliases: list[str]


class Consents(_View):
    recording: bool
    data_processing: bool
    sms: bool
    auto_call: bool


class GetContextResponse(_View):
    """`POST /voice/tools/get_context` → contract `tool_get_context_response`."""

    call: CallInfo
    reporter: Reporter
    company: str
    report_language: Literal["en", "tr"]
    sites: list[SiteInfo]
    site_id: str | None
    companies: list[Company]
    keyterms: list[str]
    consents: Consents
    recording_notice_version: str
    consent_text_version: str
    max_questions: int


class DraftQuestion(_View):
    id: str
    text: str
    choices: list[str]


class DraftState(_View):
    """Contract `draft_state`, the answer of the live draft tools."""

    report_id: str
    draft_rev: int
    missing: list[str]
    question: DraftQuestion | None
    read_back: str | None


#: model → (contract schema, JSON pointer inside it), for the drift test.
TYPED_VIEWS: dict[type[_View], tuple[str, tuple[str, ...]]] = {
    CallsStartResponse: ("calls_start_response", ()),
    Reporter: ("calls_start_response", ("properties", "reporter")),
    GetContextResponse: ("tool_get_context_response", ()),
    CallInfo: ("tool_get_context_response", ("properties", "call")),
    SiteInfo: ("tool_get_context_response", ("properties", "sites", "items")),
    Company: ("tool_get_context_response", ("properties", "companies", "items")),
    Consents: ("tool_get_context_response", ("properties", "consents")),
    DraftState: ("draft_state", ()),
}
