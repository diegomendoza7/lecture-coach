"""Generate deterministic test audio with known ground truth.

macOS `say` gives us real speech (real formants, real unvoiced consonants) while
letting us control the silences exactly: each phrase is synthesised separately,
trimmed, then concatenated with a precise number of silent samples. The gap
durations are therefore exact by construction, which is what lets the smoke
suite assert a real accuracy bound on pause detection instead of eyeballing it.

Synthetic tones cover pitch, where `say` gives us no ground truth at all.
"""

from __future__ import annotations

import subprocess
import tempfile
from pathlib import Path

import numpy as np
import soundfile as sf
from scipy.signal import resample_poly

SR = 16_000
FIXTURES = Path(__file__).parent / "fixtures"
VOICE = "Samantha"


def _say(text: str) -> np.ndarray:
    """Synthesise one phrase, return mono float32 at SR, silence trimmed."""
    with tempfile.NamedTemporaryFile(suffix=".wav", delete=False) as f:
        tmp = Path(f.name)
    cmd = ["say", "-o", str(tmp), "--file-format=WAVE", "--data-format=LEI16@22050"]
    if VOICE in _voices():
        cmd += ["-v", VOICE]
    subprocess.run(cmd + [text], check=True, capture_output=True)
    x, sr = sf.read(tmp, dtype="float32")
    tmp.unlink(missing_ok=True)
    if x.ndim > 1:
        x = x.mean(axis=1)
    x = resample_poly(x, SR, sr).astype(np.float32)
    loud = np.abs(x) > 0.005
    if not loud.any():
        return x
    return x[np.argmax(loud) : len(loud) - np.argmax(loud[::-1])]


_VOICE_CACHE: list[str] | None = None


def _voices() -> list[str]:
    global _VOICE_CACHE
    if _VOICE_CACHE is None:
        out = subprocess.run(["say", "-v", "?"], capture_output=True, text=True).stdout
        _VOICE_CACHE = [ln.split()[0] for ln in out.splitlines() if ln.strip()]
    return _VOICE_CACHE


def _noise(n: int, dbfs: float, rng: np.random.Generator) -> np.ndarray:
    """Room tone. Digital silence would make VAD trivially easy and unrealistic."""
    return (rng.standard_normal(n) * (10 ** (dbfs / 20))).astype(np.float32)


def pause_fixture(path: Path, noise_dbfs: float = -50.0) -> dict:
    """Phrases separated by exactly-known silences."""
    phrases = [
        "The rainbow is a division of white light into many beautiful colors",
        "These take the shape of a long round arch",
        "With its path high above and its two ends apparently beyond the horizon",
        "There is according to legend a boiling pot of gold at one end",
        "People look but no one ever finds it",
    ]
    gaps = [0.30, 0.75, 1.40, 0.22]  # seconds, inserted verbatim

    rng = np.random.default_rng(7)
    clips = [_say(p) for p in phrases]

    parts: list[np.ndarray] = []
    truth: list[dict] = []
    cursor = 0.0
    lead = 0.25
    parts.append(np.zeros(int(lead * SR), dtype=np.float32))
    cursor += lead

    for i, clip in enumerate(clips):
        parts.append(clip)
        cursor += len(clip) / SR
        if i < len(gaps):
            n = int(round(gaps[i] * SR))
            parts.append(np.zeros(n, dtype=np.float32))
            truth.append(
                {
                    "start": round(cursor, 6),
                    "end": round(cursor + n / SR, 6),
                    "duration": round(n / SR, 6),
                }
            )
            cursor += n / SR
    parts.append(np.zeros(int(0.25 * SR), dtype=np.float32))

    x = np.concatenate(parts)
    x = x * 0.7 / max(float(np.abs(x).max()), 1e-9)
    x = x + _noise(len(x), noise_dbfs, rng)
    sf.write(path, x, SR, subtype="PCM_16")

    words = sum(len(p.split()) for p in phrases)
    speech_time = sum(len(c) / SR for c in clips)
    return {
        "file": str(path),
        "gaps": truth,
        "n_words": words,
        "speech_time_s": round(speech_time, 4),
        "total_duration_s": round(len(x) / SR, 4),
        "transcript": " ".join(phrases),
    }


DISFLUENT_LINES = [
    "So um today I want to talk about uh the results of our study",
    "The the data shows that like a significant improvement",
    "And you know we we found that uh basically it works",
    "I mean the the conclusion is you know pretty clear",
]


def disfluent_fixture(path: Path, noise_dbfs: float = -50.0) -> dict:
    """Speech containing known fillers, repeats and markers.

    Ground truth is derived from the text handed to `say`, so the counts are
    exact by construction rather than annotated by hand.
    """
    import re

    rng = np.random.default_rng(11)
    clips = [_say(line) for line in DISFLUENT_LINES]
    parts = [np.zeros(int(0.2 * SR), dtype=np.float32)]
    for i, c in enumerate(clips):
        parts.append(c)
        if i < len(clips) - 1:
            parts.append(np.zeros(int(0.5 * SR), dtype=np.float32))
    parts.append(np.zeros(int(0.2 * SR), dtype=np.float32))
    x = np.concatenate(parts)
    x = x * 0.7 / max(float(np.abs(x).max()), 1e-9)
    x = x + _noise(len(x), noise_dbfs, rng)
    sf.write(path, x, SR, subtype="PCM_16")

    fillers = {"um", "uh", "erm", "ah", "er", "mm", "hmm"}
    markers = [("you", "know"), ("i", "mean"), ("sort", "of"), ("kind", "of"),
               ("like",), ("basically",), ("actually",), ("literally",), ("obviously",)]
    text = " ".join(DISFLUENT_LINES)
    toks = re.findall(r"[a-z']+", text.lower())

    n_fill = sum(t in fillers for t in toks)
    n_rep, i = 0, 0
    while i < len(toks) - 1:
        if toks[i] == toks[i + 1]:
            n_rep += 1
            i += 2
        else:
            i += 1
    n_mark, i = 0, 0
    while i < len(toks):
        for m in markers:
            if tuple(toks[i:i + len(m)]) == m:
                n_mark += 1
                i += len(m) - 1
                break
        i += 1

    return {"file": str(path), "transcript": text, "n_words": len(toks),
            "n_filled_pauses": n_fill, "n_repetitions": n_rep,
            "n_discourse_markers": n_mark, "duration_s": round(len(x) / SR, 4)}


def _saw(f0: np.ndarray, sr: int = SR, harmonics: int = 30) -> np.ndarray:
    """Band-limited sawtooth following an instantaneous-frequency track.

    A pulse-like waveform with real harmonic structure, so Praat's
    autocorrelation tracker is exercised the way voiced speech exercises it.
    """
    phase = 2 * np.pi * np.cumsum(f0) / sr
    x = np.zeros(len(f0))
    for n in range(1, harmonics + 1):
        if (f0 * n).max() > sr / 2:
            break
        x += np.sin(n * phase) / n
    return (x / np.abs(x).max() * 0.6).astype(np.float32)


def tone_fixture(path: Path, hz: float = 120.0, seconds: float = 3.0) -> dict:
    n = int(seconds * SR)
    x = _saw(np.full(n, hz))
    sf.write(path, x, SR, subtype="PCM_16")
    return {"file": str(path), "f0_hz": hz, "duration_s": seconds}


def glide_fixture(path: Path, lo: float = 100.0, hi: float = 200.0, seconds: float = 3.0) -> dict:
    """A one-octave glide: exactly 12 semitones of range, by construction."""
    n = int(seconds * SR)
    f0 = np.geomspace(lo, hi, n)  # geometric => linear in semitones
    x = _saw(f0)
    sf.write(path, x, SR, subtype="PCM_16")
    return {
        "file": str(path),
        "f0_lo_hz": lo,
        "f0_hi_hz": hi,
        "semitone_range": round(12 * np.log2(hi / lo), 4),
        "duration_s": seconds,
    }


def build_all() -> dict:
    FIXTURES.mkdir(exist_ok=True)
    return {
        "pauses": pause_fixture(FIXTURES / "pauses.wav"),
        "disfluent": disfluent_fixture(FIXTURES / "disfluent.wav"),
        "tone": tone_fixture(FIXTURES / "tone_120.wav"),
        "glide": glide_fixture(FIXTURES / "glide_100_200.wav"),
    }


if __name__ == "__main__":
    import json

    truth = build_all()
    (FIXTURES / "truth.json").write_text(json.dumps(truth, indent=2))
    print(json.dumps(truth, indent=2))
