"""Decode any container Lecture Coach produces into mono 16 kHz float32.

Lecture Coach records H.264 MP4 (or webm/opus as a fallback), so we decode with
PyAV rather than requiring a system ffmpeg. Everything downstream assumes the
`Audio` produced here: mono, 16 kHz, float32 in [-1, 1].
"""

from __future__ import annotations

from dataclasses import dataclass
from pathlib import Path

import numpy as np

TARGET_SR = 16_000


@dataclass
class Audio:
    samples: np.ndarray
    sr: int
    path: str
    source_sr: int
    source_channels: int

    @property
    def duration(self) -> float:
        return len(self.samples) / self.sr


def load(path: str | Path, sr: int = TARGET_SR) -> Audio:
    """Decode the first audio stream of `path` to mono float32 at `sr`."""
    import av

    path = Path(path)
    chunks: list[np.ndarray] = []
    with av.open(str(path)) as container:
        stream = next((s for s in container.streams if s.type == "audio"), None)
        if stream is None:
            raise ValueError(f"no audio stream in {path}")
        source_sr = int(stream.rate or sr)
        source_channels = int(getattr(stream, "channels", 0) or 1)
        resampler = av.AudioResampler(format="flt", layout="mono", rate=sr)
        for frame in container.decode(stream):
            for out in resampler.resample(frame):
                chunks.append(out.to_ndarray().reshape(-1))
        for out in resampler.resample(None):  # flush
            chunks.append(out.to_ndarray().reshape(-1))

    samples = (
        np.concatenate(chunks).astype(np.float32)
        if chunks
        else np.zeros(0, dtype=np.float32)
    )
    return Audio(samples, sr, str(path), source_sr, source_channels)


def frame_rms(
    samples: np.ndarray, sr: int, win_ms: float = 25.0, hop_ms: float = 10.0
) -> tuple[np.ndarray, np.ndarray]:
    """RMS per analysis frame. Returns (rms, frame_start_times)."""
    win = max(1, int(sr * win_ms / 1000))
    hop = max(1, int(sr * hop_ms / 1000))
    if len(samples) < win:
        return np.zeros(0, dtype=np.float32), np.zeros(0, dtype=np.float32)
    n = 1 + (len(samples) - win) // hop
    frames = np.lib.stride_tricks.as_strided(
        samples,
        shape=(n, win),
        strides=(samples.strides[0] * hop, samples.strides[0]),
        writeable=False,
    )
    rms = np.sqrt(np.mean(frames.astype(np.float64) ** 2, axis=1))
    times = np.arange(n) * hop / sr
    return rms.astype(np.float32), times.astype(np.float32)


def _db(x: np.ndarray | float, floor: float = 1e-10) -> float:
    return float(20.0 * np.log10(max(float(x), floor)))


def quality(audio: Audio) -> dict:
    """Signal-quality gate.

    Every prosodic metric downstream degrades on a bad recording, so we measure
    the recording itself first and let the caller decide whether the numbers are
    worth reporting. The SNR estimate is crude but directional: the gap between
    the loud frames (mostly speech) and the quiet ones (mostly room).
    """
    x = audio.samples
    if len(x) == 0:
        return {"usable": False, "warnings": ["empty audio stream"]}

    peak = float(np.max(np.abs(x)))
    clipped = float(np.mean(np.abs(x) >= 0.999))
    dc = float(np.mean(x))
    rms, _ = frame_rms(x, audio.sr)

    noise_db = _db(np.percentile(rms, 10)) if len(rms) else -100.0
    speech_db = _db(np.percentile(rms, 90)) if len(rms) else -100.0
    snr = speech_db - noise_db

    warnings: list[str] = []
    if peak < 0.02:
        warnings.append(f"signal very quiet (peak {_db(peak):.0f} dBFS)")
    if clipped > 0.0005:
        warnings.append(f"clipping on {clipped * 100:.2f}% of samples")
    if abs(dc) > 0.01:
        warnings.append(f"DC offset {dc:+.3f}")
    if snr < 15:
        warnings.append(f"low SNR ({snr:.0f} dB) - prosody metrics unreliable")
    if audio.source_sr < 16_000:
        warnings.append(f"source sample rate {audio.source_sr} Hz below 16 kHz")

    return {
        "usable": snr >= 10 and peak >= 0.02 and clipped <= 0.01,
        "duration_s": round(audio.duration, 3),
        "source_sample_rate": audio.source_sr,
        "source_channels": audio.source_channels,
        "peak_dbfs": round(_db(peak), 1),
        "clipped_fraction": round(clipped, 6),
        "dc_offset": round(dc, 5),
        "noise_floor_dbfs": round(noise_db, 1),
        "speech_level_dbfs": round(speech_db, 1),
        "snr_db": round(snr, 1),
        "warnings": warnings,
    }
