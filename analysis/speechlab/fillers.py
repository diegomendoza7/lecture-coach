"""Disfluency measurement.

Three tiers, reported separately because they carry very different confidence:

  1. `filled_pauses` - literal "um"/"uh" tokens the ASR kept. A LOWER BOUND:
     Whisper deletes many of them, so this count is never the true count.
  2. `acoustic_candidates` - voiced audio inside a speech segment that the
     transcript never accounted for, with the steady-pitch signature of a filled
     pause. This is what recovers the ones Whisper swallowed.
  3. `discourse_markers` - "like", "you know", "basically". Reported with
     surrounding context and NOT auto-classified as filler vs. legitimate use.
     Rule-based classifiers for filler-"like" run around 80% and we have not
     validated one; showing the speaker the instances in context is honest,
     printing a confident count is not.
"""

from __future__ import annotations

import re
from collections import Counter

import numpy as np

LEXICAL_FILLERS = {"um", "uh", "erm", "uhm", "ah", "er", "mm", "hmm", "mhm", "eh"}

DISCOURSE_MARKERS = (
    ("you", "know"),
    ("i", "mean"),
    ("sort", "of"),
    ("kind", "of"),
    ("you", "see"),
    ("like",),
    ("basically",),
    ("actually",),
    ("literally",),
    ("obviously",),
)

# A filled pause is a held, steady vowel. These bound "held and steady".
FILLER_MIN_S, FILLER_MAX_S = 0.15, 1.20
FILLER_MAX_F0_SD_ST = 2.0
FILLER_MIN_VOICED = 0.55


def _norm(w: str) -> str:
    return re.sub(r"[^a-z']", "", w.lower())


def _context(words, i: int, span: int = 1, width: int = 4) -> str:
    lo, hi = max(0, i - width), min(len(words), i + span + width)
    parts = [w.word for w in words[lo:hi]]
    mark = i - lo
    parts[mark] = f"[{parts[mark]}"
    parts[mark + span - 1] = f"{parts[mark + span - 1]}]"
    return " ".join(parts)


def from_transcript(words) -> dict:
    """Fillers and markers the ASR actually emitted."""
    norm = [_norm(w.word) for w in words]
    filled, markers = [], []

    i = 0
    while i < len(norm):
        if norm[i] in LEXICAL_FILLERS:
            filled.append(
                {"word": norm[i], "time": round(words[i].start, 3),
                 "duration": round(words[i].end - words[i].start, 3)}
            )
            i += 1
            continue
        for phrase in DISCOURSE_MARKERS:
            n = len(phrase)
            if tuple(norm[i : i + n]) == phrase:
                markers.append(
                    {"phrase": " ".join(phrase), "time": round(words[i].start, 3),
                     "context": _context(words, i, n)}
                )
                i += n - 1
                break
        i += 1

    return {
        "filled_pauses": filled,
        "filled_pause_count": len(filled),
        "discourse_markers": markers,
        "discourse_marker_counts": dict(Counter(m["phrase"] for m in markers)),
    }


def repetitions(words, max_n: int = 3) -> list[dict]:
    """Immediately repeated 1-3 word runs: stutters, restarts, false starts."""
    norm = [_norm(w.word) for w in words]
    out, i = [], 0
    while i < len(norm):
        hit = None
        for n in range(max_n, 0, -1):
            a, b = norm[i : i + n], norm[i + n : i + 2 * n]
            if len(b) == n and a == b and all(a):
                hit = n
                break
        if hit:
            out.append(
                {"phrase": " ".join(norm[i : i + hit]), "words": hit,
                 "time": round(words[i].start, 3), "context": _context(words, i, hit * 2)}
            )
            i += hit * 2
        else:
            i += 1
    return out


# Whisper's word end-time for a filler is usually short of the actual vowel, so
# the tail of a counted "uh" reappears as unaccounted speech right after it.
FILLER_TAIL_S = 0.30


def acoustic_candidates(cov: dict, pros, words=None) -> list[dict]:
    """Unaccounted speech that looks like a held filled pause.

    Recovers the "um"s Whisper deleted. Voiced, steady in pitch, and of a
    plausible duration - a hummed hesitation rather than a swallowed word.

    Regions abutting a filler the ASR already reported are dropped: they are the
    tail of that same vowel, and counting both would inflate the total.
    """
    known = [
        (w.start, w.end) for w in (words or []) if _norm(w.word) in LEXICAL_FILLERS
    ]
    out = []
    for r in cov.get("unaccounted_regions", []):
        d = r["duration"]
        if not (FILLER_MIN_S <= d <= FILLER_MAX_S):
            continue
        if any(
            r["start"] < e + FILLER_TAIL_S and s_ - FILLER_TAIL_S < r["end"]
            for s_, e in known
        ):
            continue
        m = (pros.times >= r["start"]) & (pros.times <= r["end"])
        if m.sum() < 5:
            continue
        voiced = pros.f0_hz[m] > 0
        ratio = float(voiced.mean())
        if ratio < FILLER_MIN_VOICED:
            continue
        st = pros.f0_st[m][voiced]
        st = st[np.isfinite(st)]
        if len(st) < 3:
            continue
        sd = float(np.std(st))
        if sd <= FILLER_MAX_F0_SD_ST:
            out.append(
                {"start": r["start"], "end": r["end"], "duration": d,
                 "voiced_ratio": round(ratio, 3), "f0_sd_st": round(sd, 3)}
            )
    return out


def label_unaccounted(cov: dict, pros) -> list[dict]:
    """Tag every unaccounted region so the viewer can offer it for listening.

    Voicing is the discriminator: a filled pause is a held vowel and is voiced,
    while a breath is turbulent noise and is not. Praat's voicing decision is
    level-dependent, so the bar is set relative to how much of THIS take was
    voiced at all - an absolute threshold calibrated on clean audio marks
    everything in a quiet recording as a breath.
    """
    voiced_all = float((pros.f0_hz > 0).mean()) if len(pros.f0_hz) else 0.0
    bar = max(0.35, 0.75 * voiced_all)
    out = []
    for r in cov.get("unaccounted_regions", []):
        m = (pros.times >= r["start"]) & (pros.times <= r["end"])
        vr = float((pros.f0_hz[m] > 0).mean()) if m.sum() else 0.0
        st = pros.f0_st[m][pros.f0_hz[m] > 0]
        st = st[np.isfinite(st)]
        sd = float(np.std(st)) if len(st) >= 3 else None
        kind = "possible_filler" if (
            vr >= bar and FILLER_MIN_S <= r["duration"] <= FILLER_MAX_S
            and (sd is None or sd <= FILLER_MAX_F0_SD_ST)
        ) else "breath_or_unvoiced"
        out.append(r | {"voiced_ratio": round(vr, 3),
                        "f0_sd_st": None if sd is None else round(sd, 2),
                        "kind": kind})
    return out


def analyze(words, cov: dict, pros, speaking_span_s: float, n_tokens: int) -> dict:
    t = from_transcript(words)
    reps = repetitions(words)
    cands = acoustic_candidates(cov, pros, words)
    per_min = (lambda n: round(n / (speaking_span_s / 60), 2)) if speaking_span_s > 0 else (lambda n: 0.0)

    return t | {
        "repetitions": reps,
        "repetition_count": len(reps),
        "acoustic_candidates": cands,
        "unaccounted_regions": label_unaccounted(cov, pros),
        "acoustic_candidate_count": len(cands),
        # The honest headline: a range, not a single confident count.
        "filled_pauses_estimated_range": [
            t["filled_pause_count"],
            t["filled_pause_count"] + len(cands),
        ],
        "filled_pauses_per_minute": per_min(t["filled_pause_count"]),
        "discourse_markers_per_minute": per_min(len(t["discourse_markers"])),
        "disfluencies_per_100_words": round(
            100 * (t["filled_pause_count"] + len(reps)) / n_tokens, 2
        ) if n_tokens else 0.0,
        "note": (
            "filled_pause_count is a lower bound - Whisper removes many fillers. "
            "acoustic_candidates estimates what it removed; add them for a range."
        ),
    }
