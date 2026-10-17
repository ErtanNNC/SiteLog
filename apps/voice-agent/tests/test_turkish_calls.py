"""W4-07: the Turkish recorded calls (Demir Yapı, §18.2: Emre Yıldız, Kartal) replayed in text mode.

`tests/sim` replays every fixture with its generic checks (disclosure first, no phone number, filed
only after a yes); here what is Turkish about them: the opening and the disclosure in Turkish, the
call's language `tr` (Deepgram `tr`, the Azure voice), the reporter's "evet" filing the read-back
revision, and every line in its spoken form: code's own lines and the lines field-api hands the
model carry no digit, no unit symbol, no clock time (§19 Q245 `SPOKEN_FORM`).
"""

from __future__ import annotations

import re

import pytest

from sitelog_voice.copy import default_copy
from tests.conftest import load_call_fixture
from tests.harness import replay_call

TR_CALLS = [
    "kartal-hero-tr",
    "kartal-question-tr",
    "kartal-fix-tr",
    "kartal-weather-tr",
    "kartal-two-sites-tr",
]

#: What a line must not carry once spoken: a digit, a unit or percent symbol, a clock time.
WRITTEN = re.compile(r"\d|[%°³²]|\bkm/sa\b")


@pytest.mark.parametrize("name", TR_CALLS)
async def test_turkish_call_speaks_turkish_words(name: str) -> None:
    replay = await replay_call(load_call_fixture(name))
    state = replay.state
    assert state is not None
    assert state.language == "tr"
    copy = default_copy()
    assert copy.line("recording_notice", "tr") in replay.opening
    assert replay.opening.startswith("SiteLog, merhaba Emre.")
    said = [e["text"] for e in state.log if e["speaker"] == "agent"]
    assert said
    for line in said:
        assert not WRITTEN.search(line), line
    # The model's request carries field-api's spoken lines, never a written number of a line.
    for seen in replay.fake.calls:
        answer = seen.answer if isinstance(seen.answer, dict) else {}
        draft = answer.get("draft") if seen.route != "update_draft" else answer
        for text in (
            (draft or {}).get("readBack") if isinstance(draft, dict) else None,
            answer.get("readBack"),
            answer.get("confirmation"),
        ):
            if isinstance(text, str):
                assert not WRITTEN.search(text), text


async def test_the_hero_files_on_evet_after_a_read_back_in_words() -> None:
    replay = await replay_call(load_call_fixture("kartal-hero-tr"))
    [filing] = replay.fake.seen("file_report")
    assert filing.body["utterance"] == "Evet."
    assert replay.state is not None and replay.state.filed
    # The read-back the model is handed (and says verbatim) is field-api's, in words.
    given = " ".join(replay.llm.request_texts())
    assert "üç firmadan sahada on iki kişi, toplam doksan saat" in given
    assert "bir buçuk saat çalışılamadı" in given
    assert "üçüncü Kat döşeme betonu dökümü tamamlandı" in given
    assert "Kaydedeyim mi?" in given
    [end] = replay.fake.seen("end_call")
    assert end.body["outcome"] == "filed"


async def test_one_question_in_turkish_then_filed() -> None:
    replay = await replay_call(load_call_fixture("kartal-question-tr"))
    [answer] = replay.fake.seen("record_answer")
    assert answer.body["utterance"] == "Altı kişi, tam gün."
    given = " ".join(replay.llm.request_texts())
    assert "Akış Mekanik: altı kişi, kişi başı sekiz saat — toplam kırk sekiz saat." in given
    [filing] = replay.fake.seen("file_report")
    assert filing.body["utterance"] == "Evet, kaydedin."
    assert filing.body["draftRev"] == 2


async def test_two_sites_asks_the_site_in_turkish() -> None:
    replay = await replay_call(load_call_fixture("kartal-two-sites-tr"))
    copy = default_copy()
    assert copy.raw("recording_notice", "tr") in replay.opening
    assert "Kartal Konutları — B Blok" in replay.opening
    assert "Ataşehir Ofis Binası" in replay.opening
    [pick] = replay.fake.seen("pick_site")
    assert pick.body["siteId"] == "d1000000-0000-4000-8000-00000000a001"
