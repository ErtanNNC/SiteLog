"""The agent's spoken lines, from `copy/{en,es,tr}.json` (W3-01, `pnpm voice:contract`).

Every fixed line the agent says is copy (CLAUDE.md "No hard-coded UI strings"; plan W3-01): the
openings, the disclosure, fillers, the §7.3 silence and time lines, the F6 fallback line, the
read-back pieces (§19 Q118), the filing question (Q119), the F3 consent sentence (Q120), the F13
lines and one goodbye per outcome. This module only looks lines up and fills placeholders; it
never writes a sentence of its own. W4-07 (§19 Q245): a filled line comes back in its spoken form
(`spoken.speakable`: times, numbers and units as words), so the TTS never reads a symbol.
"""

from __future__ import annotations

import json
import os
import re
from functools import cache
from pathlib import Path
from typing import Literal

Language = Literal["en", "es", "tr"]
LANGUAGES: tuple[Language, ...] = ("en", "es", "tr")

COPY_DIR = Path(os.environ.get("VOICE_COPY_DIR") or Path(__file__).resolve().parents[2] / "copy")

_PLACEHOLDER = re.compile(r"\{([a-z_]+)\}")

#: The disclosure (§9.4 "Recording", §15.2) is embedded in the openings as `{recording_notice}`
#: and filled from its own line, so a pack's own notice (§19 Q28 `legal_keys`) replaces it once.
RECORDING_NOTICE_KEY = "recording_notice"


def language_of(locale: str) -> Language:
    """`en-US` → `en`, `es-US` → `es`, `tr-TR` → `tr`."""
    lang = locale.split("-", 1)[0].lower()
    if lang not in LANGUAGES:
        raise ValueError(f"no voice copy for locale {locale!r}")
    return lang  # type: ignore[return-value]


class VoiceCopy:
    def __init__(self, directory: Path = COPY_DIR) -> None:
        self._lines: dict[Language, dict[str, str]] = {}
        for lang in LANGUAGES:
            data = json.loads((directory / f"{lang}.json").read_text(encoding="utf-8"))
            if data.get("language") != lang:
                raise ValueError(f"copy/{lang}.json names language {data.get('language')!r}")
            self._lines[lang] = dict(data["lines"])

    def keys(self, lang: Language = "en") -> set[str]:
        return set(self._lines[lang])

    def raw(self, key: str, lang: Language) -> str:
        try:
            return self._lines[lang][key]
        except KeyError:
            raise KeyError(f"no voice line {key!r} in {lang}") from None

    @staticmethod
    def placeholders(text: str) -> set[str]:
        return set(_PLACEHOLDER.findall(text))

    def line(
        self,
        key: str,
        lang: Language,
        *,
        recording_notice: str | None = None,
        **params: str | int | float,
    ) -> str:
        """The line `key` in `lang` with its placeholders filled, in its spoken form.

        `{recording_notice}` is the copy's own disclosure unless the pack's notice is passed.
        Every other placeholder must be given, and nothing extra (a typo would otherwise drop a
        value silently). The filled line goes through `speakable` (W4-07): a time, a number or a
        unit in a value ("17:30", a site called "Blok 2") is said as words.
        """
        from .spoken import speakable  # spoken reads its lists next to this module's copy

        text = self.raw(key, lang)
        needed = self.placeholders(text) - {RECORDING_NOTICE_KEY}
        given = set(params)
        if needed - given:
            raise KeyError(f"voice line {key!r} needs {sorted(needed - given)}")
        if given - needed:
            raise KeyError(f"voice line {key!r} takes no {sorted(given - needed)}")
        values: dict[str, str] = {k: str(v) for k, v in params.items()}
        if RECORDING_NOTICE_KEY in self.placeholders(text):
            values[RECORDING_NOTICE_KEY] = recording_notice or self.raw(RECORDING_NOTICE_KEY, lang)
        return speakable(_PLACEHOLDER.sub(lambda m: values[m.group(1)], text), lang)


@cache
def default_copy() -> VoiceCopy:
    return VoiceCopy()
