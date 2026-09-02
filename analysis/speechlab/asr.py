"""Speech recognition with word-level timestamps (MLX Whisper, Metal-accelerated).

One caveat governs everything built on top of this module: Whisper is trained to
produce clean, readable text, and it routinely deletes the disfluencies we most
want to count - "um", "uh", repetitions, false starts. Filler counts taken from
the transcript are therefore a *lower bound*, never a measurement. `coverage()`
below exists to quantify what got dropped: speech the VAD heard but the
transcript never accounted for.
"""

from __future__ import annotations

from dataclasses import dataclass, asdict

import numpy as np

DEFAULT_MODEL = "mlx-community/whisper-large-v3-turbo"


@dataclass
class Word:
    word: str
    start: float
    end: float
    prob: float

    def as_dict(self) -> dict:
        d = asdict(self)
        for k in ("start", "end", "prob"):
            d[k] = round(float(d[k]), 3)
        return d


def transcribe(
    samples: np.ndarray,
    sr: int = 16_000,
    model: str = DEFAULT_MODEL,
    language: str | None = None,
) -> dict:
    """Transcribe with word timestamps. Expects mono 16 kHz float32."""
    import mlx_whisper

    if sr != 16_000:
        raise ValueError("Whisper expects 16 kHz input")

    result = mlx_whisper.transcribe(
        samples.astype(np.float32),
        path_or_hf_repo=model,
        word_timestamps=True,
        language=language,
        # Each window decodes independently. Carrying previous text forward makes
        # Whisper "tidy" the transcript across windows, which deletes exactly the
        # repetitions and restarts we are trying to count.
        condition_on_previous_text=False,
    )

    words: list[Word] = []
    for seg in result.get("segments", []):
        for w in seg.get("words", []) or []:
            text = w["word"].strip()
            if text:
                words.append(
                    Word(text, float(w["start"]), float(w["end"]), float(w.get("probability", 0.0)))
                )

    return {
        "model": model,
        "language": result.get("language"),
        "text": result.get("text", "").strip(),
        "words": words,
    }


def coverage(words: list[Word], segs, min_gap_s: float = 0.15) -> dict:
    """Speech the VAD heard that no transcript word accounts for.

    This is the honest handle on Whisper's disfluency deletion. A filled pause
    the model dropped still shows up here as voiced audio inside a speech
    segment with no word over it, so we can report it as a *candidate* rather
    than silently under-count fillers and call the result a measurement.
    """
    spans = [(w.start, w.end) for w in words]
    unaccounted: list[dict] = []
    total_speech = 0.0
    for s in segs:
        total_speech += float(s.duration)
        cursor = s.start
        for a, b in spans:
            if b <= s.start or a >= s.end:
                continue
            if a - cursor >= min_gap_s:
                unaccounted.append({"start": round(float(cursor), 3), "end": round(float(a), 3),
                                    "duration": round(float(a - cursor), 3)})
            cursor = max(cursor, b)
        if s.end - cursor >= min_gap_s:
            unaccounted.append({"start": round(float(cursor), 3), "end": round(float(s.end), 3),
                                "duration": round(float(s.end - cursor), 3)})

    unacc_time = sum(u["duration"] for u in unaccounted)
    return {
        "speech_time_s": round(total_speech, 3),
        "unaccounted_regions": unaccounted,
        "unaccounted_time_s": round(unacc_time, 3),
        "unaccounted_ratio": round(float(unacc_time / total_speech), 4) if total_speech else 0.0,
    }
