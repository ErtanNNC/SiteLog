"""Logging and Sentry for the voice agent (spec §5 "Monitoring"; CLAUDE.md "errors to Sentry").

Logs and Sentry events carry the call id, never a phone number or the reporter's words:

- `PhoneRedactingFilter` runs every log record's message and string arguments through
  `redact_phones` (a last line of defence; code logs ids and statuses only);
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


class PhoneRedactingFilter(logging.Filter):
    def filter(self, record: logging.LogRecord) -> bool:
        if isinstance(record.msg, str):
            record.msg = redact_phones(record.msg)
        if isinstance(record.args, tuple):
            record.args = tuple(redact_phones(a) if isinstance(a, str) else a for a in record.args)
        return True


def setup_logging(level: int = logging.INFO) -> None:
    root = logging.getLogger()
    if not any(isinstance(f, PhoneRedactingFilter) for f in root.filters):
        root.addFilter(PhoneRedactingFilter())
    for handler in root.handlers:
        if not any(isinstance(f, PhoneRedactingFilter) for f in handler.filters):
            handler.addFilter(PhoneRedactingFilter())
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
