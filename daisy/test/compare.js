// Renders the host_test.cpp scenarios with the JS engine and compares them with
// the C++ output in out/. Run via `make -C daisy/test`.
const fs = require('fs'), path = require('path');
const { PS, PulsarCore, PulsarParams, psConvolveKernel } = require('../../web/engine/pulsar-core.js');
const { PC, PulsarControls } = require('../../web/engine/pulsar-controls.js');
const SR = 48000, BLOCK = 48, OUT = path.join(__dirname, 'out');
let fail = 0;

const testInput = (s) => { const t = Math.fround(s / SR), ph = t % 0.25;
  return 0.4 * Math.sin(2 * Math.PI * 330 * t) + 0.2 * Math.sin(2 * Math.PI * 1250 * t) + 0.5 * Math.exp(-ph * 60) * Math.sin(2 * Math.PI * 90 * ph); };

function render(name, secs, script, conv, input) {
  const core = new PulsarCore(SR), c = new PulsarControls(), p = new PulsarParams();
  const n = Math.floor(secs * SR), out = new Float32Array(n * 2), L = new Float32Array(BLOCK), R = new Float32Array(BLOCK), IN = new Float32Array(BLOCK);
  let kernel = null;
  for (let i = 0, b = 0; i < n; i += BLOCK, b++) {
    const t = i / SR; c.tick(t); script(c, t, b); c.compute(p);
    if (conv && b === 0) {
      const smp = new Float32Array(14400);
      for (let j = 0; j < 14400; j++) smp[j] = Math.sin(2 * Math.PI * 300 * j / SR) * Math.exp(-j / (SR * 0.05));
      core.setParams(p);
      const pl = new Float32Array(2048), len = core.renderPulsaret(p.formantHz[0], pl, 2048);
      kernel = psConvolveKernel(pl, len, smp, 14400, 200000);
      core.setKernel(kernel, kernel.length);
    }
    for (let j = 0; j < BLOCK; j++) IN[j] = testInput(i + j);
    core.setParams(p); core.process(L, R, input ? IN : null, BLOCK);
    for (let j = 0; j < BLOCK && i + j < n; j++) { out[(i + j) * 2] = L[j]; out[(i + j) * 2 + 1] = R[j]; }
  }
  return { out, pulses: core.pulseCount, kernel };
}

function compare(name, secs, script, conv, input) {
  const js = render(name, secs, script, conv, input);
  const cpp = new Float32Array(fs.readFileSync(path.join(OUT, name + '.f32')).buffer.slice(0));
  let sa = 0, sb = 0, sab = 0, ea = 0, eb = 0;
  for (let i = 0; i < js.out.length; i++) { const a = js.out[i], b = cpp[i]; sab += a * b; ea += a * a; eb += b * b; }
  const corr = sab / Math.sqrt(ea * eb + 1e-30), rmsRatio = Math.sqrt(eb / (ea + 1e-30));
  let line = `${name.padEnd(14)} correlation ${corr.toFixed(5)}  rms C++/JS ${rmsRatio.toFixed(4)}  JS pulses ${js.pulses}`;
  let ok = corr > 0.995 && Math.abs(rmsRatio - 1) < 0.02;
  if (js.kernel) {
    const k = new Float32Array(fs.readFileSync(path.join(OUT, name + '.kernel.f32')).buffer.slice(0));
    let md = 0; for (let i = 0; i < Math.min(k.length, js.kernel.length); i++) md = Math.max(md, Math.abs(k[i] - js.kernel[i]));
    line += `  kernel len ${k.length}/${js.kernel.length} max diff ${md.toExponential(2)}`;
    ok = ok && k.length === js.kernel.length && md < 1e-3;
  }
  console.log((ok ? 'ok   ' : 'FAIL ') + line);
  if (!ok) fail++;
}

compare('tone_melody', 4, (c, t) => {
  c.knob[PC.K_FORMANT] = 0.2 + 0.6 * (t / 4);
  const pad = 3 + (Math.floor(t * 2) % 7);
  if (!c.touched[pad]) { for (let i = 3; i < 10; i++) if (c.touched[i]) c.padUp(i); c.padDown(pad, 0.7); }
});
compare('free_sweep', 6, (c, t) => {
  c.setSwitch(PC.SW_RANGE, 1); c.coupled = false; c.knob[PC.K_FUND] = t / 6; c.knob[PC.K_FORMANT] = 0.55;
  c.knob[PC.K_SPREAD] = 0.5; c.knob[PC.K_WINDOW] = 2 / 6; if (!c.touched[5]) c.padDown(5, 0.6);
});
compare('rhythm_burst', 4, (c) => {
  c.setSwitch(PC.SW_RANGE, 2); c.knob[PC.K_MASK] = 0.4; c.knob[PC.K_CLUSTER] = 0.33; c.alt[PC.K_CLUSTER] = 0.8;
  c.knob[PC.K_SPREAD] = 0.6; c.tempo = 120; if (!c.touched[6]) c.padDown(6, 0.8);
});
compare('stoch_fold', 3, (c) => {
  c.setSwitch(PC.SW_MASK, 2); c.knob[PC.K_MASK] = 0.15; c.alt[PC.K_SHAPE] = 1; c.knob[PC.K_SHAPE] = 0.5;
  c.knob[PC.K_LEVEL] = 1; c.alt[PC.K_LEVEL] = 0.3; if (!c.touched[4]) c.padDown(4, 1);
});
compare('midi_clock', 4, (c, t, b) => {
  c.setSwitch(PC.SW_RANGE, 2); c.setSwitch(PC.SW_MASK, 1);
  const tick = 60 / 120 / 24;
  for (let k = Math.ceil((t - 1e-9) / tick); k * tick < t + BLOCK / SR - 1e-9; k++) c.midi(0xF8, 0, 0, k * tick);
  if (b === 250) c.midi(0x90, 62, 100, t);
});
compare('thick', 4, (c, t) => {
  c.knob[PC.K_FUND] = t / 4; c.knob[PC.K_SPREAD] = 0.3;
  const pad = 3 + (Math.floor(t * 1.5) % 7);
  if (!c.touched[pad]) { for (let i = 3; i < 10; i++) if (c.touched[i]) c.padUp(i); c.padDown(pad, 0.7); }
});
compare('filter', 4, (c, t) => {
  c.knob[PC.K_SHAPE] = 0.5; c.knob[PC.K_FORMANT] = 0.6; c.knob[PC.K_FUND] = 0;
  c.ch[PC.K_FUND] = Math.abs(1 - t / 2); c.ch[PC.K_LEVEL] = 0.75;
  if (!c.touched[5]) c.padDown(5, 0.7);
});
compare('live_input', 3, (c) => {
  c.setSwitch(PC.SW_RANGE, 2); c.coupled = false; c.knob[PC.K_SHAPE] = 1; c.knob[PC.K_FORMANT] = 0.1;
  c.knob[PC.K_CLUSTER] = 1; c.knob[PC.K_MASK] = 0.25; c.alt[PC.K_SHAPE] = 0.2; c.ch[PC.K_MASK] = 0.6;
  if (!c.touched[6]) c.padDown(6, 0.8);
}, false, true);
compare('motion', 4, (c) => {
  c.knob[PC.K_SPREAD] = 0.6; c.ch[PC.K_SPREAD] = 0.45; c.knob[PC.K_FUND] = 0.4;
  if (!c.touched[4]) c.padDown(4, 0.7);
});
compare('chorus', 4, (c, t) => {
  c.knob[PC.K_SPREAD] = 0.4; c.alt[PC.K_FUND] = t / 4; c.knob[PC.K_FUND] = 0.4;
  if (!c.touched[5]) c.padDown(5, 0.7);
});
compare('pressure_hold', 3, (c, t, b) => {
  if (b === 0) { c.knob[PC.K_FUND] = 0; c.alt[PC.K_FORMANT] = 0.8; c.alt[PC.K_WINDOW] = 0.6; }
  if (b === 10) { c.padDown(PC.P_TO, .7); c.padDown(PC.P_CH, .7); c.padUp(PC.P_CH); c.padUp(PC.P_TO); }
  if (t > 0.3 && t < 1.2 && !c.touched[6]) c.padDown(6, 0.3);
  if (c.touched[6]) c.padMove(6, t < 1.0 ? Math.fround(0.3 + 0.6 * (t - 0.3) / 0.7) : Math.fround(0.9 - (t - 1.0) * 4.0));
  if (t >= 1.2 && c.touched[6]) c.padUp(6);
});
compare('attack', 3, (c, t) => {
  c.ch[PC.K_SHAPE] = 0.75; c.alt[PC.K_WINDOW] = 0.5;
  if (t < 2.0 && !c.touched[5]) c.padDown(5, 0.7);
  if (t >= 2.0 && c.touched[5]) c.padUp(5);
});
compare('conv', 3, (c) => {
  c.setSwitch(PC.SW_RANGE, 2); c.setSwitch(PC.SW_MASK, 1); c.convOn = true; c.alt[PC.K_MASK] = 1;
  c.knob[PC.K_MASK] = 0.1; if (!c.touched[7]) c.padDown(7, 0.7);
}, true);

console.log(fail ? `${fail} scenario(s) differ` : 'C++ engine matches the JS engine');
process.exitCode = fail ? 1 : 0;
