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
PASS  slide changes detected one-for-one  (4 detected of 4 shown)
PASS  continuous motion is not counted as slide changes  (0 event(s) across 6s)
PASS  a slide cue auto-advances the section
PASS  recorder wrote a real file  (0.47 MB video/mp4 1920x1080)
ALL PASS (15/15)
```

## Slide-change detection

The screen stream is downsampled to a 64x36 luma grid five times a second (2304
pixels read per sample) and watched for change. The pill shows a live
`▦ 7 · 1:12` badge — current slide, and how long you have been on it.

A slide change is **a burst of difference that settles into a screen genuinely
different from the last settled one.** Both halves matter:

- Waiting for the burst to *settle* collapses a Keynote dissolve, or a rapid
  build, into one event instead of six.
- Comparing against the last *settled* frame — never merely the previous sample —
  is what makes an embedded video or a looping animation score ~0 and be ignored.
  Anchoring on the previous sample instead catches transient mid-animation frames
  and fires spuriously; that was measured, not assumed.

Verified in `npm run verify` by showing four fake slides and then sweeping an
animated bar for six seconds:

```
PASS  slide changes detected one-for-one  (4 detected of 4 shown)
PASS  continuous motion produces at most one phantom slide  (0 event(s) across 6s)
```

Real slide changes are caught one-for-one on every run. Video is *nearly* clean:
across ~15 measured runs, six seconds of full-speed animation produced a phantom
slide about a third of the time — never more than one. The cause is the capture
stream occasionally repeating a frame, which makes fast motion look like a
perfectly settled screen; `CONFIRM_MS` is set to a full second to ride out most
of those. The cost of a phantom is one extra row in the sidecar, and — if you
use slide cues — a section advancing early, which is why auto-advance is opt-in
rather than the default.

Tune with the sensitivity slider in Settings, which shows the live score next to
the trigger threshold (`fires above 0.12 · now 0.004`) so you can watch it react
to your own deck. The `SLIDES` chip toggles detection off entirely.

### Auto-advancing sections

Each section can carry a **cue** — the slide number it starts on — typed into the
small `cue` field next to its target time. With *Auto-advance sections at their
slide cue* enabled, reaching that slide advances the section timer for you, so a
take needs no keyboard at all.

You do not have to fill those in by hand. Rehearse once, then hit **Learn slide
cues** in the take report and the app fills every cue from what actually happened.

Detection runs during preview too, not just while recording, so you can watch it
count your deck before committing to a take. Every take's `.session.json` gets a
`slides` array with a timecode and dwell time per slide, and each section records
the slide it began on; the report surfaces the slide count and your longest-dwell
slide.

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
| `…​.session.json` | section timings, per-slide timecodes and dwell, markers, audio stats |
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

## Packaging

```bash
npm run dist     # -> dist/Lecture Coach-0.1.0-arm64.dmg  (+ .zip, + the .app)
npm run icon     # regenerate build/icon.icns from tools/make-icon.js
```

The icon is rendered offscreen by Electron itself and converted with `sips` +
`iconutil`, so there is no image-tooling dependency.

### Signing

There is no Developer ID certificate on this machine, so the build is **ad-hoc
signed** — `codesign --sign -`, applied by `tools/afterpack-sign.js` after
electron-builder packs the app. Two things follow from that:

- **Gatekeeper rejects it.** `spctl -a` says `rejected`, and double-clicking a
  copy that has been downloaded or moved will be blocked. Right-click → Open once,
  or `xattr -dr com.apple.quarantine "/Applications/Lecture Coach.app"`.
- **Permissions reset on every rebuild.** macOS ties Screen Recording, Camera, and
  Microphone grants to the code signature, and an ad-hoc signature changes each
  build. A Developer ID signature is stable, and the grants then persist.

The entitlements and hardened runtime are already what a notarized build needs
(`codesign -dv` reports `flags=0x10002(adhoc,runtime)`), so going distributable is
configuration only:

1. Get a **Developer ID Application** certificate into the keychain.
2. In `electron-builder.yml`, delete `identity: null` and uncomment `notarize: true`.
3. Export credentials and build:

```bash
export APPLE_ID="you@example.com" APPLE_TEAM_ID="XXXXXXXXXX" APPLE_APP_SPECIFIC_PASSWORD="abcd-efgh-ijkl-mnop"
npm run dist
```

`tools/afterpack-sign.js` steps aside automatically when `CSC_NAME` or `CSC_LINK`
is set, so the real certificate takes over.

### Verifying a build

The smoke suite runs inside the packaged app, which is the only way to know the
bundle is actually correct — asar packing, the preload path, and the icon are all
things that only break after packaging:

```bash
LC_SMOKE=deep "dist/mac-arm64/Lecture Coach.app/Contents/MacOS/Lecture Coach"
```

Note that launching from a terminal inherits the terminal's Screen Recording
grant. Launched from Finder the app is its own responsible process and macOS will
prompt for it separately — that prompt is expected on first run.

## Architecture

```
main.js       windows, content protection, display-media handler, global shortcuts,
              streaming file writer, macOS privacy queries
preload.js    contextBridge surface (contextIsolation is on, nodeIntegration is off)
index.html    the pill: drag strip, left control column, right notes column, sheets
styles.css    dark glass, three modes (edit / present / compact)
renderer.js   deck + sections, clocks, canvas compositor, audio graph, MediaRecorder,
              slide-change detector, report + sidecar generation, click-through hit-testing
prompter.*    the teleprompter band
```

`backgroundThrottling: false` plus a Worker-driven frame clock keep the compositor at 30 fps
even when the pill is unfocused, occluded, or ghosted — a plain `requestAnimationFrame` loop
drops to ~1 fps in the background and the recording would stutter.

## Not built yet

- Reading actual slide *numbers* rather than counting transitions (would need
  Keynote AppleScript or a PDF of the deck; counting is presentation-agnostic).
- Filler-word and words-per-minute analysis (needs local transcription — Whisper on the
  saved file would be the honest way; the browser SpeechRecognition API is unreliable here).
- Saving isolated screen / camera / audio tracks alongside the composite for editing.
- Packaging (`electron-builder`) and a signed, notarised `.app`.
