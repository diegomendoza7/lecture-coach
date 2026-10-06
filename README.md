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

## The camera bubble

A **rectangle** with a **hairline frame**, bottom-right, mirrored, at 24% of frame
width. Settings → Camera bubble changes shape (rectangle / circle), corner,
size, mirror, and frame (hairline / none).

The frame is a 1px, 24%-white stroke — it separates the bubble from a dark slide
without reading as a sticker, and a drop shadow does most of the separating work.
`npm run verify` measures it by compositing a solid-green stand-in camera and
reading the red channel down the bubble's top edge:

```
PASS  bubble frame is present but a hairline, not a ring
      (3 frame rows; red channel down the edge = [64,61,31,0,0,0,…])
```

A ring would read `[217,217,217,217,…]`. The same probe checks the corners are
filled, which is what distinguishes a rectangle from a circle in pixels rather
than in config. Existing configs are migrated to the rectangle once (`cfg._v`).

## Using an iPhone as the camera

Settings → Camera → **use iPhone**. An iPhone running as a Continuity Camera is
an ordinary `videoinput` device, so the camera dropdown lists it with a 📱 marker
and the hint line under it says whether one is visible right now.

What it needs: iOS 17+, the same Apple ID, Wi-Fi and Bluetooth on, Continuity
Camera enabled in iPhone Settings → General → AirPlay & Continuity, and the phone
nearby and stationary. If none is found, the app says exactly that list rather
than failing silently.

The interesting part is that an iPhone camera **comes and goes** — it drops when
the phone is picked up, locked, or carried away. So the chosen camera is treated
as a *preference*, never a requirement:

- Acquisition falls back **exact → preferred → any**, so a missing iPhone does
  not break the take; you get another camera instead.
- A dropped track re-acquires automatically and tells you what happened.
- `devicechange` is watched, so when the phone comes back the stream **switches
  back to it on its own**.
- Camera and microphone changes now take effect immediately instead of at the
  next preview restart (microphone changes are refused mid-take, since the audio
  track is already muxed into the recording).
- If you pick the iPhone camera and its microphone is also available, a toast
  offers to switch to that too — it is usually the better microphone.

`NSCameraUseContinuityCameraDeviceType` is set in the bundle. Recent Electron
links a new enough SDK to discover Continuity Camera without it; it is harmless
belt-and-braces.

**Not verified on real hardware.** No iPhone was visible to this Mac while this
was built, so the selection logic is tested with a stubbed device list (it must
recognise "iPhone"/"iPad" labels, ignore "FaceTime HD Camera" and "OBS Virtual
Camera", and pick the phone) — but the live connect/drop/reconnect path has not
been exercised against an actual phone.

## Importing a talk

Drop a file on the pill, or **Settings → Import a talk…** (⌘O). No typing, no
sorting. Nothing is installed to make this work — macOS already ships every
parser needed:

| Format | Read with | Becomes |
| --- | --- | --- |
| `.pptx` | `unzip` → `ppt/slides/slideN.xml` + `notesSlides/` | one section per slide, **speaker notes** as the notes (slide bullets if a slide has none), slide cues set |
| `.pdf` | `osascript -l JavaScript` → Quartz `PDFDocument` | slide-per-page with cues, or a chunked document — see below |
| `.docx` | `unzip` → `word/document.xml` (keeps `w:pStyle`) | one section per heading |
| `.doc` `.rtf` `.odt` `.html` | `textutil -convert txt` | sections by heading-ish lines, else by length |
| `.md` `.txt` | read directly | `##` headings become sections, bullets and `**bold**` survive |
| `.json` | — | a deck previously exported from this app |

Every section also gets a **target duration** computed from its own word count at
your words-per-minute, so the pacing bar is meaningful the moment the import
finishes. One level of undo is kept: the toast has an `undo` link.

Three details that make the results usable rather than merely present:

- **Slide cues come free from slide-based sources.** Section N starts on slide N,
  which is exactly what the slide-change detector auto-advances on — so importing
  a `.pptx` and enabling auto-advance gives a take that needs no keyboard.
- **Headings split at one level, not all of them.** A structured document has
  `Heading1` through `Heading4`; splitting at every level turned a real 68-heading
  business plan into 69 four-line sections. The importer picks the coarsest level
  that still yields at least three sections (that plan becomes 13) and keeps the
  deeper headings inline as bold cues, so nothing is lost.
- **A PDF is read as slides or as prose, not both.** Under ~900 characters per
  page it is treated as a deck (section per page, cues set); above that as a
  document (reflowed and chunked into ~170-word sections, no cues, because there
  page ≠ slide).

### The PDF reflow

PDFKit returns *text runs*, not lines, so a phrase can arrive as
`"O" / "ur approach" / "Stru" / "ctural screen"`. The next fragment's first
character disambiguates: lowercase means the break is inside a word or a wrapped
sentence, uppercase means a real new line. Whether to restore a space depends on
how much text preceded the break — a few characters is a split glyph run, a full
line is a wrapped sentence. That reconstructs both `Our approach` and
`…persisted across replicates…` correctly from the same rule.

Known limits: a **scanned** PDF has no text layer and is rejected with a message
saying so rather than importing an empty deck. **Keynote** `.key` files are a
proprietary protobuf format — export to PowerPoint or PDF first, which the error
message tells you.

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

The deep suite needs the **display awake and the screen unlocked** — it works by
reading pixels back out of a live capture, and a locked screen renders no windows
into that stream. It detects this and prints `SKIP` for the affected checks
instead of four misleading failures.

Note that launching from a terminal inherits the terminal's Screen Recording
grant. Launched from Finder the app is its own responsible process and macOS will
prompt for it separately — that prompt is expected on first run.

## Architecture

```
main.js       windows, content protection, display-media handler, global shortcuts,
              streaming file writer, macOS privacy queries
preload.js    contextBridge surface (contextIsolation is on, nodeIntegration is off)
importer.js   pptx / pdf / docx / doc / md import. Deliberately Electron-free, so
              it unit-tests under plain node: tools/test-import.js <file> [--quiet]
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

## About this history

Built locally between August and September 2026. Uploaded to GitHub on October 6, 2026. Commit dates reflect when the work was done on my machine. History is reconstructed from file timestamps and session logs, so early intermediate versions may be missing.
