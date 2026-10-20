"""Thai text from PDFs and OCR, cleaned without AI.

- Control characters (glyphs a PDF font could not map) are dropped; Unicode NFC (never NFKC: it splits SARA AM).
- Old Thai fonts put shifted tone marks and vowels in the Private Use Area (U+F700-U+F71A); they map back to the
  Thai characters. NIKHAHIT + SARA AA becomes SARA AM.
- PyThaiNLP's normalize removes doubled marks and puts marks in order.
- A word the dictionary does not know that becomes a known word by adding or removing one tone mark is corrected
  ("ชือ" → "ชื่อ"): OCR most often loses or invents the small marks. When several marks make known words, the Thai
  National Corpus frequency decides, and only by a wide margin (ชื่อ 19,574 against ชื้อ 34). Nothing else changes.
"""
from __future__ import annotations

import re
import unicodedata
from functools import lru_cache

THAI_RUN = re.compile("[ก-๎]+")
THAI = re.compile("[฀-๿]")
CONTROL = re.compile("[\x00-\x08\x0b-\x1f]")
MARKS = "่้๊๋"  # mai ek, mai tho, mai tri, mai chattawa
# Shifted glyphs of Thai fonts (Adobe / Apple / Microsoft private use) → the characters they draw.
PUA = {
    0xF700: "ฐ", 0xF701: "ั", 0xF702: "ิ", 0xF703: "ี", 0xF704: "ึ", 0xF705: "ื",
    0xF706: "่", 0xF707: "้", 0xF708: "๊", 0xF709: "๋", 0xF70A: "์", 0xF70B: "่",
    0xF70C: "้", 0xF70D: "๊", 0xF70E: "๋", 0xF70F: "ญ", 0xF710: "ั", 0xF711: "็",
    0xF712: "ํ", 0xF713: "่", 0xF714: "้", 0xF715: "๊", 0xF716: "๋", 0xF717: "์",
    0xF718: "ุ", 0xF719: "ู", 0xF71A: "ฺ",
}
NIKHAHIT_AA, SARA_AM = "ํา", "ำ"


def private_use_share(text: str) -> float:
    """The share of characters in the Private Use Area (high: the PDF's text layer needs mapping or OCR)."""
    letters = [char for char in text if not char.isspace()]
    return sum(1 for char in letters if 0xE000 <= ord(char) <= 0xF8FF) / len(letters) if letters else 0.0


def normalize(text: str) -> str:
    from pythainlp.util import normalize as thai_normalize

    text = unicodedata.normalize("NFC", CONTROL.sub("", text).translate(PUA)).replace(NIKHAHIT_AA, SARA_AM)
    text = thai_normalize(text) if THAI.search(text) else text
    return re.sub("[ \t ]+", " ", text).strip()


@lru_cache(maxsize=1)
def dictionary() -> frozenset[str]:
    from pythainlp.corpus import thai_words

    from ..ids import TERMS

    return frozenset(thai_words()) | frozenset(TERMS)


@lru_cache(maxsize=1)
def _tokenizer():
    from pythainlp.tokenize import Tokenizer

    return Tokenizer(custom_dict=dictionary(), engine="newmm")


@lru_cache(maxsize=1)
def _frequencies() -> dict[str, int]:
    from pythainlp.corpus import tnc

    return dict(tnc.word_freqs())


def _frequency(text: str, before: set[str]) -> int:
    """How common the words a fix made are in the Thai National Corpus (the rarest of them; words the text had
    before the fix do not count)."""
    made = [token for token in _tokenizer().word_tokenize(text) if THAI.search(token) and token not in before]
    return min((_frequencies().get(token, 0) for token in made), default=0)


def unknown_words(text: str) -> list[str]:
    """Thai words of the text the dictionary does not know (one-letter pieces included: an unknown word breaks up)."""
    words = dictionary()
    out = []
    for run in THAI_RUN.findall(text):
        out.extend(token for token in _tokenizer().word_tokenize(run) if THAI.search(token) and token not in words)
    return out


def _variants(run: str):
    """The run with one tone mark added after a letter, or one removed."""
    for index, char in enumerate(run):
        if char in MARKS:
            yield run[:index] + run[index + 1:]
    for index in range(1, len(run) + 1):
        if run[index - 1] in MARKS or (index < len(run) and run[index] in MARKS):
            continue
        for mark in MARKS:
            yield run[:index] + mark + run[index:]


def fix_marks(text: str) -> tuple[str, list[tuple[str, str]]]:
    """Restore lost or invented tone marks where that turns every unknown word of a Thai run into known ones.
    Returns the text and the corrections made [(before, after)]."""
    fixes: list[tuple[str, str]] = []

    def repair(match: re.Match[str]) -> str:
        run = match.group(0)
        if not unknown_words(run) or len(run) > 40:
            return run
        before = set(_tokenizer().word_tokenize(run))
        known = sorted({variant for variant in _variants(run) if not unknown_words(variant)}, key=lambda v: _frequency(v, before), reverse=True)
        if not known or (len(known) > 1 and _frequency(known[0], before) < 10 * max(1, _frequency(known[1], before))):
            return run  # no fix, or two fixes about as likely: left for a person or the AI
        fixes.append((run, known[0]))
        return known[0]

    return THAI_RUN.sub(repair, text), fixes
