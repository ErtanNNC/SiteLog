"""Logging and Sentry for the voice agent (spec §5 "Monitoring"; CLAUDE.md "errors to Sentry").

Logs and Sentry events carry the call id, never a phone number or the reporter's words:

- `PhoneRedactingFilter` runs every log record's message, string arguments and string `extra`
  fields through `redact_phones` (a last line of defence; code logs ids and statuses only). LiveKit
  Agents logs the room name as `extra` (`room`), and an inbound phone call's room is named by the
  SIP dispatch rule with the caller's number in it (§19 Q227);
- `before_send` drops request bodies, breadcrumbs' data and local variables, and redacts phone
  numbers from what is left (exception messages, extra), so a transcript that ended up in an
  exception message cannot carry a number out;
- events are tagged `service: voice-agent`, with `SENTRY_ENVIRONMENT` as the environment.
"""

from __future__ import annotations

import logging
from typing import Any

from .config import Settings
from .redact import redact_phones

SERVICE_TAG = "voice-agent"


#: A LogRecord's own attributes; anything else on a record came in as `extra`.
_RECORD_ATTRS = frozenset(vars(logging.LogRecord("", 0, "", 0, "", None, None))) | {
    "message",
    "asctime",
}

#: The loggers whose records are scrubbed where they are made (a logger's filter sees its own
#: records whatever handler the LiveKit CLI installs later): ours, LiveKit's and the root.
_LOGGERS = ("", "livekit", "livekit.agents", "sitelog_voice")


class PhoneRedactingFilter(logging.Filter):
    def filter(self, record: logging.LogRecord) -> bool:
        if isinstance(record.msg, str):
            record.msg = redact_phones(record.msg)
        if isinstance(record.args, tuple):
            record.args = tuple(redact_phones(a) if isinstance(a, str) else a for a in record.args)
        for key, value in list(vars(record).items()):
            if key not in _RECORD_ATTRS and isinstance(value, str):
                setattr(record, key, redact_phones(value))
        return True


def _add_filter(target: logging.Filterer) -> None:
    if not any(isinstance(f, PhoneRedactingFilter) for f in target.filters):
        target.addFilter(PhoneRedactingFilter())


def setup_logging(level: int = logging.INFO) -> None:
    """Idempotent: run at start and again in each job process (its handlers are LiveKit's)."""
    for name in _LOGGERS:
        _add_filter(logging.getLogger(name))
    for handler in logging.getLogger().handlers:
        _add_filter(handler)
    logging.getLogger("sitelog_voice").setLevel(level)


def _scrub(value: Any) -> Any:
    if isinstance(value, str):
        return redact_phones(value)
    if isinstance(value, dict):
        return {k: _scrub(v) for k, v in value.items()}
    if isinstance(value, list | tuple):
        return [_scrub(v) for v in value]
    return value


def before_send(event: dict[str, Any], _hint: dict[str, Any]) -> dict[str, Any] | None:
    event.pop("request", None)
    for crumb in (event.get("breadcrumbs") or {}).get("values", []) or []:
        crumb.pop("data", None)
    for exc in (event.get("exception") or {}).get("values", []) or []:
        for frame in (exc.get("stacktrace") or {}).get("frames", []) or []:
            frame.pop("vars", None)
    return _scrub(event)


def init_sentry(settings: Settings) -> bool:
    """Sentry when `SENTRY_DSN` is set; returns whether it was initialised."""
    if settings.sentry_dsn is None:
        return False
    import sentry_sdk

    sentry_sdk.init(
        dsn=settings.sentry_dsn.get_secret_value(),
        environment=settings.sentry_environment,
        send_default_pii=False,
        include_local_variables=False,
        before_send=before_send,  # type: ignore[arg-type]
    )
    sentry_sdk.set_tag("service", SERVICE_TAG)
    return True
