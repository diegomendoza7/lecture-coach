'use strict';
/*
 * Lecture Coach — dashboard renderer
 *
 * Recording pipeline:
 *   getDisplayMedia() ─┐
 *                      ├─▶ <canvas id="stage">  ──captureStream(0)──┐
 *   getUserMedia(cam) ─┘        (screen + cam only)                 ├─▶ MediaRecorder ─▶ file
 *   getUserMedia(mic) ──▶ AudioContext ──▶ MediaStreamDestination ──┘
 *                                    └──▶ AnalyserNode ─▶ level meter / speaking stats
 *
 * The dashboard DOM is never part of that pipeline, and both overlay windows are
 * setContentProtection(true) in main.js, so the screen stream cannot see them
 * either. Notes and timers are therefore absent from the recorded file.
 */

const api = window.coach;
const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => Array.from(r.querySelectorAll(s));
const uid = () => Math.random().toString(36).slice(2, 9);
const clamp = (v, a, b) => Math.min(b, Math.max(a, v));

const mmss = (ms) => {
  const s = Math.max(0, Math.round(ms / 1000));
  return String(Math.floor(s / 60)).padStart(2, '0') + ':' + String(s % 60).padStart(2, '0');
};
const hhmmss = (ms) => {
  const s = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(s / 3600);
  const body = String(Math.floor((s % 3600) / 60)).padStart(2, '0') + ':' + String(s % 60).padStart(2, '0');
  return h ? h + ':' + body : '0:' + body;      // YouTube chapter format
};
const signed = (ms) => (ms < 0 ? '−' : '+') + mmss(Math.abs(ms));
const parseTarget = (str) => {
  const m = String(str || '').trim().match(/^(\d+):?(\d{1,2})?$/);
  if (!m) return null;
  return m[2] === undefined ? Number(m[1]) * 60 : Number(m[1]) * 60 + Number(m[2]);
};

/* ══════════════════════════════ state ══════════════════════════════ */

const CFG_KEY = 'lc.cfg.v1';
const DECK_KEY = 'lc.deck.v1';

const DEFAULT_CFG = {
  quality: '1080', countdown: 3, systemAudio: false,
  camOn: true, camShape: 'circle', camPos: 'br', camSize: 24, camMirror: true,
  camId: '', micId: '', sourceId: '',
  pSpeed: 42, pSize: 34, pOpacity: 82, pMirror: false, pFollow: true,
  slideDetect: true, slideAuto: false, slideSens: 12,
  wpm: 145,
};

const DEFAULT_DECK = () => ({
  title: 'Untitled talk',
  sections: [
    { id: uid(), title: 'Hook', target: 60, html: '<p>One sentence: why should this room care <i>today</i>?</p><ul><li>Concrete image, not the abstraction</li><li>Land the question you will answer</li></ul>' },
    { id: uid(), title: 'Problem & gap', target: 120, html: '<p>What is known → what is missing → why the gap persists.</p><ul><li>Two citations max, spoken not read</li></ul>' },
    { id: uid(), title: 'Approach', target: 180, html: '<p>Design in one breath, then the one detail that makes it credible.</p>' },
    { id: uid(), title: 'Results', target: 240, html: '<p>Walk the axes before the data. Name the effect, then the caveat.</p>' },
    { id: uid(), title: 'Limitations', target: 60, html: '<p>Say them first, briefly, without apologising.</p>' },
    { id: uid(), title: 'Takeaways', target: 60, html: '<p>Three sentences. Repeat the opening question, answered.</p><p>Thanks + funding + contact.</p>' },
  ],
});

const load = (k, fb) => { try { const v = JSON.parse(localStorage.getItem(k)); return v || fb; } catch { return fb; } };

const cfg = Object.assign({}, DEFAULT_CFG, load(CFG_KEY, {}));
let deck = load(DECK_KEY, null) || DEFAULT_DECK();

const S = {
  mode: 'edit', ghost: false, compact: false,
  cur: 0, take: 1,
  running: false, paused: false, previewing: false,
  totalMs: 0, sectionMs: 0, last: 0,
  markers: [], log: [],
  lastFile: null, lastChapters: '',
  audio: { speakMs: 0, runMs: 0, peakDb: -100, sumDb: 0, nDb: 0, pauses: 0, longestPause: 0, quietMs: 0 },
};

const media = { screen: null, cam: null, mic: null, sysTrack: null, ctx: null, dest: null, analyser: null, data: null };
let recorder = null, writes = [], recMime = '', frameTrack = null, tickWorker = null, stageCtx = null;

/* ══════════════════════════════ elements ═══════════════════════════ */

const el = {};
const bind = (...ids) => ids.forEach((id) => { el[id] = document.getElementById(id); });
bind('pill', 'deckTitle', 'hintTitle', 'hintBody', 'takeBadge', 'recDot', 'modeEdit', 'modePresent', 'btnCompact', 'btnSettings', 'btnHide', 'btnQuit',
  'tTotal', 'tTotalSub', 'tSection', 'tSectionSub', 'secIndex', 'paceFill', 'paceLabel',
  'btnRec', 'btnPause', 'btnMarker', 'btnPrev', 'btnNext', 'btnCam', 'btnPrompter', 'btnLock',
  'meter', 'meterVal', 'speakPct', 'stage', 'previewWrap', 'noPreview',
  'slideBadge', 'btnSlides', 'secCue', 'chkSlideDetect', 'chkSlideAuto', 'rngSlideSens', 'sensRead', 'btnLearnCues',
  'rail', 'secTitle', 'secTarget', 'btnAddSection', 'btnDelSection', 'notes', 'wordCount', 'readTime',
  'btnAutoTargets', 'saveState', 'sheet', 'btnCloseSheet', 'btnOpenFolder', 'btnExport', 'btnImport', 'fileImport',
  'selCam', 'selMic', 'selQuality', 'selCountdown', 'chkSysAudio', 'permList', 'srcGrid',
  'selCamShape', 'selCamPos', 'rngCamSize', 'chkCamMirror',
  'pSpeed', 'pSize', 'pOpacity', 'chkPMirror', 'chkPFollow', 'keyList',
  'report', 'reportBody', 'btnCopyChapters', 'btnRevealFile', 'btnCloseReport',
  'countdown', 'countdownNum', 'toast', 'vScreen', 'vCam');

/* ══════════════════════════════ toast ══════════════════════════════ */

let toastTimer = null;
function toast(msg, kind = 'err', ms = 4200) {
  el.toast.className = 'toast' + (kind === 'info' ? ' info' : '');
  el.toast.textContent = msg;
  el.toast.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { el.toast.hidden = true; }, ms);
}
function toastAction(msg, label, fn) {
  toast(msg, 'err', 9000);
  const b = document.createElement('button');
  b.className = 'link';
  b.textContent = label;
  b.onclick = fn;
  el.toast.appendChild(b);
}

/* ══════════════════════════ deck & notes ═══════════════════════════ */

const section = () => deck.sections[S.cur];
const deckSlug = () => (deck.title || 'talk').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40) || 'talk';

let saveTimer = null;
function persist() {
  el.saveState.textContent = 'saving…';
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    localStorage.setItem(DECK_KEY, JSON.stringify(deck));
    localStorage.setItem(CFG_KEY, JSON.stringify(cfg));
    el.saveState.textContent = 'saved';
  }, 350);
}

function renderRail() {
  el.rail.innerHTML = '';
  deck.sections.forEach((s, i) => {
    const c = document.createElement('button');
    c.className = 'railchip' + (i === S.cur ? ' on' : '') + (S.log.some((l) => l.i === i && l.endTotalMs != null) ? ' done' : '');
    c.dataset.hit = '';
    c.innerHTML = '<b>' + (i + 1) + '</b><span></span>';
    c.querySelector('span').textContent = s.title || 'untitled';
    c.onclick = () => gotoSection(i);
    el.rail.appendChild(c);
  });
}

function renderSection() {
  const s = section();
  el.notes.innerHTML = s.html || '';
  el.secTitle.value = s.title || '';
  el.secTarget.value = mmss(s.target * 1000);
  el.secCue.value = s.cue || '';
  el.secIndex.textContent = (S.cur + 1) + '/' + deck.sections.length;
  el.tSectionSub.textContent = 'target ' + mmss(s.target * 1000);
  renderRail();
  updateCounts();
  syncPrompter();
}

function updateCounts() {
  const words = (el.notes.innerText || '').trim().split(/\s+/).filter(Boolean).length;
  el.wordCount.textContent = words + ' words';
  el.readTime.textContent = '≈ ' + mmss((words / cfg.wpm) * 60000) + ' spoken';
}

function gotoSection(i, fromRun = false) {
  if (i < 0 || i >= deck.sections.length) return;
  section().html = el.notes.innerHTML;
  if (S.running) closeLogEntry();
  S.cur = i;
  if (S.running) { S.sectionMs = 0; openLogEntry(); }
  else if (!fromRun) S.sectionMs = 0;
  renderSection();
  persist();
}

function addSection() {
  section().html = el.notes.innerHTML;
  deck.sections.splice(S.cur + 1, 0, { id: uid(), title: 'New section', target: 60, html: '' });
  S.cur += 1;
  renderSection();
  persist();
}

function delSection() {
  if (deck.sections.length < 2) return toast('A deck needs at least one section.');
  deck.sections.splice(S.cur, 1);
  S.cur = clamp(S.cur, 0, deck.sections.length - 1);
  renderSection();
  persist();
}

function autoTargets() {
  const tmp = document.createElement('div');
  section().html = el.notes.innerHTML;
  deck.sections.forEach((s) => {
    tmp.innerHTML = s.html || '';
    const w = (tmp.innerText || '').trim().split(/\s+/).filter(Boolean).length;
    s.target = Math.max(20, Math.round((w / cfg.wpm) * 60));
  });
  renderSection();
  persist();
  toast('Targets set from word count at ' + cfg.wpm + ' wpm.', 'info');
}

/* ══════════════════════════ clocks & pace ══════════════════════════ */

const totalTarget = () => deck.sections.reduce((a, s) => a + s.target, 0) * 1000;

function tickClock() {
  if (S.running && !S.paused) {
    const now = performance.now();
    const dt = now - S.last;
    S.last = now;
    S.totalMs += dt;
    S.sectionMs += dt;
  }
  paintClock();
  updateSlideBadge();
}

function paintClock() {
  const tgt = section().target * 1000;
  el.tTotal.textContent = mmss(S.totalMs);
  el.tSection.textContent = mmss(S.sectionMs);

  const totalLeft = totalTarget() - S.totalMs;
  el.tTotalSub.textContent = 'plan ' + mmss(totalTarget()) + ' · ' + signed(-totalLeft);
  el.tTotalSub.style.color = totalLeft < 0 ? 'var(--hot)' : '';

  const left = tgt - S.sectionMs;
  el.tSectionSub.textContent = 'target ' + mmss(tgt) + ' · ' + signed(-left);

  const r = tgt ? S.sectionMs / tgt : 0;
  el.paceFill.style.width = clamp(r, 0, 1) * 100 + '%';
  el.paceFill.className = 'pacefill' + (r > 1 ? ' over' : r > 0.85 ? ' warn' : '');
  el.tSection.className = 'big' + (r > 1 ? ' over' : r > 0.85 ? ' warn' : '');

  el.paceLabel.textContent = !S.running ? 'ready'
    : r > 1 ? 'over by ' + mmss(-left)
    : r > 0.85 ? 'wrap up · ' + mmss(left)
    : mmss(left) + ' left';
}

function openLogEntry() {
  S.log.push({ i: S.cur, title: section().title, target: section().target, startSlide: slides.count, startTotalMs: S.totalMs, endTotalMs: null });
}
function closeLogEntry() {
  const e = S.log[S.log.length - 1];
  if (e && e.endTotalMs == null) e.endTotalMs = S.totalMs;
}

/* ═══════════════════════ media: streams + canvas ═══════════════════ */

const QUALITY = { 720: [1280, 720, 4.5e6], 1080: [1920, 1080, 8e6], native: [null, null, 12e6] };

async function ensureStreams() {
  if (media.screen && media.mic && (!cfg.camOn || media.cam)) return;

  await api.selectSource(cfg.sourceId, cfg.systemAudio);

  if (!media.screen) {
    const want = { video: { frameRate: { ideal: 30 } }, audio: cfg.systemAudio };
    try {
      media.screen = await navigator.mediaDevices.getDisplayMedia(want);
    } catch (e) {
      if (cfg.systemAudio) {
        try { media.screen = await navigator.mediaDevices.getDisplayMedia({ video: { frameRate: { ideal: 30 } } }); }
        catch (e2) { throw screenError(e2); }
        toast('System audio is not available on this macOS build — recording mic only.', 'info');
      } else throw screenError(e);
    }
    media.sysTrack = media.screen.getAudioTracks()[0] || null;
    el.vScreen.srcObject = media.screen;
    await el.vScreen.play().catch(() => {});
  }

  if (cfg.camOn && !media.cam) {
    try {
      media.cam = await navigator.mediaDevices.getUserMedia({
        video: { deviceId: cfg.camId ? { exact: cfg.camId } : undefined, width: { ideal: 1280 }, height: { ideal: 720 }, frameRate: { ideal: 30 } },
      });
      el.vCam.srcObject = media.cam;
      await el.vCam.play().catch(() => {});
    } catch {
      toast('Camera unavailable — recording screen only.', 'info');
      cfg.camOn = false;
      el.btnCam.classList.remove('on');
    }
  }

  if (!media.mic) {
    media.mic = await navigator.mediaDevices.getUserMedia({
      audio: {
        deviceId: cfg.micId ? { exact: cfg.micId } : undefined,
        echoCancellation: false, noiseSuppression: true, autoGainControl: false,
      },
    }).catch((e) => { throw new Error('Microphone unavailable: ' + e.name); });
    buildAudioGraph();
  }

  sizeStage();
  await refreshDevices();
}

function screenError(e) {
  if (e && (e.name === 'NotAllowedError' || e.name === 'NotFoundError')) {
    toastAction('macOS blocked screen capture for this app.', 'Open Privacy settings →', () => api.openPrivacyPane('screen'));
    return new Error('Screen recording permission not granted');
  }
  return e;
}

function buildAudioGraph() {
  media.ctx = new AudioContext();
  media.dest = media.ctx.createMediaStreamDestination();
  media.analyser = media.ctx.createAnalyser();
  media.analyser.fftSize = 1024;
  media.analyser.smoothingTimeConstant = 0.55;
  media.data = new Float32Array(media.analyser.fftSize);

  const micSrc = media.ctx.createMediaStreamSource(media.mic);
  micSrc.connect(media.analyser);
  micSrc.connect(media.dest);
  if (media.sysTrack) {
    const sysGain = media.ctx.createGain();
    sysGain.gain.value = 0.8;                       // duck system audio under the voice
    media.ctx.createMediaStreamSource(new MediaStream([media.sysTrack])).connect(sysGain).connect(media.dest);
  }
}

function sizeStage() {
  const t = media.screen && media.screen.getVideoTracks()[0];
  const s = t ? t.getSettings() : { width: 1920, height: 1080 };
  const q = QUALITY[cfg.quality] || QUALITY['1080'];
  let w = q[0] || s.width || 1920;
  let h = q[1] || s.height || 1080;
  if (!q[0]) { const k = Math.min(1, 3840 / w); w = Math.round(w * k / 2) * 2; h = Math.round(h * k / 2) * 2; }
  el.stage.width = w;
  el.stage.height = h;
}

/* draw one composited frame — screen letterboxed, camera as a bubble */
function drawFrame() {
  const c = el.stage;
  const ctx = stageCtx;
  const W = c.width, H = c.height;
  ctx.fillStyle = '#000';
  ctx.fillRect(0, 0, W, H);

  const v = el.vScreen;
  if (v.readyState >= 2 && v.videoWidth) {
    const k = Math.min(W / v.videoWidth, H / v.videoHeight);
    const w = v.videoWidth * k, h = v.videoHeight * k;
    ctx.drawImage(v, (W - w) / 2, (H - h) / 2, w, h);
  }

  const cam = el.vCam;
  if (cfg.camOn && cam.readyState >= 2 && cam.videoWidth) {
    const m = W * 0.022;
    const bw = W * (cfg.camSize / 100);
    const bh = cfg.camShape === 'circle' ? bw : bw * 9 / 16;
    const x = cfg.camPos.endsWith('r') ? W - bw - m : m;
    const y = cfg.camPos.startsWith('b') ? H - bh - m : m;

    // cover-crop the camera frame into the bubble box
    const sr = cam.videoWidth / cam.videoHeight, dr = bw / bh;
    let sw = cam.videoWidth, sh = cam.videoHeight;
    if (sr > dr) sw = cam.videoHeight * dr; else sh = cam.videoWidth / dr;
    const sx = (cam.videoWidth - sw) / 2, sy = (cam.videoHeight - sh) / 2;

    ctx.save();
    ctx.beginPath();
    if (cfg.camShape === 'circle') ctx.arc(x + bw / 2, y + bh / 2, bw / 2, 0, Math.PI * 2);
    else ctx.roundRect(x, y, bw, bh, bw * 0.06);
    ctx.closePath();
    ctx.shadowColor = 'rgba(0,0,0,.55)';
    ctx.shadowBlur = W * 0.012;
    ctx.shadowOffsetY = W * 0.004;
    ctx.fillStyle = '#000';
    ctx.fill();
    ctx.shadowColor = 'transparent';
    ctx.clip();
    if (cfg.camMirror) { ctx.translate(x + bw, y); ctx.scale(-1, 1); ctx.drawImage(cam, sx, sy, sw, sh, 0, 0, bw, bh); }
    else ctx.drawImage(cam, sx, sy, sw, sh, x, y, bw, bh);
    ctx.restore();

    ctx.save();
    ctx.strokeStyle = 'rgba(255,255,255,.85)';
    ctx.lineWidth = Math.max(1, W * 0.0022);
    ctx.beginPath();
    if (cfg.camShape === 'circle') ctx.arc(x + bw / 2, y + bh / 2, bw / 2, 0, Math.PI * 2);
    else ctx.roundRect(x, y, bw, bh, bw * 0.06);
    ctx.stroke();
    ctx.restore();
  }
}

/* A Worker drives the frame clock: worker timers are never throttled, so the
   capture keeps its frame rate even when the pill is unfocused or ghosted. */
function startClockWorker(fps) {
  const src = 'let id=null;onmessage=e=>{clearInterval(id);if(e.data&&e.data.ms)id=setInterval(()=>postMessage(1),e.data.ms)}';
  if (!tickWorker) {
    tickWorker = new Worker(URL.createObjectURL(new Blob([src], { type: 'text/javascript' })));
    tickWorker.onmessage = () => {
      drawFrame();
      if (frameTrack && S.running && !S.paused) frameTrack.requestFrame();
      detectSlides();
    };
  }
  tickWorker.postMessage({ ms: Math.round(1000 / fps) });
}
function stopClockWorker() { if (tickWorker) tickWorker.postMessage({ ms: 0 }); }

async function startPreview() {
  await ensureStreams();
  stageCtx = el.stage.getContext('2d', { alpha: false });
  S.previewing = true;
  el.noPreview.hidden = true;
  startClockWorker(S.running ? 30 : 15);
  meterLoop();
}

function stopPreview() {
  if (S.running) return;
  stopClockWorker();
  for (const s of [media.screen, media.cam, media.mic]) if (s) s.getTracks().forEach((t) => t.stop());
  if (media.ctx) media.ctx.close();
  media.screen = media.cam = media.mic = media.sysTrack = media.ctx = media.dest = media.analyser = null;
  el.vScreen.srcObject = el.vCam.srcObject = null;
  S.previewing = false;
  el.noPreview.hidden = false;
  paintMeter(-100);
}

/* ═════════════════════ slide-change detection ══════════════════════
 * Downsample the screen stream to a 64x36 luma grid five times a second and
 * watch the mean absolute difference. A slide change is a *burst* of
 * difference that settles into a screen that genuinely looks different from
 * the one before the burst. Waiting for the settle collapses a Keynote
 * dissolve into one event instead of six; the before/after comparison stops
 * a looping animation or an embedded video from firing at all.
 * Cost: 2304 pixels read, 5x/sec.
 * ────────────────────────────────────────────────────────────────── */

/* CONFIRM_MS is deliberately long. A display-capture stream occasionally
 * delivers the same frame twice; mid-motion that reads as a perfectly settled
 * screen, and a short confirm window turns each such stall into a phantom slide.
 * A real slide is held for seconds, so waiting a second costs nothing — and the
 * event is timestamped at the *start* of the change, so timecodes stay exact. */
const SLIDE_W = 64, SLIDE_H = 36, SAMPLE_MS = 200, CONFIRM_MS = 1000, CALM_MS = 1400, COOLDOWN_MS = 1200;

const slides = {
  count: 1, events: [], score: 0, settle: 0, attempts: [],
  prev: null, anchor: null, calm: null, pending: false, burstAt: 0, quietMs: 0, coolMs: 0,
  lastAt: 0, lastSampleAt: 0, canvas: null, ctx: null,
};

/* mean absolute difference of two luma grids, 0..1 */
function mad(a, b) {
  let sum = 0;
  for (let i = 0; i < a.length; i++) sum += Math.abs(a[i] - b[i]);
  return sum / (a.length * 255);
}

function resetSlides() {
  slides.count = 1;
  slides.events = [];
  slides.attempts = [];
  slides.prev = null;
  slides.anchor = null;
  slides.calm = null;
  slides.score = 0;
  slides.pending = false;
  slides.quietMs = 0;
  slides.coolMs = 0;
  slides.lastAt = performance.now();
}

function detectSlides() {
  if (!cfg.slideDetect) return;
  const now = performance.now();
  if (now - slides.lastSampleAt < SAMPLE_MS) return;
  const dt = slides.lastSampleAt ? now - slides.lastSampleAt : SAMPLE_MS;
  slides.lastSampleAt = now;

  const v = el.vScreen;
  if (!(v.readyState >= 2 && v.videoWidth)) { slides.prev = null; slides.score = 0; return; }

  if (!slides.ctx) {
    slides.canvas = document.createElement('canvas');
    slides.canvas.width = SLIDE_W;
    slides.canvas.height = SLIDE_H;
    slides.ctx = slides.canvas.getContext('2d', { willReadFrequently: true });
  }
  slides.ctx.drawImage(v, 0, 0, SLIDE_W, SLIDE_H);
  const px = slides.ctx.getImageData(0, 0, SLIDE_W, SLIDE_H).data;
  const cur = new Uint8Array(SLIDE_W * SLIDE_H);
  for (let i = 0, j = 0; j < cur.length; i += 4, j++) cur[j] = (px[i] * 77 + px[i + 1] * 150 + px[i + 2] * 29) >> 8;

  const before = slides.prev;
  slides.score = before ? mad(cur, before) : 0;
  slides.prev = cur;

  if (slides.coolMs > 0) slides.coolMs -= dt;

  const trigger = cfg.slideSens / 100;
  if (slides.score > trigger) {
    // Anchor on the last *settled* screen, never on the previous sample: mid-
    // animation frames come and go, and anchoring on one makes the eventual
    // settle look like a real change.
    if (!slides.pending) { slides.pending = true; slides.anchor = slides.calm; slides.burstAt = S.running ? S.totalMs : 0; }
    slides.quietMs = 0;
  } else {
    slides.quietMs += dt;
    if (slides.pending && slides.quietMs >= CONFIRM_MS) {
      slides.pending = false;
      // The burst has settled. Count it only if the screen ended up somewhere
      // genuinely different: a looping animation or a video that returns to
      // its own starting look scores near zero here and is ignored.
      const structural = slides.anchor ? mad(cur, slides.anchor) : 1;
      slides.settle = structural;
      const counted = structural > trigger && slides.coolMs <= 0;
      if (slides.attempts.length < 60) {
        slides.attempts.push({ st: +structural.toFixed(3), sc: +slides.score.toFixed(3), anchored: !!slides.anchor, counted });
      }
      if (counted) { slides.coolMs = COOLDOWN_MS; onSlideChange(slides.burstAt); }
      slides.anchor = null;
    }
    // Becoming the new reference frame takes longer than confirming a
    // transition. Motion has lulls — a bar leaving the frame, a video cutting to
    // a near-still shot — and adopting one of those as the reference makes the
    // next settle look like a change. A slide is held for seconds; a lull is not.
    if (!slides.pending && slides.quietMs >= CALM_MS) slides.calm = cur;
  }

  if (!el.sheet.hidden) {
    el.sensRead.textContent = 'fires above ' + (cfg.slideSens / 100).toFixed(2) + ' · now ' + slides.score.toFixed(3);
  }
}

function onSlideChange(atMs) {
  slides.count++;
  slides.lastAt = performance.now();
  slides.events.push({ slide: slides.count, atMs: S.running ? (atMs || S.totalMs) : null });
  el.slideBadge.classList.add('hit');
  setTimeout(() => el.slideBadge.classList.remove('hit'), 420);

  if (cfg.slideAuto && S.running) {
    const next = deck.sections[S.cur + 1];
    if (next && next.cue && slides.count >= next.cue) gotoSection(S.cur + 1);
  }
}

function updateSlideBadge() {
  el.slideBadge.classList.toggle('off', !cfg.slideDetect);
  const dwell = slides.lastAt ? performance.now() - slides.lastAt : 0;
  el.slideBadge.textContent = '▦ ' + slides.count + ' · ' + mmss(dwell);
}

/* one row per slide, with how long it was held */
function slideTable() {
  const rows = [{ slide: 1, atMs: 0 }].concat(slides.events.filter((e) => e.atMs != null));
  return rows.map((r, i) => ({
    slide: r.slide,
    atMs: Math.round(r.atMs),
    timecode: hhmmss(r.atMs),
    dwellMs: Math.round((i + 1 < rows.length ? rows[i + 1].atMs : S.totalMs) - r.atMs),
  }));
}

function learnCues() {
  const rows = mergedLog();
  rows.forEach((r) => { if (r.i > 0 && r.startSlide) deck.sections[r.i].cue = r.startSlide; });
  if (deck.sections[0]) deck.sections[0].cue = 1;
  renderSection();
  persist();
  toast('Slide cues learned from this take. Turn on auto-advance to use them.', 'info', 4500);
}

/* ═══════════════════════════ level meter ═══════════════════════════ */

let meterRaf = 0, peakHold = -100, peakAt = 0, lastMeterTs = 0;

function meterLoop(ts) {
  meterRaf = requestAnimationFrame(meterLoop);
  if (!media.analyser) return;
  media.analyser.getFloatTimeDomainData(media.data);
  let sum = 0;
  for (let i = 0; i < media.data.length; i++) sum += media.data[i] * media.data[i];
  const db = 20 * Math.log10(Math.sqrt(sum / media.data.length) + 1e-9);

  const now = ts || performance.now();
  const dt = lastMeterTs ? now - lastMeterTs : 0;
  lastMeterTs = now;

  if (S.running && !S.paused && dt < 500) {
    const a = S.audio;
    a.runMs += dt;
    a.sumDb += db; a.nDb++;
    if (db > a.peakDb) a.peakDb = db;
    if (db > -45) {
      a.speakMs += dt;
      if (a.quietMs > 1500) { a.pauses++; a.longestPause = Math.max(a.longestPause, a.quietMs); }
      a.quietMs = 0;
    } else a.quietMs += dt;
    el.speakPct.textContent = 'speaking ' + Math.round((a.speakMs / Math.max(1, a.runMs)) * 100) + '%';
  }

  if (db > peakHold || now - peakAt > 1200) { peakHold = db; peakAt = now; }
  paintMeter(db);
}

function paintMeter(db) {
  const c = el.meter, ctx = c.getContext('2d');
  const W = c.width, H = c.height, n = 40, gap = 2;
  const seg = (W - gap * (n - 1)) / n;
  const norm = (v) => clamp((v + 60) / 60, 0, 1);
  const lit = Math.round(norm(db) * n);
  const peakSeg = Math.round(norm(peakHold) * n);
  ctx.clearRect(0, 0, W, H);
  for (let i = 0; i < n; i++) {
    const on = i < lit;
    const hot = i / n > 0.88, warm = i / n > 0.72;
    ctx.fillStyle = on ? (hot ? '#ff4d5e' : warm ? '#ffbf47' : '#3ddc91') : 'rgba(255,255,255,.075)';
    if (i === peakSeg && !on) ctx.fillStyle = 'rgba(255,255,255,.3)';
    ctx.fillRect(i * (seg + gap), 0, seg, H);
  }
  el.meterVal.textContent = db < -59 ? '−∞ dB' : Math.round(db) + ' dB' + (db > -3 ? '  ⚠ clipping' : '');
}

/* ═════════════════════════════ recording ═══════════════════════════ */

const MIMES = [
  'video/mp4;codecs="avc1.640028,mp4a.40.2"',   // best for Final Cut / Premiere / Resolve
  'video/mp4',
  'video/webm;codecs=vp9,opus',
  'video/webm;codecs=vp8,opus',
  'video/webm',
];

function pickMime() {
  for (const m of MIMES) if (window.MediaRecorder && MediaRecorder.isTypeSupported(m)) return m;
  return '';
}

async function countdown(n) {
  if (!n) return;
  el.countdown.hidden = false;
  for (let i = n; i > 0; i--) {
    el.countdownNum.textContent = String(i);
    el.countdownNum.style.animation = 'none';
    void el.countdownNum.offsetWidth;
    el.countdownNum.style.animation = '';
    await new Promise((r) => setTimeout(r, 900));
  }
  el.countdown.hidden = true;
}

async function startRun() {
  try { await startPreview(); } catch (e) { return toast(e.message || String(e)); }

  await countdown(Number(cfg.countdown));

  const stream = el.stage.captureStream(0);              // frames only on requestFrame()
  frameTrack = stream.getVideoTracks()[0];
  const audioTrack = media.dest && media.dest.stream.getAudioTracks()[0];
  if (audioTrack) stream.addTrack(audioTrack);

  recMime = pickMime();
  const bps = (QUALITY[cfg.quality] || QUALITY['1080'])[2];
  try {
    recorder = new MediaRecorder(stream, {
      mimeType: recMime || undefined,
      videoBitsPerSecond: bps,
      audioBitsPerSecond: 192000,
    });
  } catch (e) { return toast('Could not start the recorder: ' + e.message); }

  const ext = recMime.startsWith('video/mp4') ? 'mp4' : 'webm';
  try {
    S.rec = await api.recOpen({ ext, basename: deckSlug() + '_take' + S.take });
  } catch (e) { return toast('Could not open the output file: ' + e.message); }

  writes = [];
  recorder.ondataavailable = (e) => {
    if (!e.data || !e.data.size) return;
    writes.push(e.data.arrayBuffer().then((b) => api.recWrite(new Uint8Array(b))));
  };
  recorder.onerror = (e) => toast('Recorder error: ' + (e.error ? e.error.name : 'unknown'));
  recorder.onstop = finishRun;
  recorder.start(1000);

  S.running = true; S.paused = false;
  S.totalMs = 0; S.sectionMs = 0; S.last = performance.now();
  S.markers = []; S.log = [];
  resetSlides();
  S.audio = { speakMs: 0, runMs: 0, peakDb: -100, sumDb: 0, nDb: 0, pauses: 0, longestPause: 0, quietMs: 0 };
  openLogEntry();
  startClockWorker(30);

  el.btnRec.classList.add('on');
  el.btnRec.querySelector('span').textContent = 'STOP';
  el.btnPause.disabled = false;
  el.recDot.className = 'recdot live';
  renderRail();
  if (cfg.pFollow) api.prompter.cfg({ running: true, reset: true });
}

function stopRun() {
  if (!recorder || recorder.state === 'inactive') return;
  closeLogEntry();
  S.running = false; S.paused = false;
  recorder.stop();
  stopClockWorker();
  startClockWorker(15);
  el.btnRec.classList.remove('on');
  el.btnRec.querySelector('span').textContent = 'REC';
  el.btnPause.disabled = true;
  el.recDot.className = 'recdot';
  api.prompter.cfg({ running: false });
}

function pauseRun() {
  if (!S.running) return;
  S.paused = !S.paused;
  if (S.paused) { recorder.pause(); el.recDot.className = 'recdot paused'; }
  else { S.last = performance.now(); recorder.resume(); el.recDot.className = 'recdot live'; }
  api.prompter.cfg({ running: !S.paused && cfg.pFollow });
}

function marker() {
  if (!S.running) return toast('Markers need a running take.', 'info', 1800);
  S.markers.push({ atMs: S.totalMs, section: section().title, label: 'M' + (S.markers.length + 1) });
  toast('⚑ marked at ' + mmss(S.totalMs) + ' — ' + S.markers.length + ' this take', 'info', 1600);
}

async function finishRun() {
  frameTrack = null;
  let saved;
  try {
    await Promise.all(writes);
    writes = [];
    saved = await api.recClose();
  } catch (e) { return toast('Could not finish the file: ' + e.message); }
  if (!saved || saved.bytes < 1024) return toast('Nothing was captured — check screen recording permission.');

  const chapters = buildChapters();
  S.lastFile = saved.file;
  S.lastChapters = chapters;
  await api.saveSidecar({ base: saved.base, json: buildJson(saved.file), markdown: buildMarkdown(saved.file), chapters });

  S.take++;
  el.takeBadge.textContent = 'Take ' + S.take;
  showReport(saved.file, saved.bytes);
}

/* ═════════════════════════ report & sidecars ═══════════════════════ */

function mergedLog() {
  const out = [];
  for (const e of S.log) {
    const end = e.endTotalMs == null ? S.totalMs : e.endTotalMs;
    const prev = out[out.length - 1];
    if (prev && prev.title === e.title) prev.endTotalMs = end;
    else out.push({ ...e, endTotalMs: end });
  }
  return out;
}

function buildChapters() {
  const rows = mergedLog();
  if (!rows.length) return '';
  return rows.map((r, i) => (i === 0 ? '0:00' : hhmmss(r.startTotalMs)) + ' ' + (r.title || 'Section ' + (i + 1))).join('\n');
}

function stats() {
  const a = S.audio;
  const table = slideTable();
  const longest = table.reduce((m, r) => (!m || r.dwellMs > m.dwellMs ? r : m), null);
  return {
    slideCount: table.length,
    slidesPerMin: S.totalMs > 0 ? Math.round((table.length / (S.totalMs / 60000)) * 10) / 10 : 0,
    longestSlide: longest,
    durationMs: Math.round(S.totalMs),
    plannedMs: totalTarget(),
    speakingPct: Math.round((a.speakMs / Math.max(1, a.runMs)) * 100),
    avgDb: a.nDb ? Math.round(a.sumDb / a.nDb) : null,
    peakDb: Math.round(a.peakDb),
    pauses: a.pauses,
    longestPauseMs: Math.round(a.longestPause),
  };
}

function buildJson(file) {
  return {
    app: 'Lecture Coach', version: 1, recordedAt: new Date().toISOString(),
    file, deckTitle: deck.title, take: S.take, stats: stats(),
    slides: slideTable(),
    sections: mergedLog().map((r) => ({
      title: r.title, targetSec: r.target, startSlide: r.startSlide,
      startMs: Math.round(r.startTotalMs), endMs: Math.round(r.endTotalMs),
      actualSec: Math.round((r.endTotalMs - r.startTotalMs) / 1000),
    })),
    markers: S.markers.map((m) => ({ atMs: Math.round(m.atMs), timecode: hhmmss(m.atMs), section: m.section, label: m.label })),
  };
}

function buildMarkdown(file) {
  const st = stats();
  const rows = mergedLog().map((r) => {
    const actual = (r.endTotalMs - r.startTotalMs) / 1000;
    const d = Math.round(actual - r.target);
    return '| ' + r.title + ' | ' + mmss(r.target * 1000) + ' | ' + mmss(actual * 1000) + ' | ' + (d >= 0 ? '+' : '−') + mmss(Math.abs(d) * 1000) + ' |';
  });
  return [
    '# ' + deck.title + ' — take ' + S.take,
    '',
    '- **Duration** ' + mmss(st.durationMs) + '  (planned ' + mmss(st.plannedMs) + ')',
    '- **Speaking time** ' + st.speakingPct + '% · **pauses > 1.5s** ' + st.pauses + ' · **longest** ' + mmss(st.longestPauseMs),
    '- **Level** avg ' + st.avgDb + ' dBFS, peak ' + st.peakDb + ' dBFS',
    '- **Slides** ' + st.slideCount + ' detected · ' + st.slidesPerMin + '/min · longest ' +
      (st.longestSlide ? 'slide ' + st.longestSlide.slide + ' at ' + mmss(st.longestSlide.dwellMs) : 'n/a'),
    '- **File** `' + file + '`',
    '',
    '## Section pacing', '',
    '| Section | Target | Actual | Δ |', '| --- | --- | --- | --- |',
    ...rows, '',
    '## Markers', '',
    ...(S.markers.length ? S.markers.map((m) => '- `' + hhmmss(m.atMs) + '` ' + m.label + ' — ' + m.section) : ['_none_']),
    '', '## YouTube chapters', '', '```', buildChapters(), '```', '',
  ].join('\n');
}

function showReport(file, bytes) {
  const st = stats();
  const rows = mergedLog().map((r) => {
    const actual = (r.endTotalMs - r.startTotalMs) / 1000;
    const d = Math.round(actual - r.target);
    const cls = d > 10 ? 'over' : d < -10 ? 'under' : '';
    return '<tr><td>' + (r.title || '—') + '</td><td class="n">' + mmss(r.target * 1000) + '</td><td class="n">' +
      mmss(actual * 1000) + '</td><td class="n ' + cls + '">' + (d >= 0 ? '+' : '−') + mmss(Math.abs(d) * 1000) +
      '</td><td class="n">' + (r.startSlide || '—') + '</td></tr>';
  }).join('');

  el.reportBody.innerHTML =
    '<div>' +
      stat('Duration', mmss(st.durationMs), 'planned ' + mmss(st.plannedMs)) +
      stat('Speaking', st.speakingPct + '%', 'of the take') +
      stat('Pauses >1.5s', String(st.pauses), 'longest ' + mmss(st.longestPauseMs)) +
      stat('Peak level', st.peakDb + ' dB', 'avg ' + st.avgDb + ' dB') +
      stat('Slides', String(st.slideCount),
        st.longestSlide ? 'longest: #' + st.longestSlide.slide + ' at ' + mmss(st.longestSlide.dwellMs) : '') +
      stat('Size', (bytes / 1e6).toFixed(1) + ' MB', recMime.split(';')[0].replace('video/', '')) +
    '</div>' +
    '<h4>Section pacing</h4><table><tr><th>Section</th><th>Target</th><th>Actual</th><th>Δ</th><th>slide</th></tr>' + rows + '</table>' +
    '<h4>Markers</h4>' + (S.markers.length
      ? '<table>' + S.markers.map((m) => '<tr><td>' + m.label + '</td><td>' + hhmmss(m.atMs) + '</td><td>' + m.section + '</td></tr>').join('') + '</table>'
      : '<p style="opacity:.6">No markers this take.</p>') +
    '<div class="file">' + file + '<br>Saved alongside: .session.json · .report.md · .chapters.txt</div>';
  el.report.hidden = false;
  api.setSize(1000, 560);
}

const stat = (label, big, sub) => '<span class="stat">' + label + '<b>' + big + '</b>' + (sub || '') + '</span>';

/* ═════════════════════════ modes & click-through ═══════════════════ */

let ignoring = null;
function applyIgnore(v) {
  if (ignoring === v) return;
  ignoring = v;
  api.setIgnoreMouse(v, true);
}

function setMode(m) {
  S.mode = m;
  document.body.classList.toggle('present', m === 'present');
  el.modeEdit.classList.toggle('on', m === 'edit');
  el.modePresent.classList.toggle('on', m === 'present');
  el.notes.contentEditable = m === 'edit' ? 'true' : 'false';
  // Present mode: the pill never takes keyboard focus, so Keynote / Slides
  // keep the arrow keys. Clicks still land on anything marked [data-hit].
  api.setFocusable(m === 'edit');
  applyIgnore(m === 'present');
  el.hintTitle && (el.hintTitle.textContent = m === 'present' ? 'Present mode' : 'What gets recorded');
}

document.addEventListener('mousemove', (e) => {
  if (S.mode !== 'present' || S.ghost) return;
  const t = document.elementFromPoint(e.clientX, e.clientY);
  applyIgnore(!(t && t.closest('[data-hit]')));
});
document.addEventListener('mouseleave', () => { if (S.mode === 'present') applyIgnore(true); });

function setCompact(v) {
  S.compact = v;
  document.body.classList.toggle('compact', v);
  api.setSize(v ? 560 : 1000, v ? 122 : 330);
}

/* ═══════════════════════════ teleprompter ══════════════════════════ */

let promptTimer = null;
function syncPrompter() {
  clearTimeout(promptTimer);
  promptTimer = setTimeout(() => {
    api.prompter.content({
      html: el.notes.innerHTML,
      title: section().title,
      index: S.cur + 1,
      total: deck.sections.length,
    });
  }, 120);
}

function pushPrompterCfg() {
  api.prompter.cfg({
    speed: cfg.pSpeed, size: cfg.pSize, mirror: cfg.pMirror, opacity: cfg.pOpacity / 100,
  });
}

/* ══════════════════════ devices, sources, sheet ════════════════════ */

async function refreshDevices() {
  const list = await navigator.mediaDevices.enumerateDevices();
  const fill = (sel, kind, chosen) => {
    const items = list.filter((d) => d.kind === kind);
    sel.innerHTML = '';
    if (!items.length) sel.innerHTML = '<option value="">none found</option>';
    items.forEach((d, i) => {
      const o = document.createElement('option');
      o.value = d.deviceId;
      o.textContent = d.label || kind.replace('input', ' ') + ' ' + (i + 1);
      if (d.deviceId === chosen) o.selected = true;
      sel.appendChild(o);
    });
  };
  fill(el.selCam, 'videoinput', cfg.camId);
  fill(el.selMic, 'audioinput', cfg.micId);
}

async function refreshSources() {
  const sources = await api.listSources();
  el.srcGrid.innerHTML = '';
  if (!cfg.sourceId && sources[0]) cfg.sourceId = sources[0].id;
  sources.forEach((s) => {
    const d = document.createElement('div');
    d.className = 'src' + (s.id === cfg.sourceId ? ' on' : '');
    d.innerHTML = (s.thumbnail ? '<img alt="">' : '<div style="aspect-ratio:16/10"></div>') + '<em></em>';
    if (s.thumbnail) d.querySelector('img').src = s.thumbnail;
    d.querySelector('em').textContent = s.name;
    d.onclick = () => {
      cfg.sourceId = s.id;
      $$('.src', el.srcGrid).forEach((n) => n.classList.remove('on'));
      d.classList.add('on');
      persist();
      if (media.screen) toast('Screen changed — stop the preview to apply.', 'info');
    };
    el.srcGrid.appendChild(d);
  });
}

async function refreshPerms() {
  const p = await api.perms();
  const row = (k, v) => {
    const ok = v === 'granted';
    return '<div>' + k + ': <b class="' + (ok ? '' : 'no') + '">' + v + '</b>' +
      (ok ? '' : ' <button class="link" data-perm="' + k + '">fix</button>') + '</div>';
  };
  el.permList.innerHTML = row('screen', p.screen) + row('camera', p.camera) + row('microphone', p.microphone);
  $$('[data-perm]', el.permList).forEach((b) => {
    b.onclick = async () => {
      const k = b.dataset.perm;
      if (k === 'screen') api.openPrivacyPane('screen');
      else { await api.askPerm(k); refreshPerms(); }
    };
  });
}

const KEYS = [
  ['⌘⇧R', 'record / stop'], ['⌘⇧P', 'pause'], ['⌘⇧M', 'marker'],
  ['⌘⌃← →', 'previous / next section'], ['⌘⌃↑ ↓', 'prompter speed'],
  ['⌘⇧T', 'teleprompter'], ['⌘⇧S', 'prompter scroll'], ['⌘⇧L', 'prompter click-through'],
  ['⌘⇧E', 'edit / present'], ['⌘⇧H', 'ghost the pill'],
];

/* ══════════════════════════════ wiring ═════════════════════════════ */

function wire() {
  el.btnRec.onclick = () => (S.running ? stopRun() : startRun());
  el.btnPause.onclick = pauseRun;
  el.btnMarker.onclick = marker;
  el.btnPrev.onclick = () => gotoSection(S.cur - 1);
  el.btnNext.onclick = () => gotoSection(S.cur + 1);

  el.btnCam.onclick = () => {
    cfg.camOn = !cfg.camOn;
    el.btnCam.classList.toggle('on', cfg.camOn);
  el.chkSlideDetect.checked = cfg.slideDetect;
  el.chkSlideAuto.checked = cfg.slideAuto;
  el.rngSlideSens.value = cfg.slideSens;
  el.btnSlides.classList.toggle('on', cfg.slideDetect);
    persist();
    if (cfg.camOn && S.previewing) ensureStreams().catch(() => {});
  };
  el.btnPrompter.onclick = async () => {
    const shown = await api.prompter.toggle();
    el.btnPrompter.classList.toggle('on', shown);
    if (shown) { pushPrompterCfg(); syncPrompter(); }
  };
  el.btnLock.onclick = async () => {
    const locked = await api.prompter.lock(!el.btnLock.classList.contains('on'));
    el.btnLock.classList.toggle('on', locked);
  };

  el.modeEdit.onclick = () => setMode('edit');
  el.modePresent.onclick = () => setMode('present');
  el.btnCompact.onclick = () => setCompact(!S.compact);
  el.btnHide.onclick = async () => { S.ghost = await api.toggleVisible(); };
  el.btnQuit.onclick = () => api.quit();
  el.previewWrap.onclick = () => (S.previewing ? stopPreview() : startPreview().catch((e) => toast(e.message)));

  el.notes.addEventListener('input', () => { section().html = el.notes.innerHTML; updateCounts(); persist(); syncPrompter(); });
  el.notes.addEventListener('paste', (e) => {
    e.preventDefault();
    const text = (e.clipboardData || window.clipboardData).getData('text/plain');
    document.execCommand('insertText', false, text);
  });
  el.secTitle.oninput = () => { section().title = el.secTitle.value; renderRail(); persist(); syncPrompter(); };
  el.secTarget.onchange = () => {
    const v = parseTarget(el.secTarget.value);
    if (v == null) return renderSection();
    section().target = v;
    renderSection();
    persist();
  };
  el.secCue.oninput = () => {
    const n = parseInt(el.secCue.value, 10);
    if (n > 0) section().cue = n; else delete section().cue;
    persist();
  };
  el.btnSlides.onclick = () => {
    cfg.slideDetect = !cfg.slideDetect;
    el.btnSlides.classList.toggle('on', cfg.slideDetect);
    el.chkSlideDetect.checked = cfg.slideDetect;
    if (cfg.slideDetect) slides.prev = null;
    persist();
  };
  el.btnLearnCues.onclick = learnCues;
  el.btnAddSection.onclick = addSection;
  el.btnDelSection.onclick = delSection;
  el.btnAutoTargets.onclick = autoTargets;

  $$('.fmt[data-cmd]').forEach((b) => {
    b.onmousedown = (e) => e.preventDefault();       // keep the caret in the notes
    b.onclick = () => {
      const c = b.dataset.cmd;
      document.execCommand(c, false, c === 'hiliteColor' ? 'rgba(255,191,71,.35)' : undefined);
      section().html = el.notes.innerHTML;
      persist();
      syncPrompter();
    };
  });

  // Sheets need more room than the pill has, so the window grows while one is
  // open and snaps back on close (setSize pins the bottom edge).
  const sheetSize = (open) => api.setSize(S.compact && !open ? 560 : 1000, open ? 560 : (S.compact ? 122 : 330));
  el.btnSettings.onclick = () => {
    el.sheet.hidden = false;
    sheetSize(true);
    refreshSources(); refreshDevices(); refreshPerms();
  };
  el.btnCloseSheet.onclick = () => { el.sheet.hidden = true; sheetSize(false); };
  el.btnCloseReport.onclick = () => { el.report.hidden = true; sheetSize(false); };
  el.btnRevealFile.onclick = () => S.lastFile && api.reveal(S.lastFile);
  el.btnCopyChapters.onclick = () => {
    navigator.clipboard.writeText(S.lastChapters || '');
    toast('Chapters copied — paste into the YouTube description.', 'info', 2400);
  };
  el.btnOpenFolder.onclick = () => api.openOutputDir();

  el.btnExport.onclick = () => {
    section().html = el.notes.innerHTML;
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([JSON.stringify(deck, null, 2)], { type: 'application/json' }));
    a.download = (deck.title || 'deck').replace(/\s+/g, '-') + '.deck.json';
    a.click();
  };
  el.btnImport.onclick = () => el.fileImport.click();
  el.fileImport.onchange = async () => {
    const f = el.fileImport.files[0];
    if (!f) return;
    try {
      const d = JSON.parse(await f.text());
      if (!d.sections || !d.sections.length) throw new Error('no sections');
      deck = d;
      S.cur = 0;
      renderSection();
      persist();
      toast('Deck loaded: ' + (deck.title || f.name), 'info');
    } catch (e) { toast('That file is not a Lecture Coach deck.'); }
    el.fileImport.value = '';
  };

  const setCfg = (node, key, get) => {
    node.onchange = node.oninput = () => {
      cfg[key] = get(node);
      persist();
      if (key.startsWith('p')) pushPrompterCfg();
    };
  };
  const val = (n) => n.value, num = (n) => Number(n.value), chk = (n) => n.checked;
  setCfg(el.selCam, 'camId', val); setCfg(el.selMic, 'micId', val);
  setCfg(el.selQuality, 'quality', val); setCfg(el.selCountdown, 'countdown', num);
  setCfg(el.chkSysAudio, 'systemAudio', chk);
  setCfg(el.selCamShape, 'camShape', val); setCfg(el.selCamPos, 'camPos', val);
  setCfg(el.rngCamSize, 'camSize', num); setCfg(el.chkCamMirror, 'camMirror', chk);
  setCfg(el.pSpeed, 'pSpeed', num); setCfg(el.pSize, 'pSize', num);
  setCfg(el.pOpacity, 'pOpacity', num); setCfg(el.chkPMirror, 'pMirror', chk);
  setCfg(el.chkPFollow, 'pFollow', chk);
  setCfg(el.chkSlideAuto, 'slideAuto', chk);
  setCfg(el.rngSlideSens, 'slideSens', num);
  el.chkSlideDetect.onchange = () => {
    cfg.slideDetect = el.chkSlideDetect.checked;
    el.btnSlides.classList.toggle('on', cfg.slideDetect);
    slides.prev = null;
    persist();
  };

  el.selQuality.addEventListener('change', () => { if (S.previewing && !S.running) sizeStage(); });

  el.deckTitle.value = deck.title || '';
  el.deckTitle.oninput = () => { deck.title = el.deckTitle.value; persist(); };

  window.__lcShortcut = async (name) => {
    switch (name) {
      case 'record': return S.running ? stopRun() : startRun();
      case 'pause': return pauseRun();
      case 'marker': return marker();
      case 'next': return gotoSection(S.cur + 1);
      case 'prev': return gotoSection(S.cur - 1);
      case 'faster': cfg.pSpeed = clamp(cfg.pSpeed + 6, 8, 140); el.pSpeed.value = cfg.pSpeed; pushPrompterCfg(); persist();
        return toast('prompter ' + cfg.pSpeed + ' px/s', 'info', 1200);
      case 'slower': cfg.pSpeed = clamp(cfg.pSpeed - 6, 8, 140); el.pSpeed.value = cfg.pSpeed; pushPrompterCfg(); persist();
        return toast('prompter ' + cfg.pSpeed + ' px/s', 'info', 1200);
      case 'prompter': return el.btnPrompter.click();
      case 'scroll': return api.prompter.cfg({ toggleRun: true });
      case 'lock': return el.btnLock.click();
      case 'mode': return setMode(S.mode === 'edit' ? 'present' : 'edit');
      case 'hide': S.ghost = await api.toggleVisible(); return;
    }
  };

  window.addEventListener('beforeunload', () => {
    if (recorder && recorder.state !== 'inactive') recorder.stop();
    for (const s of [media.screen, media.cam, media.mic]) if (s) s.getTracks().forEach((t) => t.stop());
  });
}

/* ═══════════════════════════════ boot ══════════════════════════════ */

function boot() {
  el.selQuality.value = cfg.quality;
  el.selCountdown.value = String(cfg.countdown);
  el.chkSysAudio.checked = cfg.systemAudio;
  el.selCamShape.value = cfg.camShape;
  el.selCamPos.value = cfg.camPos;
  el.rngCamSize.value = cfg.camSize;
  el.chkCamMirror.checked = cfg.camMirror;
  el.pSpeed.value = cfg.pSpeed;
  el.pSize.value = cfg.pSize;
  el.pOpacity.value = cfg.pOpacity;
  el.chkPMirror.checked = cfg.pMirror;
  el.chkPFollow.checked = cfg.pFollow;
  el.btnCam.classList.toggle('on', cfg.camOn);
  el.chkSlideDetect.checked = cfg.slideDetect;
  el.chkSlideAuto.checked = cfg.slideAuto;
  el.rngSlideSens.value = cfg.slideSens;
  el.btnSlides.classList.toggle('on', cfg.slideDetect);
  el.keyList.innerHTML = KEYS.map((k) => '<div><kbd>' + k[0] + '</kbd> · ' + k[1] + '</div>').join('');

  stageCtx = el.stage.getContext('2d', { alpha: false });
  drawFrame();
  paintMeter(-100);
  renderSection();
  wire();
  setMode('edit');
  setInterval(tickClock, 100);
  refreshDevices().catch(() => {});
  pushPrompterCfg();
  api.ready('dash');
}

document.addEventListener('DOMContentLoaded', boot);

/* hook used by `npm run smoke` in main.js */
window.__lcSelfTest = () => {
  const checks = {
    dom: !!(el.pill && el.notes && el.stage && el.meter),
    deck: Array.isArray(deck.sections) && deck.sections.length > 0,
    canvas2d: !!stageCtx,
    captureStream: typeof el.stage.captureStream === 'function',
    recorderMime: pickMime(),
    worker: (() => { try { startClockWorker(2); stopClockWorker(); return true; } catch { return false; } })(),
    bridge: typeof api.recOpen === 'function' && typeof api.recClose === 'function',
  };
  return { ok: Object.values(checks).every(Boolean), ...checks };
};

/* ─────────────────────────────────────────────────────────────────────
 * `npm run verify` support (main.js, LC_SMOKE=deep).
 * Proves on *your* machine that the overlays are excluded from capture:
 * samples the pixels where the pill sits, once with content protection on
 * and once with it off. Big difference = the pill is only in the capture
 * when protection is disabled, i.e. protection is doing its job.
 * ──────────────────────────────────────────────────────────────────── */

const wait = (ms) => new Promise((r) => setTimeout(r, ms));
let probe = null;

window.__lcProbeStart = async () => {
  await api.selectSource(cfg.sourceId, false);
  const st = await navigator.mediaDevices.getDisplayMedia({ video: { frameRate: { ideal: 30 } } });
  media.screen = st;
  el.vScreen.srcObject = st;
  await el.vScreen.play();
  await wait(700);
  const c = document.createElement('canvas');
  probe = { st, c, ctx: c.getContext('2d', { willReadFrequently: true }) };
  return { w: el.vScreen.videoWidth, h: el.vScreen.videoHeight };
};

function sampleRect(rect, displayW) {
  const v = el.vScreen;
  const k = v.videoWidth / displayW;
  const x = Math.round(rect.x * k), y = Math.round(rect.y * k);
  const w = Math.max(1, Math.round(rect.w * k)), h = Math.max(1, Math.round(rect.h * k));
  probe.c.width = v.videoWidth;
  probe.c.height = v.videoHeight;
  probe.ctx.drawImage(v, 0, 0);
  const d = probe.ctx.getImageData(x, y, w, h).data;
  let r = 0, g = 0, b = 0;
  for (let i = 0; i < d.length; i += 4) { r += d[i]; g += d[i + 1]; b += d[i + 2]; }
  const n = d.length / 4;
  return [r / n, g / n, b / n];
}

window.__lcSample = (rect, displayW) => sampleRect(rect, displayW).map(Math.round);

window.__lcSlideBegin = () => { startClockWorker(15); resetSlides(); return true; };
window.__lcSlideState = () => ({ count: slides.count, score: Number(slides.score.toFixed(3)), attempts: slides.attempts.slice() });

window.__lcProbeRecord = async (ms) => {
  sizeStage();
  stageCtx = el.stage.getContext('2d', { alpha: false });
  startClockWorker(30);
  const stream = el.stage.captureStream(0);
  frameTrack = stream.getVideoTracks()[0];
  const mime = pickMime();
  const rec = new MediaRecorder(stream, { mimeType: mime, videoBitsPerSecond: 4.5e6 });
  await api.recOpen({ ext: mime.startsWith('video/mp4') ? 'mp4' : 'webm', basename: '_verify' });
  const pending = [];
  rec.ondataavailable = (e) => e.data.size && pending.push(e.data.arrayBuffer().then((b) => api.recWrite(new Uint8Array(b))));
  const done = new Promise((r) => { rec.onstop = r; });
  S.running = true;                       // lets the worker call requestFrame()
  rec.start(500);
  await wait(ms);
  rec.stop();
  S.running = false;
  await done;
  stopClockWorker();
  await Promise.all(pending);
  const saved = await api.recClose();
  probe.st.getTracks().forEach((t) => t.stop());
  media.screen = null;
  return { file: saved.file, bytes: saved.bytes, mime, w: el.stage.width, h: el.stage.height };
};
