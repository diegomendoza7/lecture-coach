"""Voice activity detection (Silero v5, ONNX) -> speech segments.

Why not an energy/ZCR gate: unvoiced consonants (s, f, t, k) carry high
zero-crossing rates and low energy, so naive gates score them as silence and
manufacture a pause inside every word containing an "s". Silero is trained on
speech and does not have that failure mode.

Post-processing here is tuned for *measuring pauses*, not for cropping speech.
The usual `speech_pad_ms` that VAD wrappers apply would dilate every speech
segment and shrink every gap between them, biasing pause durations low, so the
padding is zero by default.
"""

from __future__ import annotations

from dataclasses import dataclass
from pathlib import Path

import numpy as np

MODEL_PATH = Path(__file__).parent / "models" / "silero_vad.onnx"
CHUNK = 512  # samples; Silero v5 advances exactly this much per step at 16 kHz
CONTEXT = 64  # v5 also wants the previous 64 samples prepended (576 in total)
CHUNK_S = CHUNK / 16_000  # 32 ms


@dataclass
class Segment:
    start: float
    end: float

    @property
    def duration(self) -> float:
        return self.end - self.start


def speech_probs(samples: np.ndarray, sr: int = 16_000) -> np.ndarray:
    """Per-chunk speech probability at 32 ms resolution."""
    import onnxruntime as ort

    if sr != 16_000:
        raise ValueError("Silero v5 here is wired for 16 kHz only")

    opts = ort.SessionOptions()
    opts.inter_op_num_threads = 1
    opts.intra_op_num_threads = 1
    sess = ort.InferenceSession(
        str(MODEL_PATH), sess_options=opts, providers=["CPUExecutionProvider"]
    )

    n_chunks = len(samples) // CHUNK
    if n_chunks == 0:
        return np.zeros(0, dtype=np.float32)

    state = np.zeros((2, 1, 128), dtype=np.float32)
    context = np.zeros(CONTEXT, dtype=np.float32)
    sr_in = np.array(sr, dtype=np.int64)
    probs = np.empty(n_chunks, dtype=np.float32)
    for i in range(n_chunks):
        chunk = samples[i * CHUNK : (i + 1) * CHUNK].astype(np.float32)
        inp = np.concatenate((context, chunk)).reshape(1, CONTEXT + CHUNK)
        out, state = sess.run(None, {"input": inp, "state": state, "sr": sr_in})
        probs[i] = out[0][0]
        context = chunk[-CONTEXT:]
    return probs


def segments_from_probs(
    probs: np.ndarray,
    threshold: float = 0.5,
    min_speech_ms: float = 120.0,
    min_silence_ms: float = 60.0,
) -> list[Segment]:
    """Hysteresis threshold over the probability track.

    Two thresholds (not one) so that a probability hovering at the boundary does
    not shatter one utterance into a burst of fake micro-pauses.
    """
    neg = max(threshold - 0.15, 0.05)
    min_speech = min_speech_ms / 1000.0
    min_silence = min_silence_ms / 1000.0

    segs: list[Segment] = []
    triggered = False
    start = 0.0
    silence_start: float | None = None

    for i, p in enumerate(probs):
        t = i * CHUNK_S
        if not triggered:
            if p >= threshold:
                triggered, start, silence_start = True, t, None
            continue
        if p >= neg:
            silence_start = None
            continue
        # below the release threshold: candidate end of speech
        if silence_start is None:
            silence_start = t
        elif t - silence_start >= min_silence:
            if silence_start - start >= min_speech:
                segs.append(Segment(start, silence_start))
            triggered, silence_start = False, None

    if triggered:
        end = len(probs) * CHUNK_S
        if end - start >= min_speech:
            segs.append(Segment(start, end))
    return segs


def _edge(samples: np.ndarray, sr: int, t: float, back: float, fwd: float, is_start: bool) -> float:
    """Locate the true energy transition near a coarse VAD edge.

    Threshold is the midpoint *in dB* between the local quiet and loud levels,
    not the linear midpoint: amplitude is so top-heavy that a linear midpoint
    sits well inside the speech and clips off the natural decay of a final
    vowel or fricative.
    """
    lo = max(0, int((t - back) * sr))
    hi = min(len(samples), int((t + fwd) * sr))
    win = max(1, int(sr * 0.005))  # 5 ms
    if hi - lo < 2 * win:
        return t
    seg = samples[lo:hi].astype(np.float64)
    env = np.sqrt(np.convolve(seg**2, np.ones(win) / win, mode="same"))
    quiet, loud = np.percentile(env, 5), np.percentile(env, 95)
    if loud <= quiet * 2:  # window does not straddle a transition
        return t
    mid = np.sqrt(max(quiet, 1e-9) * loud)
    above = env >= mid
    if not above.any():
        return t
    idx = np.argmax(above) if is_start else len(above) - 1 - np.argmax(above[::-1])
    return float(lo + idx) / sr


def _refine(samples: np.ndarray, sr: int, segs: list[Segment], max_shift: float = 0.15) -> list[Segment]:
    """Snap segment edges to the waveform.

    Silero decides on a 32 ms grid and its offset decision lags the actual end
    of speech, which biases every measured gap short. Refinement is clamped so
    an edge can never travel more than halfway into an adjacent gap, otherwise
    two neighbouring corrections could swallow a short pause entirely.
    """
    if not segs:
        return segs
    total = len(samples) / sr
    out: list[Segment] = []
    for i, s in enumerate(segs):
        prev_end = segs[i - 1].end if i > 0 else 0.0
        next_start = segs[i + 1].start if i + 1 < len(segs) else total
        half_before = max(0.0, (s.start - prev_end) / 2)
        half_after = max(0.0, (next_start - s.end) / 2)
        inward = max(0.0, min(max_shift, s.duration / 3))
        a = _edge(samples, sr, s.start, min(max_shift, half_before), inward, True)
        b = _edge(samples, sr, s.end, inward, min(max_shift, half_after), False)
        if b > a:
            out.append(Segment(a, b))
    return out


def detect(
    samples: np.ndarray,
    sr: int = 16_000,
    threshold: float = 0.5,
    min_speech_ms: float = 120.0,
    min_silence_ms: float = 60.0,
    refine: bool = True,
) -> tuple[list[Segment], np.ndarray]:
    """Returns (speech segments, per-chunk probability track)."""
    probs = speech_probs(samples, sr)
    segs = segments_from_probs(probs, threshold, min_speech_ms, min_silence_ms)
    if refine:
        segs = _refine(samples, sr, segs)
    return segs, probs
