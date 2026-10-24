// Control-layer tests: node web/test/controls.js
// Covers scales, root key, chromatic paging, MIDI notes/expression/CC/clock,
// and the engine's beat sync. Same expectations apply to the C++ port.
const assert = require('assert');
const { PulsarCore, PulsarParams } = require('../engine/pulsar-core.js');
const { PC, PulsarControls } = require('../engine/pulsar-controls.js');

let pass = 0;
const near = (a, b, tol, msg) => { assert(Math.abs(a - b) <= tol, `${msg}: got ${a}, want ${b}`); pass++; };
const eq = (a, b, msg) => { assert.deepStrictEqual(a, b, msg); pass++; };
const mtof = (n) => 440 * Math.pow(2, (n - 69) / 12);
const tap = (c, i) => { c.padDown(i, 0.7); c.padUp(i); };
const combo = (c, mod, i) => { c.padDown(mod, 0.7); tap(c, i); c.padUp(mod); };
const fund = (c) => c.compute(new PulsarParams()).fundHz;

// --- scales & pads (TONE) ---
let c = new PulsarControls();
eq(PC.SCALES.map((s) => s[0]), ['Chromatic', 'Major', 'Minor', 'Min Pent', 'Maj Pent', 'Dorian', 'Harm Minor'], 'scale list');
c.padDown(3, .7); near(fund(c), mtof(36), 0.01, 'C major pad 1 = C2'); c.padUp(3);
c.padDown(9, .7); near(fund(c), mtof(47), 0.01, 'C major pad 7 = B2'); c.padUp(9);
combo(c, PC.P_CH, 6); eq(c.scale, 3, 'CH+P06 = Min Pent');
c.padDown(8, .7); near(fund(c), mtof(48), 0.01, 'min pent pad 6 continues into next octave (C3)'); c.padUp(8);
combo(c, PC.P_CH, PC.P_OCT_UP); eq(c.scale, 4, 'CH+P02 cycles to next scale');
combo(c, PC.P_CH, PC.P_OCT_DN); combo(c, PC.P_CH, PC.P_OCT_DN); eq(c.scale, 2, 'CH+P00 cycles back');
assert(c.events.some((e) => e.type === 'scale' && e.blinks === 3)); pass++;

// --- chromatic paging (7 semitones) ---
combo(c, PC.P_CH, 3); eq(c.scale, 0, 'CH+P03 = Chromatic');
tap(c, PC.P_OCT_UP);
c.padDown(3, .7); near(fund(c), mtof(36 + 7), 0.01, 'chromatic page +1 starts at G2'); c.padUp(3);
for (let i = 0; i < 9; i++) tap(c, PC.P_OCT_UP); eq(c.oct, 5, 'chromatic paging limit is ±5');
combo(c, PC.P_CH, 4); eq(c.oct, 3, 'switching to a 7-note scale clamps shift to ±3 octaves');

// --- root key: TO + pad takes that pad's current note ---
c = new PulsarControls(); combo(c, PC.P_CH, 3);           // chromatic, page 0: pads C..F#
tap(c, PC.P_OCT_UP);                                        // page +1: pads G..C#
combo(c, PC.P_TO, 5); eq(c.root, 9, 'TO + pad (A) sets root A');
assert(!c.events.some((e) => e.type === 'tempo')); pass++; // TO combo must not tap tempo
combo(c, PC.P_CH, 4); tap(c, PC.P_OCT_DN);                  // A major, octave 0
c.padDown(3, .7); near(fund(c), mtof(36 + 9), 0.01, 'A major pad 1 = A2'); c.padUp(3);
eq(c.describe(c.compute(new PulsarParams())).scale, 'A Major', 'display shows key');

// --- MIDI notes are chromatic and ignore the scale ---
c = new PulsarControls(); combo(c, PC.P_CH, 4);             // C major pentatonic on pads
c.midi(0x90, 61, 100); near(fund(c), mtof(61), 0.01, 'MIDI C#4 plays despite pentatonic pad scale');
c.midi(0xE0, 0x7F, 0x7F); near(fund(c), mtof(63), 0.05, 'bend +2 semitones');
c.cc(PC.CC_BEND_RANGE, 12); near(fund(c), mtof(73), 0.2, 'bend range 12');
c.midi(0xE0, 0, 0x40); c.midi(0x80, 61, 0);
eq(c.activeKey(), -1, 'note off releases');

// velocity & aftertouch
c.midi(0x90, 60, 127); let p = c.compute(new PulsarParams());
near(p.gate, 0.85, 0.001, 'full velocity gate');
const fd0 = p.formantHz[0];
c.midi(0xD0, 127, 0); p = c.compute(new PulsarParams());
near(p.gate, 1, 0.001, 'aftertouch raises level');
assert(p.formantHz[0] > fd0 * 1.5, 'aftertouch pushes formant like pad pressure'); pass++;
c.midi(0xD0, 0, 0);
c.midi(0xB0, 1, 127); p = c.compute(new PulsarParams());
near(p.formantHz[0] / fd0, 8, 0.01, 'mod wheel raises formant 3 octaves');
c.midi(0xB0, 1, 0); c.midi(0x80, 60, 0);

// legato glide only when overlapping
c.knob[PC.K_FUND] = 0.5;
c.midi(0x90, 60, 100); eq(c.compute(new PulsarParams()).glideSec, 0, 'detached note: no glide');
c.midi(0x90, 64, 100); assert(c.compute(new PulsarParams()).glideSec > 0, 'legato note glides'); pass++;
c.midi(0x80, 64, 0); near(fund(c), mtof(60), 0.01, 'last-note priority falls back to held note');
c.midi(0x80, 60, 0);

// sustain pedal
c.midi(0x90, 67, 100); c.midi(0xB0, 64, 127); c.midi(0x80, 67, 0);
eq(c.activeKey(), PC.MIDI_KEY + 67, 'sustain holds released note');
c.midi(0xB0, 64, 0); eq(c.activeKey(), -1, 'pedal up releases');

// pads and MIDI share one stack
c.padDown(5, .7); c.midi(0x90, 72, 100); near(fund(c), mtof(72), 0.01, 'MIDI note on top of pad');
c.midi(0x80, 72, 0); near(fund(c), mtof(36 + 4), 0.01, 'back to held pad (E2 in C major)'); c.padUp(5);

// CCs
c.cc(74, 127); eq(c.knob[PC.K_FORMANT], 1, 'CC74 -> formant knob');
c.cc(80, 0); eq(c.alt[PC.K_CLUSTER], 0, 'CC80 -> edge (alt layer)');
c.cc(86, 127); eq(c.range(), 2, 'CC86 -> RHYTHM'); c.cc(87, 64); eq(c.sw[PC.SW_MASK], 1, 'CC87 -> CHANNEL');

// root from MIDI
c = new PulsarControls(); c.cc(PC.CC_ROOT_FROM_MIDI, 127);
c.midi(0x90, 64, 90); c.midi(0x90, 57, 90); c.midi(0x90, 60, 90);
eq(c.root, 9, 'root follows lowest held note (A)');

// --- RHYTHM via MIDI + clock ---
c = new PulsarControls(); c.setSwitch(PC.SW_RANGE, 2);
let t = 0; const tick = 60 / 120 / 24;
for (let i = 0; i < 48; i++) { c.midi(0xF8, 0, 0, t); t += tick; }
near(c.bpm(), 120, 0.5, 'clock 120 bpm'); eq(c.sync, 2, 'one sync per beat');
c.midi(0x90, 48, 100); near(fund(c), 2, 0.01, 'MIDI C3 = 1/4 at 120 = 2 Hz');
c.midi(0x80, 48, 0); c.midi(0x90, 62, 100); near(fund(c), 2 * 2 * 2, 0.01, 'D4 = 1/8, one octave up = x2');
p = c.compute(new PulsarParams()); eq(p.sync, 2, 'sync passed to engine when pulses divide the beat');
c.midi(0x80, 62, 0); c.midi(0x90, 52, 100); // E3 = 1/8T: 3 per beat, still integer
eq(c.compute(new PulsarParams()).sync, 2, 'triplets sync too');
c.tick(t + 1); eq(c.extBpm, 0, 'clock loss falls back to internal tempo');

// --- Thick on the right fader in TONE ---
c = new PulsarControls(); c.knob[PC.K_FUND] = 0.8; c.padDown(3, .7);
p = c.compute(new PulsarParams());
near(p.thick, 0.8, 1e-9, 'TONE: right fader = thick'); eq(p.glideSec, 0, 'TONE pads: no glide');
c.midi(0x90, 60, 100); c.midi(0x90, 64, 100);
near(c.compute(new PulsarParams()).glideSec, PC.LEGATO_GLIDE_SEC, 1e-9, 'TONE MIDI legato: short fixed glide');
c.setSwitch(PC.SW_RANGE, 1); eq(c.compute(new PulsarParams()).thick, 0, 'FREE: no thick');
c.setSwitch(PC.SW_RANGE, 2); eq(c.compute(new PulsarParams()).thick, 0, 'RHYTHM: no thick');
{ // engine: thick widens the stereo image and stays clean
  const core = new PulsarCore(48000), pp = new PulsarParams(), L = new Float32Array(48), R = new Float32Array(48);
  pp.fundHz = 110; pp.formantHz = [440, 0, 0]; pp.gate = 1;
  const side = (th) => { pp.thick = th; let s = 0, m = 0;
    for (let b = 0; b < 2000; b++) { core.setParams(pp); core.process(L, R, null, 48);
      for (let i = 0; i < 48; i++) { assert(isFinite(L[i]) && isFinite(R[i])); s += (L[i] - R[i]) ** 2; m += (L[i] + R[i]) ** 2; } }
    return Math.sqrt(s / m); };
  const dry = side(0), wide = side(0.8);
  assert(dry < 1e-6, 'thick 0 is mono-centred'); pass++;
  assert(wide > 0.1, 'thick 0.8 has stereo width, got ' + wide); pass++;
  assert(core.pulseCountB > 0, 'second train emits'); pass++;
}

// --- filter on the CH layer (P11 + faders) ---
c = new PulsarControls();
p = c.compute(new PulsarParams()); near(p.cutoffHz, 18000, 1e-6, 'filter open by default'); eq(p.resonance, 0, 'no resonance by default');
c.padDown(PC.P_CH, .7); c.turn(PC.K_FUND, 0.5); c.turn(PC.K_LEVEL, 0.6); c.turn(PC.K_SHAPE, 0.9); c.padUp(PC.P_CH);
p = c.compute(new PulsarParams());
near(p.cutoffHz, 30 * Math.sqrt(600), 0.01, 'P11 + right fader = cutoff'); near(p.resonance, 0.6, 1e-9, 'P11 + left fader = resonance');
eq(c.knob[PC.K_FUND], new PulsarControls().knob[PC.K_FUND], 'right fader main value untouched');
near(c.knob[PC.K_SHAPE], 0.9, 1e-9, 'knobs with P11 held still edit their main value');
c.cc(102, 0); c.cc(103, 127); p = c.compute(new PulsarParams());
near(p.cutoffHz, 30, 1e-6, 'CC102 = cutoff'); near(p.resonance, 1, 1e-9, 'CC103 = resonance');
{ // engine: low-pass removes highs; full resonance sweep stays stable
  const hf = (cut, res) => { const core = new PulsarCore(48000), pp = new PulsarParams(), L = new Float32Array(48), R = new Float32Array(48);
    pp.fundHz = 110; pp.formantHz = [2000, 0, 0]; pp.shape = 3; pp.gate = 1; pp.cutoffHz = cut; pp.resonance = res;
    let d = 0, e = 0, prev = 0, peak = 0;
    for (let b = 0; b < 1000; b++) { if (cut < 0) pp.cutoffHz = 30 * Math.pow(600, (b % 250) / 250); core.setParams(pp); core.process(L, R, null, 48);
      for (let i = 0; i < 48; i++) { assert(isFinite(L[i])); d += (L[i] - prev) ** 2; e += L[i] * L[i]; prev = L[i]; peak = Math.max(peak, Math.abs(L[i])); } }
    return { ratio: Math.sqrt(d / (e + 1e-12)), peak }; };
  const open = hf(18000, 0).ratio, closed = hf(300, 0).ratio;
  assert(closed < open * 0.25, 'cutoff 300 Hz removes highs: ' + closed + ' vs ' + open); pass++;
  const sweep = hf(-1, 1);
  assert(sweep.peak <= 1.0001, 'full-resonance sweep stays bounded, peak ' + sweep.peak); pass++;
}

// --- hold (latch) on short P10+P11, recalibrate on long ---
c = new PulsarControls(); c.tick(10);
c.padDown(PC.P_TO, .7); c.padDown(PC.P_CH, .7); c.tick(10.2); c.padUp(PC.P_CH); c.padUp(PC.P_TO);
eq(c.latch, true, 'short TO+CH toggles hold');
assert(!c.events.some((e) => e.type === 'tempo')); pass++;
c.tick(20); c.padDown(PC.P_TO, .7); c.padDown(PC.P_CH, .7); c.tick(21.6);
assert(c.events.some((e) => e.type === 'recal')); pass++;
c.padUp(PC.P_CH); c.padUp(PC.P_TO); eq(c.latch, true, 'long TO+CH recalibrates without toggling hold');

// --- engine: beat sync locks pulse train to the clock ---
// Internal rate 0.3% fast (realistic tempo-estimate error). With sync the error
// is pulled back every beat; without it the drift keeps growing.
function worstOffset(useSync) {
  const SR = 48000, B = 48, core = new PulsarCore(SR), pp = new PulsarParams();
  const L = new Float32Array(B), R = new Float32Array(B);
  pp.fundHz = 2 * 1.003; pp.gate = 1; pp.sync = useSync ? 0 : -1;
  let syncN = 0, worst = 0;
  for (let s = 0; s < SR * 8; s += B) {
    if (useSync && s % (SR / 2) < B && s > 0) pp.sync = ++syncN; // beat every 0.5 s
    core.setParams(pp); const before = core.ringW; core.process(L, R, null, B);
    for (let j = before; j !== core.ringW; j = (j + 1) % 256) {
      const tt = core.ringT[j] / SR, off = Math.abs(tt - Math.round(tt * 2) / 2);
      if (tt > 0.6) worst = Math.max(worst, off);
    }
  }
  return worst;
}
const withSync = worstOffset(true), without = worstOffset(false);
assert(withSync < 0.0025, 'synced pulses within 2.5 ms of the beat, got ' + withSync); pass++;
assert(without > 0.01, 'unsynced drift grows past 10 ms, got ' + without); pass++;
console.log(`beat sync: worst offset ${(withSync * 1000).toFixed(2)} ms synced vs ${(without * 1000).toFixed(1)} ms free`);

console.log(`controls: ${pass} checks passed`);
