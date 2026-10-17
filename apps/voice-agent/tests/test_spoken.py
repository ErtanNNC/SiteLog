"""W4-07 (§19 Q245 `SPOKEN_FORM`): the agent's port of the shared `speakable()` says every golden
case of the shared tables (`copy/spoken.json`, written by `pnpm voice:contract`) exactly as the
shared code does, and the agent's fixed lines are said in that form."""

from __future__ import annotations

import pytest

from sitelog_voice.copy import LANGUAGES, default_copy
from sitelog_voice.spoken import default_rules, speakable, spoken_integer, spoken_time

CASES = default_rules().cases


def test_the_recommended_policy_and_an_empty_pronunciation_list() -> None:
    rules = default_rules()
    assert rules.policy == "code"
    assert rules.pronunciations == {"en": {}, "es": {}, "tr": {}}
    assert {lang for lang, _, _ in CASES} == set(LANGUAGES)


@pytest.mark.parametrize(("lang", "written", "spoken"), CASES, ids=[c[1][:40] for c in CASES])
def test_every_shared_case(lang: str, written: str, spoken: str) -> None:
    assert speakable(written, lang) == spoken  # type: ignore[arg-type]
    assert speakable(spoken, lang) == spoken  # type: ignore[arg-type]


def test_numbers_and_times() -> None:
    assert spoken_integer(184, "tr") == "yüz seksen dört"
    assert spoken_integer(2041, "en") == "two thousand forty-one"
    assert spoken_integer(21000, "es") == "veintiún mil"
    assert spoken_time(17, 30, "tr") == "on yedi otuz"
    assert spoken_time(13, 0, "es") == "una de la tarde"
    assert spoken_time(8, 5, "en") == "eight oh five a.m."


def test_fixed_lines_are_said_in_words() -> None:
    copy = default_copy()
    assert (
        copy.line("goodbye_callback_requested", "tr", time="17:30")
        == "Tamam, sizi saat on yedi otuz gibi arayacağım. İyi günler."
    )
    assert (
        copy.line("callback_outside_window", "es", time="13:00")
        == "Solo puedo llamar hasta la una de la tarde. ¿Hacemos el reporte ahora?"
    )
    line = copy.line("opening_talk_now", "tr", first="Emre", site="Kartal Konutları — B Blok 2")
    assert line.endswith("Kartal Konutları — B Blok iki için bugünün raporunu dinliyorum.")


def test_the_tts_policy_leaves_a_line_as_written() -> None:
    from dataclasses import replace

    rules = replace(default_rules(), policy="tts")
    assert speakable("184 saat", "tr", rules=rules) == "184 saat"
