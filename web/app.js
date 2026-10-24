// Pulsar Touch — browser host: hardware replica, display, audio plumbing.
// The synthesis lives in engine/ (portable); this file is the "board".
'use strict';

const $ = (id) => document.getElementById(id);
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));

const ctl = new PulsarControls();
const params = new PulsarParams();
let viewCore = new PulsarCore(48000);     // main-thread instance: drawing + kernel building
let ctx = null, node = null, analyser = null, micSrc = null, micStream = null;
let sample = null;                        // Float32Array mono at ctx rate
let kernelKey = '', kernelDirtyAt = 0;
const pulses = [];                        // {t, r} from the worklet
let pulseCount = 0, lastPulseT = -1, inPeak = 0;

// ------------------------------------------------------------------ layout
// Positions in % of the board (from the Simple Touch photo, 600 x 972).
const PADS = [
  { id: 0, x: 24, y: 63.8, small: 1, label: 'P00', sub: 'oct −' },
  { id: 1, x: 51.7, y: 62.6, small: 1, label: 'P01', sub: 'conv' },
  { id: 2, x: 75, y: 63.8, small: 1, label: 'P02', sub: 'oct +' },
  { id: 3, x: 10.5, y: 82.3 }, { id: 4, x: 29, y: 78.4 }, { id: 5, x: 48, y: 82 },
  { id: 6, x: 68, y: 80.8 }, { id: 7, x: 89.5, y: 85.6 }, { id: 8, x: 31.7, y: 93.6 },
  { id: 9, x: 68, y: 94.2 },
  { id: 10, x: 38.7, y: 5, small: 1, label: 'P10', sub: 'TO' },
  { id: 11, x: 62.2, y: 5, small: 1, label: 'P11', sub: 'CH' },
];
const KNOBS = [ // index = PC.K_*
  { x: 21.2, y: 49.5 }, { x: 21.2, y: 35.5 }, { x: 40.8, y: 35.5 }, { x: 60.3, y: 35.5 },
  { x: 79.2, y: 35.5 }, { x: 79.2, y: 49.5 },
];
const FADERS = [{ i: 6, x: 6.5, y: 42 }, { i: 7, x: 93.5, y: 42 }];
const SWITCHES = [
  { i: PC.SW_RANGE, x: 37.8, y: 66, id: 'S09/10', names: PC.RANGE_NAMES },
  { i: PC.SW_MASK, x: 53.5, y: 72.5, id: 'S07/08', names: PC.MASK_NAMES },
];

const board = $('board');
const padEls = [], knobEls = [], faderEls = [], swEls = [];

function el(tag, cls, parent, html) {
  const e = document.createElement(tag); if (cls) e.className = cls;
  if (html != null) e.innerHTML = html; if (parent) parent.appendChild(e); return e;
}

function buildBoard() {
  for (const p of PADS) {
    const e = el('div', 'pad' + (p.small ? ' small' : ''), board);
    e.style.left = p.x + '%'; e.style.top = p.y + '%';
    el('div', 'fill', e);
    const l = el('div', 'lbl', e, (p.label || 'P0' + p.id) + '<small></small>');
    e._sub = l.querySelector('small'); e._fill = e.querySelector('.fill'); e._def = p.sub || '';
    padEls[p.id] = e; bindPad(e, p.id);
  }
  KNOBS.forEach((k, i) => {
    const e = el('div', 'knob', board);
    e.style.left = k.x + '%'; e.style.top = k.y + '%';
    e.innerHTML = `<svg viewBox="-50 -50 100 100">
      <circle r="40" fill="#1b1b1e" stroke="#333" stroke-width="2"/>
      <path class="trk" fill="none" stroke="#2c2c30" stroke-width="6" stroke-linecap="round"/>
      <path class="val" fill="none" stroke="var(--gold)" stroke-width="6" stroke-linecap="round"/>
      <line class="ptr" x1="0" y1="0" x2="0" y2="-30" stroke="#eee" stroke-width="5" stroke-linecap="round"/>
      </svg><span class="name"><b></b><span></span></span>`;
    e.querySelector('.trk').setAttribute('d', arc(-135, 135, 46));
    e._val = e.querySelector('.val'); e._ptr = e.querySelector('.ptr');
    e._b = e.querySelector('.name b'); e._s = e.querySelector('.name span');
    knobEls[i] = e; bindDrag(e, i, 0.005);
  });
  for (const f of FADERS) {
    const e = el('div', 'fader', board);
    e.style.left = f.x + '%'; e.style.top = f.y + '%';
    e.innerHTML = '<div class="track"></div><div class="fill"></div><div class="cap"></div><span class="name"><b></b><span></span></span>';
    e._fill = e.querySelector('.fill'); e._cap = e.querySelector('.cap');
    e._b = e.querySelector('.name b'); e._s = e.querySelector('.name span');
    faderEls[f.i] = e; bindFader(e, f.i);
  }
  for (const s of SWITCHES) {
    const e = el('div', 'sw', board);
    e.style.left = s.x + '%'; e.style.top = s.y + '%';
    e.innerHTML = '<div class="lever"></div>';
    e.title = s.id + ': ' + s.names.join(' / ');
    e._lever = e.querySelector('.lever'); e._names = s.names;
    e._label = el('div', 'swlabel', board);
    const side = s.i === PC.SW_MASK; // mask switch label sits to the right, clear of P05
    Object.assign(e._label.style, { position: 'absolute', left: (side ? s.x + 5.5 : s.x) + '%', top: (side ? s.y + 2.5 : s.y + 6.4) + '%', transform: side ? 'none' : 'translateX(-50%)',
      font: '600 10px ui-monospace, Menlo, monospace', color: 'var(--gold)', pointerEvents: 'none', whiteSpace: 'nowrap' });
    e.addEventListener('pointerdown', (ev) => {
      const r = e.getBoundingClientRect(), pos = clamp(Math.floor((ev.clientY - r.top) / r.height * 3), 0, 2);
      ctl.setSwitch(s.i, pos); ensureAudio();
    });
    swEls[s.i] = e;
  }
}

function arc(a0, a1, r) {
  const p = (a) => [Math.sin(a * Math.PI / 180) * r * 0.9, -Math.cos(a * Math.PI / 180) * r * 0.9];
  const [x0, y0] = p(a0), [x1, y1] = p(a1);
  return `M${x0.toFixed(2)},${y0.toFixed(2)} A${r * 0.9},${r * 0.9} 0 ${a1 - a0 > 180 ? 1 : 0} 1 ${x1.toFixed(2)},${y1.toFixed(2)}`;
}

// ------------------------------------------------------------------ input
const altActive = () => ctl.toHeld();

const chActive = (i) => !altActive() && ctl.chHeld() && PC.CH_KNOBS.indexOf(i) >= 0; // P11: S35 input gain, faders = filter
function writeKnob(i, v) {
  v = clamp(v, 0, 1);
  if (altActive()) { ctl.alt[i] = v; ctl.modUsed[0] = true; }
  else if (chActive(i)) { ctl.ch[i] = v; ctl.modUsed[1] = true; }
  else ctl.knob[i] = v;
}
function readKnob(i) { return altActive() ? ctl.alt[i] : chActive(i) ? ctl.ch[i] : ctl.knob[i]; }

function bindDrag(e, i, sens) {
  let startY = 0, startV = 0, id = null, lastTap = 0;
  e.addEventListener('pointerdown', (ev) => {
    id = ev.pointerId; e.setPointerCapture(id); startY = ev.clientY; startV = readKnob(i);
    const now = performance.now();
    if (now - lastTap < 300) writeKnob(i, altActive() ? new PulsarControls().alt[i] : new PulsarControls().knob[i]);
    lastTap = now; ev.preventDefault();
  });
  e.addEventListener('pointermove', (ev) => {
    if (ev.pointerId !== id) return;
    writeKnob(i, startV + (startY - ev.clientY) * sens * (ev.altKey ? 0.2 : 1));
  });
  const end = (ev) => { if (ev.pointerId === id) id = null; };
  e.addEventListener('pointerup', end); e.addEventListener('pointercancel', end);
}

function bindFader(e, i) {
  let id = null;
  const set = (ev) => { const r = e.getBoundingClientRect(); writeKnob(i, 1 - (ev.clientY - r.top) / r.height); };
  e.addEventListener('pointerdown', (ev) => { id = ev.pointerId; e.setPointerCapture(id); set(ev); ev.preventDefault(); });
  e.addEventListener('pointermove', (ev) => { if (ev.pointerId === id) set(ev); });
  const end = (ev) => { if (ev.pointerId === id) id = null; };
  e.addEventListener('pointerup', end); e.addEventListener('pointercancel', end);
}

// Pad pressure: Pencil/pen pressure when available, otherwise the touch
// position inside the pad (top edge = full pressure). Mirrors MPR121 delta.
function padPressure(e, ev) {
  if (ev.pointerType === 'pen' && ev.pressure > 0) return clamp(ev.pressure, 0.05, 1);
  const r = e.getBoundingClientRect();
  return clamp(1.15 - (ev.clientY - r.top) / r.height, 0.1, 1);
}
function bindPad(e, i) {
  const ids = new Set();
  e.addEventListener('pointerdown', (ev) => {
    ensureAudio(); e.setPointerCapture(ev.pointerId); ids.add(ev.pointerId);
    if (ids.size === 1) ctl.padDown(i, padPressure(e, ev));
    ev.preventDefault();
  });
  e.addEventListener('pointermove', (ev) => { if (ids.has(ev.pointerId)) ctl.padMove(i, padPressure(e, ev)); });
  const up = (ev) => { if (!ids.delete(ev.pointerId)) return; if (!ids.size) ctl.padUp(i); };
  e.addEventListener('pointerup', up); e.addEventListener('pointercancel', up);
}

const KEYS = { a: 3, s: 4, d: 5, f: 6, g: 7, h: 8, j: 9, z: 0, x: 1, c: 2, q: 10, w: 11 };
window.addEventListener('keydown', (ev) => {
  if (ev.repeat || ev.metaKey || ev.ctrlKey || ev.target.tagName === 'SELECT' || ev.target.tagName === 'INPUT') return;
  const k = ev.key.toLowerCase();
  if (ev.key === 'Shift') { ctl.padDown(10, 0.7); return; }
  if (k === ' ') { ctl.padDown(10, .7); ctl.padDown(11, .7); ctl.padUp(11); ctl.padUp(10); ev.preventDefault(); return; }
  if ('123'.includes(k) && k) { ctl.setSwitch(PC.SW_RANGE, +k - 1); return; }
  if ('890'.includes(k) && k) { ctl.setSwitch(PC.SW_MASK, k === '0' ? 2 : +k - 8); return; }
  if (k in KEYS) { ensureAudio(); ctl.padDown(KEYS[k], 0.7); }
});
window.addEventListener('keyup', (ev) => {
  const k = ev.key.toLowerCase();
  if (ev.key === 'Shift') { ctl.padUp(10); return; }
  if (k in KEYS) ctl.padUp(KEYS[k]);
});
window.addEventListener('blur', () => { for (let i = 0; i < 12; i++) ctl.padUp(i); });

// ------------------------------------------------------------------ audio
async function ensureAudio() {
  if (ctx) { if (ctx.state !== 'running') ctx.resume(); return; }
  ctx = new (window.AudioContext || window.webkitAudioContext)({ latencyHint: 'interactive' });
  const [core, wk] = await Promise.all([
    fetch('engine/pulsar-core.js', { cache: 'no-store' }).then((r) => r.text()),
    fetch('engine/pulsar-worklet.js', { cache: 'no-store' }).then((r) => r.text()),
  ]);
  const url = URL.createObjectURL(new Blob([core, '\n', wk], { type: 'application/javascript' }));
  await ctx.audioWorklet.addModule(url);
  node = new AudioWorkletNode(ctx, 'pulsar', { numberOfInputs: 1, numberOfOutputs: 1, outputChannelCount: [2] });
  analyser = ctx.createAnalyser(); analyser.fftSize = 4096; analyser.smoothingTimeConstant = 0.6;
  node.connect(analyser); analyser.connect(ctx.destination);
  node.port.onmessage = onWorklet;
  viewCore = new PulsarCore(ctx.sampleRate);
  if (sample && sample._sr !== ctx.sampleRate) loadDemo($('demoSample').value || 'kwee');
  kernelKey = '';
  $('power').textContent = 'Audio on'; $('power').classList.remove('primary'); $('power').classList.add('on');
}

function onWorklet(e) {
  const m = e.data;
  if (m.type === 'pulses') {
    pulseCount = m.count; inPeak = m.inPeak || 0;
    for (let k = 0; k < m.n; k++) {
      pulses.push({ t: m.times[k], r: m.routes[k] });
      if (m.routes[k]) lastPulseT = m.times[k];
    }
    if (pulses.length > 6000) pulses.splice(0, pulses.length - 6000);
  } else if (m.type === 'rec') {
    if (m.data.length > 256) setSample(m.data, ctx.sampleRate, 'recorded');
  }
}

$('power').addEventListener('click', async () => {
  if (!ctx) return ensureAudio();
  if (ctx.state === 'running') { await ctx.suspend(); $('power').textContent = 'Audio off'; $('power').classList.remove('on'); }
  else { await ctx.resume(); $('power').textContent = 'Audio on'; $('power').classList.add('on'); }
});

$('mic').addEventListener('click', async () => {
  await ensureAudio();
  if (micStream) {
    micStream.getTracks().forEach((t) => t.stop()); micSrc.disconnect(); micStream = micSrc = null;
    $('mic').textContent = 'Enable input'; $('mic').classList.remove('on'); return;
  }
  try {
    micStream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false } });
    micSrc = ctx.createMediaStreamSource(micStream); micSrc.connect(node);
    $('mic').textContent = 'Input on'; $('mic').classList.add('on');
    toast('Input ready — hold P01 to record');
  } catch (err) { toast('Input unavailable: ' + err.message); }
});

// ------------------------------------------------------------------ MIDI
// Raw bytes go straight into PulsarControls.midi() — the same entry point the
// Daisy USB-MIDI handler and the iPad CoreMIDI/AUv3 host will use.
let midiAccess = null, midiSeenAt = -1;
function onMidiMessage(e) {
  const [st, d1 = 0, d2 = 0] = e.data;
  const t = (e.timeStamp || performance.now()) / 1000;
  if (st < 0xF8) { midiSeenAt = t; if ((st & 0xF0) === 0x90 && d2 > 0) ensureAudio(); }
  ctl.midi(st, d1, d2, t);
}
function refreshMidiInputs() {
  const names = [];
  midiAccess.inputs.forEach((inp) => { inp.onmidimessage = onMidiMessage; names.push(inp.name); });
  $('midiStatus').textContent = names.length ? 'Listening (omni): ' + names.join(', ') : 'No MIDI inputs found — plug one in';
}
$('midiBtn').addEventListener('click', async () => {
  if (midiAccess) { refreshMidiInputs(); return; }
  if (!navigator.requestMIDIAccess) { $('midiStatus').textContent = 'This browser has no Web MIDI (use Chrome or Edge on a computer).'; return; }
  try {
    midiAccess = await navigator.requestMIDIAccess();
    midiAccess.onstatechange = refreshMidiInputs;
    refreshMidiInputs();
    $('midiBtn').textContent = 'MIDI on'; $('midiBtn').classList.add('on');
  } catch (err) { $('midiStatus').textContent = 'MIDI access denied: ' + err.message; }
});
$('rootFromMidi').addEventListener('change', (e) => { ctl.rootFromMidi = e.target.checked; });
$('bendRange').addEventListener('change', (e) => { ctl.bendRange = clamp(+e.target.value || 0, 0, 24); });

// ------------------------------------------------------------------ samples
function setSample(data, sr, name) {
  const max = Math.floor(sr * 2);
  sample = data.length > max ? data.slice(0, max) : data;
  sample._sr = sr; sample._name = name; kernelKey = '';
  drawSample();
  if (!ctl.convOn) { ctl.convOn = true; toast('Sample “' + name + '” loaded · convolve on'); }
}

const DEMOS = {
  kwee: 'Voice “kwee” (Fig. 10)', wood: 'Wood knock', metal: 'Metal bar', noise: 'Noise hit', chirp: 'Bird chirp',
};
for (const [k, v] of Object.entries(DEMOS)) el('option', '', $('demoSample'), v).value = k;
$('demoSample').addEventListener('change', (e) => { if (e.target.value) loadDemo(e.target.value); });

function loadDemo(name) {
  const sr = ctx ? ctx.sampleRate : 48000, rnd = () => Math.random() * 2 - 1;
  let n, d;
  const reson = (x, f, bw) => { // 2-pole resonator, in place
    const r = Math.exp(-Math.PI * bw / sr), c = 2 * r * Math.cos(2 * Math.PI * f / sr);
    let y1 = 0, y2 = 0; for (let i = 0; i < x.length; i++) { const y = x[i] * (1 - r) + c * y1 - r * r * y2; y2 = y1; y1 = y; x[i] = y; }
  };
  if (name === 'wood') {
    n = sr * 0.25; d = new Float32Array(n);
    for (let i = 0; i < n; i++) { const t = i / sr;
      d[i] = Math.sin(2 * Math.PI * 420 * t) * Math.exp(-t * 40) + 0.6 * Math.sin(2 * Math.PI * 1180 * t) * Math.exp(-t * 70) +
             0.3 * Math.sin(2 * Math.PI * 2650 * t) * Math.exp(-t * 120) + (i < sr * 0.002 ? rnd() * 0.8 : 0); }
  } else if (name === 'metal') {
    n = sr * 1.2; d = new Float32Array(n);
    const ratios = [1, 2.76, 5.4, 8.93, 13.34];
    for (let i = 0; i < n; i++) { const t = i / sr; let v = 0;
      ratios.forEach((r, k) => { v += Math.sin(2 * Math.PI * 520 * r * t) * Math.exp(-t * (2.5 + k * 2)) / (k + 1); }); d[i] = v; }
  } else if (name === 'noise') {
    n = sr * 0.15; d = new Float32Array(n);
    for (let i = 0; i < n; i++) d[i] = rnd() * Math.exp(-i / (sr * 0.03));
  } else if (name === 'chirp') {
    n = sr * 0.3; d = new Float32Array(n); let ph = 0;
    for (let i = 0; i < n; i++) { const t = i / sr, tt = (t % 0.15) / 0.15;
      ph += (2000 + 2600 * tt * tt) / sr; d[i] = Math.sin(2 * Math.PI * ph) * Math.sin(Math.PI * tt) ** 2; }
  } else { // "kwee": /k/ burst + glottal source through moving formants /u/ -> /i/
    n = Math.floor(sr * 0.45); d = new Float32Array(n);
    const src = new Float32Array(n); let ph = 0;
    for (let i = 0; i < n; i++) { const t = i / sr;
      if (t < 0.025) { src[i] = rnd() * 0.5 * (1 - t / 0.025); continue; }
      ph += (190 + 40 * (t / 0.45)) / sr; if (ph >= 1) ph -= 1; src[i] = (ph < 0.08 ? 1 : 0) - 0.08; }
    const seg = (a, f0, f1, bw) => { // piecewise resonator with sliding formant
      const out = new Float32Array(n), blk = 256;
      for (let s = 0; s < n; s += blk) { const t = s / n, f = f0 + (f1 - f0) * Math.min(1, Math.max(0, (t - 0.1) / 0.5));
        const x = src.slice(s, s + blk); reson(x, f, bw); for (let i = 0; i < x.length; i++) out[s + i] = x[i] * a; }
      return out; };
    const F1 = seg(1, 320, 280, 80), F2 = seg(0.7, 750, 2300, 120), F3 = seg(0.35, 2400, 3000, 180);
    for (let i = 0; i < n; i++) { const t = i / n; d[i] = (F1[i] + F2[i] + F3[i]) * Math.min(1, t * 30) * Math.min(1, (1 - t) * 6); }
  }
  let pk = 1e-9; for (const v of d) pk = Math.max(pk, Math.abs(v)); for (let i = 0; i < d.length; i++) d[i] /= pk;
  setSample(d, sr, DEMOS[name]);
}

$('file').addEventListener('change', async (e) => {
  const f = e.target.files[0]; if (!f) return; await ensureAudio();
  try {
    const buf = await ctx.decodeAudioData(await f.arrayBuffer());
    const n = buf.length, d = new Float32Array(n);
    for (let c = 0; c < buf.numberOfChannels; c++) { const ch = buf.getChannelData(c); for (let i = 0; i < n; i++) d[i] += ch[i] / buf.numberOfChannels; }
    setSample(d, ctx.sampleRate, f.name);
  } catch (err) { toast('Could not decode ' + f.name); }
});

// Rebuild kernel = pulsaret (*) sample when the pulsaret settles (debounced).
function maybeRebuildKernel(now) {
  if (!node || !sample || !ctl.convOn) return;
  const fd = clamp(params.formantHz[0], 30, 8000);
  const key = [params.shape.toFixed(2), params.window.toFixed(2), params.cluster.toFixed(2), params.fold.toFixed(2), Math.round(fd), sample.length, sample._name].join('|');
  if (key !== kernelKey) { kernelKey = key; kernelDirtyAt = now; return; }
  if (kernelDirtyAt && now - kernelDirtyAt > 0.12) {
    kernelDirtyAt = 0;
    viewCore.setParams(params);
    const sr = ctx.sampleRate, pl = new Float32Array(Math.floor(sr * 0.5));
    const n = viewCore.renderPulsaret(fd, pl, pl.length);
    const k = psConvolveKernel(pl, n, sample, sample.length, Math.floor(sr * PS.MAX_KERNEL_SEC));
    node.port.postMessage({ type: 'kernel', data: k }, [k.buffer]);
  }
}

// ------------------------------------------------------------------ drawing
function fitCanvas(c) {
  if (!c.dataset.h) { c.dataset.h = c.getAttribute('height'); c.style.height = c.dataset.h + 'px'; }
  const dpr = window.devicePixelRatio || 1, w = c.clientWidth, h = +c.dataset.h;
  if (c.width !== Math.round(w * dpr) || c.height !== Math.round(h * dpr)) {
    c.width = Math.round(w * dpr); c.height = Math.round(h * dpr);
  }
  const g = c.getContext('2d'); g.setTransform(dpr, 0, 0, dpr, 0, 0); return [g, w, h];
}

let pulsaretKey = '';
function drawPulsaret() {
  const fd = params.formantHz[0], p = 1 / params.fundHz, d = params.cluster / fd;
  const key = [params.shape, params.window, params.cluster, params.fold, fd.toFixed(1), params.fundHz.toFixed(2), $('cvPulsaret').clientWidth].join();
  if (key === pulsaretKey) return; pulsaretKey = key;
  const [g, w, h] = fitCanvas($('cvPulsaret'));
  g.clearRect(0, 0, w, h);
  viewCore.setParams(params);
  // span shows d against p; when p is much longer, zoom so d fills ~70% (p marked off-screen)
  const span = d > p ? d * 1.05 : Math.min(p * 1.05, d / 0.7);
  const mid = h / 2, amp = h * 0.42, px = (t) => t / span * w;
  // period marker
  g.fillStyle = 'rgba(241,211,107,.06)'; g.fillRect(0, 0, px(p), h);
  g.strokeStyle = '#5b4d1e'; g.setLineDash([3, 3]); g.beginPath(); g.moveTo(px(p), 0); g.lineTo(px(p), h); g.stroke();
  // window
  g.strokeStyle = '#3d6f6b'; g.beginPath();
  for (let x = 0; x <= px(d); x++) { const y = mid - viewCore.windowAt(x / px(d)) * amp; x ? g.lineTo(x, y) : g.moveTo(x, y); }
  g.stroke(); g.setLineDash([]);
  // pulsaret: `cluster` cycles of w under the window, over duration d
  g.strokeStyle = '#f1d36b'; g.lineWidth = 1.5; g.beginPath();
  const wd = Math.max(1, px(d)), steps = Math.max(wd, params.cluster * 64);
  for (let k = 0; k <= steps; k++) { const t = k / steps, x = t * wd;
    const y = mid - viewCore.shapeAt(t * params.cluster) * viewCore.windowAt(t) * amp; k ? g.lineTo(x, y) : g.moveTo(x, y); }
  g.lineTo(w, mid); g.stroke(); g.lineWidth = 1;
  g.fillStyle = '#8a7530'; g.font = '10px ui-monospace, Menlo, monospace';
  if (px(p) <= w) g.fillText('p', px(p) + 3, 11); else g.fillText('p →', w - 24, 11);
  const ms = (s) => s < 0.001 ? (s * 1e6).toFixed(0) + ' µs' : s < 1 ? (s * 1000).toFixed(s < 0.01 ? 2 : 1) + ' ms' : s.toFixed(2) + ' s';
  const mode = params.edge > 0.5 ? 'overlap (OPulWM)' : 'cut (PulWM)';
  $('dDuty').textContent = `d ${ms(d)} · p ${ms(p)}${d > p ? ' · ' + mode : ''}`;
}

function drawTrain(now) {
  const [g, w, h] = fitCanvas($('cvTrain'));
  g.clearRect(0, 0, w, h);
  const span = 3, t0 = now - span, mid = h / 2;
  g.strokeStyle = '#1d1d21'; g.beginPath(); g.moveTo(0, mid); g.lineTo(w, mid); g.stroke();
  let i = pulses.length - 1;
  while (i >= 0 && pulses[i].t > t0) i--;
  for (let k = Math.max(0, i); k < pulses.length; k++) {
    const e = pulses[k], x = (e.t - t0) / span * w; if (x < 0) continue;
    if (e.r === PS.R_MUTE) { g.fillStyle = '#3a3a40'; g.fillRect(x, mid - 1, 1.5, 2); continue; }
    g.fillStyle = e.r === PS.R_LEFT ? '#5fd0c8' : e.r === PS.R_RIGHT ? '#e07ab8' : '#f1d36b';
    const top = e.r === PS.R_RIGHT ? mid : 6, bot = e.r === PS.R_LEFT ? mid : h - 6;
    g.fillRect(x, top, 1.5, bot - top);
  }
  if (pulses.length > 1 && params.fundHz > 40) {
    g.fillStyle = 'rgba(5,5,6,.65)'; g.fillRect(w - 168, 4, 164, 18);
    g.fillStyle = '#8d8a83'; g.font = '11px ui-monospace, Menlo, monospace';
    g.fillText('fused into tone (>20/s)', w - 162, 17);
  }
  $('dCount').textContent = pulseCount.toLocaleString() + ' pulsars';
}

const tdBuf = new Float32Array(2048), fBuf = new Float32Array(2048);
function drawScopes() {
  let [g, w, h] = fitCanvas($('cvScope'));
  g.clearRect(0, 0, w, h);
  g.fillStyle = '#8d8a83'; g.font = '10px ui-monospace, Menlo, monospace'; g.fillText('scope', 8, 14);
  if (analyser) {
    analyser.getFloatTimeDomainData(tdBuf);
    let s = 0; for (let i = 1; i < 1024; i++) if (tdBuf[i - 1] <= 0 && tdBuf[i] > 0) { s = i; break; }
    g.strokeStyle = '#f1d36b'; g.beginPath();
    for (let x = 0; x < w; x++) { const v = tdBuf[s + Math.floor(x / w * 1024)] || 0; const y = h / 2 - v * h * 0.45; x ? g.lineTo(x, y) : g.moveTo(x, y); }
    g.stroke();
  }
  [g, w, h] = fitCanvas($('cvSpec'));
  g.clearRect(0, 0, w, h);
  g.fillStyle = '#8d8a83'; g.fillText('spectrum', 8, 14);
  g.strokeStyle = '#1f1f23';
  for (const f of [100, 1000, 10000]) { const x = Math.log(f / 20) / Math.log(1000) * w; g.beginPath(); g.moveTo(x, 0); g.lineTo(x, h); g.stroke();
    g.fillText(f >= 1000 ? f / 1000 + 'k' : f, x + 3, h - 4); }
  if (analyser) {
    analyser.getFloatFrequencyData(fBuf);
    const nyq = ctx.sampleRate / 2;
    g.strokeStyle = '#5fd0c8'; g.beginPath();
    for (let x = 0; x < w; x++) { const f = 20 * Math.pow(1000, x / w), b = Math.min(2047, Math.round(f / nyq * 2048));
      const y = h - (clamp(fBuf[b], -110, -10) + 110) / 100 * h; x ? g.lineTo(x, y) : g.moveTo(x, y); }
    g.stroke();
  }
  // formant markers
  params.formantHz.forEach((f, k) => { if (params.formantAmp[k] < 0.01 || f < 20) return;
    const x = Math.log(f / 20) / Math.log(1000) * w; g.fillStyle = '#f0955a'; g.fillRect(x - 1, 0, 2, 6); });
}

function drawSample() {
  const [g, w, h] = fitCanvas($('cvSample'));
  g.clearRect(0, 0, w, h);
  g.fillStyle = '#8d8a83'; g.font = '10px ui-monospace, Menlo, monospace';
  if (!sample) { g.fillText('no sample', 8, h / 2 + 3); return; }
  g.fillStyle = '#6b4f2a';
  const step = sample.length / w;
  for (let x = 0; x < w; x++) { let m = 0; for (let i = Math.floor(x * step); i < (x + 1) * step; i++) m = Math.max(m, Math.abs(sample[i] || 0));
    g.fillRect(x, h / 2 - m * h * 0.45, 1, Math.max(1, m * h * 0.9)); }
  g.fillStyle = '#e9e6df'; g.fillText(sample._name + ' · ' + (sample.length / sample._sr).toFixed(2) + ' s', 8, 12);
}

// ------------------------------------------------------------------ board state -> DOM
function fmtSec(s) { return s < 1 ? Math.round(s * 1000) + ' ms' : s.toFixed(2) + ' s'; }
function fmtHz(f) { return f >= 1000 ? (f / 1000).toFixed(2) + ' kHz' : f >= 10 ? f.toFixed(1) + ' Hz' : f.toFixed(2) + ' Hz'; }
function morphName(v, names) { const a = Math.floor(clamp(v, 0, names.length - 1)), f = v - a;
  return f < 0.15 || a >= names.length - 1 ? names[Math.min(a, names.length - 1)] : f > 0.85 ? names[a + 1] : names[a] + '→' + names[a + 1]; }

function knobText(i, alt) {
  const p = params, r = ctl.range();
  if (alt) switch (i) {
    case 0: return Math.round(ctl.alt[0] * 100) + '%';
    case 1: return '+' + (ctl.alt[1] * 2).toFixed(1) + ' oct';
    case 2: return p.edge > 0.5 ? 'overlap' : 'cut ' + (p.edge * 12).toFixed(1) + 'ms';
    case 3: return Math.round(p.fold * 100) + '%';
    case 4: return p.releaseSec.toFixed(2) + ' s';
    case 5: return Math.round(ctl.alt[5] * 100) + '%';
    case 6: return Math.round(p.drive * 100) + '%';
    case 7: return p.chorus < 0.005 ? 'off' : (p.chorus <= 0.5 ? 'chorus ' : 'ensemble ') + Math.round(p.chorus * 100) + '%';
  }
  switch (i) {
    case 0: return ctl.knob[0] < 0.01 ? '1 formant' : Math.round(ctl.knob[0] * 100) + '%';
    case 1: return (ctl.coupled && r !== 2) ? '×' + (p.formantHz[0] / p.fundHz).toFixed(2) : fmtHz(p.formantHz[0]);
    case 2: return p.cluster.toFixed(1) + ' cyc';
    case 3: return morphName(p.shape, PS.SHAPE_NAMES);
    case 4: return morphName(p.window, PS.WIN_NAMES);
    case 5: return p.maskMode === 3 ? 'p ' + p.prob.toFixed(2) : p.maskMode === 0 ? 'off' : p.burst + ':' + p.rest;
    case 6: return Math.round(p.level * 100) + '%';
    case 7: return r === 1 ? fmtHz(p.fundHz) : r === 0 ? (ctl.knob[7] < 0.01 ? 'off' : Math.round(ctl.knob[7] * 100) + '%' + (ctl.knob[7] > 0.6 ? ' +sub' : '')) : 'glide ' + p.glideSec.toFixed(2) + 's';
  }
}

function updateBoard() {
  const alt = altActive();
  board.classList.toggle('alt', alt);
  for (let i = 0; i < 6; i++) {
    const e = knobEls[i], v = readKnob(i), a = -135 + v * 270;
    e._val.setAttribute('d', v > 0.003 ? arc(-135, a, 46) : '');
    e._val.style.stroke = alt ? 'var(--alt)' : 'var(--gold)';
    e._ptr.setAttribute('transform', `rotate(${a})`);
    const ch = chActive(i);
    e._b.textContent = alt ? PC.ALT_NAMES[i] : ch ? PC.CH_NAMES[i] : PC.KNOB_NAMES[i];
    e._s.textContent = !ch ? knobText(i, alt) : i === 3 ? fmtSec(params.attackSec) : i === 4 ? Math.round(ctl.liftSec() * 1000) + ' ms' : i === 0 ? (ctl.ch[0] < 0.005 ? 'static' : (0.05 * Math.pow(60, ctl.ch[0])).toFixed(2) + ' Hz')
      : (20 * Math.log10(params.inputGain)).toFixed(1) + ' dB';
    e._val.style.stroke = alt ? 'var(--alt)' : ch ? '#b48cf0' : 'var(--gold)';
  }
  board.classList.toggle('ch', chActive(6));
  for (const i of [6, 7]) {
    const e = faderEls[i], v = readKnob(i), ch = chActive(i);
    e._fill.style.height = v * 100 + '%'; e._cap.style.bottom = v * 100 + '%';
    e._b.textContent = alt ? PC.ALT_NAMES[i] : ch ? PC.CH_NAMES[i] : i === 7 ? ['thick', 'fund', 'glide'][ctl.range()] : PC.KNOB_NAMES[i];
    e._s.textContent = ch ? (i === 7 ? fmtHz(params.cutoffHz) : Math.round(ctl.ch[6] * 100) + '%') : knobText(i, alt);
  }
  swEls.forEach((e, i) => { const pos = ctl.sw[i]; e._lever.style.top = (5 + pos * 32.5) + '%'; e._label.textContent = e._names[pos]; });

  const act = ctl.activePad(), range = ctl.range();
  padEls.forEach((e, i) => {
    e.classList.toggle('down', !!ctl.touched[i]);
    e.classList.toggle('active', i === act);
    e._fill.style.opacity = ctl.touched[i] ? 0.25 + ctl.pressure[i] * 0.75 : (i === act ? 0.2 : 0);
    let sub = e._def;
    if (i >= 3 && i <= 9) {
      const st = ctl.padSemis(i), name = PC.NOTE_NAMES[((st % 12) + 12) % 12];
      sub = range === 2 ? PC.SUBDIV_NAMES[i - 3] : name + (range === 0 ? 2 + Math.floor(st / 12) : '');
      if (ctl.chHeld()) sub = PC.SCALES[i - 3][0];
      else if (ctl.toHeld()) sub = 'root ' + name;
    } else if (ctl.chHeld() && (i === 0 || i === 2)) sub = i ? 'scale +' : 'scale −';
    else if (ctl.chHeld() && i === 1) sub = 'couple';
    else if (ctl.toHeld() && (i === 0 || i === 2)) sub = i ? 'bpm +' : 'bpm −';
    else if (i === 1 && ctl.recording) sub = 'REC';
    if (e._sub.textContent !== sub) e._sub.textContent = sub;
  });
  $('layerHint').innerHTML = ctl.chHeld() ? '<b style="color:#b48cf0">CH layer</b>: faders = filter cutoff (right) · resonance (left) · P03–P09 pick scale · P00/P02 cycle · P01 formant coupling'
    : alt ? '<b style="color:var(--alt)">TO layer</b>: knobs edit width · push · edge · fold · release · conv · drive · chorus · P03–P09 set root · P00/P02 tempo'
    : 'Hold <b>P10 / Shift</b> for the second knob layer · hold <b>P11 / W</b> for scales · <b>Space</b> = hold';
}

function updateDisplay(now) {
  const d = ctl.describe(params);
  $('dRange').textContent = d.range;
  $('dFund').textContent = params.gate > 0 || ctl.activeKey() >= 0 ? fmtHz(d.fund) : '— Hz';
  $('dMask').textContent = d.mask;
  $('dForm').textContent = fmtHz(d.formant);
  $('dNote').textContent = d.note;
  $('dScale').textContent = d.scale; $('dOct').textContent = d.oct;
  $('fIn').classList.toggle('on', inPeak > 0.05);
  $('fMidi').classList.toggle('on', d.midi || now - midiSeenAt < 0.15); $('fExt').classList.toggle('on', d.ext);
  $('fHold').classList.toggle('on', d.latch); $('fConv').classList.toggle('on', d.conv); $('fRec').classList.toggle('on', d.rec);
  $('dShape').textContent = morphName(params.shape, PS.SHAPE_NAMES) + ' · ' + morphName(params.window, PS.WIN_NAMES) + (params.fold > 0.01 ? ' · fold' : '');
  // LED: flashes per pulsar (rhythm), glows at audio rates — same as the Seed LED on hardware
  let led = 0;
  if (ctx && params.gate > 0) { const age = ctx.currentTime - lastPulseT; led = age < 0.04 ? 1 : params.fundHz > 25 ? 0.5 : 0; }
  if (blink.until > now) led = Math.floor((blink.until - now) / 0.12) % 2 ? 1 : 0;
  const col = led ? `rgba(255,${180 + led * 40},90,${0.35 + led * 0.65})` : '#33240f';
  $('led').style.background = col; $('seedLed').style.background = col;
}

let toastTimer = 0;
function toast(t) { const e = $('toast'); e.textContent = t; e.classList.add('show'); clearTimeout(toastTimer); toastTimer = setTimeout(() => e.classList.remove('show'), 1600); }
const blink = { until: 0 };

// ------------------------------------------------------------------ main loop
let lastSent = '';
function frame(ts) {
  const now = ts / 1000;
  ctl.tick(now);
  ctl.compute(params);
  while (ctl.events.length) {
    const ev = ctl.events.shift();
    toast(ev.text);
    if (ev.blinks) blink.until = now + ev.blinks * 0.24;
    if (ev.type === 'rec-start') {
      if (!micStream) toast('Enable input first (Convolution card)');
      if (node) node.port.postMessage({ type: 'rec', on: true, seconds: 2 });
    } else if (ev.type === 'rec-stop' && node) node.port.postMessage({ type: 'rec', on: false });
  }
  if (node) {
    const s = JSON.stringify(params);
    if (s !== lastSent) { node.port.postMessage({ type: 'params', p: params }); lastSent = s; }
  }
  maybeRebuildKernel(now);
  updateBoard();
  updateDisplay(now);
  drawPulsaret();
  drawTrain(ctx ? ctx.currentTime : now);
  drawScopes();
  requestAnimationFrame(frame);
}

// ------------------------------------------------------------------ presets (after PulsarGenerator "settings")
const v = (x, n) => x / n;
const PRESETS = [
  { name: 'Ondioline', sw: [0, 0], knob: [0, .35, 0, 0, v(4, 6), 0, .7, 0], pad: 5 },
  { name: 'Formant voice', sw: [0, 0], knob: [.55, .5, .12, 0, v(1, 6), 0, .7, .3], alt: { 1: .5 }, pad: 4 },
  { name: 'Fig. 9 · 2:1 subharmonics', sw: [1, 0], coupled: false, knob: [0, 3 / 7, 0, 0, v(4, 6), 7 / 20, .7, Math.log2(400) / 13], pad: 3 },
  { name: 'Blip rhythm', sw: [2, 0], knob: [.3, .55, .2, v(4, 7), v(2, 6), .25, .75, 0], alt: { 4: .35 }, tempo: 120, pad: 6 },
  { name: 'Channel dialog', sw: [2, 1], knob: [.25, .45, .5, v(1, 7), v(1, 6), 0, .75, 0], alt: { 4: .4 }, tempo: 120, pad: 7 },
  { name: 'Pulse cloud', sw: [1, 2], coupled: false, knob: [.8, .5, .5, v(5, 7), 0, .3, .7, Math.log2(36) / 13], alt: { 0: 1, 2: .8 }, pad: 5 },
  { name: 'CP 1919 (first pulsar)', sw: [1, 0], coupled: false, knob: [.3, .45, .5, v(5, 7), v(1, 6), 0, .8, Math.log2(0.748 / 0.25) / 13], alt: { 4: .6 }, pad: 3 },
  { name: 'Ensemble strings', sw: [0, 0], knob: [.4, .3, .3, v(1, 7), 0, 0, .7, .5], alt: { 7: .85 }, pad: 5 },
  { name: 'Thick unison + sub', sw: [0, 0], knob: [.35, .4, .15, v(1, 7), v(1, 6), 0, .7, .75], pad: 3 },
  { name: 'Live input gate (enable input)', sw: [2, 0], coupled: false, knob: [0, .1, 1, 1, 0, .25, .8, 0], tempo: 90, pad: 6 },
  { name: 'Analog intermittency', sw: [0, 2], knob: [0, .25, 0, v(3, 7), v(3, 6), .15, .7, 0], pad: 3 },
];
PRESETS.forEach((p, i) => { el('option', '', $('preset'), p.name).value = i; });
el('option', '', $('preset'), 'Preset…').value = ''; $('preset').value = '';
$('preset').addEventListener('change', (e) => {
  const p = PRESETS[e.target.value]; if (!p) return;
  const d = new PulsarControls();
  ctl.knob = p.knob.slice(); ctl.alt = d.alt.slice(); Object.entries(p.alt || {}).forEach(([k, val]) => (ctl.alt[k] = val));
  ctl.sw = p.sw.slice(); ctl.coupled = p.coupled !== false; ctl.oct = 0; ctl.tempo = p.tempo || 90;
  ctl.latch = true; ctl.latchedKey = p.pad; ctl.lastKey = p.pad;
  ensureAudio(); toast(p.name + ' · HOLD on (Space to release)');
  e.target.blur();
});

// ------------------------------------------------------------------ help
$('helpBody').innerHTML = `
<table>
<tr><th>Control</th><th>Main</th><th>Hold P10 (TO) / Shift</th></tr>
<tr><td>S30</td><td>Spread — adds formants 2 &amp; 3 above f<sub>d</sub></td><td>Width — formant stereo spread · <i>hold P11: motion (formants drift in stereo)</i></td></tr>
<tr><td>S31</td><td>Formant f<sub>d</sub> (× f<sub>p</sub> when coupled, Hz when free)</td><td>Push — pad pressure raises formant</td></tr>
<tr><td>S32</td><td>Cluster — cycles of w per pulsaret (1–7)</td><td>Edge — cut crossfade → overlap (OPulWM)</td></tr>
<tr><td>S33</td><td>Shape — sine · tri · saw · square · pulse · vela · noise · <b>live input</b></td><td>Fold — wavefolder · <i>hold P11: attack (4 ms – 3 s)</i></td></tr>
<tr><td>S34</td><td>Window — gauss · FOF · expodec · lindec · rect · linatt · expatt</td><td>Release · <i>hold P11: lift (pressure look-back, noon = 150 ms)</i></td></tr>
<tr><td>S35</td><td>Mask — burst ratio b:r or probability</td><td>Conv — convolution mix · <i>hold P11: input gain</i></td></tr>
<tr><td>S36 (L fader)</td><td>Level</td><td>Drive · <i>hold P11: filter resonance</i></td></tr>
<tr><td>S37 (R fader)</td><td>TONE: thick (detuned 2nd train + width, sub above 60%) · FREE: fundamental 0.25 Hz–2 kHz · RHYTHM: glide</td><td>Chorus → ensemble · <i>hold P11: filter cutoff</i></td></tr>
<tr><td>S09/10 switch</td><td colspan="2">TONE (pads = notes) · FREE (fader = f<sub>p</sub>, pads = formant notes) · RHYTHM (pads = note values at tempo)</td></tr>
<tr><td>S07/08 switch</td><td colspan="2">BURST · CHANNEL (bursts left, rests right) · STOCHASTIC</td></tr>
<tr><td>P03–P09</td><td colspan="2">Notes / subdivisions; position on pad (or Pencil force) = pressure</td></tr>
<tr><td>P00 / P02</td><td>Octave − / + (Chromatic: ±7 semitones)</td><td>Tempo − / +</td></tr>
<tr><td>P01</td><td colspan="2">Tap: convolution on/off · hold: record input (2 s)</td></tr>
<tr><td>P10</td><td colspan="2">Tap tempo · hold = TO layer</td></tr>
<tr><td>P11</td><td colspan="2">Hold + P03–P09: scale (Chromatic · Major · Minor · Min Pent · Maj Pent · Dorian · Harm Minor) · + P00/P02: cycle scale · + P01: formant coupling</td></tr>
<tr><td>P10 + P03–P09</td><td colspan="2">Set root key to that pad's note (scale type is kept)</td></tr>
<tr><td>P10 + P11</td><td colspan="2">Quick tap: hold (latch) on/off · hold 1.5 s: recalibrate pads (hardware only)</td></tr>
</table>
<p class="muted" style="margin-top:10px">Keyboard: <kbd>A</kbd>–<kbd>J</kbd> P03–P09 · <kbd>Z</kbd> <kbd>X</kbd> <kbd>C</kbd> P00–P02 ·
<kbd>Shift</kbd>/<kbd>Q</kbd> P10 · <kbd>W</kbd> P11 · <kbd>Space</kbd> hold · <kbd>1</kbd><kbd>2</kbd><kbd>3</kbd> range ·
<kbd>8</kbd><kbd>9</kbd><kbd>0</kbd> mask · double-click a knob to reset · Option-drag = fine</p>`;

// MIDI CC map, generated from the control layer so it can't drift
$('helpBody').insertAdjacentHTML('beforeend', '<table><tr><th>CC</th><th>Parameter</th><th>CC</th><th>Parameter</th></tr>' +
  PC.CC_MAP.slice(0, 8).map((m, i) => { const a = PC.CC_MAP[i + 8];
    return `<tr><td>${m[0]}</td><td>${PC.KNOB_NAMES[m[2]]} (${PC.KNOB_IDS[m[2]]})</td><td>${a[0]}</td><td>${PC.ALT_NAMES[a[2]]} (TO + ${PC.KNOB_IDS[a[2]]})</td></tr>`; }).join('') +
  `<tr><td>1</td><td>mod wheel → formant</td><td>64</td><td>sustain</td></tr>
   <tr><td>86</td><td>range switch (TONE/FREE/RHYTHM)</td><td>87</td><td>mask switch (BURST/CHAN/STOCH)</td></tr>
   <tr><td>88</td><td>bend range (semitones)</td><td>89</td><td>root from MIDI (≥64 on)</td></tr>
   <tr><td>102</td><td>filter cutoff (P11 + S37)</td><td>103</td><td>filter resonance (P11 + S36)</td></tr>
   <tr><td>104</td><td>input gain (P11 + S35)</td><td>105</td><td>formant motion (P11 + S30)</td></tr>
   <tr><td>106</td><td>lift window (P11 + S34)</td><td>107</td><td>attack (P11 + S33)</td></tr>
   <tr><td>123</td><td>all notes off</td><td></td><td></td></tr></table>`);

buildBoard();
drawSample();
requestAnimationFrame(frame);
