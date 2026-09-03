/* speechlab web app shell: record, upload, analyse, browse.
 *
 * The results pane is not implemented here - it delegates to SpeechReport,
 * the same renderer the standalone HTML export uses. Dropping this whole
 * shell into an Electron view later means keeping report.js and swapping the
 * four fetch() calls below for IPC.
 */
const $ = s => document.querySelector(s);
const state = { takes: [], sel: null, ctl: null, poll: 0 };

const fmtDur = s => {            // round total seconds first, else 59.9s renders "0:60"
  if (s == null) return '';
  const n = Math.round(s);
  return `${Math.floor(n / 60)}:${String(n % 60).padStart(2, '0')}`;
};
const fmtSize = b => b > 1e9 ? (b / 1e9).toFixed(1) + ' GB'
  : b > 1e6 ? (b / 1e6).toFixed(0) + ' MB' : (b / 1e3).toFixed(0) + ' KB';

async function api(path, opts) {
  const r = await fetch(path, opts);
  const ct = r.headers.get('content-type') || '';
  const body = ct.includes('json') ? await r.json() : await r.text();
  if (!r.ok) throw new Error((body && body.error) || r.statusText);
  return body;
}

// ------------------------------------------------------------------ takes
async function loadTakes(selectId) {
  const d = await api('/api/takes');
  state.takes = d.takes;
  $('#dir').textContent = d.dir;
  const box = $('#takes');
  box.innerHTML = '';
  if (!d.takes.length) {
    box.innerHTML = '<div class="empty">No takes yet. Record one, or add a file.</div>';
  }
  d.takes.forEach(t => {
    const n = document.createElement('div');
    n.className = 'take' + (t.id === state.sel ? ' sel' : '');
    const dot = !t.analyzed ? 'no' : (t.usable ? 'ok' : 'warn');
    const bits = [t.analyzed ? fmtDur(t.duration_s) : fmtSize(t.size),
                  t.modified.slice(0, 16).replace('T', ' ')];
    if (t.analyzed && t.wpm) bits.push(t.wpm.toFixed(0) + ' wpm');
    n.innerHTML = `<div class="n"><span class="dot ${dot}"></span> ${t.name}</div>` +
                  `<div class="m">${bits.map(b => `<span>${b}</span>`).join('')}</div>`;
    n.onclick = () => select(t.id);
    box.appendChild(n);
  });
  if (selectId) select(selectId);
}

function blank(html) {
  if (state.ctl) { state.ctl.destroy(); state.ctl = null; }
  $('#main').innerHTML = `<div class="blank">${html}</div>`;
}

async function select(id) {
  state.sel = id;
  [...document.querySelectorAll('.take')].forEach(n =>
    n.classList.toggle('sel', n.querySelector('.n').textContent.trim() === (state.takes.find(t => t.id === id) || {}).name));
  const t = state.takes.find(x => x.id === id);
  if (!t) return;
  if (!t.analyzed) {
    blank(`<b>${t.name}</b>${fmtSize(t.size)} · not analysed yet<br><br>
      <button class="primary" id="go">Analyse this take</button>`);
    $('#go').onclick = () => analyze(id);
    return;
  }
  try {
    const rep = await api('/api/report/' + encodeURIComponent(id));
    rep.source.name = t.name;
    if (state.ctl) state.ctl.destroy();
    const main = $('#main');
    main.innerHTML = '';
    const host = document.createElement('div');
    main.appendChild(host);
    state.ctl = SpeechReport.render(host, rep, { audioUrl: '/api/audio/' + encodeURIComponent(id) });
    const re = document.createElement('button');
    re.textContent = 'Re-analyse';
    re.style.marginTop = '18px';
    re.onclick = () => analyze(id);
    main.appendChild(re);
  } catch (e) {
    blank(`<b>Could not load report</b>${e.message}`);
  }
}

// ---------------------------------------------------------------- analysis
async function analyze(id) {
  if (state.ctl) { state.ctl.destroy(); state.ctl = null; }
  const t = state.takes.find(x => x.id === id) || { name: id };
  $('#main').innerHTML =
    `<div class="prog"><div class="lab"><span id="stage">starting…</span>
     <span class="mono" id="pct">0%</span></div>
     <div class="track"><div class="fill" id="fill"></div></div>
     <div class="hint">First run of a session loads the Whisper weights, which takes
     a few extra seconds. After that it is roughly 12&times; realtime.</div></div>`;
  let job;
  try {
    job = (await api('/api/analyze/' + encodeURIComponent(id), { method: 'POST' })).job;
  } catch (e) {
    return blank(`<b>Could not start</b>${e.message}`);
  }
  clearInterval(state.poll);
  state.poll = setInterval(async () => {
    let j;
    try { j = await api('/api/jobs/' + job); } catch { return; }
    if ($('#stage')) {
      $('#stage').textContent = j.stage || j.state;
      $('#pct').textContent = Math.round((j.progress || 0) * 100) + '%';
      $('#fill').style.width = Math.round((j.progress || 0) * 100) + '%';
    }
    if (j.state === 'done') { clearInterval(state.poll); await loadTakes(id); }
    if (j.state === 'error') {
      clearInterval(state.poll);
      $('#main').innerHTML = `<div class="err">Analysis failed — ${j.error}</div>`;
    }
  }, 400);
}

// ------------------------------------------------------------------ upload
async function upload(blob, name) {
  const r = await api('/api/takes', {
    method: 'POST', body: blob,
    headers: { 'X-Filename': encodeURIComponent(name), 'Content-Type': 'application/octet-stream' },
  });
  await loadTakes();
  analyze(r.id);
}

$('#add').onclick = () => $('#file').click();
$('#file').onchange = async e => {
  const f = e.target.files[0];
  if (!f) return;
  const safe = f.name.replace(/[^A-Za-z0-9 ._-]/g, '_');
  blank('<b>Uploading…</b>' + f.name);
  try { await upload(f, safe); } catch (err) { blank(`<b>Upload failed</b>${err.message}`); }
  e.target.value = '';
};

// --------------------------------------------------------------- recording
let rec = null;
$('#rec').onclick = startRecording;

async function startRecording() {
  let stream;
  try {
    stream = await navigator.mediaDevices.getUserMedia({
      audio: {
        // The analysis feed wants the untouched signal. Browser noise
        // suppression is nonlinear and eats the quiet passages and breaths
        // that prosody and breath detection depend on; AGC would flatten the
        // very energy dynamics we are trying to measure.
        echoCancellation: false, noiseSuppression: false, autoGainControl: false,
      },
    });
  } catch (e) {
    alert('Microphone unavailable: ' + e.message);
    return;
  }
  const mimes = ['audio/webm;codecs=opus', 'audio/webm', 'audio/mp4'];
  const mime = mimes.find(m => MediaRecorder.isTypeSupported(m)) || '';
  const mr = new MediaRecorder(stream, mime ? { mimeType: mime, audioBitsPerSecond: 128000 } : undefined);
  const chunks = [];
  mr.ondataavailable = e => e.data.size && chunks.push(e.data);

  const ac = new AudioContext();
  const an = ac.createAnalyser(); an.fftSize = 1024;
  ac.createMediaStreamSource(stream).connect(an);
  const buf = new Float32Array(an.fftSize);
  let peak = 0, raf = 0;

  const mask = document.createElement('div');
  mask.className = 'mask';
  mask.innerHTML = `<div class="rec-panel">
      <div class="clock" id="clk">0:00</div>
      <div class="st" id="st">recording — unprocessed signal</div>
      <div class="meter"><div class="lvl" id="lvl"></div></div>
      <div class="peak" id="pk">peak —</div>
      <div class="acts">
        <button id="stop" class="primary">Stop &amp; analyse</button>
        <button id="cancel">Cancel</button>
      </div>
      <div class="hint">Aim for peaks near &minus;12 dBFS. Talk for 90 s or more:
      lexical diversity needs 100+ words, and pace variability needs a few windows.</div>
    </div>`;
  document.body.appendChild(mask);
  const t0 = Date.now();

  function frame() {
    an.getFloatTimeDomainData(buf);
    let s = 0, mx = 0;
    for (const v of buf) { s += v * v; mx = Math.max(mx, Math.abs(v)); }
    peak = Math.max(peak, mx);
    const db = 20 * Math.log10(Math.max(Math.sqrt(s / buf.length), 1e-6));
    mask.querySelector('#lvl').style.width = Math.max(0, Math.min(1, (db + 60) / 60)) * 100 + '%';
    mask.querySelector('#pk').textContent =
      'peak ' + (20 * Math.log10(Math.max(peak, 1e-6))).toFixed(1) + ' dBFS' +
      (peak > 0 && peak < 0.06 ? '  — too quiet, move closer' : '');
    const el = (Date.now() - t0) / 1000;
    mask.querySelector('#clk').textContent =
      Math.floor(el / 60) + ':' + String(Math.floor(el % 60)).padStart(2, '0');
    raf = requestAnimationFrame(frame);
  }
  frame();

  const cleanup = () => {
    cancelAnimationFrame(raf);
    stream.getTracks().forEach(t => t.stop());
    ac.close();
    mask.remove();
  };
  mask.querySelector('#cancel').onclick = () => { mr.onstop = cleanup; mr.stop(); };
  mask.querySelector('#stop').onclick = () => {
    mr.onstop = async () => {
      cleanup();
      const ext = (mime.includes('mp4')) ? 'mp4' : 'webm';
      const d = new Date(), p = n => String(n).padStart(2, '0');
      const name = `take_${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}_` +
                   `${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}.${ext}`;
      blank('<b>Saving…</b>' + name);
      try { await upload(new Blob(chunks, { type: mime || 'audio/webm' }), name); }
      catch (e) { blank(`<b>Save failed</b>${e.message}`); }
    };
    mr.stop();
  };
  mr.start(1000);
  rec = mr;
}

blank('<b>Pick a take</b>Choose one on the left, record a new one, or add a file.');
loadTakes();
