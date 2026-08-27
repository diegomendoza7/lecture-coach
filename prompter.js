'use strict';
const api = window.coach;
const band = document.getElementById('band');
const scroll = document.getElementById('scroll');
const text = document.getElementById('text');
const runLab = document.getElementById('run');
const speedLab = document.getElementById('speed');

let speed = 42;        // px per second
let running = false;
let pos = 0;           // fractional scroll position
let last = 0;

function frame(ts) {
  requestAnimationFrame(frame);
  const dt = last ? Math.min(100, ts - last) : 0;
  last = ts;
  if (!running) return;
  const max = scroll.scrollHeight - scroll.clientHeight;
  pos = Math.min(max, pos + (speed * dt) / 1000);
  scroll.scrollTop = pos;
  if (pos >= max) setRun(false);
}
requestAnimationFrame(frame);

function setRun(v) {
  running = v;
  runLab.textContent = v ? 'SCROLLING' : 'PAUSED';
  runLab.className = 'run' + (v ? '' : ' off');
}

api.prompter.onContent((p) => {
  text.innerHTML = p.html || '';
  document.getElementById('title').textContent = p.title || '';
  document.getElementById('idx').textContent = p.index + '/' + p.total;
  pos = 0;
  scroll.scrollTop = 0;
});

api.prompter.onCfg((c) => {
  if (c.speed != null) { speed = c.speed; speedLab.textContent = speed + ' px/s'; }
  if (c.size != null) text.style.fontSize = c.size + 'px';
  if (c.opacity != null) band.style.background = 'rgba(8,10,14,' + c.opacity + ')';
  if (c.mirror != null) scroll.classList.toggle('mirror', !!c.mirror);
  if (c.reset) { pos = 0; scroll.scrollTop = 0; }
  if (c.toggleRun) setRun(!running);
  else if (c.running != null) setRun(!!c.running);
});

api.ready('prompter');
