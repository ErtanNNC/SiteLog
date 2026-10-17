"""The dialog model's tools (spec §9.4 "Tools the agent can call", plus `pick_site`, Appendix B).

Each is a `@function_tool` that POSTs to field-api through `FieldApi` with the call token. The model
supplies only what it must interpret from the reporter (a status, minutes, a day reference, a site
from `get_context`'s list); everything code knows it takes from `CallState`:

- `update_draft` sends the reporter's turns as heard (the transcript is data, §9.4 rule 8);
- `record_answer` answers the draft's open question with the reporter's last turn;
- `file_report` sends the reporter's **verbatim** last turn and the read-back's draft revision; code
  in field-api files only when that turn is a §9.5 confirm (§19 Q119).
  The model cannot pass a "yes".
- `end_call` refuses `filed` unless field-api answered `filed`.

What the model gets back has phone numbers redacted (§10.12; the contract carries none anyway) and
field-api errors as a short status, never a raw error. W3-02 lays them down; W3-09 … W3-14 fill the
behaviour behind each route, and W3-12 speaks the read-back with `session.say` instead of handing
it to the model.
"""

from __future__ import annotations

from collections.abc import Awaitable, Callable
from typing import Any, Literal

from livekit.agents import function_tool
from livekit.agents.llm import FunctionTool

from .contract import ContractError, DraftState, TurnPending, is_pending
from .field_api import FieldApiError
from .redact import redact_phones
from .session import CallState

ToolResult = dict[str, Any]


def _safe(value: Any) -> Any:
    """Tool output as the model may see it: every string phone-redacted."""
    if isinstance(value, str):
        return redact_phones(value)
    if isinstance(value, dict):
        return {k: _safe(v) for k, v in value.items()}
    if isinstance(value, list):
        return [_safe(v) for v in value]
    return value


def _draft_view(draft: DraftState) -> ToolResult:
    return {
        "missing": draft.missing,
        "question": (
            {"text": draft.question.text, "choices": draft.question.choices}
            if draft.question
            else None
        ),
        "readBack": draft.read_back,
    }


async def _guard(name: str, call: Callable[[], Awaitable[ToolResult]]) -> ToolResult:
    try:
        return _safe(await call())
    except FieldApiError as exc:
        return {"status": "error", "tool": name, "code": exc.code}
    except ContractError:
        return {"status": "error", "tool": name, "code": "contract"}


def build_tools(state: CallState, *, now: Callable[[], float]) -> list[FunctionTool]:
    """The tools of one call, bound to its state. `now()` is seconds since the call connected."""
    api, auth = state.api, state.auth

    @function_tool
    async def get_context() -> ToolResult:
        """Load the call's context: the reporter's sites with today's status and deadline, the
        report language, the companies and their aliases, and how many questions to ask at most.
        Call it once at the start of the call."""

        async def run() -> ToolResult:
            ctx = await api.get_context(auth)
            state.context = ctx
            return {
                "sites": [{"id": s.id, "name": s.name, "status": s.status} for s in ctx.sites],
                "siteId": ctx.site_id,
                "reportLanguage": ctx.report_language,
                "companies": [{"name": c.name, "aliases": c.aliases} for c in ctx.companies],
                "maxQuestions": ctx.max_questions,
            }

        return await _guard("get_context", run)

    @function_tool
    async def pick_site(site_id: str) -> ToolResult:
        """Fix the site this call is about, when the reporter covers more than one.

        Args:
            site_id: the id of one of the sites get_context returned.
        """
        if state.context is None or site_id not in {s.id for s in state.context.sites}:
            return {"status": "unknown_site"}
        return await _guard("pick_site", lambda: api.tool("pick_site", auth, siteId=site_id))

    @function_tool
    async def update_draft() -> ToolResult:
        """Update the report draft from everything the reporter has said so far. Returns what is
        still missing, at most one question to ask, or the read-back when nothing is missing.
        `status: pending` means it is still working: say a short line and call it again."""
        if not state.segments:
            return {"status": "nothing_heard"}

        async def run() -> ToolResult:
            draft = await api.update_draft(auth, state.segments_payload())
            if isinstance(draft, TurnPending):
                # §19 Q117: the worker's turn runs past field-api's wait; the same words again
                # find the same turn (W3-09).
                return {"status": "pending"}
            state.draft = draft
            state.read_back_rev = draft.draft_rev if draft.read_back else None
            return _draft_view(draft)

        return await _guard("update_draft", run)

    @function_tool
    async def record_answer() -> ToolResult:
        """Record the reporter's last words as the answer to the open question. Say the
        `confirmation` it returns; `not_understood`: ask the question once more with its choices;
        `skipped`: it is left for the office, go on. `pending`: say a short line, call it again."""
        last = state.last_utterance
        question = state.draft.question if state.draft else None
        if last is None or question is None:
            return {"status": "no_open_question"}

        async def run() -> ToolResult:
            data = await api.tool(
                "record_answer",
                auth,
                questionId=question.id,
                utterance=last.text,
                start=last.start,
                end=last.end,
            )
            if is_pending(data):
                return {"status": "pending"}
            draft = DraftState.model_validate(data["draft"])
            state.draft = draft
            state.read_back_rev = draft.draft_rev if draft.read_back else None
            return {
                "status": data["status"],
                "confirmation": data["confirmation"],
                **_draft_view(draft),
            }

        return await _guard("record_answer", run)

    @function_tool
    async def apply_correction() -> ToolResult:
        """Apply the change the reporter just asked for (to today's draft, or to the report
        load_report found). Returns a read-back of the change only."""
        last = state.last_utterance
        if last is None:
            return {"status": "nothing_heard"}

        async def run() -> ToolResult:
            fields: dict[str, Any] = {"utterance": last.text, "start": last.start, "end": last.end}
            if state.loaded_report_id:
                fields["reportId"] = state.loaded_report_id
            data = await api.tool("apply_correction", auth, **fields)
            draft = DraftState.model_validate(data["draft"])
            state.draft = draft
            state.read_back_rev = draft.draft_rev
            return {
                "status": data["status"],
                "lines": data.get("lines", []),
                "readBack": data.get("readBack"),
            }

        return await _guard("apply_correction", run)

    @function_tool
    async def file_report() -> ToolResult:
        """File the report. Call it only right after the reporter said yes to "Shall I file it?".
        The reporter's own words decide; if they were not a clear yes, ask again."""
        last = state.last_utterance
        if state.draft is None or state.read_back_rev is None or last is None:
            return {"status": "read_back_first"}
        draft = state.draft

        async def run() -> ToolResult:
            data = await api.tool(
                "file_report",
                auth,
                reportId=draft.report_id,
                draftRev=state.read_back_rev,
                utterance=last.text,
            )
            if data["status"] == "draft_changed":
                state.draft = DraftState.model_validate(data["draft"])
                state.read_back_rev = None
            return {k: v for k, v in data.items() if k != "draft"}

        result = await _guard("file_report", run)
        if result.get("status") == "filed":
            state.filed = True
        return result

    @function_tool
    async def set_day_status(
        status: Literal["no_work", "weather_day"],
        since: str | None = None,
        workers_before: int | None = None,
    ) -> ToolResult:
        """Record a day with no work, or a weather day (work stopped by weather).

        Args:
            status: no_work or weather_day.
            since: for a weather day, when work stopped as HH:MM, or "never_started".
            workers_before: for a weather day, how many workers were on site before it stopped.
        """
        details: dict[str, Any] = {}
        if since is not None:
            details["since"] = since
        if workers_before is not None:
            details["workersBefore"] = workers_before
        fields: dict[str, Any] = {"status": status}
        if details:
            fields["details"] = details
        return await _guard("set_day_status", lambda: api.tool("set_day_status", auth, **fields))

    @function_tool
    async def schedule_callback(minutes: int) -> ToolResult:
        """Call the reporter back later.

        Args:
            minutes: in how many minutes (5 to 720).
        """
        return await _guard(
            "schedule_callback", lambda: api.tool("schedule_callback", auth, minutes=minutes)
        )

    @function_tool
    async def set_preference(
        contact_pref: Literal["link", "call"] | None = None,
        no_calls_today: bool = False,
    ) -> ToolResult:
        """Change how the reporter is reached: "text me instead" is link, "call me" is call;
        "not today" sets no_calls_today.

        Args:
            contact_pref: link or call.
            no_calls_today: true when the reporter asked not to be called today.
        """
        fields: dict[str, Any] = {}
        if contact_pref is not None:
            fields["contactPref"] = contact_pref
        if no_calls_today:
            fields["noCallsToday"] = True
        if not fields:
            return {"status": "nothing_to_change"}
        return await _guard("set_preference", lambda: api.tool("set_preference", auth, **fields))

    @function_tool
    async def load_report(day_reference: str) -> ToolResult:
        """Load a filed report of another day the reporter wants to change.

        Args:
            day_reference: the day as the reporter said it, e.g. "Friday" or "yesterday".
        """

        async def run() -> ToolResult:
            data = await api.tool("load_report", auth, dayReference=day_reference[:100])
            state.loaded_report_id = data.get("reportId") if data["status"] == "found" else None
            return data

        return await _guard("load_report", run)

    @function_tool
    async def start_fallback_recording(
        reason: Literal["not_understood", "stt_low_confidence", "agent_error"],
    ) -> ToolResult:
        """Switch to the simple recording mode after you could not understand twice in a row.

        Args:
            reason: why.
        """
        return await _guard(
            "start_fallback_recording",
            lambda: api.tool("start_fallback_recording", auth, reason=reason, at=round(now(), 2)),
        )

    @function_tool
    async def end_call(
        outcome: Literal[
            "filed",
            "draft_saved",
            "no_work",
            "weather_day",
            "edit_applied",
            "callback_requested",
            "fallback_recording",
            "abandoned",
        ],
    ) -> ToolResult:
        """End the call with its outcome, after the goodbye.

        Args:
            outcome: what the call achieved.
        """
        if outcome == "filed" and not state.filed:
            outcome = "draft_saved"  # only field-api's `filed` answer files (§19 Q119)

        async def run() -> ToolResult:
            await api.end_call(
                auth,
                outcome=outcome,
                dialog_log=state.log[-2000:],
                metrics=state.metrics.to_contract(),
            )
            state.ended = outcome
            return {"status": "ended", "outcome": outcome}

        return await _guard("end_call", run)

    return [
        get_context,
        pick_site,
        update_draft,
        record_answer,
        apply_correction,
        file_report,
        set_day_status,
        schedule_callback,
        set_preference,
        load_report,
        start_fallback_recording,
        end_call,
    ]


#: The tool names the model may call; `tests/test_tools.py` checks each has a contract route.
TOOL_NAMES = (
    "get_context",
    "pick_site",
    "update_draft",
    "record_answer",
    "apply_correction",
    "file_report",
    "set_day_status",
    "schedule_callback",
    "set_preference",
    "load_report",
    "start_fallback_recording",
    "end_call",
)
