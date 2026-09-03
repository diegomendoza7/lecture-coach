"""speechlab CLI - analyze one take, emit the sidecar JSON.

    python -m speechlab TAKE.mp4 -o TAKE.speech.json
"""

from __future__ import annotations

import argparse
import sys
from pathlib import Path

from . import asr, report


def main(argv: list[str] | None = None) -> int:
    if argv is None:
        argv = sys.argv[1:]
    if argv and argv[0] == "web":
        return _web(argv[1:])

    ap = argparse.ArgumentParser(prog="speechlab", description=__doc__)
    ap.add_argument("audio", help="audio or video file (anything ffmpeg can decode)")
    ap.add_argument("-o", "--out", help="write JSON here (default: <input>.speech.json)")
    ap.add_argument("--model", default=asr.DEFAULT_MODEL, help="MLX Whisper repo")
    ap.add_argument("--language", default=None, help="force a language, e.g. en")
    ap.add_argument("--no-asr", action="store_true", help="acoustics only, no transcript")
    ap.add_argument("--no-contours", action="store_true", help="omit drawing contours")
    ap.add_argument("--stdout", action="store_true", help="print JSON instead of writing")
    ap.add_argument("-q", "--quiet", action="store_true", help="suppress the readable summary")
    ap.add_argument("--no-html", action="store_true", help="skip the clickable HTML report")
    args = ap.parse_args(argv)

    src = Path(args.audio)
    if not src.exists():
        print(f"speechlab: no such file: {src}", file=sys.stderr)
        return 2

    rep = report.analyze(
        src,
        model=args.model,
        language=args.language,
        run_asr=not args.no_asr,
        contours=not args.no_contours,
    )
    text = report.to_json(rep)

    if args.stdout:
        print(text)
    else:
        dest = Path(args.out) if args.out else src.with_suffix(".speech.json")
        dest.write_text(text)
        if not args.no_html:
            from . import viewer

            html = viewer.render(rep, dest.with_suffix(".html"), src)
            rep["_html"] = str(html)
        if not args.quiet:
            print(report.to_text(rep))
            print()
        print(f"wrote {dest}")
        if "_html" in rep:
            print(f"wrote {rep['_html']}   <- open this")
    return 0


def _web(argv: list[str]) -> int:
    ap = argparse.ArgumentParser(prog="speechlab web", description="local web app")
    ap.add_argument("--port", type=int, default=8765)
    ap.add_argument("--host", default="127.0.0.1")
    ap.add_argument("--takes-dir", default=None, help="default: ~/Movies/Lecture Coach")
    ap.add_argument("--language", default="en")
    ap.add_argument("--model", default=asr.DEFAULT_MODEL)
    ap.add_argument("--no-open", action="store_true")
    a = ap.parse_args(argv)

    from .web import server

    if not a.no_open:
        import threading
        import webbrowser

        threading.Timer(0.7, lambda: webbrowser.open(f"http://{a.host}:{a.port}")).start()
    server.serve(a.host, a.port, a.takes_dir, a.language, a.model)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
