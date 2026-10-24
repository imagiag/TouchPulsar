// Offline smoke test: node web/test/render.js [outdir]
// Renders a few scenarios through PulsarControls -> PulsarCore and writes WAVs.
const fs = require('fs'), path = require('path');
const { PS, PulsarCore, PulsarParams, psConvolveKernel } = require('../engine/pulsar-core.js');
const { PC, PulsarControls } = require('../engine/pulsar-controls.js');
const SR = 48000, BLOCK = 48, out = process.argv[2] || path.join(__dirname, 'out');
fs.mkdirSync(out, { recursive: true });

function wav(file, L, R) {
  const n = L.length, b = Buffer.alloc(44 + n * 4);
  b.write('RIFF', 0); b.writeUInt32LE(36 + n * 4, 4); b.write('WAVEfmt ', 8);
  b.writeUInt32LE(16, 16); b.writeUInt16LE(1, 20); b.writeUInt16LE(2, 22);
  b.writeUInt32LE(SR, 24); b.writeUInt32LE(SR * 4, 28); b.writeUInt16LE(4, 32); b.writeUInt16LE(16, 34);
  b.write('data', 36); b.writeUInt32LE(n * 4, 40);
  for (let i = 0; i < n; i++) {
    b.writeInt16LE(Math.max(-32767, Math.min(32767, L[i] * 32767 | 0)), 44 + i * 4);
    b.writeInt16LE(Math.max(-32767, Math.min(32767, R[i] * 32767 | 0)), 46 + i * 4);
  }
  fs.writeFileSync(file, b);
}

function run(name, secs, script) {
  const core = new PulsarCore(SR), ctl = new PulsarControls(), p = new PulsarParams();
  const n = Math.floor(secs * SR), L = new Float32Array(n), R = new Float32Array(n);
  const bl = new Float32Array(BLOCK), br = new Float32Array(BLOCK);
  let t0 = process.hrtime.bigint(), cpu = 0n;
  for (let i = 0; i < n; i += BLOCK) {
    const t = i / SR; ctl.tick(t); script(ctl, t, core);
    core.setParams(ctl.compute(p));
    const s = process.hrtime.bigint(); core.process(bl, br, null, BLOCK); cpu += process.hrtime.bigint() - s;
    L.set(bl.subarray(0, Math.min(BLOCK, n - i)), i); R.set(br.subarray(0, Math.min(BLOCK, n - i)), i);
  }
  let peak = 0, sq = 0, nan = 0;
  for (let i = 0; i < n; i++) { const v = L[i]; if (!isFinite(v) || !isFinite(R[i])) nan++; peak = Math.max(peak, Math.abs(v), Math.abs(R[i])); sq += v * v; }
  const rt = Number(cpu) / 1e9 / secs * 100;
  console.log(`${name.padEnd(22)} peak ${peak.toFixed(3)}  rms ${Math.sqrt(sq / n).toFixed(3)}  nan ${nan}  cpu ${rt.toFixed(2)}% of realtime  pulses ${core.pulseCount}`);
  wav(path.join(out, name + '.wav'), L, R);
  if (nan) process.exitCode = 1;
}

// 1. TONE: play a little melody, sweep formant
run('tone_melody', 4, (c, t) => {
  c.sw = [0, 0]; c.knob[PC.K_FORMANT] = 0.2 + 0.6 * (t / 4);
  const pad = 3 + (Math.floor(t * 2) % 7);
  if (!c.touched[pad]) { for (let i = 3; i < 10; i++) if (c.touched[i]) c.padUp(i); c.padDown(pad, 0.7); }
});
// 2. FREE: fader sweeps fundamental from rhythm to tone (crossing time scales)
run('free_sweep', 6, (c, t) => {
  c.sw = [1, 0]; c.coupled = false; c.knob[PC.K_FUND] = t / 6; c.knob[PC.K_FORMANT] = 0.55;
  c.knob[PC.K_SPREAD] = 0.5; c.knob[PC.K_WINDOW] = 2 / 6; if (!c.touched[5]) c.padDown(5, 0.6);
});
// 3. RHYTHM + burst masking, 3 formants, cluster 3, overlap
run('rhythm_burst', 4, (c, t) => {
  c.sw = [2, 0]; c.knob[PC.K_MASK] = 0.4; c.knob[PC.K_CLUSTER] = 0.33; c.alt[PC.K_CLUSTER] = 0.8;
  c.knob[PC.K_SPREAD] = 0.6; c.alt[PC.K_FUND] = 0.4; if (!c.touched[6]) c.padDown(6, 0.8);
});
// 4. Stochastic masking at audio rate, max fold, square shape
run('stoch_fold', 3, (c, t) => {
  c.sw = [0, 2]; c.knob[PC.K_MASK] = 0.15; c.alt[PC.K_SHAPE] = 1; c.knob[PC.K_SHAPE] = 0.5;
  c.knob[PC.K_LEVEL] = 1; c.alt[PC.K_LEVEL] = 1; if (!c.touched[4]) c.padDown(4, 1);
});
// 5. Convolution: noise-burst "sample" convolved with pulsaret, channel masking
const kcore = new PulsarCore(SR);
const smp = new Float32Array(SR * 0.4); for (let i = 0; i < smp.length; i++) smp[i] = (kcore.rand() * 2 - 1) * Math.exp(-i / (SR * 0.05));
const pls = new Float32Array(SR); kcore.p.cluster = 3; const pl = kcore.renderPulsaret(800, pls, SR);
const kern = psConvolveKernel(pls, pl, smp, smp.length, SR * PS.MAX_KERNEL_SEC);
run('conv_channel', 4, (c, t, core) => {
  if (t === 0) core.setKernel(kern, kern.length);
  c.sw = [2, 1]; c.convOn = true; c.alt[PC.K_MASK] = 1; c.knob[PC.K_MASK] = 0.1; if (!c.touched[7]) c.padDown(7, 0.7);
});
// 6. Extreme: max fundamental, max cluster, overlap -> voice stealing
run('stress', 2, (c, t) => {
  c.sw = [1, 0]; c.knob[PC.K_FUND] = 1; c.knob[PC.K_CLUSTER] = 1; c.alt[PC.K_CLUSTER] = 1;
  c.knob[PC.K_SPREAD] = 1; c.knob[PC.K_FORMANT] = 0; c.coupled = false; if (!c.touched[3]) c.padDown(3, 1);
});
