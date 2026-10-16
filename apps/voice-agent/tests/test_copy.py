from __future__ import annotations

import pytest

from sitelog_voice.copy import LANGUAGES, VoiceCopy, default_copy, language_of


def test_every_language_has_every_key_and_placeholder() -> None:
    copy = default_copy()
    en = copy.keys("en")
    assert {"recording_notice", "opening_inbound", "filler", "fallback", "confirm_repeat"} <= en
    for lang in LANGUAGES:
        assert copy.keys(lang) == en
        for key in en:
            assert copy.placeholders(copy.raw(key, lang)) == copy.placeholders(copy.raw(key, "en"))


def test_openings_carry_the_disclosure_first() -> None:
    copy = default_copy()
    for lang in LANGUAGES:
        line = copy.line("opening_inbound", lang, first="Kevin", site="Northgate")
        assert copy.raw("recording_notice", lang) in line
        assert "{" not in line


def test_pack_notice_replaces_the_default() -> None:
    copy = default_copy()
    line = copy.line(
        "opening_inbound",
        "en",
        first="Kevin",
        site="Northgate",
        recording_notice="Pack notice.",
    )
    assert "Pack notice." in line
    assert copy.raw("recording_notice", "en") not in line


def test_placeholders_are_strict() -> None:
    copy = default_copy()
    with pytest.raises(KeyError, match="needs"):
        copy.line("opening_inbound", "en", first="Kevin")
    with pytest.raises(KeyError, match="takes no"):
        copy.line("filler", "en", first="Kevin")
    with pytest.raises(KeyError, match="no voice line"):
        copy.raw("nope", "en")


def test_turkish_has_no_exclamation_marks() -> None:
    copy = VoiceCopy()
    for key in copy.keys("tr"):
        assert "!" not in copy.raw(key, "tr"), key


def test_language_of() -> None:
    assert language_of("en-US") == "en"
    assert language_of("es-US") == "es"
    assert language_of("tr-TR") == "tr"
    with pytest.raises(ValueError):
        language_of("de-DE")
