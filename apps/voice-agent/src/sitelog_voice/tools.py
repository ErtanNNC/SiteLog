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

What the model gets back has phone numbers redacted (§10.12; the contract carries none anyway).
W3-12 adds the guard every tool runs in (`build_tools`' `guard`):

- the model's arguments are checked against `contract/` before anything leaves (`FieldApi`), so a
  wrong value (`minutes: 2`) never reaches field-api;
- no tool that processes the reporter's speech (`SPEECH_TOOLS`) runs before the disclosure was
  played (§9.4 "Recording", §15.2): it answers `disclosure_first` and sends nothing;
- an error reaches the model as `{status: error, code, say}`: `say` is code's short line in the call
  language (`tool_error`, or the site question for `site_required`), never field-api's message;
- field-api failing twice (a 5xx or the network) is an agent error: the call goes to the simple
  recording mode (§7.3, §10.12 "calls fall back to plain recording");
- the call (`ToolHooks`, `agent.ReportCall`) hears when a tool starts and what it answered: the §7.3
  machine moves on it, and a filler covers a long wait.
"""

from __future__ import annotations

from collections.abc import Awaitable, Callable
from typing import Any, Literal, Protocol

from livekit.agents import function_tool
from livekit.agents.llm import FunctionTool

from .contract import ContractError, DraftState, TurnPending, is_pending
from .copy import VoiceCopy, default_copy
from .field_api import FieldApiError
from .redact import redact_phones
from .session import CallState, settle_outcome
from .special import next_step_line

ToolResult = dict[str, Any]

#: Tools that process what the reporter said (or act on it): never before the disclosure.
SPEECH_TOOLS = frozenset(
    {
        "update_draft",
        "record_answer",
        "apply_correction",
        "file_report",
        "set_day_status",
        "schedule_callback",
        "set_preference",
        "load_report",
        "save_change",
        "start_fallback_recording",
    }
)


class ToolHooks(Protocol):
    """What the call does around a turn and a tool (`agent.ReportCall`); `NoHooks` for a bare
    agent."""

    def turn_heard(self, text: str, confidence: float | None) -> None: ...

    def tool_started(self, name: str) -> None: ...

    def tool_done(self, name: str, result: ToolResult) -> None: ...

    def agent_error(self) -> None: ...

    async def fallback(self, reason: str) -> None: ...

    async def ended(self, outcome: str) -> None: ...


class NoHooks:
    def turn_heard(self, text: str, confidence: float | None) -> None:
        pass

    def tool_started(self, name: str) -> None:
        pass

    def tool_done(self, name: str, result: ToolResult) -> None:
        pass

    def agent_error(self) -> None:
        pass

    async def fallback(self, reason: str) -> None:
        pass

    async def ended(self, outcome: str) -> None:
        pass


async def post_fallback(state: CallState, reason: str, at: float) -> None:
    """F6's simple recording mode, at field-api (`calls.fallback`, W3-11) and in the call state."""
    if state.fallback:
        return
    state.fallback = True
    await state.api.tool(
        "start_fallback_recording", state.auth, reason=reason, at=round(min(max(at, 0), 3600), 2)
    )


async def send_end_call(state: CallState, outcome: str) -> None:
    """`end_call` once, with the dialog log and the metrics; the outcome already settled."""
    if state.ended:
        return
    await state.api.end_call(
        state.auth,
        outcome=outcome,
        dialog_log=state.end_log(),
        metrics=state.metrics.to_contract(),
    )
    state.ended = outcome


def error_line(state: CallState, code: str, copy: VoiceCopy | None = None) -> str:
    """The line the agent says for a tool error: never the error itself."""
    copy = copy or default_copy()
    if code == "site_required":
        # F14: the draft needs the site first; the site question in code's words.
        return next_step_line(state, copy)
    return copy.line("tool_error", state.language)


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


def build_tools(
    state: CallState, *, now: Callable[[], float], hooks: ToolHooks | None = None
) -> list[FunctionTool]:
    """The tools of one call, bound to its state. `now()` is seconds since the call connected."""
    api, auth = state.api, state.auth
    copy = default_copy()
    hooks = hooks or NoHooks()

    async def guard(name: str, call: Callable[[], Awaitable[ToolResult]]) -> ToolResult:
        if name in SPEECH_TOOLS and not state.disclosure_played:
            # §9.4 "Recording": nothing that processes speech before the recording notice.
            return {"status": "disclosure_first"}
        hooks.tool_started(name)
        try:
            result = _safe(await call())
        except FieldApiError as exc:
            if exc.retryable:
                hooks.agent_error()
            result = {"status": "error", "code": exc.code, "say": error_line(state, exc.code)}
        except ContractError:
            # The model's arguments (or field-api's answer) off the contract: nothing was done.
            result = {"status": "error", "code": "invalid", "say": error_line(state, "invalid")}
        hooks.tool_done(name, result)
        return result

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

        return await guard("get_context", run)

    @function_tool
    async def pick_site(site_id: str) -> ToolResult:
        """Fix the site this call is about, when the reporter covers more than one.

        Args:
            site_id: the id of one of the sites get_context returned.
        """
        if state.context is None or site_id not in {s.id for s in state.context.sites}:
            return {"status": "unknown_site"}

        async def run() -> ToolResult:
            data = await api.tool("pick_site", auth, siteId=site_id)
            if state.context is not None:
                state.context = state.context.model_copy(update={"site_id": data["siteId"]})
            return data

        return await guard("pick_site", run)

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

        return await guard("update_draft", run)

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

        return await guard("record_answer", run)

    @function_tool
    async def apply_correction() -> ToolResult:
        """Apply the change the reporter just asked for (to today's draft, or to the report
        load_report found). Say the `readBack` it returns (the change only, then "Shall I file
        it?"); `not_understood`: say its line. `pending`: say a short line, call it again."""
        last = state.last_utterance
        if last is None:
            return {"status": "nothing_heard"}

        async def run() -> ToolResult:
            fields: dict[str, Any] = {"utterance": last.text, "start": last.start, "end": last.end}
            if state.loaded_report_id:
                fields["reportId"] = state.loaded_report_id
            try:
                data = await api.tool("apply_correction", auth, **fields)
            except FieldApiError as exc:
                # W3-14 (F10 call): code's lines for a locked report and a change still running.
                line = {"report_locked": "edit_locked", "correction_pending": "edit_pending"}.get(
                    exc.code
                )
                if line is None:
                    raise
                return {"status": exc.code, "say": copy.line(line, state.language)}
            if is_pending(data):
                # W3-10: a worker turn like update_draft; the same words again are the same turn.
                return {"status": "pending"}
            if data["status"] == "preview":
                # W3-14 (F10 call): the filed report's change, read back with "Save it?"; only the
                # reporter's yes to it saves (save_change).
                state.pending_change = {
                    "reportId": fields["reportId"],
                    "correctionId": data["correctionId"],
                    "heard": len(state.segments),
                }
                return {"status": "preview", "readBack": data["readBack"]}
            if data.get("draft") is not None:
                draft = DraftState.model_validate(data["draft"])
                state.draft = draft
                # §9.4 rule 5: the change alone is read back, then "Shall I file it?"; the yes
                # after it names this revision.
                state.read_back_rev = (
                    draft.draft_rev if data.get("readBack") or draft.read_back else None
                )
            return {
                "status": data["status"],
                "lines": data.get("lines", []),
                "readBack": data.get("readBack"),
            }

        return await guard("apply_correction", run)

    @function_tool
    async def file_report() -> ToolResult:
        """File the report. Call it only right after the reporter said yes to "Shall I file it?".
        The reporter's own words decide (code checks them): say the `say` line it returns;
        `draft_changed`: read back the new `readBack`; `pending`: a short line, then call again."""
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
            status = data["status"]
            if status == "draft_changed":
                # The draft moved since the read-back: read the new one back, then ask again.
                changed = DraftState.model_validate(data["draft"])
                state.draft = changed
                state.read_back_rev = changed.draft_rev if changed.read_back else None
                return {"status": status, **_draft_view(changed)}
            if status == "not_confirmed":
                # §19 Q119: not a clear yes; code's line, never the model's guess.
                return {"status": status, "say": copy.line("confirm_repeat", state.language)}
            if status == "filed":
                # F6 step 7: the goodbye says the PDF and the photos link were sent.
                return {
                    "status": status,
                    "reportNo": data["reportNo"],
                    "say": copy.line("goodbye_filed", state.language),
                }
            return {"status": status}  # pending: say a short line, call file_report again

        result = await guard("file_report", run)
        if result.get("status") == "filed":
            state.filed = True
        return result

    @function_tool
    async def set_day_status(
        status: Literal["no_work", "weather_day"],
        since: str | None = None,
        workers_before: int | None = None,
    ) -> ToolResult:
        """Record a day with no work, or a weather day (work stopped by weather). In two steps:
        the first call returns a read-back (`status: confirm`) to say as it is; after the reporter
        answers, call it again with the same details: code logs the day only on their yes.

        Args:
            status: no_work or weather_day.
            since: for a weather day, when work stopped as HH:MM, or "never_started".
            workers_before: for a weather day, how many workers were on site before it stopped.
        """
        details: dict[str, Any] = {}
        if status == "weather_day":
            if since is not None:
                details["since"] = since
            if workers_before is not None:
                details["workersBefore"] = workers_before
        fields: dict[str, Any] = {"status": status}
        if details:
            fields["details"] = details
        last = state.last_utterance
        if last is not None:
            fields["start"] = last.start
            if last.end > last.start:
                fields["end"] = last.end
        pending = state.day_off
        # The reporter's turn after the read-back of these same details is the answer to it: code
        # (field-api) decides whether it is a yes. Never the model's word for it (§19 Q119).
        if (
            pending is not None
            and pending["status"] == status
            and pending["details"] == details
            and last is not None
            and len(state.segments) > pending["heard"]
        ):
            fields["utterance"] = last.text
            fields["confirmKey"] = pending["key"]
            # The details' source is when they were said, not the yes.
            fields["start"] = pending["start"]
            fields.pop("end", None)
            if pending.get("end") is not None:
                fields["end"] = pending["end"]

        async def run() -> ToolResult:
            data = await api.tool("set_day_status", auth, **fields)
            answer = data["status"]
            if answer in ("confirm", "not_confirmed"):
                state.day_off = {
                    "status": status,
                    "details": details,
                    "key": data["confirmKey"],
                    "heard": len(state.segments),
                    "start": fields.get("start", 0),
                    "end": fields.get("end"),
                }
            else:
                state.day_off = None
            if answer == "ok":
                state.day_logged = status
            return {"status": answer, "say": data["confirmation"]}

        return await guard("set_day_status", run)

    @function_tool
    async def schedule_callback(minutes: int) -> ToolResult:
        """Call the reporter back later.

        Args:
            minutes: in how many minutes (5 to 720).
        """

        async def run() -> ToolResult:
            try:
                return await api.tool("schedule_callback", auth, minutes=minutes)
            except FieldApiError as exc:
                if exc.code != "not_available":
                    raise
                # §19 Q128: no pack places outbound calls yet (W3-17); code's line, not a promise.
                return {
                    "status": "not_available",
                    "say": copy.line("callback_unavailable", state.language),
                }

        return await guard("schedule_callback", run)

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
        return await guard("set_preference", lambda: api.tool("set_preference", auth, **fields))

    @function_tool
    async def load_report(day_reference: str) -> ToolResult:
        """Load a filed report of another day the reporter wants to change.

        Args:
            day_reference: the day as the reporter said it, e.g. "Friday" or "yesterday".
        """

        async def run() -> ToolResult:
            data = await api.tool("load_report", auth, dayReference=day_reference[:100])
            found = data["status"] == "found"
            state.loaded_report_id = data.get("reportId") if found else None
            state.pending_change = None
            # W3-14 (F10 call): code's lines: the summary and "What should I change?", or why not.
            lang = state.language
            if found:
                say = f"{data['summary']} {copy.line('edit_ask', lang)}"
            else:
                say = copy.line(
                    {"locked": "edit_locked", "ambiguous": "edit_ambiguous"}.get(
                        data["status"], "edit_not_found"
                    ),
                    lang,
                )
            return {**data, "say": say}

        return await guard("load_report", run)

    @function_tool
    async def save_change() -> ToolResult:
        """Save the change of another day's report after it was read back. Call it only right
        after the reporter answered "Save it?". Their own words decide (code checks them): say
        the `say` line it returns."""
        pending = state.pending_change
        last = state.last_utterance
        if pending is None or last is None or len(state.segments) <= pending["heard"]:
            return {"status": "read_back_first"}

        async def run() -> ToolResult:
            data = await api.tool(
                "save_change",
                auth,
                reportId=pending["reportId"],
                correctionId=pending["correctionId"],
                utterance=last.text,
            )
            if data["status"] == "saved":
                state.edit_saved = True
                state.pending_change = None
            elif data["status"] == "draft_changed":
                state.pending_change = None
            return {"status": data["status"], "say": data["confirmation"]}

        return await guard("save_change", run)

    @function_tool
    async def start_fallback_recording(
        reason: Literal["not_understood", "stt_low_confidence", "agent_error"],
    ) -> ToolResult:
        """Switch to the simple recording mode after you could not understand twice in a row.

        Args:
            reason: why.
        """
        if state.fallback:
            return {"status": "recording"}

        async def run() -> ToolResult:
            await post_fallback(state, reason, now())
            # The call says F6's line and plays the tone; the model is not asked again.
            await hooks.fallback(reason)
            return {"status": "recording"}

        return await guard("start_fallback_recording", run)

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
        if state.ended:
            return {"status": "ended", "outcome": state.ended}
        # Only what field-api did: `filed` after its `filed` (§19 Q119), a day off or a saved
        # change when it logged them (W3-14), no callback before W3-17 (§19 Q128).
        settled = settle_outcome(state, outcome)

        async def run() -> ToolResult:
            await send_end_call(state, settled)
            await hooks.ended(settled)
            return {"status": "ended", "outcome": settled}

        return await guard("end_call", run)

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
        save_change,
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
    "save_change",
    "start_fallback_recording",
    "end_call",
)

#: W3-14: the contract routes code calls itself, never the model: the consent question's answer
#: (F3, §19 Q120) and an unknown caller's message (F13).
CODE_ROUTES = ("record_consent", "leave_message")
