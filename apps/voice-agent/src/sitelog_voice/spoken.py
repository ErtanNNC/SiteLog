"""The spoken form of a line (W4-07; spec §9.4 "numbers spoken naturally", §19 Q245 `SPOKEN_FORM`).

The port of `packages/shared/src/spoken.ts`' `speakable()`: code turns every fixed line the agent
says into words before TTS (report numbers in groups, times, percentages, units, decimals, every
other number; TR ordinals and suffixes; the listening test's pronunciation list), so no voice reads
a symbol or a written number as it likes. field-api already hands its lines in this form; saying
them again changes nothing (idempotent).

The lists (units, pronunciations, the policy) come from `copy/spoken.json`, written by
`pnpm voice:contract`, with every golden case of the shared tables: the tests check this port says
each one exactly as the shared code does.
"""

from __future__ import annotations

import json
import re
from collections.abc import Callable
from dataclasses import dataclass
from functools import cache
from pathlib import Path
from typing import Literal

from .copy import COPY_DIR, Language

EsForm = Literal["alone", "masc", "fem"]

#: Letters (Python's `re` has no `\p{L}`): word characters but digits and the underscore.
L = r"[^\W\d_]"


@dataclass(frozen=True)
class SpokenUnit:
    written: tuple[str, ...]
    one: str
    many: str
    feminine: bool = False
    around: tuple[str, str] | None = None


@dataclass(frozen=True)
class SpokenRules:
    policy: str
    pronunciations: dict[str, dict[str, str]]
    units: dict[str, tuple[SpokenUnit, ...]]
    es_feminine: frozenset[str]
    tr_ordinal_nouns: tuple[str, ...]
    cases: tuple[tuple[str, str, str], ...]


def load_rules(directory: Path = COPY_DIR) -> SpokenRules:
    data = json.loads((directory / "spoken.json").read_text(encoding="utf-8"))
    units = {
        lang: tuple(
            SpokenUnit(
                written=tuple(u["written"]),
                one=u["one"],
                many=u["many"],
                feminine=bool(u.get("feminine", False)),
                around=(u["around"][0], u["around"][1]) if u.get("around") else None,
            )
            for u in items
        )
        for lang, items in data["units"].items()
    }
    return SpokenRules(
        policy=data["policy"],
        pronunciations={k: dict(v) for k, v in data["pronunciations"].items()},
        units=units,
        es_feminine=frozenset(data["esFeminine"]),
        tr_ordinal_nouns=tuple(data["trOrdinalNouns"]),
        cases=tuple((c["language"], c["written"], c["spoken"]) for c in data["cases"]),
    )


@cache
def default_rules() -> SpokenRules:
    return load_rules()


# ───────────────────────────── number words ─────────────────────────────

EN_ONES = [
    "zero",
    "one",
    "two",
    "three",
    "four",
    "five",
    "six",
    "seven",
    "eight",
    "nine",
    "ten",
    "eleven",
    "twelve",
    "thirteen",
    "fourteen",
    "fifteen",
    "sixteen",
    "seventeen",
    "eighteen",
    "nineteen",
]
EN_TENS = ["", "", "twenty", "thirty", "forty", "fifty", "sixty", "seventy", "eighty", "ninety"]


def _en_below_1000(n: int) -> str:
    parts: list[str] = []
    h, r = divmod(n, 100)
    if h:
        parts.append(f"{EN_ONES[h]} hundred")
    if r:
        if r < 20:
            parts.append(EN_ONES[r])
        else:
            t, o = divmod(r, 10)
            parts.append(f"{EN_TENS[t]}-{EN_ONES[o]}" if o else EN_TENS[t])
    return " ".join(parts)


def _en_words(n: int) -> str:
    if n == 0:
        return "zero"
    m, rest = divmod(n, 1_000_000)
    t, r = divmod(rest, 1000)
    parts: list[str] = []
    if m:
        parts.append(f"{_en_below_1000(m)} million")
    if t:
        parts.append(f"{_en_below_1000(t)} thousand")
    if r:
        parts.append(_en_below_1000(r))
    return " ".join(parts)


ES_UNITS = [
    "cero",
    "uno",
    "dos",
    "tres",
    "cuatro",
    "cinco",
    "seis",
    "siete",
    "ocho",
    "nueve",
    "diez",
    "once",
    "doce",
    "trece",
    "catorce",
    "quince",
    "dieciséis",
    "diecisiete",
    "dieciocho",
    "diecinueve",
    "veinte",
    "veintiuno",
    "veintidós",
    "veintitrés",
    "veinticuatro",
    "veinticinco",
    "veintiséis",
    "veintisiete",
    "veintiocho",
    "veintinueve",
]
ES_TENS = [
    "",
    "",
    "",
    "treinta",
    "cuarenta",
    "cincuenta",
    "sesenta",
    "setenta",
    "ochenta",
    "noventa",
]
ES_HUNDREDS = [
    "",
    "ciento",
    "doscientos",
    "trescientos",
    "cuatrocientos",
    "quinientos",
    "seiscientos",
    "setecientos",
    "ochocientos",
    "novecientos",
]


def _es_agree(words: str, form: EsForm) -> str:
    if form == "alone":
        return words
    one = "un" if form == "masc" else "una"
    if words.endswith("veintiuno"):
        return words[: -len("veintiuno")] + ("veintiún" if form == "masc" else "veintiuna")
    if words == "uno":
        return one
    if words.endswith(" uno"):
        return words[:-3] + one
    return words


def _es_below_1000(n: int, form: EsForm) -> str:
    if n == 100:
        return "cien"
    parts: list[str] = []
    h, r = divmod(n, 100)
    if h:
        hundreds = ES_HUNDREDS[h]
        parts.append(re.sub(r"ientos$", "ientas", hundreds) if form == "fem" else hundreds)
    if r:
        if r < 30:
            parts.append(ES_UNITS[r])
        else:
            t, o = divmod(r, 10)
            parts.append(f"{ES_TENS[t]} y {ES_UNITS[o]}" if o else ES_TENS[t])
    return _es_agree(" ".join(parts), form)


def _es_words(n: int, form: EsForm) -> str:
    if n == 0:
        return "cero"
    m, rest = divmod(n, 1_000_000)
    t, r = divmod(rest, 1000)
    parts: list[str] = []
    if m:
        parts.append("un millón" if m == 1 else f"{_es_below_1000(m, 'masc')} millones")
    if t:
        parts.append("mil" if t == 1 else f"{_es_below_1000(t, 'masc')} mil")
    if r:
        parts.append(_es_below_1000(r, form))
    return " ".join(parts)


TR_ONES = ["sıfır", "bir", "iki", "üç", "dört", "beş", "altı", "yedi", "sekiz", "dokuz"]
TR_TENS = ["", "on", "yirmi", "otuz", "kırk", "elli", "altmış", "yetmiş", "seksen", "doksan"]


def _tr_below_1000(n: int) -> str:
    parts: list[str] = []
    h, r = divmod(n, 100)
    t, o = divmod(r, 10)
    if h:
        parts.append("yüz" if h == 1 else f"{TR_ONES[h]} yüz")
    if t:
        parts.append(TR_TENS[t])
    if o:
        parts.append(TR_ONES[o])
    return " ".join(parts)


def _tr_words(n: int) -> str:
    if n == 0:
        return "sıfır"
    m, rest = divmod(n, 1_000_000)
    t, r = divmod(rest, 1000)
    parts: list[str] = []
    if m:
        parts.append(f"{_tr_below_1000(m)} milyon")
    if t:
        parts.append("bin" if t == 1 else f"{_tr_below_1000(t)} bin")
    if r:
        parts.append(_tr_below_1000(r))
    return " ".join(parts)


TR_ORDINAL = {
    "sıfır": "sıfırıncı",
    "bir": "birinci",
    "iki": "ikinci",
    "üç": "üçüncü",
    "dört": "dördüncü",
    "beş": "beşinci",
    "altı": "altıncı",
    "yedi": "yedinci",
    "sekiz": "sekizinci",
    "dokuz": "dokuzuncu",
    "on": "onuncu",
    "yirmi": "yirminci",
    "otuz": "otuzuncu",
    "kırk": "kırkıncı",
    "elli": "ellinci",
    "altmış": "altmışıncı",
    "yetmiş": "yetmişinci",
    "seksen": "sekseninci",
    "doksan": "doksanıncı",
    "yüz": "yüzüncü",
    "bin": "bininci",
    "milyon": "milyonuncu",
}


def _tr_ordinal(words: str) -> str:
    head, _, last = words.rpartition(" ")
    return f"{head} {TR_ORDINAL.get(last, last)}" if head else TR_ORDINAL.get(last, last)


MAX_DIGITS = 9
ZERO: dict[str, str] = {"en": "zero", "es": "cero", "tr": "sıfır"}


def _integer_words(digits: str, lang: str, form: EsForm = "alone") -> str:
    if len(digits) > MAX_DIGITS:
        return " ".join(_integer_words(d, lang) for d in digits)
    zeros = len(digits) - len(digits.lstrip("0"))
    if zeros == len(digits):
        return " ".join([ZERO[lang]] * len(digits))
    n = int(digits[zeros:])
    words = _en_words(n) if lang == "en" else _es_words(n, form) if lang == "es" else _tr_words(n)
    return " ".join([*([ZERO[lang]] * zeros), words])


def spoken_integer(n: int, lang: Language) -> str:
    """A whole number as words in the call language (TR 184 → "yüz seksen dört")."""
    return _integer_words(str(abs(int(n))), lang)


def spoken_time(hh: int, mm: int, lang: Language) -> str:
    """ "17:30" as said: TR 24-hour ("on yedi otuz"), EN and ES 12-hour with the part of the day."""
    if lang == "tr":
        h = _tr_words(hh)
        if mm == 0:
            return h
        return f"{h} {f'sıfır {_tr_words(mm)}' if mm < 10 else _tr_words(mm)}"
    h12 = hh % 12 or 12
    if lang == "en":
        if mm == 0 and hh == 12:
            return "noon"
        if mm == 0 and hh == 0:
            return "midnight"
        m = "" if mm == 0 else f" oh {_en_words(mm)}" if mm < 10 else f" {_en_words(mm)}"
        return f"{_en_words(h12)}{m} {'a.m.' if hh < 12 else 'p.m.'}"
    if mm == 0 and hh == 12:
        return "doce del mediodía"
    hour = "una" if h12 == 1 else _es_words(h12, "alone")
    if mm == 0:
        m = ""
    elif mm == 15:
        m = " y cuarto"
    elif mm == 30:
        m = " y media"
    else:
        m = f" y {_es_words(mm, 'alone')}"
    if hh < 6:
        part = "de la madrugada"
    elif hh < 12:
        part = "de la mañana"
    elif hh < 20:
        part = "de la tarde"
    else:
        part = "de la noche"
    return f"{hour}{m} {part}"


def _decimal_words(whole: str, fraction: str, lang: str, form: EsForm) -> str:
    w = _integer_words(whole, lang)
    half = re.fullmatch(r"50*", fraction) is not None
    if lang == "tr":
        if half:
            return "yarım" if int(whole) == 0 else f"{w} buçuk"
        return f"{w} virgül {_integer_words(fraction, 'tr')}"
    if lang == "en":
        if half and int(whole) > 0:
            return f"{w} and a half"
        return f"{w} point {' '.join(EN_ONES[int(d)] for d in fraction)}"
    if half and int(whole) > 0:
        return f"{_integer_words(whole, 'es', form)} y medio"
    return f"{_integer_words(whole, 'es', form)} punto {_integer_words(fraction, 'es')}"


# ───────────────────────────── speakable ─────────────────────────────

BEFORE = r"(?<!\w)"  # not after a letter, a digit or an underscore
AFTER = r"(?!\d)"

NUMBER_RE: dict[str, str] = {
    "en": r"\d{1,3}(?:,\d{3})+(?:\.\d+)?|\d+(?:\.\d+)?",
    "es": r"\d{1,3}(?:,\d{3})+(?:\.\d+)?|\d+\.\d+|\d+,\d{1,2}(?!\d)|\d+",
    "tr": r"\d{1,3}(?:\.\d{3})+(?:,\d+)?|\d+,\d+|\d+\.\d{1,2}(?!\d)(?!\.)|\d+",
}


def _parse_number(written: str, lang: str) -> tuple[str, str]:
    s = written
    if lang == "tr":
        if re.match(r"\d{1,3}(?:\.\d{3})+", s):
            s = s.replace(".", "").replace(",", ".", 1)
        else:
            s = s.replace(",", ".", 1)
    elif re.match(r"\d{1,3}(?:,\d{3})+", s):
        s = s.replace(",", "")
    else:
        s = s.replace(",", ".", 1)
    whole, _, fraction = s.partition(".")
    return whole or "0", fraction


def _number_words(written: str, lang: str, form: EsForm = "alone") -> str:
    whole, fraction = _parse_number(written, lang)
    if fraction and re.search(r"[1-9]", fraction):
        return _decimal_words(whole, fraction, lang, form)
    return _integer_words(whole, lang, form)


ES_NOT_A_NOUN = frozenset(
    ["en", "de", "del", "y", "o", "a", "al", "por", "para", "con", "que", "se"]
)
AND = {"en": "and", "es": "y", "tr": "ve"}
PERCENT = {"en": "percent", "es": "por ciento", "tr": "yüzde"}


def _es_form_of(rest: str, feminine: frozenset[str]) -> EsForm:
    m = re.match(rf"\s+({L}+)", rest)
    if not m:
        return "alone"
    nxt = m.group(1).lower()
    if nxt in ES_NOT_A_NOUN:
        return "alone"
    return "fem" if nxt in feminine else "masc"


def _sub(pattern: str, text: str, fn: Callable[[re.Match[str]], str]) -> str:
    return re.sub(pattern, fn, text)


def speakable(text: str, lang: Language, *, rules: SpokenRules | None = None) -> str:
    """`text` as the agent says it in `lang`: names, report numbers, times, percentages, units and
    numbers in words (the shared `speakable()`, rule for rule). Pure."""
    r = rules or default_rules()
    if r.policy == "tts" or not text:
        return text
    s = text

    # 1. Names the listening test flagged (whole words).
    for written, said in r.pronunciations.get(lang, {}).items():
        s = re.sub(rf"(?<!{L})(?<!\d){re.escape(written)}(?!{L})(?!\d)", lambda _m, w=said: w, s)

    # 2. "&" between words.
    s = re.sub(r"\s&\s", f" {AND[lang]} ", s)

    # 3. Report numbers in groups.
    def report_no(m: re.Match[str]) -> str:
        groups = m.group(2)[1:].split("-")
        return f"{m.group(1)} {', '.join(_integer_words(g, lang) for g in groups)}"

    s = _sub(rf"(?<!{L})(?<![\d-])([A-Z]{{1,6}})((?:-\d{{2,6}})+)(?!{L})(?![\d-])", s, report_no)

    # 4. Times.
    if lang == "tr":

        def tr_time(m: re.Match[str]) -> str:
            hh = int(m.group(1) or m.group(3))
            mm = int(m.group(2) or m.group(4))
            said = spoken_time(hh, mm, "tr")
            suffix = m.group(5)
            if suffix is None:
                return said
            if suffix[0].islower():
                return f"{said}{suffix}"
            return f"{said}{m.group(0)[m.start(5) - m.start(0) - 1 :]}"

        s = _sub(
            r"(?<![\d:.,])(?:(?<=[Ss]aat\s)([01]?\d|2[0-3])\.([0-5]\d)|([01]?\d|2[0-3]):([0-5]\d))"
            rf"(?![\d:])(?:['’]({L}+))?",
            s,
            tr_time,
        )
    else:

        def time(m: re.Match[str]) -> str:
            las = m.group(1)
            hh, mm = int(m.group(2)), int(m.group(3))
            said = spoken_time(hh, mm, lang)
            if not las:
                return said
            if (hh % 12 or 12) == 1 and said.startswith("una"):
                las = las.replace("las", "la", 1)
            return f"{las}{said}"

        s = _sub(r"(\blas\s+)?(?<![\d:.,])([01]?\d|2[0-3]):([0-5]\d)(?![\d:])", s, time)
        if lang == "en":
            s = re.sub(r"([ap])\.m\.\.", r"\1.m.", s)

    num = NUMBER_RE[lang]

    # 5. Percentages.
    if lang == "tr":
        s = _sub(
            rf"%\s?({num}){AFTER}|{BEFORE}({num})\s?%",
            s,
            lambda m: f"yüzde {_number_words(m.group(1) or m.group(2), 'tr')}",
        )
    else:
        s = _sub(
            rf"{BEFORE}({num})\s?%",
            s,
            lambda m: f"{_number_words(m.group(1), lang)} {PERCENT[lang]}",
        )

    # 6. Units after a number (longest written form first).
    pairs = sorted(
        ((w, u) for u in r.units.get(lang, ()) for w in u.written),
        key=lambda p: -len(p[0]),
    )
    by_written = dict(pairs)
    alt = "|".join(re.escape(w) for w, _ in pairs)

    def unit(m: re.Match[str]) -> str:
        written = m.group(1)
        u = by_written[m.group(2)]
        whole, fraction = _parse_number(written, lang)
        one = int(whole) == 1 and not re.search(r"[1-9]", fraction)
        words = _number_words(written, lang, "fem" if u.feminine else "masc")
        if u.around:
            return f"{u.around[0]} {words} {u.around[1]}"
        return f"{words} {u.one if one else u.many}"

    if alt:
        s = _sub(rf"{BEFORE}({num})\s?({alt})(?!{L})(?![\d²³])", s, unit)

    # 7. ES halves before a noun: "3.5 horas" → "tres horas y media".
    if lang == "es":

        def half(m: re.Match[str]) -> str:
            noun = m.group(2)
            fem = noun.lower() in r.es_feminine
            whole = _integer_words(m.group(1), "es", "fem" if fem else "masc")
            return f"{whole} {noun} y {'media' if fem else 'medio'}"

        s = _sub(rf"{BEFORE}([1-9]\d*)[.,]50?{AFTER}\s+({L}+)", s, half)

    # 8. Every other number. TR: "3. Kat" is an ordinal; "14'te" joins its suffix.
    if lang == "tr":
        nouns = r.tr_ordinal_nouns

        def tr_number(m: re.Match[str]) -> str:
            written = m.group(1)
            tail = m.group(2) or ""
            if tail == ".":
                after = m.string[m.end() :]
                nxt = re.match(rf"\s+({L}+)", after)
                word = nxt.group(1) if nxt else ""
                if word and (word[0].islower() or word in nouns):
                    return _tr_ordinal(_number_words(written, "tr"))
                return f"{_number_words(written, 'tr')}."
            if tail:
                suffix = tail[1:]
                if suffix[0].islower():
                    return f"{_number_words(written, 'tr')}{suffix}"
                return f"{_number_words(written, 'tr')}{tail}"
            return _number_words(written, "tr")

        s = _sub(rf"{BEFORE}({num}){AFTER}(\.|['’]{L}+)?", s, tr_number)
    else:
        feminine = r.es_feminine

        def number(m: re.Match[str]) -> str:
            form: EsForm = _es_form_of(m.string[m.end() :], feminine) if lang == "es" else "alone"
            return _number_words(m.group(1), lang, form)

        s = _sub(rf"{BEFORE}({num}){AFTER}", s, number)

    return s
