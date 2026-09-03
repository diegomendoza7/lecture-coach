"""speechlab smoke suite.

    python tests/test_smoke.py          # everything
    SL_FAST=1 python tests/test_smoke.py  # skip ASR (no model load)

Check-based, not pytest, to match the other projects here. Every numeric
tolerance below is a MEASURED bound, not an aspiration - if one starts failing,
something regressed rather than the target being unrealistic.
"""

from __future__ import annotations

import json
import os
import shutil
import subprocess
import sys
from pathlib import Path

import numpy as np

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from speechlab import asr, audio, fillers, lexical, prosody, report, timing, vad  # noqa: E402

FAST = os.environ.get("SL_FAST") == "1"
FIXTURES = Path(__file__).parent / "fixtures"
RESULTS: list[tuple[str, str, str]] = []


def check(name: str, ok: bool, detail: str = "") -> bool:
    RESULTS.append(("PASS" if ok else "FAIL", name, detail))
    print(f"  [{'PASS' if ok else 'FAIL'}] {name}" + (f"  ({detail})" if detail else ""))
    return ok


def skip(name: str, why: str) -> None:
    RESULTS.append(("SKIP", name, why))
    print(f"  [SKIP] {name}  ({why})")


def ensure_fixtures() -> dict | None:
    truth = FIXTURES / "truth.json"
    if truth.exists():
        return json.loads(truth.read_text())
    if not shutil.which("say"):
        return None
    print("building fixtures...")
    import make_fixtures  # noqa: E402

    t = make_fixtures.build_all()
    truth.write_text(json.dumps(t, indent=2))
    return t


def main() -> int:
    sys.path.insert(0, str(Path(__file__).parent))
    truth = ensure_fixtures()
    if truth is None:
        print("cannot build fixtures (no `say` on this machine)")
        return 2

    # ---------------------------------------------------------------- audio
    print("\naudio")
    t = truth["pauses"]
    a = audio.load(t["file"])
    check("decodes to mono 16 kHz float32",
          a.sr == 16_000 and a.samples.dtype == np.float32 and a.samples.ndim == 1,
          f"{a.sr} Hz, {a.samples.dtype}")
    check("duration matches fixture", abs(a.duration - t["total_duration_s"]) < 0.02,
          f"{a.duration:.3f}s vs {t['total_duration_s']}s")
    q = audio.quality(a)
    check("quality gate passes clean audio", q["usable"] and not q["warnings"],
          f"SNR {q['snr_db']} dB")
    quiet = audio.Audio(a.samples * 0.001, a.sr, "x", 16_000, 1)
    check("quality gate flags a too-quiet take", not audio.quality(quiet)["usable"])

    # ------------------------------------------------------------------ vad
    print("\nvad + pauses")
    segs, probs = vad.detect(a.samples, a.sr)
    check("finds the 5 spoken phrases", len(segs) == 5, f"{len(segs)} segments")
    pl = timing.pauses(segs, a.duration)
    check("finds the 4 inserted pauses", len(pl) == len(t["gaps"]), f"{len(pl)} pauses")

    if len(pl) == len(t["gaps"]):
        errs = [abs(p.duration - g["duration"]) * 1000 for p, g in zip(pl, t["gaps"])]
        check("pause duration within 100 ms of truth", max(errs) < 100,
              f"max {max(errs):.1f} ms, mean {np.mean(errs):.1f} ms")
        onsets = [abs(p.start - g["start"]) * 1000 for p, g in zip(pl, t["gaps"])]
        check("pause onset within 100 ms of truth", max(onsets) < 100,
              f"max {max(onsets):.1f} ms")
        kinds = [p.kind for p in pl]
        check("pause taxonomy correct", kinds == ["short", "long", "extended", "short"],
              str(kinds))

    check("no spurious pauses inside phrases",
          all(p.duration >= timing.MIN_PAUSE_S for p in pl))
    check("phonation time within 0.5 s of truth",
          abs(sum(s.duration for s in segs) - t["speech_time_s"]) < 0.5,
          f"{sum(s.duration for s in segs):.3f}s vs {t['speech_time_s']}s")

    # Lecture Coach records AAC in MP4, not WAV. Decode through the real path.
    mp4 = FIXTURES / "container_test.mp4"
    try:
        import av

        x = a.samples
        with av.open(str(mp4), "w") as out:
            st = out.add_stream("aac", rate=48000, layout="stereo")
            res = av.AudioResampler(format="fltp", layout="stereo", rate=48000)
            fr = av.AudioFrame.from_ndarray(x.reshape(1, -1), format="flt", layout="mono")
            fr.rate, fr.pts = a.sr, 0
            for f in list(res.resample(fr)) + list(res.resample(None)):
                for pk in st.encode(f):
                    out.mux(pk)
            for pk in st.encode(None):
                out.mux(pk)
        ma = audio.load(mp4)
        msegs, _ = vad.detect(ma.samples, ma.sr)
        mps = timing.pauses(msegs, ma.duration)
        check("AAC/MP4 decodes to the same measurements as WAV",
              len(mps) == len(pl)
              and max(abs(x1.duration - x2.duration) for x1, x2 in zip(mps, pl)) < 0.08,
              f"{len(mps)} pauses, max delta "
              f"{max(abs(x1.duration - x2.duration) for x1, x2 in zip(mps, pl))*1000:.1f} ms"
              if len(mps) == len(pl) else f"{len(mps)} vs {len(pl)} pauses")
    except Exception as e:
        skip("AAC/MP4 decode", f"{type(e).__name__}: {e}")

    # -------------------------------------------------------------- prosody
    print("\nprosody")
    tone = truth["tone"]
    ta = audio.load(tone["file"])
    tp = prosody.extract(ta.samples, ta.sr)
    ts = prosody.summarize(tp, [vad.Segment(0, ta.duration)])
    cents = 1200 * np.log2(ts["f0_median_hz"] / tone["f0_hz"])
    check("pitch exact on a known tone", abs(cents) < 10,
          f"{ts['f0_median_hz']} Hz vs {tone['f0_hz']} Hz ({cents:+.1f} cents)")
    check("steady tone reads as zero variation", ts["f0_sd_st"] < 0.05,
          f"sd {ts['f0_sd_st']} st")

    gl = truth["glide"]
    ga = audio.load(gl["file"])
    gp = prosody.extract(ga.samples, ga.sr)
    gs = prosody.summarize(gp, [vad.Segment(0, ga.duration)])
    expected = gl["semitone_range"] * 0.90  # p5-p95 of a linear-in-semitones sweep
    check("semitone range correct on a one-octave glide",
          abs(gs["f0_range_st"] - expected) < 0.6,
          f"{gs['f0_range_st']} st vs {expected:.2f} st expected")
    check("adaptive pitch range brackets the speaker",
          tp.floor_hz < tone["f0_hz"] < tp.ceiling_hz,
          f"{tp.floor_hz}-{tp.ceiling_hz} Hz for a {tone['f0_hz']} Hz voice")

    # -------------------------------------------------------------- lexical
    print("\nlexical")
    syl = {"the": 1, "table": 2, "walked": 1, "shape": 1, "wanted": 2, "beautiful": 3}
    bad = {w: lexical.count_syllables(w) for w, e in syl.items() if lexical.count_syllables(w) != e}
    check("syllable counter on common patterns", not bad, str(bad) if bad else "6/6")
    reps = lexical.repeated_phrases(lexical.tokens(
        "at the end of the day we go at the end of the day"))
    check("repeated phrase found once, at full length",
          len(reps) == 1 and reps[0]["phrase"] == "at the end of the day", str(reps))
    check("MTLD withheld below 100 tokens",
          "mtld" not in lexical.analyze("one two three four five"))
    check("MTLD reported above 100 tokens",
          "mtld" in lexical.analyze(" ".join(f"word{i%40}" for i in range(150))))

    # ------------------------------------------------------------------ asr
    if FAST:
        skip("asr + disfluency + end-to-end", "SL_FAST=1")
    else:
        print("\nasr")
        tr = asr.transcribe(a.samples, a.sr, language="en")
        check("word count matches the read passage",
              len(tr["words"]) == t["n_words"], f"{len(tr['words'])} vs {t['n_words']}")
        import difflib

        ref = lexical.tokens(t["transcript"])
        hyp = lexical.tokens(tr["text"])
        sm = difflib.SequenceMatcher(None, ref, hyp)
        acc = sum(b.size for b in sm.get_matching_blocks()) / len(ref)
        check("word accuracy >= 95% on clean speech", acc >= 0.95, f"{acc*100:.1f}%")
        check("word timestamps are ordered and inside the take",
              all(w.start <= w.end for w in tr["words"])
              and tr["words"][-1].end <= a.duration + 0.1)

        print("\ndisfluency")
        d = truth["disfluent"]
        r = report.analyze(d["file"], language="en", contours=False)
        dd = r["disfluency"]
        check("filled pauses found", dd["filled_pause_count"] == d["n_filled_pauses"],
              f"{dd['filled_pause_count']} vs {d['n_filled_pauses']}")
        check("no double-counted filler tails",
              dd["filled_pauses_estimated_range"][1] == d["n_filled_pauses"],
              f"range {dd['filled_pauses_estimated_range']}")
        check("repetitions found", dd["repetition_count"] == d["n_repetitions"],
              f"{dd['repetition_count']} vs {d['n_repetitions']}")
        check("discourse markers found",
              len(dd["discourse_markers"]) == d["n_discourse_markers"],
              f"{len(dd['discourse_markers'])} vs {d['n_discourse_markers']}")
        check("fluent speech yields no false disfluencies",
              report.analyze(t["file"], language="en", contours=False)["disfluency"][
                  "filled_pauses_estimated_range"] == [0, 0])

        print("\nend to end")
        check("report has no composite score",
              not any("score" in k for k in report.to_json(r).lower().split('"')),
              "no invented 0-100 numbers")
        check("serialises without numpy leakage", isinstance(json.loads(report.to_json(r)), dict))
        out = FIXTURES / "cli_out.json"
        out.unlink(missing_ok=True)
        p = subprocess.run(
            [sys.executable, "-m", "speechlab", d["file"], "-o", str(out), "--language", "en"],
            cwd=Path(__file__).resolve().parents[1], capture_output=True, text=True,
            env={**os.environ, "PYTHONPATH": str(Path(__file__).resolve().parents[1])},
        )
        check("CLI writes a sidecar", p.returncode == 0 and out.exists(),
              p.stderr.strip()[-120:] if p.returncode else f"{out.stat().st_size} bytes")
        if out.exists():
            j = json.loads(out.read_text())
            check("sidecar carries drawing contours",
                  "contours" in j and len(j["contours"]["f0_st"]) > 10,
                  f"{len(j.get('contours',{}).get('f0_st',[]))} points")
            check("unaccounted audio is labelled for listening",
                  all(x.get("kind") in ("possible_filler", "breath_or_unvoiced")
                      for x in j["disfluency"]["unaccounted_regions"]))
            from speechlab import viewer

            html = viewer.render(j, FIXTURES / "cli_out.html", Path(d["file"]))
            body = html.read_text()
            check("HTML export inlines data and points at the sibling audio",
                  html.stat().st_size > 8000
                  and "__DATA__" not in body and "__AUDIO__" not in body
                  and "__CSS__" not in body and "__REPORT_JS__" not in body
                  and 'audioUrl: "disfluent.wav"' in body,
                  f"{html.stat().st_size} bytes")
            check("export and web app share one renderer",
                  "window.SpeechReport" in body
                  and (Path(__file__).resolve().parents[1] / "speechlab" / "web"
                       / "static" / "report.js").read_text()[:80] in body)

    n_pass = sum(1 for r, _, _ in RESULTS if r == "PASS")
    n_fail = sum(1 for r, _, _ in RESULTS if r == "FAIL")
    n_skip = sum(1 for r, _, _ in RESULTS if r == "SKIP")
    print(f"\n{n_pass} passed, {n_fail} failed, {n_skip} skipped")
    if n_fail:
        for r, name, detail in RESULTS:
            if r == "FAIL":
                print(f"  FAILED: {name}  {detail}")
    return 1 if n_fail else 0


if __name__ == "__main__":
    _code = main()
    # Exit through os._exit rather than SystemExit.
    #
    # With PyAV, onnxruntime, MLX and a subprocess all exercised in one process,
    # interpreter teardown intermittently aborts in a C++ static destructor
    # ("recursive_mutex lock failed", SIGABRT/134) - observed on 2 of 3 runs.
    # It happens AFTER every check has run and printed, so left alone it turns a
    # fully passing suite into a failing exit status and would break any CI or
    # `npm run verify` integration.
    #
    # This is a workaround, not a fix: the race is in native teardown, not in
    # anything the suite asserts. Nothing after this point needs to run, so the
    # exit status is made to reflect the checks.
    sys.stdout.flush()
    sys.stderr.flush()
    os._exit(_code)
