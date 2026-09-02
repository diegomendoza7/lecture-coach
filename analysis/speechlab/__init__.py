"""speechlab - measurement layer for Lecture Coach takes.

Design rules, deliberately:
  * Pause timing comes from VAD on the waveform, never from gaps between ASR
    words. ASR alignment error (50-200 ms) must not leak into pause metrics.
  * Pitch is reported in semitones relative to the speaker's own median. Hz is
    a linear scale and perception is logarithmic; a 30 Hz rise means something
    completely different on a 95 Hz voice than on a 220 Hz one.
  * Loudness is relative only. An uncalibrated microphone cannot measure SPL,
    so we report variability and never an absolute "loudness" figure.
  * No composite 0-100 scores. We emit measurements; interpretation needs a
    per-speaker baseline, and anything beyond that needs validation we haven't
    done yet.
"""

__version__ = "0.1.0"
