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
    on_progress=None,
) -> dict:
    """`on_progress(stage, fraction)` is called as work completes, so a UI can
    show something during the ASR pass - by far the slowest stage."""
    step = on_progress or (lambda *_: None)
    step("decoding audio", 0.05)
    a = _audio.load(path)
    quality = _audio.quality(a)

    step("detecting speech", 0.15)
    segs, _probs = _vad.detect(a.samples, a.sr)
    step("measuring pitch and energy", 0.32)
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
        step("done", 1.0)
        return out

    step("transcribing", 0.45)
    tr = _asr.transcribe(a.samples, a.sr, model=model, language=language)
    step("analysing words", 0.92)
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
    step("done", 1.0)
    return out


def to_json(report: dict, indent: int = 2) -> str:
    return json.dumps(report, cls=_Encoder, indent=indent)


def _mmss(t: float) -> str:
    return f"{int(t) // 60}:{int(t) % 60:02d}"


def to_text(r: dict) -> str:
    """Human-readable digest. Deliberately shows ranges and units, not verdicts."""
    L: list[str] = []
    src = Path(r["source"]["path"]).name
    L.append(f"{src}   {_mmss(r['source']['duration_s'])}")

    q = r["quality"]
    verdict = "ok" if q["usable"] else "POOR - metrics below are unreliable"
    L.append(f"recording   SNR {q['snr_db']} dB, peak {q['peak_dbfs']} dBFS   {verdict}")
    for w in q["warnings"]:
        L.append(f"            ! {w}")

    t = r["timing"]
    L.append("")
    if "rate" in r and "words_per_minute" in r["rate"]:
        rt = r["rate"]
        loc = (
            f"   (local {rt['wpm_local_min']:.0f}-{rt['wpm_local_max']:.0f}, sd {rt['wpm_local_sd']:.0f})"
            if "wpm_local_sd" in rt else ""
        )
        L.append("TEMPO")
        L.append(f"  speaking rate      {rt['words_per_minute']:.0f} wpm{loc}")
        L.append(f"  articulation rate  {rt['articulation_rate_syl_per_s']:.1f} syl/s of phonation")
        L.append(f"  pause ratio        {t['pause_ratio']*100:.0f}% of speaking time")

    c = t["pause_counts"]
    L.append("")
    L.append(f"PAUSES   {t['n_pauses']} total ({t['pauses_per_minute']}/min)")
    L.append(f"  {'  '.join(f'{k} {v}' for k, v in c.items())}")
    if r["pauses"]:
        longest = max(r["pauses"], key=lambda p: p["duration"])
        L.append(f"  longest {longest['duration']:.1f}s at {_mmss(longest['start'])}")

    p = r["prosody"]
    L.append("")
    L.append("VOICE")
    if "f0_median_hz" in p:
        L.append(f"  pitch median       {p['f0_median_hz']:.0f} Hz")
        L.append(f"  pitch variation    {p['f0_sd_st']:.2f} st sd, {p['f0_range_st']:.1f} st range")
    if "energy_sd_db" in p:
        L.append(f"  energy variation   {p['energy_sd_db']:.1f} dB sd  (relative to this mic only)")

    if "disfluency" in r:
        d = r["disfluency"]
        lo, hi = d["filled_pauses_estimated_range"]
        L.append("")
        L.append("DISFLUENCY")
        rng = f"{lo}" if lo == hi else f"{lo}-{hi}"
        L.append(f"  filled pauses      {rng}   (um/uh; upper end estimates what Whisper dropped)")
        L.append(f"  repetitions        {d['repetition_count']}")
        mk = d["discourse_marker_counts"]
        detail = ", ".join(f"{k} {v}" for k, v in sorted(mk.items(), key=lambda x: -x[1])) or "none"
        L.append(f"  discourse markers  {len(d['discourse_markers'])}   {detail}")
        L.append("                     (shown in context in the JSON - not auto-judged as fillers)")

    if "vocabulary" in r:
        v = r["vocabulary"]
        L.append("")
        L.append(f"VOCABULARY   {v['total_tokens']} words, {v['unique_tokens']} unique")
        bits = [f"MATTR {v['mattr_50']:.2f}"]
        bits.append(f"MTLD {v['mtld']:.0f}" if "mtld" in v else "MTLD n/a (short take)")
        L.append(f"  diversity          {'   '.join(bits)}")
        for rp in v["repeated_phrases"][:4]:
            L.append(f"  repeated           \"{rp['phrase']}\" x{rp['count']}")

    L.append("")
    L.append("No overall score by design - these are measurements. Interpretation")
    L.append("needs your own baseline across several takes.")
    return "\n".join(L)
