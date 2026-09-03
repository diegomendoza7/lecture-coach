"""Standalone HTML export of one take.

Deliberately thin: it inlines the same `web/static/style.css` and
`web/static/report.js` the local web app serves, so the two views cannot drift.
The only difference is the host - the app mounts the renderer against a served
`/api/audio/...` URL, this writes a file that points at the audio sitting next
to it on disk.
"""

from __future__ import annotations

import json
import os
from pathlib import Path

STATIC = Path(__file__).parent / "web" / "static"

TEMPLATE = """<!DOCTYPE html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>__TITLE__</title>
<style>
__CSS__
body{margin:0}
.wrap{max-width:1180px;margin:0 auto;padding:26px 22px 70px}
</style></head><body><div class="wrap"><div id="root"></div></div>
<script>
__REPORT_JS__
</script>
<script>
SpeechReport.render(document.getElementById('root'), __DATA__, {audioUrl: "__AUDIO__"});
</script>
</body></html>
"""


def render(report: dict, out_path: str | Path, audio_path: str | Path | None = None) -> Path:
    out_path = Path(out_path)
    audio = Path(audio_path or report["source"]["path"])
    try:
        rel = os.path.relpath(audio, out_path.parent)
    except ValueError:
        rel = str(audio)

    data = dict(report)
    data["source"] = dict(report["source"], name=audio.name)
    blob = json.dumps(data).replace("</", "<\\/")

    html = (
        TEMPLATE.replace("__CSS__", (STATIC / "style.css").read_text())
        .replace("__REPORT_JS__", (STATIC / "report.js").read_text())
        .replace("__TITLE__", audio.name)
        .replace("__AUDIO__", rel.replace("\\", "/"))
        .replace("__DATA__", blob)
    )
    out_path.write_text(html)
    return out_path
