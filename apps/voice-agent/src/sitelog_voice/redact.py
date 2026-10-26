"""Phone numbers out of text before it reaches a model (CLAUDE.md "Never send phone numbers to an
LLM", spec §10.12).

A port of `packages/shared/src/redact.ts` (`redactPhones`): the same four patterns, the same
`[phone]` placeholder, and `tests/test_redact.py` runs that file's vectors. The agent applies it to
every reporter turn before the dialog model sees it (`session.py`), and to every text it logs.
A spoken number the reporter says ("call Mike on 555 014 3378") is redacted like a typed one.
"""

from __future__ import annotations

import re

PHONE_PLACEHOLDER = "[phone]"

_PATTERNS: tuple[re.Pattern[str], ...] = (
    # International: +1 555 014 3378, +90 (532) 123-4567
    re.compile(r"\+[0-9][0-9 ().-]{5,}[0-9]"),
    # North American: (555) 014-3378, 555.014.3378, 555 014 3378
    re.compile(r"(?<![0-9A-Za-z-])\(?[0-9]{3}\)?[ .-]?[0-9]{3}[ .-][0-9]{4}(?![0-9A-Za-z-])"),
    # Turkish mobile grouping: 0532 123 45 67, 532 123 45 67
    re.compile(
        r"(?<![0-9A-Za-z-])0?[0-9]{3}[ .-]?[0-9]{3}[ .-][0-9]{2}[ .-][0-9]{2}(?![0-9A-Za-z-])"
    ),
    # A bare run of 10–15 digits: 5550143378, 905321234567
    re.compile(r"(?<![0-9A-Za-z-])[0-9]{10,15}(?![0-9A-Za-z-])"),
)


def redact_phones(text: str) -> str:
    out = text
    for pattern in _PATTERNS:
        out = pattern.sub(PHONE_PLACEHOLDER, out)
    return out


def contains_phone(text: str) -> bool:
    return redact_phones(text) != text
