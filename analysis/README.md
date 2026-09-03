# speechlab — measurement layer

Analyses one Lecture Coach take and writes a `*.speech.json` sidecar next to it,
alongside the `*.session.json` that `main.js` already produces.

```bash
.venv/bin/python -m speechlab ~/Movies/"Lecture Coach"/take_2026-09-01_143022.mp4
```

Writes three files next to the take: a readable terminal summary, the
`.speech.json` sidecar, and a clickable `.speech.html` report — a seekable
timeline with the pitch and energy contours, pause bands, breath markers and a
transcript where every word seeks the audio. Open it with `open take.speech.html`.
Keep the HTML beside its audio file; it references it by relative path rather
than embedding it, so a 45-minute take stays small.

Prints a readable summary and writes the JSON. Add `-q` for JSON only,
`--no-asr` to skip the transcript (acoustics only, no model load), `--no-html`
to skip the report.

To test without Electron, record straight from the mic:

```bash
.venv/bin/python tools/record.py 60          # writes take_<timestamp>.wav
.venv/bin/python -m speechlab take_*.wav --language en
```

The first recording will need Terminal granted microphone access in System
Settings > Privacy & Security > Microphone; the recorder warns if the stream
came back silent.

Runs entirely on-device. Nothing is uploaded; the only network access is the
one-time Whisper weight download from Hugging Face.

## Setup

```bash
python3 -m venv .venv && .venv/bin/pip install -r requirements.txt
```

Apple Silicon only, because ASR runs through MLX on the GPU. The acoustic half
(`--no-asr`) is portable.

## Verify

```bash
.venv/bin/python tests/test_smoke.py       # 31 checks
SL_FAST=1 .venv/bin/python tests/test_smoke.py   # 21, skips ASR
```

Fixtures are generated, not committed: `tests/make_fixtures.py` builds speech
with macOS `say` and concatenates it with sample-exact silences, so pause ground
truth is known by construction rather than annotated by hand. Pitch is checked
against synthetic tones where the answer is known exactly.

## Measured accuracy

Against those fixtures, on clean single-speaker audio:

| Measurement | Result |
|---|---|
| Pause duration | max error 75 ms, mean 31 ms |
| Pause onset | max error 30 ms |
| Pause count / taxonomy | 4/4, all classes correct, 0 spurious |
| Phonation time | within 0.2 s over 14 s of speech |
| Pitch on a known tone | 0.0 cents error |
| Semitone range on a 1-octave glide | within 0.3 st |
| ASR word accuracy | 100% (55/55 words) |
| Filled pauses / repetitions / markers | 3/3, 3/3, 5/5, no false positives on fluent speech |
| AAC/MP4 vs WAV | measurements differ by < 7 ms |

Warm ASR throughput is ~12x realtime on an M2 Pro: a 45-minute take analyses in
about four minutes. These are numbers from synthetic and TTS audio, which is
cleaner than a real room — treat them as an upper bound until re-measured on
real takes.

## Design decisions worth not re-deriving

**Pauses come from VAD, never from gaps between ASR words.** Word timestamps
carry 50–200 ms of alignment error; the taxonomy's class boundaries are at
200/400/1000 ms. Deriving pauses from ASR would misclassify them on noise alone.

**Silero VAD needs 64 samples of rolling context prepended to each 512-sample
chunk** (576 total). Feeding it bare 512-sample chunks returns ~0.001 for
everything and finds no speech at all. This cost an hour; don't rediscover it.

**VAD edges are refined against the waveform.** Silero decides on a 32 ms grid
and its speech-offset decision lags the true end, which biased every measured
gap ~75 ms short. Snapping edges to the energy transition — thresholded at the
dB midpoint, not the linear midpoint — cut max error from 140 ms to 75 ms.
Refinement is clamped to half the adjacent gap so two corrections can never
swallow a short pause.

**Minimum pause is 150 ms, not the conventional 100 ms.** The closure phase of
/p/, /t/, /k/ is genuinely silent for 50–120 ms. A 100 ms floor turns every
"put" and "back" into a hesitation event.

**Pitch is in semitones relative to the speaker's own median.** Pitch perception
is logarithmic. A "30 Hz rise" is a swoop on a 95 Hz voice and inaudible on a
220 Hz one, so any Hz threshold silently applies a different standard to
different speakers.

**Pitch floor/ceiling are found per-speaker in two passes** (Hirst's method)
rather than fixed at 75–600 Hz. A window that wide lets the tracker jump an
octave on a creaky syllable. On the test speech it narrows to 107–335 Hz.

**Loudness is relative only.** An uncalibrated microphone cannot measure SPL, so
`energy_median_dbfs` is comparable only within one mic/gain setup. The *dB
variation* is comparable across sessions; there is no "loudness in sones".

**Filler counts are a range, not a number.** Whisper is trained to produce clean
readable text and deletes many disfluencies. `filled_pause_count` is what
survived; `acoustic_candidates` finds voiced, steady-pitch audio inside a speech
segment that no transcript word accounts for — the ones it swallowed — and
`filled_pauses_estimated_range` reports both ends. Candidates abutting a counted
filler are dropped, because Whisper's end-timestamp falls short of the vowel and
the tail would otherwise be counted twice.

**Discourse markers are reported in context, not classified.** Deciding whether
a given "like" is a filler runs ~80% at best with rules, and we haven't
validated one. The take report shows the instances; the speaker judges.

**No readability indices.** Flesch and friends are dominated by sentence length,
and "sentences" in an ASR transcript are wherever Whisper put a full stop. The
grade level would be a fact about the model's punctuation habits.

**No composite score.** Every field is a measurement or a count. A "monotony
score" needs a perceptual validation study (target: r > 0.75 against human
ratings) that hasn't been run; a confident number nobody validated is worse than
no number. The smoke suite asserts no field named `*score*` exists.

## Known limits

- **English only** — the marker lists, syllable heuristic and filler vocabulary.
- **One speaker, close mic.** No diarization: analysing a conversation or a
  Q&A section produces garbage silently.
- **Syllable counting is a vowel-cluster heuristic** (~90%). It undercounts
  vowel hiatus: "idea" and "created" score one low. Fine in aggregate, wrong per
  word.
- **Mic distance is uncontrolled.** Leaning in and out of a laptop mic looks
  identical to genuine dynamic range in `energy_sd_db`.
- Lecture Coach captures with `noiseSuppression: true` ([renderer.js:388]).
  That's nonlinear and attenuates quiet passages and breath — the low-energy
  material prosody cares about. A separate unprocessed audio-only track would
  measure better.
- MTLD is withheld below 100 tokens; short takes get MATTR only.
- **Quiet recordings degrade voicing detection.** Praat's voiced/unvoiced
  decision is level-dependent, so a take at ~-37 dBFS speech level drops the
  voiced-frame ratio from ~0.85 to ~0.55 and with it the confidence of any
  filler classification. The filler/breath threshold is therefore set relative
  to each take's own voicing rate, not as an absolute. The real fix is recording
  hotter: aim for peaks around -12 dBFS and SNR above 20 dB.

## Integration (not built yet)

`main.js` already has the seam: `file:save-sidecar` writes `${base}.session.json`.
The plan is a `speech:analyze` IPC handler that spawns this CLI on the finished
take, writes `${base}.speech.json`, and lets the take report render the
contours and a clickable pause/filler timeline — every metric seekable to the
audio that produced it.
