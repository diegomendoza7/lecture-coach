"""Record a take from the microphone, for testing speechlab without Electron.

    python tools/record.py 60 -o take.wav      # 60 seconds
    python tools/record.py -o take.wav          # until Ctrl-C

Records at the device's native rate and resamples to 16 kHz mono, which is what
the analysis pipeline wants. Warns if the stream came back silent, which on
macOS almost always means the terminal has not been granted microphone access
(System Settings > Privacy & Security > Microphone).
"""

from __future__ import annotations

import argparse
import queue
import sys
import time
from pathlib import Path

import numpy as np
import sounddevice as sd
import soundfile as sf
from scipy.signal import resample_poly

TARGET_SR = 16_000


def meter(level: float, width: int = 30) -> str:
    db = 20 * np.log10(max(level, 1e-6))
    filled = int(np.clip((db + 60) / 60, 0, 1) * width)
    return "#" * filled + "-" * (width - filled) + f" {db:6.1f} dBFS"


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("seconds", nargs="?", type=float, default=None)
    ap.add_argument("-o", "--out", default=None, help="default: take_<timestamp>.wav")
    ap.add_argument("-d", "--device", type=int, default=None)
    ap.add_argument("--countdown", type=int, default=3)
    args = ap.parse_args(argv)

    if args.out is None:
        args.out = time.strftime("take_%Y-%m-%d_%H%M%S.wav")

    dev = sd.query_devices(args.device, kind="input")
    sr = int(dev["default_samplerate"])
    print(f"input: {dev['name']}  @{sr} Hz")

    for i in range(args.countdown, 0, -1):
        print(f"  starting in {i}...", end="\r", flush=True)
        time.sleep(1)

    q: queue.Queue[np.ndarray] = queue.Queue()

    def cb(indata, frames, tinfo, status):
        if status:
            print(f"\n  {status}", file=sys.stderr)
        q.put(indata[:, 0].copy())

    limit = f"{args.seconds:.0f}s" if args.seconds else "Ctrl-C to stop"
    print(f"RECORDING ({limit})" + " " * 20)
    chunks: list[np.ndarray] = []
    t0 = time.time()
    try:
        with sd.InputStream(
            samplerate=sr, channels=1, dtype="float32", device=args.device, callback=cb
        ):
            while args.seconds is None or time.time() - t0 < args.seconds:
                try:
                    c = q.get(timeout=0.2)
                except queue.Empty:
                    continue
                chunks.append(c)
                el = time.time() - t0
                print(
                    f"  {int(el)//60:d}:{int(el)%60:02d}  {meter(float(np.abs(c).max()))}",
                    end="\r",
                    flush=True,
                )
    except KeyboardInterrupt:
        pass

    while not q.empty():
        chunks.append(q.get())
    if not chunks:
        print("\nno audio captured")
        return 1

    x = np.concatenate(chunks)
    peak = float(np.abs(x).max())
    print(f"\ncaptured {len(x)/sr:.1f}s, peak {20*np.log10(max(peak,1e-9)):.1f} dBFS")
    if peak < 1e-4:
        print(
            "\nWARNING: the stream is silent. Grant your terminal microphone access in\n"
            "System Settings > Privacy & Security > Microphone, then try again.",
            file=sys.stderr,
        )

    y = resample_poly(x, TARGET_SR, sr).astype(np.float32)
    out = Path(args.out)
    sf.write(out, y, TARGET_SR, subtype="PCM_16")
    print(f"wrote {out}  ({out.stat().st_size/1024:.0f} KB)")
    print(f"\nnow run:\n  .venv/bin/python -m speechlab {out} --language en")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
