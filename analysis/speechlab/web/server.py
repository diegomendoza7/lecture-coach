"""Local web app for speechlab - record, analyse and read results in a browser.

Standard library only, matching how Lecture Coach itself was built (no runtime
npm dependencies). Binds to 127.0.0.1 so nothing is exposed off the machine.

Analysis runs in-process on a worker thread rather than by shelling out to the
CLI, so the Whisper weights stay resident between takes: the first analysis of a
session pays the model load, every one after it is several seconds.
"""

from __future__ import annotations

import json
import mimetypes
import re
import threading
import traceback
import uuid
from datetime import datetime
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import unquote, urlparse

from .. import asr, report

STATIC = Path(__file__).parent / "static"
MEDIA_SUFFIXES = {".wav", ".mp4", ".m4a", ".mov", ".webm", ".mp3", ".aiff", ".aif", ".flac", ".ogg", ".caf"}
SAFE_NAME = re.compile(r"^[A-Za-z0-9 ._-]{1,120}$")

JOBS: dict[str, dict] = {}
JOBS_LOCK = threading.Lock()
ANALYSIS_LOCK = threading.Lock()  # one analysis at a time; it is CPU bound


class State:
    takes_dir = Path.home() / "Movies" / "Lecture Coach"
    language: str | None = "en"
    model = asr.DEFAULT_MODEL


def sidecar(p: Path) -> Path:
    return p.with_suffix(".speech.json")


def list_takes() -> list[dict]:
    State.takes_dir.mkdir(parents=True, exist_ok=True)
    out = []
    for f in sorted(State.takes_dir.iterdir(), key=lambda x: x.stat().st_mtime if x.exists() else 0, reverse=True):
        if not f.is_file() or f.suffix.lower() not in MEDIA_SUFFIXES:
            continue
        sc = sidecar(f)
        row = {
            "id": f.name,
            "name": f.stem,
            "size": f.stat().st_size,
            "modified": datetime.fromtimestamp(f.stat().st_mtime).isoformat(timespec="seconds"),
            "analyzed": sc.exists(),
        }
        if sc.exists():
            try:
                d = json.loads(sc.read_text())
                row |= {
                    "duration_s": d["source"]["duration_s"],
                    "wpm": d.get("rate", {}).get("words_per_minute"),
                    "pause_ratio": d["timing"]["pause_ratio"],
                    "f0_sd_st": d.get("prosody", {}).get("f0_sd_st"),
                    "filled": d.get("disfluency", {}).get("filled_pauses_estimated_range"),
                    "snr_db": d["quality"]["snr_db"],
                    "usable": d["quality"]["usable"],
                }
            except Exception:
                row["analyzed"] = False
        out.append(row)
    return out


def resolve(take_id: str) -> Path | None:
    """Resolve an id to a file inside the takes dir. Never trusts the string."""
    name = unquote(take_id)
    if "/" in name or "\\" in name or name.startswith("."):
        return None
    p = (State.takes_dir / name).resolve()
    try:
        p.relative_to(State.takes_dir.resolve())
    except ValueError:
        return None
    return p if p.is_file() else None


def start_job(path: Path) -> str:
    jid = uuid.uuid4().hex[:12]
    with JOBS_LOCK:
        JOBS[jid] = {"state": "queued", "stage": "waiting", "progress": 0.0, "take": path.name}

    def run():
        def prog(stage: str, frac: float):
            with JOBS_LOCK:
                JOBS[jid] |= {"state": "running", "stage": stage, "progress": frac}

        try:
            with ANALYSIS_LOCK:
                rep = report.analyze(
                    path, model=State.model, language=State.language, on_progress=prog
                )
            sidecar(path).write_text(report.to_json(rep))
            with JOBS_LOCK:
                JOBS[jid] |= {"state": "done", "stage": "done", "progress": 1.0}
        except Exception as e:
            traceback.print_exc()
            with JOBS_LOCK:
                JOBS[jid] |= {"state": "error", "stage": "failed", "error": f"{type(e).__name__}: {e}"}

    threading.Thread(target=run, daemon=True).start()
    return jid


class Handler(BaseHTTPRequestHandler):
    server_version = "speechlab"

    def log_message(self, fmt, *args):
        pass  # the UI is the log

    # ----------------------------------------------------------- responses
    def _send(self, code: int, body: bytes, ctype: str, extra: dict | None = None):
        self.send_response(code)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        for k, v in (extra or {}).items():
            self.send_header(k, v)
        self.end_headers()
        if self.command != "HEAD":
            self.wfile.write(body)

    def _json(self, obj, code: int = 200):
        self._send(code, json.dumps(obj).encode(), "application/json")

    def _file(self, p: Path):
        """Serve with byte-range support - browsers need it to seek audio."""
        ctype = mimetypes.guess_type(p.name)[0] or "application/octet-stream"
        size = p.stat().st_size
        rng = self.headers.get("Range")
        if rng and rng.startswith("bytes="):
            s, _, e = rng[6:].partition("-")
            start = int(s) if s else 0
            end = int(e) if e else size - 1
            end = min(end, size - 1)
            if start > end:
                self._send(416, b"", "text/plain", {"Content-Range": f"bytes */{size}"})
                return
            with p.open("rb") as fh:
                fh.seek(start)
                chunk = fh.read(end - start + 1)
            self.send_response(206)
            self.send_header("Content-Type", ctype)
            self.send_header("Content-Length", str(len(chunk)))
            self.send_header("Content-Range", f"bytes {start}-{end}/{size}")
            self.send_header("Accept-Ranges", "bytes")
            self.end_headers()
            self.wfile.write(chunk)
            return
        self._send(200, p.read_bytes(), ctype, {"Accept-Ranges": "bytes"})

    # ---------------------------------------------------------------- GET
    def do_GET(self):
        path = urlparse(self.path).path
        try:
            if path in ("/", "/index.html"):
                return self._send(200, (STATIC / "app.html").read_bytes(), "text/html; charset=utf-8")
            if path.startswith("/static/"):
                f = (STATIC / path[len("/static/"):]).resolve()
                if not str(f).startswith(str(STATIC.resolve())) or not f.is_file():
                    return self._json({"error": "not found"}, 404)
                ctype = mimetypes.guess_type(f.name)[0] or "text/plain"
                return self._send(200, f.read_bytes(), f"{ctype}; charset=utf-8")
            if path == "/api/takes":
                return self._json({"takes": list_takes(), "dir": str(State.takes_dir)})
            if path.startswith("/api/jobs/"):
                with JOBS_LOCK:
                    j = JOBS.get(path.rsplit("/", 1)[-1])
                return self._json(j or {"error": "no such job"}, 200 if j else 404)
            if path.startswith("/api/report/"):
                p = resolve(path[len("/api/report/"):])
                if not p or not sidecar(p).exists():
                    return self._json({"error": "not analysed"}, 404)
                return self._send(200, sidecar(p).read_bytes(), "application/json")
            if path.startswith("/api/audio/"):
                p = resolve(path[len("/api/audio/"):])
                if not p:
                    return self._json({"error": "not found"}, 404)
                return self._file(p)
            return self._json({"error": "not found"}, 404)
        except Exception as e:
            traceback.print_exc()
            return self._json({"error": f"{type(e).__name__}: {e}"}, 500)

    # --------------------------------------------------------------- POST
    def do_POST(self):
        path = urlparse(self.path).path
        try:
            if path == "/api/takes":
                name = unquote(self.headers.get("X-Filename", "")).strip()
                if not SAFE_NAME.match(name) or Path(name).suffix.lower() not in MEDIA_SUFFIXES:
                    return self._json({"error": f"bad filename: {name!r}"}, 400)
                n = int(self.headers.get("Content-Length", 0))
                if n <= 0:
                    return self._json({"error": "empty upload"}, 400)
                State.takes_dir.mkdir(parents=True, exist_ok=True)
                dest = State.takes_dir / name
                stem, suf, i = dest.stem, dest.suffix, 2
                while dest.exists():
                    dest = State.takes_dir / f"{stem}-{i}{suf}"
                    i += 1
                read = 0
                with dest.open("wb") as fh:
                    while read < n:
                        chunk = self.rfile.read(min(1 << 20, n - read))
                        if not chunk:
                            break
                        fh.write(chunk)
                        read += len(chunk)
                return self._json({"id": dest.name, "bytes": read})
            if path.startswith("/api/analyze/"):
                p = resolve(path[len("/api/analyze/"):])
                if not p:
                    return self._json({"error": "not found"}, 404)
                return self._json({"job": start_job(p)})
            return self._json({"error": "not found"}, 404)
        except Exception as e:
            traceback.print_exc()
            return self._json({"error": f"{type(e).__name__}: {e}"}, 500)


def serve(host="127.0.0.1", port=8765, takes_dir: Path | None = None,
          language: str | None = "en", model: str = asr.DEFAULT_MODEL) -> None:
    if takes_dir:
        State.takes_dir = Path(takes_dir).expanduser()
    State.language, State.model = language, model
    State.takes_dir.mkdir(parents=True, exist_ok=True)
    httpd = ThreadingHTTPServer((host, port), Handler)
    print(f"speechlab web  ->  http://{host}:{port}")
    print(f"takes: {State.takes_dir}")
    try:
        httpd.serve_forever()
    except KeyboardInterrupt:
        print("\nstopped")
