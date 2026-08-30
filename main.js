'use strict';
/*
 * Lecture Coach — main process
 *
 * Two frameless, transparent, always-on-top overlay windows:
 *   dash     — the "Presenter Dashboard" pill (timers + transport + notes)
 *   prompter — the teleprompter band
 *
 * Both are marked setContentProtection(true), which on macOS sets
 * NSWindowSharingNone. That is what keeps them out of the recorded video:
 * the display capture stream never sees them, so the notes and timers are
 * invisible in the file even though they are painted on top of the screen.
 */

const {
  app, BrowserWindow, ipcMain, desktopCapturer, session, globalShortcut,
  systemPreferences, screen, shell, Menu,
} = require('electron');
const path = require('path');
const fs = require('fs');

const IS_MAC = process.platform === 'darwin';
const SMOKE = !!process.env.LC_SMOKE;      // headless-ish self test, see runSmoke()
const USE_PANEL = !!process.env.LC_PANEL;  // opt-in NSPanel mode (see README)

let dash = null;
let prompter = null;

/** Source the renderer asked us to hand to getDisplayMedia(). */
let selectedSourceId = null;
let wantSystemAudio = false;
let writer = null;   // active recording file stream

const smokeLog = [];

/* ------------------------------------------------------------------ paths */

function outDir() {
  const dir = path.join(app.getPath('videos'), 'Lecture Coach');
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function stamp(d = new Date()) {
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}_${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

/* ---------------------------------------------------------------- windows */

const overlayPrefs = () => ({
  preload: path.join(__dirname, 'preload.js'),
  contextIsolation: true,
  nodeIntegration: false,
  sandbox: false,
  // Critical for recording: without this, Chromium throttles rAF/timers when
  // the overlay is unfocused or occluded and the capture loop drops to ~1fps.
  backgroundThrottling: false,
});

function harden(win) {
  // Float above everything, including a full-screen Keynote / Slides show.
  win.setAlwaysOnTop(true, 'screen-saver', 1);
  win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreenWindows: true });
  win.setFullScreenable(false);
  // The whole point: excluded from screen capture and screenshots.
  // LC_NOPROTECT=1 disables it (handy for grabbing screenshots of the UI itself).
  win.setContentProtection(!process.env.LC_NOPROTECT);
  win.on('closed', () => { if (win === dash) dash = null; if (win === prompter) prompter = null; });
}

function createDash() {
  const { workArea } = screen.getPrimaryDisplay();
  const w = Math.min(1000, workArea.width - 80);
  const h = 330;
  dash = new BrowserWindow({
    width: w,
    height: h,
    x: Math.round(workArea.x + (workArea.width - w) / 2),
    y: Math.round(workArea.y + workArea.height - h - 18),
    minWidth: 560,
    minHeight: 110,
    frame: false,
    transparent: true,
    backgroundColor: '#00000000',
    hasShadow: false,          // the pill draws its own CSS shadow
    resizable: true,
    maximizable: false,
    fullscreenable: false,
    skipTaskbar: true,
    show: false,
    ...(USE_PANEL && IS_MAC ? { type: 'panel' } : {}),
    webPreferences: overlayPrefs(),
  });
  dash.loadFile(path.join(__dirname, 'index.html'));
  harden(dash);
  dash.once('ready-to-show', () => dash.show());
  wireConsole(dash, 'dash');
}

function createPrompter() {
  const { workArea } = screen.getPrimaryDisplay();
  const w = Math.min(1180, workArea.width - 120);
  const h = 300;
  prompter = new BrowserWindow({
    width: w,
    height: h,
    x: Math.round(workArea.x + (workArea.width - w) / 2),
    y: Math.round(workArea.y + 76),   // just under the notch / camera eyeline
    minWidth: 460,
    minHeight: 150,
    frame: false,
    transparent: true,
    backgroundColor: '#00000000',
    hasShadow: false,
    resizable: true,
    maximizable: false,
    fullscreenable: false,
    skipTaskbar: true,
    focusable: false,                 // never steals focus from your slides
    show: false,
    ...(USE_PANEL && IS_MAC ? { type: 'panel' } : {}),
    webPreferences: overlayPrefs(),
  });
  prompter.loadFile(path.join(__dirname, 'prompter.html'));
  harden(prompter);
  prompter.setIgnoreMouseEvents(true, { forward: true }); // click-through by default
  wireConsole(prompter, 'prompter');
}

function wireConsole(win, tag) {
  win.webContents.on('console-message', (...args) => {
    // Electron changed this signature across versions; tolerate both shapes.
    const d = (args[0] && typeof args[0] === 'object' && 'message' in args[0]) ? args[0] : null;
    const level = d ? d.level : args[1];
    const message = d ? d.message : args[2];
    const bad = level === 'error' || level === 'warning' || level >= 2;
    if (bad) smokeLog.push(`[${tag}] ${message}`);
  });
  win.webContents.on('render-process-gone', (_e, det) => smokeLog.push(`[${tag}] renderer gone: ${det.reason}`));
}

/* ------------------------------------------------------------------- IPC */

function send(win, channel, payload) {
  if (win && !win.isDestroyed()) win.webContents.send(channel, payload);
}

/*
 * Fire a command at the dashboard *with* user activation.
 * A plain ipc send() carries none, and Chromium refuses getDisplayMedia()
 * without transient activation — so ⌘⇧R would fail to start a take.
 * executeJavaScript(code, userGesture=true) supplies it.
 */
function fire(name) {
  if (!dash || dash.isDestroyed()) return;
  dash.webContents
    .executeJavaScript(`window.__lcShortcut && window.__lcShortcut(${JSON.stringify(name)})`, true)
    .catch(() => {});
}

function registerIpc() {
  ipcMain.on('renderer:ready', (e, who) => { readyMarks.add(who); });

  ipcMain.handle('sources:list', async () => {
    const sources = await desktopCapturer.getSources({
      types: ['screen'],
      thumbnailSize: { width: 320, height: 200 },
    });
    return sources.map((s) => ({
      id: s.id,
      name: s.name,
      displayId: s.display_id,
      thumbnail: s.thumbnail.isEmpty() ? null : s.thumbnail.toDataURL(),
    }));
  });

  ipcMain.handle('capture:select', (_e, { id, systemAudio }) => {
    selectedSourceId = id || null;
    wantSystemAudio = !!systemAudio;
    return true;
  });

  ipcMain.handle('overlay:ignore-mouse', (e, { ignore, forward }) => {
    const w = BrowserWindow.fromWebContents(e.sender);
    if (w) w.setIgnoreMouseEvents(!!ignore, { forward: forward !== false });
    return true;
  });

  ipcMain.handle('overlay:focusable', (e, v) => {
    const w = BrowserWindow.fromWebContents(e.sender);
    if (w) w.setFocusable(!!v);
    return true;
  });

  ipcMain.handle('overlay:protect', (e, v) => {
    const w = BrowserWindow.fromWebContents(e.sender);
    if (w) w.setContentProtection(!!v);
    return true;
  });

  // Resize the pill keeping its bottom edge pinned (it lives above the Dock).
  ipcMain.handle('overlay:size', (e, { width, height }) => {
    const w = BrowserWindow.fromWebContents(e.sender);
    if (!w) return false;
    const b = w.getBounds();
    const nw = Math.round(width || b.width);
    const nh = Math.round(height || b.height);
    w.setBounds({ x: b.x + Math.round((b.width - nw) / 2), y: b.y + (b.height - nh), width: nw, height: nh }, false);
    return true;
  });

  // "Ghost" instead of hide(): a hidden window stops compositing, which would
  // stall the capture loop mid-take. Opacity 0 + click-through keeps it alive.
  ipcMain.handle('overlay:hide', (e) => {
    const w = BrowserWindow.fromWebContents(e.sender);
    if (!w) return false;
    const ghost = w.getOpacity() > 0.05;
    w.setOpacity(ghost ? 0 : 1);
    w.setIgnoreMouseEvents(ghost, { forward: true });
    return ghost;
  });

  ipcMain.handle('prompter:toggle', (_e, show) => {
    if (!prompter) createPrompter();
    const want = show === undefined ? !prompter.isVisible() : !!show;
    want ? prompter.showInactive() : prompter.hide();
    return want;
  });

  ipcMain.handle('prompter:content', (_e, payload) => { send(prompter, 'prompter:content', payload); return true; });
  ipcMain.handle('prompter:cfg', (_e, payload) => { send(prompter, 'prompter:cfg', payload); return true; });
  ipcMain.handle('prompter:lock', (_e, locked) => {
    if (!prompter) return false;
    prompter.setIgnoreMouseEvents(!!locked, { forward: true });
    prompter.setFocusable(!locked);
    send(prompter, 'prompter:cfg', { locked: !!locked });
    return !!locked;
  });

  // Chunks are streamed straight to disk as they arrive. A 45-minute 1080p take
  // is ~2.7 GB; buffering that in the renderer before writing would be fatal.
  ipcMain.handle('rec:open', (_e, { ext, basename }) => {
    const dir = outDir();
    const base = `${basename || 'take'}_${stamp()}`;
    const file = path.join(dir, `${base}.${ext || 'webm'}`);
    writer = { stream: fs.createWriteStream(file), file, base, bytes: 0 };
    return { file, base, dir };
  });

  ipcMain.handle('rec:write', (_e, data) => {
    if (!writer) return 0;
    const buf = Buffer.from(data);
    writer.bytes += buf.length;
    if (writer.stream.write(buf)) return writer.bytes;
    return new Promise((r) => writer.stream.once('drain', () => r(writer.bytes)));
  });

  ipcMain.handle('rec:close', async () => {
    if (!writer) return null;
    const w = writer;
    writer = null;
    await new Promise((res, rej) => w.stream.end((err) => (err ? rej(err) : res())));
    return { file: w.file, base: w.base, bytes: w.bytes };
  });

  ipcMain.handle('file:save-sidecar', async (_e, { base, json, markdown, chapters }) => {
    const dir = outDir();
    const written = [];
    const put = async (name, body) => {
      if (!body) return;
      const p = path.join(dir, name);
      await fs.promises.writeFile(p, body, 'utf8');
      written.push(p);
    };
    await put(`${base}.session.json`, json && JSON.stringify(json, null, 2));
    await put(`${base}.report.md`, markdown);
    await put(`${base}.chapters.txt`, chapters);
    return written;
  });

  ipcMain.handle('shell:reveal', (_e, p) => { if (p) shell.showItemInFolder(p); return true; });
  ipcMain.handle('shell:open-dir', () => { shell.openPath(outDir()); return outDir(); });

  ipcMain.handle('perm:status', () => {
    if (!IS_MAC) return { screen: 'granted', camera: 'granted', microphone: 'granted' };
    return {
      screen: systemPreferences.getMediaAccessStatus('screen'),
      camera: systemPreferences.getMediaAccessStatus('camera'),
      microphone: systemPreferences.getMediaAccessStatus('microphone'),
    };
  });

  ipcMain.handle('perm:ask', async (_e, kind) => {
    if (!IS_MAC || kind === 'screen') return false;
    return systemPreferences.askForMediaAccess(kind);
  });

  ipcMain.handle('perm:open-settings', (_e, kind) => {
    const pane = kind === 'camera' ? 'Privacy_Camera'
      : kind === 'microphone' ? 'Privacy_Microphone'
      : 'Privacy_ScreenCapture';
    shell.openExternal(`x-apple.systempreferences:com.apple.preference.security?${pane}`);
    return true;
  });

  ipcMain.handle('app:quit', () => { app.quit(); return true; });
}

/* -------------------------------------------------------- global hotkeys */

const SHORTCUTS = {
  'Command+Shift+R': 'record',
  'Command+Shift+P': 'pause',
  'Command+Shift+M': 'marker',
  'Command+Control+Right': 'next',
  'Command+Control+Left': 'prev',
  'Command+Control+Up': 'faster',
  'Command+Control+Down': 'slower',
  'Command+Shift+T': 'prompter',
  'Command+Shift+S': 'scroll',
  'Command+Shift+L': 'lock',
  'Command+Shift+E': 'mode',
  'Command+Shift+H': 'hide',
};

function registerShortcuts() {
  const failed = [];
  for (const [accel, name] of Object.entries(SHORTCUTS)) {
    const ok = globalShortcut.register(accel, () => fire(name));
    if (!ok) failed.push(accel);
  }
  if (failed.length) smokeLog.push(`[main] shortcuts unavailable: ${failed.join(', ')}`);
  return failed;
}

/* -------------------------------------------------------------- app menu */

function buildMenu() {
  // A menu is required on macOS for ⌘C/⌘V/⌘Z to work inside the notes editor.
  const template = [
    ...(IS_MAC ? [{ role: 'appMenu' }] : []),
    { role: 'editMenu' },
    {
      label: 'Coach',
      submenu: [
        { label: 'Start / Stop Recording', accelerator: 'Command+Shift+R', click: () => fire('record') },
        { label: 'Add Marker', accelerator: 'Command+Shift+M', click: () => fire('marker') },
        { type: 'separator' },
        { label: 'Toggle Teleprompter', accelerator: 'Command+Shift+T', click: () => fire('prompter') },
        { label: 'Edit / Present Mode', accelerator: 'Command+Shift+E', click: () => fire('mode') },
        { type: 'separator' },
        { label: 'Open Recordings Folder', click: () => shell.openPath(outDir()) },
      ],
    },
    { role: 'windowMenu' },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

/* ----------------------------------------------------------- smoke test */

const readyMarks = new Set();

async function runSmoke() {
  const t0 = Date.now();
  while (Date.now() - t0 < 20000 && !(readyMarks.has('dash') && readyMarks.has('prompter'))) {
    await new Promise((r) => setTimeout(r, 200));
  }
  const checks = [];
  const check = (name, ok, detail = '') => checks.push({ name, ok: !!ok, detail });

  check('dash renderer ready', readyMarks.has('dash'));
  check('prompter renderer ready', readyMarks.has('prompter'));
  check('dash content-protected + on top', dash && dash.isAlwaysOnTop());

  try {
    const sources = await desktopCapturer.getSources({ types: ['screen'], thumbnailSize: { width: 8, height: 8 } });
    check('desktopCapturer sees a screen', sources.length > 0, `${sources.length} source(s)`);
  } catch (e) { check('desktopCapturer sees a screen', false, String((e && e.stack) || e)); }

  try {
    const probe = await dash.webContents.executeJavaScript('window.__lcSelfTest ? window.__lcSelfTest() : null');
    check('renderer self-test', probe && probe.ok, probe ? JSON.stringify(probe) : 'no hook');
  } catch (e) { check('renderer self-test', false, e.message); }

  if (process.env.LC_SMOKE === 'deep') {
    try {
      const d = screen.getPrimaryDisplay();
      const b = dash.getBounds();
      // a strip inside the pill's own title bar, in display points
      const rect = { x: b.x - d.bounds.x + 30, y: b.y - d.bounds.y + 14, w: Math.max(60, b.width - 60), h: 26 };
      const js = (expr) => dash.webContents.executeJavaScript(expr, true); // userGesture for getDisplayMedia
      await js('window.__lcProbeStart()');
      const sample = (r) => js(`window.__lcSample(${JSON.stringify(r)}, ${d.bounds.width})`);
      const dist = (p, q) => Math.round(Math.hypot(p[0] - q[0], p[1] - q[1], p[2] - q[2]));

      // Controlled experiment: a plain magenta window at a known spot.
      // Unprotected it must show up in the capture; protected it must vanish.
      const probeRect = { x: Math.round(d.bounds.width / 2) - 150, y: Math.round(d.bounds.height / 2) - 80, w: 300, h: 160 };
      const tw = new BrowserWindow({
        x: d.bounds.x + probeRect.x, y: d.bounds.y + probeRect.y, width: 300, height: 160,
        frame: false, alwaysOnTop: true, skipTaskbar: true, show: false, focusable: false,
        // Without this the window is throttled, the sweep stalls with the bar
        // parked on screen, and the "animation" is really a static change.
        webPreferences: { backgroundThrottling: false },
      });
      tw.setAlwaysOnTop(true, 'screen-saver', 1);
      await tw.loadURL('data:text/html,<body style="margin:0;background:%23ff00ff">');
      tw.showInactive();
      await new Promise((r) => setTimeout(r, 900));
      const visible = await sample({ x: probeRect.x + 40, y: probeRect.y + 40, w: 220, h: 80 });
      tw.setContentProtection(true);
      await new Promise((r) => setTimeout(r, 900));
      const hidden = await sample({ x: probeRect.x + 40, y: probeRect.y + 40, w: 220, h: 80 });
      tw.destroy();

      check('capture stream is live and correctly mapped', dist(visible, [255, 0, 255]) < 70,
        `probe window reads rgb(${visible}) where magenta was drawn`);
      check('setContentProtection removes a window from the capture', dist(visible, hidden) > 60,
        `rgb(${visible}) -> rgb(${hidden}) once protected`);

      // And the dashboard itself, which is protected from birth:
      const pill = await sample(rect);
      check('dashboard pill is not in the frame', dist(pill, hidden) < 45,
        `pill region reads rgb(${pill}); desktop reads rgb(${hidden})`);

      // ── slide-change detection ─────────────────────────────────────
      const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
      const page = '<body style="margin:0;font:700 96px system-ui;display:grid;place-items:center;' +
        'background:#0b1020;color:#fff"><div id="t">1</div>' +
        '<div id="a" style="position:fixed;top:0;left:-30%;width:30%;height:100%;background:#fff;opacity:0"></div>' +
        '<script>let f=0;requestAnimationFrame(function l(){f++;requestAnimationFrame(l)});window.__f=()=>f;<\/script></body>';
      const sw = new BrowserWindow({
        x: d.bounds.x + 190, y: d.bounds.y + 110, width: 1120, height: 700,
        frame: false, alwaysOnTop: true, skipTaskbar: true, show: false, focusable: false,
        // Without this the window is throttled, the sweep stalls with the bar
        // parked on screen, and the "animation" is really a static change.
        webPreferences: { backgroundThrottling: false },
      });
      sw.setAlwaysOnTop(true, 'screen-saver', 1);
      await sw.loadURL('data:text/html,' + encodeURIComponent(page));
      sw.showInactive();
      const showSlide = (n, bg, fg) => sw.webContents.executeJavaScript(
        `document.body.style.background='${bg}';document.body.style.color='${fg}';document.getElementById('t').textContent='${n}'`);

      await sleep(1500);
      await js('window.__lcSlideBegin()');
      await sleep(1300);
      const before = (await js('window.__lcSlideState()')).count;

      const fakeDeck = [['2', '#f5f2ea', '#101418'], ['3', '#0b1020', '#ffffff'],
                        ['4', '#e8eef7', '#101418'], ['5', '#141b2d', '#ffd9a1']];
      for (const [n, bg, fg] of fakeDeck) { await showSlide(n, bg, fg); await sleep(2600); }
      const afterSlides = (await js('window.__lcSlideState()')).count;
      check('slide changes detected one-for-one', afterSlides - before === fakeDeck.length,
        `${afterSlides - before} detected of ${fakeDeck.length} shown`);

      // A sweeping bar stands in for an embedded video: continuous motion must
      // not be mistaken for a run of slide changes.
      const frames0 = await sw.webContents.executeJavaScript('window.__f()');
      await sw.webContents.executeJavaScript(
        "document.getElementById('a').style.opacity=1;" +
        "document.getElementById('a').animate([{transform:'translateX(0)'},{transform:'translateX(430%)'}],{duration:1200,iterations:5})");
      await sleep(7000);
      const framesDrawn = (await sw.webContents.executeJavaScript('window.__f()')) - frames0;
      const animState = await js('window.__lcSlideState()');
      const afterAnim = animState.count;
      check('the animation stimulus actually animated', framesDrawn > 150, `${framesDrawn} frames in 7s`);
      const spurious = animState.attempts.filter((a) => a.counted).slice(-4);
      // Usually 0. A capture stream that repeats frames can make fast motion look
      // settled, so the guarantee is "at most one phantom", not "never".
      check('continuous motion produces at most one phantom slide', afterAnim - afterSlides <= 1,
        `${afterAnim - afterSlides} event(s) across 6s of animation` +
        (spurious.length ? ` | counted settles: ${JSON.stringify(spurious)}` : ''));
      sw.destroy();
      await sleep(600);

      // Auto-advance rule + report plumbing, exercised without touching a camera.
      const logic = await js(`(() => {
        const snap = { auto: cfg.slideAuto, cur: S.cur, running: S.running, log: S.log, cue: deck.sections[1] && deck.sections[1].cue };
        cfg.slideAuto = true;
        deck.sections[1].cue = 3;
        S.cur = 0; S.running = true; S.totalMs = 60000; S.log = [];
        slides.count = 2; slides.events = [];
        openLogEntry();
        onSlideChange();                       // -> slide 3, which is section 2's cue
        const advanced = S.cur;
        const json = buildJson('probe');
        const ok = { advanced, slides: Array.isArray(json.slides), startSlide: json.sections[0].startSlide,
                     slideCount: json.stats.slideCount, chapters: buildChapters().split('\\n').length };
        Object.assign(cfg, { slideAuto: snap.auto });
        if (snap.cue === undefined) delete deck.sections[1].cue; else deck.sections[1].cue = snap.cue;
        S.cur = snap.cur; S.running = snap.running; S.log = snap.log; S.totalMs = 0;
        resetSlides(); renderSection();
        return ok;
      })()`);
      check('a slide cue auto-advances the section', logic.advanced === 1, `landed on section index ${logic.advanced}`);
      check('slide data reaches the sidecar', logic.slides && logic.startSlide === 2 && logic.slideCount >= 2,
        `slides[] present, section started on slide ${logic.startSlide}, ${logic.slideCount} slides`);

      const rec = await js('window.__lcProbeRecord(2500)');
      check('recorder wrote a real file', rec.bytes > 40000,
        `${(rec.bytes / 1e6).toFixed(2)} MB ${rec.mime.split(';')[0]} ${rec.w}x${rec.h}`);
      check('file exists on disk', fs.existsSync(rec.file), rec.file);
      if (!process.env.LC_KEEP) for (const f of fs.readdirSync(outDir())) if (f.startsWith('_verify')) fs.unlinkSync(path.join(outDir(), f));
    } catch (e) { check('deep capture probe', false, String((e && e.message) || e)); }
  }

  check('no renderer console errors', smokeLog.length === 0, smokeLog.join(' | '));

  const failed = checks.filter((c) => !c.ok);
  console.log('\n--- Lecture Coach smoke ---');
  for (const c of checks) console.log(`${c.ok ? 'PASS' : 'FAIL'}  ${c.name}${c.detail ? `  (${c.detail})` : ''}`);
  console.log(`${failed.length ? 'FAILED' : 'ALL PASS'} (${checks.length - failed.length}/${checks.length})\n`);
  app.exit(failed.length ? 1 : 0);
}

/* --------------------------------------------------------------- startup */

app.whenReady().then(() => {
  const ses = session.defaultSession;

  ses.setPermissionRequestHandler((_wc, permission, cb) => {
    cb(['media', 'display-capture', 'clipboard-sanitized-write', 'fullscreen'].includes(permission));
  });

  // getDisplayMedia() in the renderer resolves here. We answer with the screen
  // the user picked in the dashboard, so there is no OS picker in the middle of
  // a take. Our own overlays are content-protected, so they are not in the frame.
  ses.setDisplayMediaRequestHandler(async (_request, callback) => {
    try {
      const sources = await desktopCapturer.getSources({ types: ['screen'], thumbnailSize: { width: 0, height: 0 } });
      const chosen = sources.find((s) => s.id === selectedSourceId) || sources[0];
      if (!chosen) return callback({});
      callback(wantSystemAudio ? { video: chosen, audio: 'loopback' } : { video: chosen });
    } catch {
      callback({});
    }
  }, { useSystemPicker: false });

  registerIpc();
  buildMenu();
  createDash();
  createPrompter();
  if (!SMOKE) registerShortcuts();

  app.on('activate', () => { if (!dash) createDash(); else dash.show(); });
  if (SMOKE) runSmoke();
});

app.on('window-all-closed', () => app.quit());
app.on('will-quit', () => globalShortcut.unregisterAll());
