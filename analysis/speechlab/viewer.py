"""Render a take into a self-contained HTML report you can click through.

The point of this file is listening. Every measurement in the sidecar is an
assertion about a moment in the audio, and the only way to know whether a
"pause" or a "breath" is really that is to hear it. So every pause, every
breath, every discourse marker and every word is a seek target.

The HTML references the audio by relative path rather than embedding it, so the
report stays small on a 45-minute take. Keep the two files side by side.
"""

from __future__ import annotations

import json
import os
from pathlib import Path

TEMPLATE = r"""<!DOCTYPE html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>__TITLE__</title>
<style>
*{box-sizing:border-box}
body{margin:0;background:#12141a;color:#e6e8ee;font:14px/1.5 -apple-system,BlinkMacSystemFont,"SF Pro Text",system-ui,sans-serif}
.wrap{max-width:1180px;margin:0 auto;padding:28px 22px 80px}
h1{font-size:19px;margin:0 0 2px;font-weight:600}
.sub{color:#8b93a7;font-size:13px;margin-bottom:18px}
.warn{background:#3a2a12;border:1px solid #7a5a20;color:#f0c987;padding:9px 12px;border-radius:7px;margin:12px 0;font-size:13px}
.bar{display:flex;align-items:center;gap:14px;margin:16px 0 10px;flex-wrap:wrap}
button{background:#232734;color:#e6e8ee;border:1px solid #363c4d;border-radius:7px;padding:7px 13px;font-size:13px;cursor:pointer;font-family:inherit}
button:hover{background:#2c3243}
button.play{background:#3d6ae0;border-color:#3d6ae0;min-width:78px;font-weight:500}
button.play:hover{background:#4d78ea}
.time{font-variant-numeric:tabular-nums;color:#9aa3b8;font-size:13px}
.tlwrap{overflow-x:auto;overflow-y:hidden;border:1px solid #262b38;border-radius:9px;background:#171a22}
canvas{display:block;cursor:pointer}
.legend{display:flex;gap:16px;flex-wrap:wrap;color:#8b93a7;font-size:12px;margin:9px 2px 22px}
.legend i{display:inline-block;width:10px;height:10px;border-radius:2px;margin-right:5px;vertical-align:-1px}
.cards{display:grid;grid-template-columns:repeat(auto-fill,minmax(168px,1fr));gap:11px;margin-bottom:26px}
.card{background:#171a22;border:1px solid #262b38;border-radius:9px;padding:12px 13px}
.card .k{color:#8b93a7;font-size:11px;text-transform:uppercase;letter-spacing:.5px;margin-bottom:5px}
.card .v{font-size:21px;font-weight:600;font-variant-numeric:tabular-nums}
.card .n{color:#6f778c;font-size:11.5px;margin-top:3px}
.cols{display:grid;grid-template-columns:1fr 1fr;gap:22px}
@media(max-width:820px){.cols{grid-template-columns:1fr}}
h2{font-size:13px;text-transform:uppercase;letter-spacing:.6px;color:#8b93a7;margin:0 0 9px;font-weight:600}
.list{background:#171a22;border:1px solid #262b38;border-radius:9px;max-height:290px;overflow-y:auto}
.row{display:flex;gap:10px;padding:7px 12px;border-bottom:1px solid #1f242f;cursor:pointer;font-size:13px;align-items:baseline}
.row:last-child{border-bottom:0}
.row:hover{background:#1f2431}
.row .t{color:#6f9ff0;font-variant-numeric:tabular-nums;min-width:44px}
.row .d{color:#8b93a7;margin-left:auto;font-variant-numeric:tabular-nums;font-size:12px}
.empty{padding:14px 12px;color:#6f778c;font-size:13px}
.tx{background:#171a22;border:1px solid #262b38;border-radius:9px;padding:16px 18px;line-height:2.1;margin-top:6px}
.tx span{cursor:pointer;padding:2px 1px;border-radius:3px}
.tx span:hover{background:#2c3243}
.tx span.on{background:#3d6ae0;color:#fff}
.tx span.gap{border-bottom:2px solid #c98b3a}
.note{color:#6f778c;font-size:12.5px;margin-top:26px;border-top:1px solid #262b38;padding-top:14px}
</style></head><body><div class="wrap">
<h1>__TITLE__</h1>
<div class="sub" id="sub"></div>
<div id="warns"></div>

<div class="bar">
  <button class="play" id="play">Play</button>
  <span class="time" id="tc">0:00.0 / 0:00</span>
  <span style="flex:1"></span>
  <button id="zo">&minus;</button><button id="zi">+</button>
  <label class="time"><input type="checkbox" id="follow" checked> follow</label>
</div>

<div class="tlwrap" id="tlwrap"><canvas id="tl"></canvas></div>
<div class="legend">
  <span><i style="background:#3d6ae0"></i>pitch (semitones re your median)</span>
  <span><i style="background:rgba(201,139,58,.6)"></i>pause</span>
  <span><i style="background:rgba(120,132,160,.6)"></i>energy &amp; breaths</span>
</div>

<div class="cards" id="cards"></div>

<div class="cols">
  <div><h2>Pauses</h2><div class="list" id="pauses"></div></div>
  <div><h2>Breaths &amp; unaccounted audio</h2><div class="list" id="breaths"></div></div>
</div>
<div class="cols" style="margin-top:22px">
  <div><h2>Discourse markers</h2><div class="list" id="markers"></div></div>
  <div><h2>Repeated phrases</h2><div class="list" id="repeats"></div></div>
</div>

<h2 style="margin-top:26px">Transcript</h2>
<div class="tx" id="tx"></div>

<div class="note" id="note"></div>
</div>
<audio id="au" src="__AUDIO__" preload="metadata"></audio>
<script>
const D = __DATA__;
const au = document.getElementById('au');
const cv = document.getElementById('tl'), ctx = cv.getContext('2d');
const wrap = document.getElementById('tlwrap');
const DUR = D.source.duration_s;
let pps = Math.max(14, Math.min(90, 940 / DUR));
const H = 190;

const fmt = (t, dec) => {
  const m = Math.floor(t/60), s = t - m*60;
  return m + ':' + (dec ? (s<10?'0':'')+s.toFixed(1) : String(Math.floor(s)).padStart(2,'0'));
};

function layout(){
  const dpr = window.devicePixelRatio || 1;
  const w = Math.max(320, Math.ceil(DUR * pps));
  cv.style.width = w+'px'; cv.style.height = H+'px';
  cv.width = w*dpr; cv.height = H*dpr;
  ctx.setTransform(dpr,0,0,dpr,0,0);
  draw();
}

function draw(){
  const w = DUR*pps, ey0 = 118, eyH = 56, py0 = 16, pyH = 92;
  ctx.clearRect(0,0,w,H);
  ctx.fillStyle = '#171a22'; ctx.fillRect(0,0,w,H);

  // pause bands
  for(const p of D.pauses){
    ctx.fillStyle = p.kind==='extended' ? 'rgba(201,139,58,.30)' : 'rgba(201,139,58,.15)';
    ctx.fillRect(p.start*pps, 0, Math.max(1,p.duration*pps), H);
  }
  // breath / unaccounted ticks
  for(const b of (D.unaccounted||[])){
    ctx.fillStyle = b.kind==='possible_filler' ? 'rgba(224,90,90,.42)' : 'rgba(120,132,160,.30)';
    ctx.fillRect(b.start*pps, ey0, Math.max(1,b.duration*pps), eyH);
  }

  // time ruler
  const step = pps>55?1:pps>26?2:pps>12?5:10;
  ctx.strokeStyle='#242938'; ctx.fillStyle='#5d6579'; ctx.font='10px ui-monospace,monospace'; ctx.lineWidth=1;
  for(let t=0;t<=DUR;t+=step){
    const x=Math.round(t*pps)+.5;
    ctx.beginPath(); ctx.moveTo(x,H-15); ctx.lineTo(x,H); ctx.stroke();
    if(t % (step*(pps>26?5:2)) === 0) ctx.fillText(fmt(t,false), x+3, H-5);
  }

  const C = D.contours;
  if(C && C.energy_db && C.energy_db.length){
    // energy envelope
    const es = C.energy_db.filter(v=>v>-90);
    const lo = Math.min(...es), hi = Math.max(...es);
    ctx.fillStyle='rgba(120,132,160,.55)';
    ctx.beginPath(); ctx.moveTo(0, ey0+eyH);
    C.energy_db.forEach((v,i)=>{
      const n = Math.max(0,Math.min(1,(v-lo)/((hi-lo)||1)));
      ctx.lineTo(i*C.step_s*pps, ey0+eyH-n*eyH);
    });
    ctx.lineTo(C.energy_db.length*C.step_s*pps, ey0+eyH); ctx.closePath(); ctx.fill();

    // pitch, in semitones about the median
    const vals = C.f0_st.filter(v=>v!==null);
    if(vals.length){
      const a = Math.min(...vals), b = Math.max(...vals), span=(b-a)||1;
      // zero line = the speaker's median pitch
      const zy = py0+pyH-((0-a)/span)*pyH;
      ctx.strokeStyle='rgba(120,132,160,.35)';
      ctx.beginPath(); ctx.moveTo(0,zy); ctx.lineTo(w,zy); ctx.stroke();
      ctx.fillStyle='#3d6ae0';
      C.f0_st.forEach((v,i)=>{
        if(v===null) return;
        const y = py0+pyH-((v-a)/span)*pyH;
        ctx.fillRect(i*C.step_s*pps, y-1.4, Math.max(1.6,C.step_s*pps), 2.8);
      });
      ctx.fillStyle='#5d6579'; ctx.font='10px ui-monospace,monospace';
      ctx.fillText(b.toFixed(0)+' st', 4, py0+9);
      ctx.fillText(a.toFixed(0)+' st', 4, py0+pyH-2);
    }
  }
  // playhead
  const x = au.currentTime*pps;
  ctx.strokeStyle='#fff'; ctx.lineWidth=1.5;
  ctx.beginPath(); ctx.moveTo(x,0); ctx.lineTo(x,H); ctx.stroke();
}

function seek(t){ au.currentTime = Math.max(0, Math.min(DUR-0.01, t)); if(au.paused) draw(); }
cv.addEventListener('click', e => seek((e.clientX - cv.getBoundingClientRect().left)/pps));

document.getElementById('play').onclick = () => au.paused ? au.play() : au.pause();
au.addEventListener('play', ()=>document.getElementById('play').textContent='Pause');
au.addEventListener('pause',()=>document.getElementById('play').textContent='Play');
document.getElementById('zi').onclick = ()=>{pps=Math.min(400,pps*1.6);layout();};
document.getElementById('zo').onclick = ()=>{pps=Math.max(4,pps/1.6);layout();};
addEventListener('keydown', e=>{
  if(e.code==='Space'){e.preventDefault(); au.paused?au.play():au.pause();}
  if(e.code==='ArrowLeft') seek(au.currentTime-2);
  if(e.code==='ArrowRight') seek(au.currentTime+2);
});

// transcript
const words = (D.transcript && D.transcript.words) || [];
const tx = document.getElementById('tx');
const gapAfter = new Set();
for(const p of D.pauses){
  let bi=-1, bd=1e9;
  words.forEach((w,i)=>{const d=Math.abs(w.end-p.start); if(d<bd){bd=d;bi=i;}});
  if(bi>=0 && bd<0.4) gapAfter.add(bi);
}
words.forEach((w,i)=>{
  const s=document.createElement('span');
  s.textContent=w.word; s.dataset.i=i;
  if(gapAfter.has(i)) s.className='gap';
  s.onclick=()=>seek(w.start);
  tx.appendChild(s); tx.appendChild(document.createTextNode(' '));
});
const spans=[...tx.querySelectorAll('span')];
let cur=-1;
function tick(){
  const t=au.currentTime;
  let lo=0,hi=words.length-1,f=-1;
  while(lo<=hi){const m=(lo+hi)>>1; if(words[m].start<=t){f=m;lo=m+1;}else hi=m-1;}
  if(f!==cur){
    if(spans[cur])spans[cur].classList.remove('on');
    if(spans[f]){spans[f].classList.add('on');
      if(document.getElementById('follow').checked)
        spans[f].scrollIntoView({block:'nearest',behavior:'smooth'});}
    cur=f;
  }
  document.getElementById('tc').textContent=fmt(t,true)+' / '+fmt(DUR,false);
  draw();
  if(document.getElementById('follow').checked && !au.paused){
    const x=t*pps;
    if(x<wrap.scrollLeft+60||x>wrap.scrollLeft+wrap.clientWidth-60)
      wrap.scrollLeft=x-wrap.clientWidth/2;
  }
  requestAnimationFrame(tick);
}

// lists
function fill(id, items, render){
  const el=document.getElementById(id);
  if(!items.length){el.innerHTML='<div class="empty">none</div>';return;}
  el.innerHTML='';
  for(const it of items){
    const r=document.createElement('div'); r.className='row'; r.innerHTML=render(it);
    r.onclick=()=>{seek(Math.max(0,(it.start??it.time??0)-0.35)); au.play();};
    el.appendChild(r);
  }
}
fill('pauses', D.pauses, p=>`<span class="t">${fmt(p.start,false)}</span><span>${p.kind}</span><span class="d">${p.duration.toFixed(2)}s</span>`);
fill('breaths', D.unaccounted||[], b=>`<span class="t">${fmt(b.start,false)}</span><span>${b.kind==='possible_filler'?'possible filler':'breath / unvoiced'}</span><span class="d">${b.duration.toFixed(2)}s · voiced ${(b.voiced_ratio*100).toFixed(0)}%</span>`);
fill('markers', (D.disfluency&&D.disfluency.discourse_markers)||[], m=>`<span class="t">${fmt(m.time,false)}</span><span>${m.context}</span>`);
const reps=((D.vocabulary&&D.vocabulary.repeated_phrases)||[]).map(r=>({...r,start:null}));
const rel=document.getElementById('repeats');
if(!reps.length){rel.innerHTML='<div class="empty">none</div>';}
else rel.innerHTML=reps.map(r=>`<div class="row"><span>&ldquo;${r.phrase}&rdquo;</span><span class="d">x${r.count}</span></div>`).join('');

// header + cards
document.getElementById('sub').textContent =
  `${fmt(DUR,false)} · ${D.quality.snr_db} dB SNR · peak ${D.quality.peak_dbfs} dBFS · analysed ${D.generated_at.slice(0,16).replace('T',' ')}`;
document.getElementById('warns').innerHTML =
  (D.quality.warnings||[]).map(w=>`<div class="warn">${w}</div>`).join('');
const t=D.timing, r=D.rate||{}, p=D.prosody||{}, v=D.vocabulary||{}, d=D.disfluency||{};
const fr=d.filled_pauses_estimated_range;
const cards=[
  ['Speaking rate', (r.words_per_minute??'-')+' wpm', r.wpm_local_min?`local ${r.wpm_local_min.toFixed(0)}-${r.wpm_local_max.toFixed(0)}`:''],
  ['Articulation', (r.articulation_rate_syl_per_s??'-')+' syl/s', 'while actually speaking'],
  ['Pause ratio', (t.pause_ratio*100).toFixed(0)+'%', `${t.n_pauses} pauses, ${t.pauses_per_minute}/min`],
  ['Longest pause', (t.pause_longest_s??0).toFixed(2)+'s', ''],
  ['Pitch median', (p.f0_median_hz??'-')+' Hz', `floor ${p.pitch_floor_hz} - ceil ${p.pitch_ceiling_hz}`],
  ['Pitch variation', (p.f0_sd_st??'-')+' st', `range ${p.f0_range_st??'-'} st`],
  ['Energy variation', (p.energy_sd_db??'-')+' dB', 'this mic only'],
  ['Filled pauses', fr?(fr[0]===fr[1]?fr[0]:fr[0]+'-'+fr[1]):'-', 'lower bound + estimate'],
  ['Repetitions', d.repetition_count??'-', ''],
  ['Words', v.total_tokens??'-', `${v.unique_tokens??'-'} unique`],
  ['Lexical diversity', v.mtld?v.mtld.toFixed(0):'n/a', v.mtld?'MTLD':'needs 100+ words'],
];
document.getElementById('cards').innerHTML = cards.map(([k,val,n])=>
  `<div class="card"><div class="k">${k}</div><div class="v">${val}</div><div class="n">${n||''}</div></div>`).join('');
document.getElementById('note').textContent =
  'No overall score by design - every figure here is a measurement. Orange bands are pauses, '+
  'grey blocks under the energy trace are breaths or audio the transcript did not account for, '+
  'and underlined words are followed by a pause. Click anything to hear it. '+
  'Space plays, arrows jump 2s.';

addEventListener('resize', layout);
au.addEventListener('loadedmetadata', layout);
layout(); tick();
</script></body></html>
"""


def render(report: dict, out_path: str | Path, audio_path: str | Path | None = None) -> Path:
    out_path = Path(out_path)
    audio = Path(audio_path or report["source"]["path"])
    try:
        rel = os.path.relpath(audio, out_path.parent)
    except ValueError:
        rel = str(audio)

    data = {
        "source": report["source"],
        "generated_at": report["generated_at"],
        "quality": report["quality"],
        "timing": report["timing"],
        "pauses": report["pauses"],
        "contours": report.get("contours", {}),
        "prosody": report.get("prosody", {}),
        "rate": report.get("rate", {}),
        "vocabulary": report.get("vocabulary", {}),
        "transcript": report.get("transcript", {}),
        "disfluency": report.get("disfluency", {}),
        "unaccounted": report.get("disfluency", {}).get("unaccounted_regions", []),
    }
    blob = json.dumps(data).replace("</", "<\\/")
    html = (
        TEMPLATE.replace("__DATA__", blob)
        .replace("__TITLE__", audio.name)
        .replace("__AUDIO__", rel.replace("\\", "/"))
    )
    out_path.write_text(html)
    return out_path
