"""Pitch and energy contours.

Pitch is reported in semitones relative to the speaker's own median, because
pitch perception is logarithmic. A "30 Hz rise" is a dramatic swoop on a 95 Hz
voice and nearly inaudible on a 220 Hz one, so any threshold expressed in Hz
silently applies a different standard to different speakers.

Energy is reported in dBFS and, more usefully, as variation in dB. An
uncalibrated microphone cannot measure sound pressure level, so the absolute
figure is only comparable within one recording setup; the *variation* is
comparable across sessions.
"""

from __future__ import annotations

from dataclasses import dataclass, field

import numpy as np

from .audio import frame_rms
from .vad import Segment


@dataclass
class Prosody:
    times: np.ndarray = field(repr=False)
    f0_hz: np.ndarray = field(repr=False)      # 0 where unvoiced
    f0_st: np.ndarray = field(repr=False)      # semitones re median, NaN unvoiced
    energy_db: np.ndarray = field(repr=False)
    energy_times: np.ndarray = field(repr=False)
    floor_hz: float = 0.0
    ceiling_hz: float = 0.0
    median_hz: float = 0.0


def _pitch_range(sound, time_step: float) -> tuple[float, float]:
    """Two-pass adaptive floor/ceiling (Hirst's method).

    A fixed 75-600 Hz window is the usual default and the usual source of octave
    errors: it is too wide for any individual speaker, so the tracker is free to
    jump an octave on a creaky syllable. One wide pass to find where this voice
    actually sits, then a second pass bracketed around it.
    """
    rough = sound.to_pitch_ac(time_step=time_step, pitch_floor=60.0, pitch_ceiling=700.0)
    v = rough.selected_array["frequency"]
    v = v[v > 0]
    if len(v) < 10:
        return 75.0, 600.0
    q15, q65 = np.percentile(v, 15), np.percentile(v, 65)
    return float(max(50.0, q15 * 0.72)), float(min(900.0, q65 * 1.90))


def extract(
    samples: np.ndarray, sr: int, time_step: float = 0.01
) -> Prosody:
    import parselmouth

    sound = parselmouth.Sound(samples.astype(np.float64), sampling_frequency=sr)
    floor, ceiling = _pitch_range(sound, time_step)
    pitch = sound.to_pitch_ac(
        time_step=time_step,
        pitch_floor=floor,
        pitch_ceiling=ceiling,
        very_accurate=True,
    )
    f0 = pitch.selected_array["frequency"].astype(np.float64)
    times = np.asarray(pitch.xs(), dtype=np.float64)

    voiced = f0 > 0
    median = float(np.median(f0[voiced])) if voiced.any() else 0.0
    f0_st = np.full_like(f0, np.nan)
    if median > 0:
        f0_st[voiced] = 12.0 * np.log2(f0[voiced] / median)

    rms, e_times = frame_rms(samples, sr, win_ms=25.0, hop_ms=time_step * 1000)
    with np.errstate(divide="ignore"):
        energy_db = 20.0 * np.log10(np.maximum(rms, 1e-10))

    return Prosody(times, f0, f0_st, energy_db, e_times, floor, ceiling, median)


def _mask_to_segments(times: np.ndarray, segs: list[Segment]) -> np.ndarray:
    """True where `times` falls inside a speech segment."""
    m = np.zeros(len(times), dtype=bool)
    for s in segs:
        m |= (times >= s.start) & (times <= s.end)
    return m


def summarize(pros: Prosody, segs: list[Segment]) -> dict:
    """Aggregate over speech only. Pauses would otherwise dilute every statistic."""
    in_speech = _mask_to_segments(pros.times, segs) if segs else np.ones(len(pros.times), bool)
    voiced = (pros.f0_hz > 0) & in_speech
    n_voiced = int(voiced.sum())

    out: dict = {
        "voiced_frames": n_voiced,
        "voiced_ratio": round(float(voiced.sum() / max(in_speech.sum(), 1)), 4),
        "pitch_floor_hz": round(pros.floor_hz, 1),
        "pitch_ceiling_hz": round(pros.ceiling_hz, 1),
    }
    if n_voiced >= 20:
        st = pros.f0_st[voiced]
        hz = pros.f0_hz[voiced]
        out |= {
            "f0_median_hz": round(float(np.median(hz)), 2),
            "f0_sd_st": round(float(np.std(st)), 3),
            "f0_range_st": round(float(np.percentile(st, 95) - np.percentile(st, 5)), 3),
            "f0_iqr_st": round(float(np.percentile(st, 75) - np.percentile(st, 25)), 3),
        }
    else:
        out["f0_note"] = "too few voiced frames for reliable pitch statistics"

    e_speech = _mask_to_segments(pros.energy_times, segs) if segs else np.ones(len(pros.energy_times), bool)
    e = pros.energy_db[e_speech]
    e = e[np.isfinite(e) & (e > -80)]
    if len(e) >= 20:
        out |= {
            # dBFS: comparable within one mic/gain setup, not across setups.
            "energy_median_dbfs": round(float(np.median(e)), 2),
            # dB differences: comparable across sessions.
            "energy_sd_db": round(float(np.std(e)), 3),
            "energy_range_db": round(float(np.percentile(e, 95) - np.percentile(e, 5)), 3),
        }
    return out
