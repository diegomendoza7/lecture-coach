"""Pauses and tempo, derived from VAD segments.

Deliberately not derived from gaps between ASR words: word-level timestamps
carry 50-200 ms of alignment error, and feeding that into a taxonomy whose
class boundaries are 200/400/1000 ms would misclassify pauses on noise alone.

The minimum pause length is 150 ms rather than the more common 100 ms because
the closure phase of a stop consonant (the silent part of /p/, /t/, /k/) runs
50-120 ms and is *not* a pause. A 100 ms floor turns every "put" and "back"
into a hesitation event.
"""

from __future__ import annotations

from dataclasses import dataclass, asdict

import numpy as np

from .vad import Segment

MIN_PAUSE_S = 0.15

# Upper bound of each class, in seconds.
TAXONOMY = (
    ("micro", 0.25),      # breath, planning inside a clause
    ("short", 0.50),      # clause boundary
    ("long", 1.00),       # sentence boundary, rhetorical beat
    ("extended", float("inf")),  # hesitation or a deliberate hold
)


@dataclass
class Pause:
    start: float
    end: float
    duration: float
    kind: str

    def as_dict(self) -> dict:
        d = asdict(self)
        return {k: (round(float(v), 3) if isinstance(v, (int, float)) and not isinstance(v, bool) and k != "kind" else v) for k, v in d.items()}


def classify(duration: float) -> str:
    for name, upper in TAXONOMY:
        if duration < upper:
            return name
    return TAXONOMY[-1][0]


def pauses(
    segs: list[Segment], total_duration: float, min_pause_s: float = MIN_PAUSE_S
) -> list[Pause]:
    """Silences *between* speech segments.

    Leading and trailing silence are excluded: they are recording handles, not
    speaking behaviour, and counting them would let a slow start inflate the
    pause statistics of an otherwise fluent take.
    """
    out: list[Pause] = []
    for a, b in zip(segs, segs[1:]):
        d = b.start - a.end
        if d >= min_pause_s:
            out.append(Pause(a.end, b.start, d, classify(d)))
    return out


def summarize(
    segs: list[Segment], pause_list: list[Pause], total_duration: float
) -> dict:
    phonation = float(sum(s.duration for s in segs))
    speaking_span = (segs[-1].end - segs[0].start) if segs else 0.0
    durations = np.array([p.duration for p in pause_list], dtype=float)

    counts = {name: 0 for name, _ in TAXONOMY}
    for p in pause_list:
        counts[p.kind] += 1

    out = {
        "total_duration_s": round(total_duration, 3),
        # Time from first word to last: the denominator for anything per-minute.
        "speaking_span_s": round(speaking_span, 3),
        "phonation_time_s": round(phonation, 3),
        "phonation_ratio": round(phonation / speaking_span, 4) if speaking_span else 0.0,
        "pause_ratio": round(1 - phonation / speaking_span, 4) if speaking_span else 0.0,
        "n_speech_segments": len(segs),
        "n_pauses": len(pause_list),
        "pauses_per_minute": round(len(pause_list) / (speaking_span / 60), 2)
        if speaking_span > 0
        else 0.0,
        "pause_counts": counts,
    }
    if len(durations):
        out |= {
            "pause_median_s": round(float(np.median(durations)), 3),
            "pause_mean_s": round(float(durations.mean()), 3),
            "pause_p90_s": round(float(np.percentile(durations, 90)), 3),
            "pause_longest_s": round(float(durations.max()), 3),
            "pause_total_s": round(float(durations.sum()), 3),
        }
    return out


def rate(words, segs: list[Segment], speaking_span_s: float, phonation_s: float) -> dict:
    """Tempo. Two different denominators, two different meanings.

    Speech rate divides by wall-clock time and so falls when you pause more.
    Articulation rate divides by phonation time only, so it measures how fast
    you move your mouth when you are actually moving it. A speaker who sounds
    "fast" usually has a normal speech rate and a high articulation rate, or a
    normal articulation rate and too few pauses - and the fix differs.
    """
    from .lexical import count_syllables

    if not words or speaking_span_s <= 0:
        return {"note": "no words to rate"}

    syl = sum(count_syllables(w.word) for w in words)
    out = {
        "n_words": len(words),
        "words_per_minute": round(len(words) / (speaking_span_s / 60), 1),
        "syllables_per_second": round(syl / speaking_span_s, 3),
        "articulation_rate_syl_per_s": round(syl / phonation_s, 3) if phonation_s > 0 else 0.0,
    }

    # Local rate over a sliding 10 s window: a single mean hides a take that
    # started measured and ended sprinting.
    win = 10.0
    starts = np.array([w.start for w in words])
    local = []
    t = starts[0]
    while t + win <= starts[-1]:
        n = int(((starts >= t) & (starts < t + win)).sum())
        local.append(n / win * 60)
        t += win / 2
    if len(local) >= 2:
        out |= {
            "wpm_local_sd": round(float(np.std(local)), 2),
            "wpm_local_min": round(float(np.min(local)), 1),
            "wpm_local_max": round(float(np.max(local)), 1),
        }
    return out
