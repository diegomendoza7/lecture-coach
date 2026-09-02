"""Assemble one take into the sidecar JSON Lecture Coach will render.

There is deliberately no overall score in this document. Every field is a
measurement or a count. Turning them into a single "delivery score" needs
per-speaker baselines and a perceptual validation study we have not run, and a
confident-looking number that nobody validated is worse than no number.
"""

from __future__ import annotations

import datetime as _dt
import json
from pathlib import Path

import numpy as np

from . import asr as _asr
from . import audio as _audio
from . import fillers as _fillers
from . import lexical as _lexical
from . import prosody as _prosody
from . import timing as _timing
from . import vad as _vad

SCHEMA = "speechlab/1"
CONTOUR_HZ = 10.0  # resolution of the contours handed to the UI


class _Encoder(json.JSONEncoder):
    def default(self, o):
        if isinstance(o, (np.integer,)):
            return int(o)
        if isinstance(o, (np.floating,)):
            return float(o)
        if isinstance(o, np.ndarray):
            return o.tolist()
        return super().default(o)


def _contours(pros, step_hz: float = CONTOUR_HZ) -> dict:
    """Downsample pitch and energy for drawing. NaN marks unvoiced."""
    if len(pros.times) == 0:
        return {}
    end = float(pros.times[-1])
    grid = np.arange(0.0, end, 1.0 / step_hz)
    f0 = np.interp(grid, pros.times, np.where(pros.f0_hz > 0, pros.f0_st, np.nan))
    idx = np.searchsorted(pros.energy_times, grid).clip(0, len(pros.energy_db) - 1)
    return {
        "step_s": round(1.0 / step_hz, 4),
        "f0_st": [None if not np.isfinite(v) else round(float(v), 2) for v in f0],
        "energy_db": [round(float(v), 1) for v in pros.energy_db[idx]],
    }


def analyze(
    path: str | Path,
    model: str = _asr.DEFAULT_MODEL,
    language: str | None = None,
    run_asr: bool = True,
    contours: bool = True,
) -> dict:
    a = _audio.load(path)
    quality = _audio.quality(a)

    segs, _probs = _vad.detect(a.samples, a.sr)
    pros = _prosody.extract(a.samples, a.sr)
    pause_list = _timing.pauses(segs, a.duration)
    t_sum = _timing.summarize(segs, pause_list, a.duration)

    out: dict = {
        "schema": SCHEMA,
        "generated_at": _dt.datetime.now().astimezone().isoformat(timespec="seconds"),
        "source": {"path": str(Path(path).resolve()), "duration_s": round(a.duration, 3)},
        "quality": quality,
        "timing": t_sum,
        "prosody": _prosody.summarize(pros, segs),
        "pauses": [p.as_dict() for p in pause_list],
    }
    if contours:
        out["contours"] = _contours(pros)

    if not run_asr:
        out["note"] = "ASR skipped: rate, disfluency and vocabulary omitted"
        return out

    tr = _asr.transcribe(a.samples, a.sr, model=model, language=language)
    cov = _asr.coverage(tr["words"], segs)
    vocab = _lexical.analyze(tr["text"])

    out |= {
        "transcript": {
            "language": tr["language"],
            "model": tr["model"],
            "text": tr["text"],
            "words": [w.as_dict() for w in tr["words"]],
        },
        "rate": _timing.rate(
            tr["words"], segs, t_sum["speaking_span_s"], t_sum["phonation_time_s"]
        ),
        "disfluency": _fillers.analyze(
            tr["words"], cov, pros, t_sum["speaking_span_s"], vocab.get("total_tokens", 0)
        ),
        "vocabulary": vocab,
        "asr_coverage": {k: v for k, v in cov.items() if k != "unaccounted_regions"},
    }
    return out


def to_json(report: dict, indent: int = 2) -> str:
    return json.dumps(report, cls=_Encoder, indent=indent)
