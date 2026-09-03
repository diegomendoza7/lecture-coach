/* Shared report renderer.
 *
 * One module, two hosts: the local web app mounts it against a served audio
 * URL, and viewer.py inlines this exact file into a standalone HTML export.
 * Keeping a single implementation is the point - a second copy would drift.
 *
 *   SpeechReport.render(rootElement, reportJson, { audioUrl })
 */
window.SpeechReport = (function () {
  const fmt = (t, dec) => {
    if (!isFinite(t)) t = 0;
    const m = Math.floor(t / 60), s = t - m * 60;
    return m + ':' + (dec ? (s < 10 ? '0' : '') + s.toFixed(1)
                          : String(Math.floor(s)).padStart(2, '0'));
  };
  const el = (tag, cls, html) => {
    const n = document.createElement(tag);
    if (cls) n.className = cls;
    if (html != null) n.innerHTML = html;
    return n;
  };
  const esc = s => String(s).replace(/[&<>"]/g, c =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

  function render(root, D, opts) {
    opts = opts || {};
    root.innerHTML = '';
    root.classList.add('rep');
    const DUR = D.source.duration_s;
    const unacc = (D.disfluency && D.disfluency.unaccounted_regions) || D.unaccounted || [];
    const H = 190;
    let pps = 20, raf = 0;

    const audio = new Audio();
    audio.preload = 'metadata';
    audio.hidden = true;
    if (opts.audioUrl) audio.src = opts.audioUrl;
    root.appendChild(audio);

    // ------------------------------------------------------------- header
    root.appendChild(el('h1', null, esc(D.source.name || (D.source.path || '').split('/').pop())));
    const q = D.quality;
    root.appendChild(el('div', 'sub',
      `${fmt(DUR)} · ${q.snr_db} dB SNR · peak ${q.peak_dbfs} dBFS · analysed ${String(D.generated_at).slice(0, 16).replace('T', ' ')}`));
    (q.warnings || []).forEach(w => root.appendChild(el('div', 'warn', esc(w))));

    // ------------------------------------------------------------ controls
    const bar = el('div', 'bar');
    const play = el('button', 'primary', 'Play'); play.style.minWidth = '76px';
    const tc = el('span', 'time', '0:00.0 / ' + fmt(DUR));
    const spacer = el('span'); spacer.style.flex = '1';
    const zo = el('button', null, '&minus;'), zi = el('button', null, '+');
    const follow = el('label', 'time');
    follow.innerHTML = '<input type="checkbox" checked> follow';
    bar.append(play, tc, spacer, zo, zi, follow);
    root.appendChild(bar);

    const wrap = el('div', 'tlwrap');
    const cv = el('canvas');
    wrap.appendChild(cv); root.appendChild(wrap);
    const ctx = cv.getContext('2d');

    root.appendChild(el('div', 'legend',
      '<span><i style="background:#3d6ae0"></i>pitch (semitones re your median)</span>' +
      '<span><i style="background:rgba(201,139,58,.6)"></i>pause</span>' +
      '<span><i style="background:rgba(120,132,160,.6)"></i>energy &amp; breaths</span>'));

    // --------------------------------------------------------------- cards
    const t = D.timing, r = D.rate || {}, p = D.prosody || {},
          v = D.vocabulary || {}, d = D.disfluency || {};
    const fr = d.filled_pauses_estimated_range;
    const cards = [
      ['Speaking rate', (r.words_per_minute ?? '—') + (r.words_per_minute ? ' wpm' : ''),
        r.wpm_local_min != null ? `local ${r.wpm_local_min.toFixed(0)}–${r.wpm_local_max.toFixed(0)}` : ''],
      ['Articulation', (r.articulation_rate_syl_per_s ?? '—') + (r.articulation_rate_syl_per_s ? ' syl/s' : ''), 'while actually speaking'],
      ['Pause ratio', (t.pause_ratio * 100).toFixed(0) + '%', `${t.n_pauses} pauses · ${t.pauses_per_minute}/min`],
      ['Longest pause', (t.pause_longest_s ?? 0).toFixed(2) + 's', ''],
      ['Pitch median', (p.f0_median_hz ?? '—') + (p.f0_median_hz ? ' Hz' : ''), p.pitch_floor_hz ? `range ${p.pitch_floor_hz}–${p.pitch_ceiling_hz} Hz` : ''],
      ['Pitch variation', (p.f0_sd_st ?? '—') + (p.f0_sd_st ? ' st' : ''), p.f0_range_st ? `${p.f0_range_st} st span` : ''],
      ['Energy variation', (p.energy_sd_db ?? '—') + (p.energy_sd_db ? ' dB' : ''), 'this mic only'],
      ['Filled pauses', fr ? (fr[0] === fr[1] ? fr[0] : fr[0] + '–' + fr[1]) : '—', 'lower bound + estimate'],
      ['Repetitions', d.repetition_count ?? '—', ''],
      ['Words', v.total_tokens ?? '—', v.unique_tokens != null ? `${v.unique_tokens} unique` : ''],
      ['Lexical diversity', v.mtld ? v.mtld.toFixed(0) : 'n/a', v.mtld ? 'MTLD' : 'needs 100+ words'],
    ];
    root.appendChild(el('div', 'cards', cards.map(([k, val, n]) =>
      `<div class="card"><div class="k">${k}</div><div class="v">${val}</div><div class="n">${n || ''}</div></div>`).join('')));

    // --------------------------------------------------------------- lists
    function listBlock(title, items, renderRow, seekOf) {
      const box = el('div');
      box.appendChild(el('h2', null, title));
      const list = el('list' in window ? 'div' : 'div', 'list');
      if (!items.length) list.appendChild(el('div', 'empty', 'none'));
      else items.forEach(it => {
        const row = el('div', 'row', renderRow(it));
        const s = seekOf ? seekOf(it) : null;
        if (s != null) row.onclick = () => { seek(Math.max(0, s - 0.35)); audio.play(); };
        else row.style.cursor = 'default';
        list.appendChild(row);
      });
      box.appendChild(list);
      return box;
    }
    const c1 = el('div', 'cols');
    c1.append(
      listBlock('Pauses', D.pauses || [],
        x => `<span class="t">${fmt(x.start)}</span><span>${x.kind}</span><span class="d">${x.duration.toFixed(2)}s</span>`,
        x => x.start),
      listBlock('Breaths & unaccounted audio', unacc,
        x => `<span class="t">${fmt(x.start)}</span><span>${x.kind === 'possible_filler' ? 'possible filler' : 'breath / unvoiced'}</span>` +
             `<span class="d">${x.duration.toFixed(2)}s · voiced ${(x.voiced_ratio * 100).toFixed(0)}%</span>`,
        x => x.start));
    root.appendChild(c1);

    const c2 = el('div', 'cols');
    c2.append(
      listBlock('Discourse markers', (d.discourse_markers || []),
        x => `<span class="t">${fmt(x.time)}</span><span>${esc(x.context)}</span>`,
        x => x.time),
      listBlock('Repeated phrases', (v.repeated_phrases || []),
        x => `<span>&ldquo;${esc(x.phrase)}&rdquo;</span><span class="d">×${x.count}</span>`,
        null));
    root.appendChild(c2);

    // ---------------------------------------------------------- transcript
    const words = (D.transcript && D.transcript.words) || [];
    root.appendChild(el('h2', null, 'Transcript'));
    const tx = el('div', 'tx');
    const gapAfter = new Set();
    (D.pauses || []).forEach(pz => {
      let bi = -1, bd = 1e9;
      words.forEach((w, i) => { const dd = Math.abs(w.end - pz.start); if (dd < bd) { bd = dd; bi = i; } });
      if (bi >= 0 && bd < 0.4) gapAfter.add(bi);
    });
    if (!words.length) tx.appendChild(el('div', 'empty', 'no transcript'));
    words.forEach((w, i) => {
      const s = el('span', gapAfter.has(i) ? 'gap' : null, esc(w.word));
      s.onclick = () => seek(w.start);
      tx.append(s, document.createTextNode(' '));
    });
    root.appendChild(tx);
    const spans = [...tx.querySelectorAll('span')];

    root.appendChild(el('div', 'note',
      'No overall score by design — every figure here is a measurement. Orange bands are ' +
      'pauses, grey blocks under the energy trace are breaths or audio the transcript did ' +
      'not account for, and underlined words are followed by a pause. Click anything to ' +
      'hear it. Space plays, arrows jump 2s.'));

    // ------------------------------------------------------------- drawing
    function layout() {
      const dpr = window.devicePixelRatio || 1;
      const w = Math.max(320, Math.ceil(DUR * pps));
      cv.style.width = w + 'px'; cv.style.height = H + 'px';
      cv.width = w * dpr; cv.height = H * dpr;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      draw();
    }
    function draw() {
      const w = Math.max(320, DUR * pps), ey0 = 118, eyH = 56, py0 = 16, pyH = 92;
      ctx.clearRect(0, 0, w, H);
      ctx.fillStyle = '#171a22'; ctx.fillRect(0, 0, w, H);
      (D.pauses || []).forEach(pz => {
        ctx.fillStyle = pz.kind === 'extended' ? 'rgba(201,139,58,.30)' : 'rgba(201,139,58,.15)';
        ctx.fillRect(pz.start * pps, 0, Math.max(1, pz.duration * pps), H);
      });
      unacc.forEach(b => {
        ctx.fillStyle = b.kind === 'possible_filler' ? 'rgba(224,90,90,.42)' : 'rgba(120,132,160,.30)';
        ctx.fillRect(b.start * pps, ey0, Math.max(1, b.duration * pps), eyH);
      });
      const step = pps > 55 ? 1 : pps > 26 ? 2 : pps > 12 ? 5 : 10;
      ctx.strokeStyle = '#242938'; ctx.fillStyle = '#5d6579';
      ctx.font = '10px ui-monospace,monospace'; ctx.lineWidth = 1;
      for (let s = 0; s <= DUR; s += step) {
        const x = Math.round(s * pps) + .5;
        ctx.beginPath(); ctx.moveTo(x, H - 15); ctx.lineTo(x, H); ctx.stroke();
        if (s % (step * (pps > 26 ? 5 : 2)) === 0) ctx.fillText(fmt(s), x + 3, H - 5);
      }
      const C = D.contours;
      if (C && C.energy_db && C.energy_db.length) {
        const es = C.energy_db.filter(x => x > -90);
        const lo = Math.min(...es), hi = Math.max(...es);
        ctx.fillStyle = 'rgba(120,132,160,.55)';
        ctx.beginPath(); ctx.moveTo(0, ey0 + eyH);
        C.energy_db.forEach((val, i) => {
          const n = Math.max(0, Math.min(1, (val - lo) / ((hi - lo) || 1)));
          ctx.lineTo(i * C.step_s * pps, ey0 + eyH - n * eyH);
        });
        ctx.lineTo(C.energy_db.length * C.step_s * pps, ey0 + eyH);
        ctx.closePath(); ctx.fill();
        const vals = C.f0_st.filter(x => x !== null);
        if (vals.length) {
          const a = Math.min(...vals), b = Math.max(...vals), span = (b - a) || 1;
          const zy = py0 + pyH - ((0 - a) / span) * pyH;
          ctx.strokeStyle = 'rgba(120,132,160,.35)';
          ctx.beginPath(); ctx.moveTo(0, zy); ctx.lineTo(w, zy); ctx.stroke();
          ctx.fillStyle = '#3d6ae0';
          C.f0_st.forEach((val, i) => {
            if (val === null) return;
            const y = py0 + pyH - ((val - a) / span) * pyH;
            ctx.fillRect(i * C.step_s * pps, y - 1.4, Math.max(1.6, C.step_s * pps), 2.8);
          });
          ctx.fillStyle = '#5d6579';
          ctx.fillText(b.toFixed(0) + ' st', 4, py0 + 9);
          ctx.fillText(a.toFixed(0) + ' st', 4, py0 + pyH - 2);
        }
      }
      const x = audio.currentTime * pps;
      ctx.strokeStyle = '#fff'; ctx.lineWidth = 1.5;
      ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, H); ctx.stroke();
    }

    function seek(s) {
      if (!isFinite(s)) return;
      audio.currentTime = Math.max(0, Math.min(DUR - 0.01, s));
      if (audio.paused) draw();
    }
    function fitZoom() {
      const w = wrap.clientWidth || 900;
      pps = Math.max(6, Math.min(90, (w - 4) / Math.max(DUR, 1)));
      layout();
    }

    cv.onclick = e => seek((e.clientX - cv.getBoundingClientRect().left) / pps);
    play.onclick = () => audio.paused ? audio.play() : audio.pause();
    audio.onplay = () => play.textContent = 'Pause';
    audio.onpause = () => play.textContent = 'Play';
    zi.onclick = () => { pps = Math.min(400, pps * 1.6); layout(); };
    zo.onclick = () => { pps = Math.max(4, pps / 1.6); layout(); };

    let cur = -1;
    function tick() {
      const now = audio.currentTime;
      let lo = 0, hi = words.length - 1, f = -1;
      while (lo <= hi) { const m = (lo + hi) >> 1; if (words[m].start <= now) { f = m; lo = m + 1; } else hi = m - 1; }
      if (f !== cur) {
        if (spans[cur]) spans[cur].classList.remove('on');
        if (spans[f]) {
          spans[f].classList.add('on');
          if (follow.firstChild.checked) spans[f].scrollIntoView({ block: 'nearest', behavior: 'smooth' });
        }
        cur = f;
      }
      tc.textContent = fmt(now, true) + ' / ' + fmt(DUR);
      draw();
      if (follow.firstChild.checked && !audio.paused) {
        const x = now * pps;
        if (x < wrap.scrollLeft + 60 || x > wrap.scrollLeft + wrap.clientWidth - 60)
          wrap.scrollLeft = x - wrap.clientWidth / 2;
      }
      raf = requestAnimationFrame(tick);
    }

    const onKey = e => {
      if (e.target.tagName === 'INPUT') return;
      if (e.code === 'Space') { e.preventDefault(); audio.paused ? audio.play() : audio.pause(); }
      if (e.code === 'ArrowLeft') seek(audio.currentTime - 2);
      if (e.code === 'ArrowRight') seek(audio.currentTime + 2);
    };
    addEventListener('keydown', onKey);
    addEventListener('resize', fitZoom);
    audio.addEventListener('loadedmetadata', draw);
    fitZoom(); tick();

    return {
      destroy() {
        cancelAnimationFrame(raf);
        removeEventListener('keydown', onKey);
        removeEventListener('resize', fitZoom);
        audio.pause(); audio.src = '';
      },
      seek, audio,
    };
  }
  return { render, fmt };
})();
