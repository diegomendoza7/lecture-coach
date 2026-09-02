"""Vocabulary measures over the transcript.

Two honest limits, both reported rather than hidden:

  * Readability indices (Flesch and friends) are deliberately NOT computed here.
    They are dominated by sentence length, and "sentences" in an ASR transcript
    are wherever Whisper decided to put a full stop. The resulting grade level
    is a fact about the ASR model's punctuation habits, not about the speaker.
  * MTLD is unstable below ~100 tokens, so it is omitted rather than reported
    as a confident number on a short take.
"""

from __future__ import annotations

import re
from collections import Counter

WORD_RE = re.compile(r"[a-z']+")
MTLD_MIN_TOKENS = 100
MATTR_WINDOW = 50

VOWELS = "aeiouy"


def tokens(text: str) -> list[str]:
    return [t.strip("'") for t in WORD_RE.findall(text.lower()) if t.strip("'")]


def count_syllables(word: str) -> int:
    """Vowel-cluster heuristic with the usual English corrections.

    Roughly 90% accurate on English, which is adequate for an aggregate
    syllables-per-second rate but not for any single word.
    """
    w = re.sub(r"[^a-z]", "", word.lower())
    if not w:
        return 0
    groups = re.findall(rf"[{VOWELS}]+", w)
    n = len(groups)
    # Silent final -e ("shape"), but not where the e carries a syllable ("table").
    if w.endswith("e") and not w.endswith(("le", "ee", "ye")) and n > 1:
        n -= 1
    # Silent -ed ("walked"), but pronounced after t/d ("created", "wanted").
    if re.search(r"[^aeioutd]ed$", w) and n > 1:
        n -= 1
    return max(1, n)


def _mtld_pass(toks: list[str], threshold: float = 0.72) -> float:
    factors, types, count = 0.0, set(), 0
    for t in toks:
        types.add(t)
        count += 1
        if len(types) / count <= threshold:
            factors += 1
            types, count = set(), 0
    if count > 0:
        ttr = len(types) / count
        factors += (1 - ttr) / (1 - threshold)
    return len(toks) / factors if factors > 0 else 0.0


def mtld(toks: list[str]) -> float:
    """Bidirectional MTLD. Length-robust in a way plain TTR is not."""
    return (_mtld_pass(toks) + _mtld_pass(toks[::-1])) / 2


def mattr(toks: list[str], window: int = MATTR_WINDOW) -> float:
    if len(toks) < window:
        return len(set(toks)) / len(toks) if toks else 0.0
    ratios = [
        len(set(toks[i : i + window])) / window for i in range(len(toks) - window + 1)
    ]
    return sum(ratios) / len(ratios)


def repeated_phrases(toks: list[str], n_range=(3, 7), min_count: int = 2) -> list[dict]:
    """Verbatim n-grams the speaker leaned on.

    Longer matches win: if "at the end of the day" repeats, we do not also
    report "at the end", "the end of" and every other fragment inside it.
    """
    found: list[dict] = []
    claimed: set[tuple[int, int]] = set()
    for n in range(n_range[1], n_range[0] - 1, -1):
        counts = Counter(tuple(toks[i : i + n]) for i in range(len(toks) - n + 1))
        for gram, c in counts.items():
            if c < min_count:
                continue
            positions = [
                i for i in range(len(toks) - n + 1) if tuple(toks[i : i + n]) == gram
            ]
            # Overlap, not containment: a repeated 6-gram otherwise yields two
            # shifted 5-grams ("at the end of the" and "the end of the day").
            if any(
                any(p < ce and cs < p + n for cs, ce in claimed) for p in positions
            ):
                continue
            for p in positions:
                claimed.add((p, p + n))
            found.append({"phrase": " ".join(gram), "count": c, "length": n})
    return sorted(found, key=lambda d: (-d["count"], -d["length"]))[:20]


def analyze(text: str) -> dict:
    toks = tokens(text)
    if not toks:
        return {"total_tokens": 0, "note": "empty transcript"}

    syl = sum(count_syllables(t) for t in toks)
    out = {
        "total_tokens": len(toks),
        "unique_tokens": len(set(toks)),
        "type_token_ratio": round(len(set(toks)) / len(toks), 4),
        "mattr_50": round(mattr(toks), 4),
        "syllables": syl,
        "mean_syllables_per_word": round(syl / len(toks), 3),
        "mean_word_length": round(sum(len(t) for t in toks) / len(toks), 3),
        "repeated_phrases": repeated_phrases(toks),
    }
    if len(toks) >= MTLD_MIN_TOKENS:
        out["mtld"] = round(mtld(toks), 2)
    else:
        out["mtld_note"] = (
            f"omitted: {len(toks)} tokens, MTLD needs >= {MTLD_MIN_TOKENS} to be stable"
        )
    return out
