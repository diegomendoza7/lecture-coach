# Lecture Coach

A floating presenter dashboard, teleprompter overlay, and screen + webcam recorder
for rehearsing research talks and filming lecture-style videos on macOS.

```bash
npm install
npm start
```

## What it does

**Presenter Dashboard** — a translucent pill that floats above Keynote, Google Slides,
or anything else, with a dual timer (total vs. current section), a pacing bar, transport
controls, a live mic meter, and a scrollable rich-text notes pane on the right.

**Teleprompter** — a separate always-on-top band placed near the camera eyeline, with
auto-scroll, adjustable speed/size/opacity, and mirror mode for beam-splitter rigs.

**Recorder** — composites the chosen display and the webcam into one canvas and records
that canvas plus your mic (optionally plus system audio) to H.264 MP4.

### Why the notes never appear in the recording

Two independent reasons:

1. Both overlay windows call `win.setContentProtection(true)` (`main.js`), which sets
   `NSWindowSharingNone` on macOS. The display-capture stream physically cannot see them.
2. The recorded frame is a canvas that only ever has two things drawn on it — the screen
   video and the camera video (`drawFrame()` in `renderer.js`). No DOM is involved.

`npm run verify` proves #1 on your own machine: it puts a magenta window on screen,
samples those pixels out of the live capture stream, turns protection on, and samples
again. It also checks the dashboard's own pixels and records a real 2.5s file.

```
PASS  capture stream is live and correctly mapped  (probe window reads rgb(255,0,254)…)
PASS  setContentProtection removes a window from the capture  (… -> rgb(43,43,43))
PASS  dashboard pill is not in the frame
PASS  recorder wrote a real file  (0.47 MB video/mp4 1920x1080)
```

## Edit mode vs. Present mode  (⌘⇧E)

| | Edit | Present |
| --- | --- | --- |
| Mouse | fully interactive | click-through except over controls |
| Keyboard focus | takes focus (you type notes) | `setFocusable(false)` — arrow keys stay with your slides |
| Notes | editable | read-only |

Present mode combines `setIgnoreMouseEvents(true, {forward: true})` with hit-testing on
forwarded `mousemove`: anything marked `[data-hit]` stays clickable, the rest of the pill
passes clicks through to the app underneath.

## Shortcuts (global — they work while Keynote is frontmost)

| Key | Action |
| --- | --- |
| ⌘⇧R | start / stop recording |
| ⌘⇧P | pause / resume |
| ⌘⇧M | drop a marker at this moment |
| ⌘⌃← / → | previous / next section |
| ⌘⌃↑ / ↓ | teleprompter speed |
| ⌘⇧T | show / hide teleprompter |
| ⌘⇧S | teleprompter scroll play / pause |
| ⌘⇧L | teleprompter click-through lock |
| ⌘⇧E | edit / present mode |
| ⌘⇧H | ghost the pill (opacity 0, still recording) |

Shortcuts are dispatched with `executeJavaScript(code, userGesture = true)` rather than a
plain IPC message, because Chromium refuses `getDisplayMedia()` without transient user
activation — a plain IPC send would make ⌘⇧R fail to start a take.

## Output

Everything lands in `~/Movies/Lecture Coach/`:

| File | Contents |
| --- | --- |
| `talk_take1_<date>.mp4` | the video (H.264/AAC; falls back to WebM VP9 if MP4 is unavailable) |
| `…​.session.json` | section timings, markers with timecodes, audio stats |
| `…​.report.md` | human-readable pacing table |
| `…​.chapters.txt` | YouTube chapter list, ready to paste into a description |

Chunks stream to disk as they arrive (`rec:open` / `rec:write` / `rec:close`). A 45-minute
1080p take is ~2.7 GB, which is not something to hold in a renderer Blob.

## macOS permissions

- **Screen Recording** must be granted manually, and macOS requires an app restart after
  granting. Settings → Privacy & Security → Screen & System Audio Recording.
- **Camera / Microphone** prompt on first use; the Settings sheet shows live status with a
  `fix` link for each.
- **System audio** uses Electron's `audio: 'loopback'`, which needs a recent macOS. If the
  request fails the app silently retries video-only and tells you it's mic-only.

## Environment flags

| Flag | Effect |
| --- | --- |
| `LC_SMOKE=1` | structural self-test, prints PASS/FAIL and exits |
| `LC_SMOKE=deep` | the above plus the pixel + recording proof (`npm run verify`) |
| `LC_KEEP=1` | keep the `_verify` file instead of deleting it |
| `LC_NOPROTECT=1` | skip `setContentProtection` (needed to screenshot the UI itself) |
| `LC_PANEL=1` | create the overlays as macOS `NSPanel`s — try it if a full-screen app still covers them |

## Architecture

```
main.js       windows, content protection, display-media handler, global shortcuts,
              streaming file writer, macOS privacy queries
preload.js    contextBridge surface (contextIsolation is on, nodeIntegration is off)
index.html    the pill: drag strip, left control column, right notes column, sheets
styles.css    dark glass, three modes (edit / present / compact)
renderer.js   deck + sections, clocks, canvas compositor, audio graph, MediaRecorder,
              report + sidecar generation, click-through hit-testing
prompter.*    the teleprompter band
```

`backgroundThrottling: false` plus a Worker-driven frame clock keep the compositor at 30 fps
even when the pill is unfocused, occluded, or ghosted — a plain `requestAnimationFrame` loop
drops to ~1 fps in the background and the recording would stutter.

## Not built yet

- Filler-word and words-per-minute analysis (needs local transcription — Whisper on the
  saved file would be the honest way; the browser SpeechRecognition API is unreliable here).
- Saving isolated screen / camera / audio tracks alongside the composite for editing.
- Packaging (`electron-builder`) and a signed, notarised `.app`.
