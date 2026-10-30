// =============================================================================
// PulsarControls — maps the Synthux Simple Touch surface (12 pads, 6 knobs,
// 2 faders, 2 three-way switches) and MIDI input to PulsarParams.
//
// This is the "firmware UI" layer. The browser and iPad call it from their UI
// thread; on Daisy it runs in the main loop (same split as TouchString).
// Plain script, no DOM, no platform APIs: hosts feed it raw MIDI bytes.
// =============================================================================

var PC = {
  // knob indices (S30..S37)
  K_SPREAD: 0, K_FORMANT: 1, K_CLUSTER: 2, K_SHAPE: 3, K_WINDOW: 4, K_MASK: 5, K_LEVEL: 6, K_FUND: 7,
  KNOB_IDS: ['S30', 'S31', 'S32', 'S33', 'S34', 'S35', 'S36', 'S37'],
  KNOB_NAMES: ['spread', 'formant', 'cluster', 'shape', 'window', 'mask', 'level', 'fund'],
  ALT_NAMES: ['width', 'push', 'edge', 'fold', 'lift', 'in gain', 'drive', 'chorus'],
  CH_NAMES: ['motion', 'dly time', 'delay', 'attack', 'release', 'conv', 'res', 'cutoff'], // P11 (CH) layer
  CH_KNOBS: [0, 1, 2, 3, 4, 5, 6, 7], // every knob and fader has a CH-layer function
  // delay time steps (beats), synced to the tempo
  DELAY_BEATS: [0.25, 1 / 3, 0.5, 0.75, 2 / 3, 1, 1.5, 2],
  DELAY_NAMES: ['1/16', '1/8T', '1/8', '1/8.', '1/4T', '1/4', '1/4.', '1/2'],
  // switches
  SW_RANGE: 0,  // S09/S10 (left):  up TONE · center FREE · down RHYTHM
  SW_MASK: 1,   // S07/S08 (right): up BURST · center CHANNEL · down STOCH
  RANGE_NAMES: ['TONE', 'FREE', 'RHYTHM'],
  MASK_NAMES: ['BURST', 'CHANNEL', 'STOCH'],
  // pads
  P_OCT_DN: 0, P_CONV: 1, P_OCT_UP: 2, P_TO: 10, P_CH: 11,
  // Scales for pads P03..P09 (semitones above the root). CH + P03..P09 selects.
  SCALES: [
    ['Chromatic', [0, 1, 2, 3, 4, 5, 6]],
    ['Major', [0, 2, 4, 5, 7, 9, 11]],
    ['Minor', [0, 2, 3, 5, 7, 8, 10]],
    ['Min Pent', [0, 3, 5, 7, 10, 12, 15]],
    ['Maj Pent', [0, 2, 4, 7, 9, 12, 14]],
    ['Dorian', [0, 2, 3, 5, 7, 9, 10]],
    ['Harm Minor', [0, 2, 3, 5, 7, 8, 11]],
  ],
  NOTE_NAMES: ['C', 'C#', 'D', 'Eb', 'E', 'F', 'F#', 'G', 'Ab', 'A', 'Bb', 'B'],
  // pulsar-graph note values (Fig. 5): pulses per beat for pads P03..P09
  SUBDIV: [1, 2, 3, 4, 5, 6, 8],
  SUBDIV_NAMES: ['1/4', '1/8', '1/8T', '1/16', '1/16Q', '1/16T', '1/32'],
  // MIDI note pitch class -> SUBDIV index (white keys C..B; black keys use the key below)
  PC_TO_SUBDIV: [0, 0, 1, 1, 2, 3, 3, 4, 4, 5, 5, 6],
  // burst ratios b:r ordered by rest fraction (knob 0 = no masking)
  BURSTS: [[1, 0], [7, 1], [6, 1], [5, 1], [4, 1], [3, 1], [5, 2], [2, 1], [5, 3], [3, 2], [4, 3],
           [1, 1], [3, 4], [2, 3], [3, 5], [1, 2], [2, 5], [1, 3], [1, 4], [1, 5], [1, 6]],
  HOLD_SEC: 0.4,
  PRESS_HIST: 96,            // pressure look-back history per pad (sampled every 10 ms, > 0.75 s)
  PRESS_HIST_DT: 0.01,
  LEGATO_GLIDE_SEC: 0.06,    // TONE: fixed portamento for overlapping MIDI notes
  LATCH_MAX_SEC: 1.0,        // P10+P11 shorter than this toggles hold
  RECAL_SEC: 1.5,            // P10+P11 held this long recalibrates the pads (hardware)
  MIDI_KEY: 128,             // note-stack keys: pads 3..9, MIDI notes 128 + note
  // MIDI CC map: [cc, layer ('k' main / 'a' alt), index]
  CC_MAP: [
    [77, 'k', 0], [74, 'k', 1], [71, 'k', 2], [75, 'k', 3], [76, 'k', 4], [85, 'k', 5], [7, 'k', 6], [5, 'k', 7],
    [78, 'a', 0], [79, 'a', 1], [80, 'a', 2], [81, 'a', 3], [106, 'a', 4], [104, 'a', 5], [83, 'a', 6], [84, 'a', 7],
  ],
  CC_CUTOFF: 102, CC_RES: 103, CC_CONV: 82, CC_MOTION: 105, CC_RELEASE: 72, CC_ATTACK: 107, CC_DELAY_TIME: 108, CC_DELAY_AMT: 109,
  CC_MOD: 1, CC_SUSTAIN: 64, CC_RANGE: 86, CC_MASKMODE: 87, CC_BEND_RANGE: 88, CC_ROOT_FROM_MIDI: 89,
  CC_ALL_OFF: 123,
};

function PulsarControls() {
  this.knob = [0.15, 0.45, 0.0, 0.0, 0.0, 0.0, 0.7, 0.35];
  this.alt = [0.6, 0.35, 0.3, 0.0, 0.5, 0.5, 0.15, 0.0]; // [4] lift (0.15 s), [5] input gain (0 dB) // [7] chorus/ensemble (off)
  this.tempo = 90;           // BPM: tap P10, P10 + P00/P02, or MIDI clock
  this.ch = [0, 3 / 7, 0, 0, 0.3, 0.6, 0, 1]; // CH layer: [0] motion (off), [1] delay time (1/8.), [2] delay amount (off), [3] attack (4 ms),
                                          // [4] release (0.1 s), [5] conv mix (60 %), [6] resonance, [7] cutoff (open)
  this.sw = [0, 0];
  this.touched = new Uint8Array(12);
  this.pressure = new Float32Array(12);
  this.pHistV = new Float32Array(12 * PC.PRESS_HIST); this.pHistT = new Float64Array(12 * PC.PRESS_HIST).fill(-1e9);
  this.pHistW = new Int32Array(12); this.pHistLast = new Float64Array(12).fill(-1e9);
  this.heldPress = new Float32Array(12).fill(0.6); // pressure each pad had when released
  this.stack = [];           // held note keys (pads 3..9, MIDI 128+n), last = active
  this.lastKey = 3;          // pitch source after release (keeps the release tail in tune)
  this.oct = 0;              // pad shift: octaves, or 7-semitone pages in Chromatic
  this.scale = 1;            // Major
  this.root = 0;             // 0..11, C
  this.latch = false;
  this.latchedKey = -1;
  this.coupled = true;
  this.convOn = false;
  this.recording = false;
  this.modUsed = [false, false]; // P10 / P11 combined with something
  this.padDownAt = new Float64Array(12);
  this.consumed = new Uint8Array(12); // pad was part of a modifier combo
  this.comboAt = -1;         // time P10+P11 were both pressed
  this.recalDone = false;
  this.taps = [];
  this.events = [];          // {type, text, blinks} for UI / LED feedback
  this.now = 0;
  // MIDI state
  this.midiVel = new Float32Array(128);
  this.midiAT = new Float32Array(128);   // poly aftertouch per note
  this.chanAT = 0;
  this.bend = 0;             // -1..1
  this.bendRange = 2;        // semitones
  this.mod = 0;              // mod wheel 0..1 -> formant
  this.sustain = false;
  this.sustained = [];       // MIDI keys released while sustain pedal is down
  this.legato = false;       // last MIDI note started while another was held
  this.rootFromMidi = false;
  this.clockTimes = [];      // recent MIDI clock arrival times (s)
  this.clockCount = 0;
  this.extBpm = 0;           // >0 while external clock is running
  this.dlyBpm = 0;           // clock tempo for the delay: moves only on changes > 1%, so jitter doesn't bend the repeats
  this.lastClockAt = -1;
  this.sync = 0;             // increments on each beat to phase-align the engine
  this.midiActivity = 0;     // time of last MIDI message (UI blink)
}

PulsarControls.prototype.bpm = function () { return this.extBpm > 0 ? this.extBpm : this.tempo; };
PulsarControls.prototype.delayBpm = function () { return this.extBpm > 0 && this.dlyBpm > 0 ? this.dlyBpm : this.tempo; };
PulsarControls.prototype.range = function () { return this.sw[PC.SW_RANGE]; };
PulsarControls.prototype.toHeld = function () { return !!this.touched[PC.P_TO]; };
PulsarControls.prototype.chHeld = function () { return !!this.touched[PC.P_CH]; };
PulsarControls.prototype._ev = function (type, text, blinks) { this.events.push({ type: type, text: text, blinks: blinks || 0 }); };
PulsarControls.prototype.chromatic = function () { return this.scale === 0; };
PulsarControls.prototype.octLimit = function () { return this.chromatic() ? 5 : 3; };
PulsarControls.prototype.shiftSemis = function () { return this.oct * (this.chromatic() ? 7 : 12); };
PulsarControls.prototype.rootName = function () { return PC.NOTE_NAMES[this.root]; };

// Semitones above C of a note pad (root + scale degree + octave/page shift).
PulsarControls.prototype.padSemis = function (pad) {
  return this.root + PC.SCALES[this.scale][1][pad - 3] + this.shiftSemis();
};

// Hardware-style knob write: holding P10 (TO) edits the alt layer.
// Holding P11 (CH) makes the faders edit the filter (S37 cutoff, S36 resonance).
PulsarControls.prototype.turn = function (i, v) {
  if (this.toHeld()) { this.alt[i] = v; this.modUsed[0] = true; }
  else if (this.chHeld() && PC.CH_KNOBS.indexOf(i) >= 0) { this.ch[i] = v; this.modUsed[1] = true; }
  else this.knob[i] = v;
};
PulsarControls.prototype.setSwitch = function (i, pos) { this.sw[i] = pos; };

// ---- note stack (shared by pads and MIDI) ----
PulsarControls.prototype._push = function (key) {
  var k = this.stack.indexOf(key); if (k >= 0) this.stack.splice(k, 1);
  this.stack.push(key); this.lastKey = key;
  if (this.latch) this.latchedKey = key;
};
PulsarControls.prototype._pull = function (key) {
  var k = this.stack.indexOf(key); if (k >= 0) this.stack.splice(k, 1);
};
PulsarControls.prototype.activeKey = function () {
  if (this.stack.length) return this.stack[this.stack.length - 1];
  if (this.latch && this.latchedKey >= 0) return this.latchedKey;
  return -1;
};
PulsarControls.prototype.activePad = function () { // pad index for UI highlight, or -1
  var k = this.activeKey(); return k >= 3 && k <= 9 ? k : -1;
};

PulsarControls.prototype.toggleLatch = function () {
  this.latch = !this.latch;
  this.latchedKey = this.latch ? (this.stack.length ? this.stack[this.stack.length - 1] : this.lastKey) : -1;
  this._ev('latch', this.latch ? 'HOLD on' : 'HOLD off', this.latch ? 2 : 1);
};

// ---- pads ----
PulsarControls.prototype.padDown = function (i, pressure) {
  this.touched[i] = 1; this.pressure[i] = pressure; this.padDownAt[i] = this.now; this.consumed[i] = 0;
  var b0 = i * PC.PRESS_HIST; this.pHistV.fill(0, b0, b0 + PC.PRESS_HIST); this.pHistT.fill(-1e9, b0, b0 + PC.PRESS_HIST);
  this.pHistLast[i] = -1e9; this._pressRecord(i, pressure);
  var to = this.touched[PC.P_TO], ch = this.touched[PC.P_CH];

  if ((i === PC.P_TO && ch) || (i === PC.P_CH && to)) { // TO + CH: tap = hold (latch), long = recalibrate
    this.modUsed[0] = this.modUsed[1] = true;
    this.comboAt = this.now; this.recalDone = false;
    return;
  }
  if (i === PC.P_TO || i === PC.P_CH) { this.modUsed[i === PC.P_TO ? 0 : 1] = false; return; }

  if (ch) { // ---- CH layer: scales & coupling ----
    this.modUsed[1] = true; this.consumed[i] = 1;
    if (i === PC.P_OCT_DN || i === PC.P_OCT_UP) this.setScale((this.scale + (i === PC.P_OCT_UP ? 1 : 6)) % 7);
    else if (i === PC.P_CONV) {
      this.coupled = !this.coupled;
      this._ev('coupled', this.coupled ? 'Formant coupled' : 'Formant free', this.coupled ? 2 : 1);
    } else if (i >= 3 && i <= 9) this.setScale(i - 3);
    return;
  }
  if (to) { // ---- TO layer: tempo nudge, root key ----
    this.modUsed[0] = true; this.consumed[i] = 1;
    if (i === PC.P_OCT_DN || i === PC.P_OCT_UP) {
      var b = Math.max(40, Math.min(240, this.tempo + (i === PC.P_OCT_UP ? 5 : -5)));
      this.tempo = b;
      this._ev('tempo', 'Tempo ' + Math.round(b), 1);
    } else if (i >= 3 && i <= 9) {
      this.setRoot(this.padSemis(i));
    }
    return;
  }
  if (i === PC.P_OCT_DN || i === PC.P_OCT_UP) {
    var lim = this.octLimit();
    this.oct = Math.max(-lim, Math.min(lim, this.oct + (i === PC.P_OCT_UP ? 1 : -1)));
    var txt = this.chromatic() ? 'Shift ' + (this.oct > 0 ? '+' : '') + this.oct * 7 + ' st'
                               : 'Octave ' + (this.oct > 0 ? '+' : '') + this.oct;
    this._ev('oct', txt, Math.abs(this.oct) + 1);
    return;
  }
  if (i === PC.P_CONV) return; // resolved on release / hold in tick()
  if (i >= 3 && i <= 9) this._push(i);
};

PulsarControls.prototype.setScale = function (s) {
  this.scale = s;
  var lim = this.octLimit(); this.oct = Math.max(-lim, Math.min(lim, this.oct));
  this._ev('scale', 'Scale: ' + this.rootName() + ' ' + PC.SCALES[s][0], s + 1);
};

PulsarControls.prototype.setRoot = function (semis) {
  this.root = ((semis % 12) + 12) % 12;
  this._ev('root', 'Root: ' + this.rootName(), 1);
};

PulsarControls.prototype.padMove = function (i, pressure) {
  if (!this.touched[i]) return;
  this.pressure[i] = pressure;
  this._pressRecord(i, pressure);
};

// ---- pressure look-back: the sound uses max(now, value `lift` seconds ago), so a finger
// lift shorter than the window is never heard, and a released pad keeps its pre-lift pressure.
PulsarControls.prototype.delayStep = function () { return Math.round(this.ch[PC.K_FORMANT] * 7); };
PulsarControls.prototype.liftSec = function () { return pcExp(this.alt[PC.K_WINDOW], 0.03, 0.75); }; // P10 + S34
PulsarControls.prototype._pressRecord = function (i, v) {
  if (this.now - this.pHistLast[i] < PC.PRESS_HIST_DT) return;
  var k = i * PC.PRESS_HIST + this.pHistW[i];
  this.pHistV[k] = v; this.pHistT[k] = this.now;
  this.pHistW[i] = (this.pHistW[i] + 1) % PC.PRESS_HIST; this.pHistLast[i] = this.now;
};
PulsarControls.prototype._pressAgo = function (i, tau) { // newest sample at least tau old
  var target = this.now - tau, base = i * PC.PRESS_HIST;
  for (var k = 1; k <= PC.PRESS_HIST; k++) {
    var idx = base + (this.pHistW[i] - k + PC.PRESS_HIST) % PC.PRESS_HIST;
    if (this.pHistT[idx] <= target) return this.pHistV[idx];
  }
  return 0;
};
PulsarControls.prototype.effPress = function (i) {
  return Math.max(this.pressure[i], this._pressAgo(i, this.liftSec()));
};

PulsarControls.prototype.padUp = function (i) {
  if (!this.touched[i]) return;
  this.touched[i] = 0;
  this.heldPress[i] = this.effPress(i);
  var held = this.now - this.padDownAt[i];
  if ((i === PC.P_TO || i === PC.P_CH) && this.comboAt >= 0) {
    if (!this.recalDone && this.now - this.comboAt < PC.LATCH_MAX_SEC) this.toggleLatch();
    this.comboAt = -1;
  } else if (i === PC.P_TO && !this.modUsed[0] && held < PC.HOLD_SEC) this._tap();
  if (i === PC.P_CONV) {
    // result (captured / silence) is reported by the host once it has the audio
    if (this.recording) { this.recording = false; this._ev('rec-stop', 'Recording stopped…', 0); }
    else if (!this.consumed[i]) {
      this.convOn = !this.convOn; this._ev('conv', this.convOn ? 'Convolve on' : 'Convolve off', this.convOn ? 2 : 1);
    }
  }
  this._pull(i);
};

PulsarControls.prototype._tap = function () {
  var t = this.now, taps = this.taps;
  if (taps.length && t - taps[taps.length - 1] > 2) taps.length = 0;
  taps.push(t); if (taps.length > 4) taps.shift();
  if (taps.length >= 2) {
    var b = 60 * (taps.length - 1) / (taps[taps.length - 1] - taps[0]);
    this.tempo = Math.max(40, Math.min(240, b));
  }
  this._ev('tempo', 'Tempo ' + Math.round(this.tempo), 1); // short LED flash on every tap
};

// ---- MIDI (omni; hosts pass raw bytes, timestamps in seconds) ----
PulsarControls.prototype.midi = function (status, d1, d2, t) {
  if (t === undefined) t = this.now;
  var type = status & 0xF0;
  if (status >= 0xF8) { // realtime
    if (status === 0xF8) this._clock(t);
    else if (status === 0xFA) { this.clockCount = 0; this.clockTimes.length = 0; this.sync++; } // start
    else if (status === 0xFC) { this.extBpm = 0; this.lastClockAt = -1; }                       // stop
    return;
  }
  this.midiActivity = t;
  if (type === 0x90 && d2 > 0) this.noteOn(d1, d2 / 127);
  else if (type === 0x80 || type === 0x90) this.noteOff(d1);
  else if (type === 0xA0) this.midiAT[d1] = d2 / 127;
  else if (type === 0xD0) this.chanAT = d1 / 127;
  else if (type === 0xE0) this.bend = ((d2 << 7 | d1) - 8192) / 8192;
  else if (type === 0xB0) this.cc(d1, d2);
};

PulsarControls.prototype.noteOn = function (n, vel) {
  var key = PC.MIDI_KEY + n;
  this.legato = this.stack.some(function (k) { return k >= PC.MIDI_KEY; });
  var s = this.sustained.indexOf(key); if (s >= 0) this.sustained.splice(s, 1);
  this.midiVel[n] = vel; this.midiAT[n] = 0;
  this._push(key);
  if (this.rootFromMidi) {
    var lo = 127; // lowest held MIDI note = chord root
    for (var j = 0; j < this.stack.length; j++) if (this.stack[j] >= PC.MIDI_KEY) lo = Math.min(lo, this.stack[j] - PC.MIDI_KEY);
    if (lo % 12 !== this.root) this.setRoot(lo);
  }
};

PulsarControls.prototype.noteOff = function (n) {
  var key = PC.MIDI_KEY + n;
  if (this.sustain) { if (this.sustained.indexOf(key) < 0) this.sustained.push(key); return; }
  this._pull(key);
};

PulsarControls.prototype.cc = function (c, v) {
  var x = v / 127, m = PC.CC_MAP;
  for (var i = 0; i < m.length; i++) {
    if (m[i][0] === c) { (m[i][1] === 'k' ? this.knob : this.alt)[m[i][2]] = x; return; }
  }
  if (c === PC.CC_DELAY_TIME) this.ch[PC.K_FORMANT] = x;
  else if (c === PC.CC_DELAY_AMT) this.ch[PC.K_CLUSTER] = x;
  else if (c === PC.CC_ATTACK) this.ch[PC.K_SHAPE] = x;
  else if (c === PC.CC_RELEASE) this.ch[PC.K_WINDOW] = x;
  else if (c === PC.CC_MOTION) this.ch[PC.K_SPREAD] = x;
  else if (c === PC.CC_CONV) this.ch[PC.K_MASK] = x;
  else if (c === PC.CC_CUTOFF) this.ch[PC.K_FUND] = x;
  else if (c === PC.CC_RES) this.ch[PC.K_LEVEL] = x;
  else if (c === PC.CC_MOD) this.mod = x;
  else if (c === PC.CC_SUSTAIN) {
    this.sustain = v >= 64;
    if (!this.sustain) { for (var j = 0; j < this.sustained.length; j++) this._pull(this.sustained[j]); this.sustained.length = 0; }
  }
  else if (c === PC.CC_RANGE) this.sw[PC.SW_RANGE] = Math.min(2, Math.floor(v / 43));
  else if (c === PC.CC_MASKMODE) this.sw[PC.SW_MASK] = Math.min(2, Math.floor(v / 43));
  else if (c === PC.CC_BEND_RANGE) this.bendRange = Math.max(0, Math.min(24, v));
  else if (c === PC.CC_ROOT_FROM_MIDI) this.rootFromMidi = v >= 64;
  else if (c === PC.CC_ALL_OFF || c === 120) this.allNotesOff();
};

PulsarControls.prototype.allNotesOff = function () {
  var keep = [];
  for (var i = 0; i < this.stack.length; i++) if (this.stack[i] < PC.MIDI_KEY) keep.push(this.stack[i]);
  this.stack = keep; this.sustained.length = 0; this.sustain = false;
};

// 24 PPQN clock -> tempo (averaged over one beat) + beat sync counter.
PulsarControls.prototype._clock = function (t) {
  var ct = this.clockTimes;
  if (this.lastClockAt >= 0 && t - this.lastClockAt > 0.5) ct.length = 0; // clock resumed after a gap
  ct.push(t); if (ct.length > 25) ct.shift();
  this.lastClockAt = t;
  if (ct.length >= 7) {
    var b = 60 * (ct.length - 1) / ((ct[ct.length - 1] - ct[0]) * 24);
    if (b > 20 && b < 400) this.extBpm = this.extBpm > 0 ? this.extBpm + (b - this.extBpm) * 0.3 : b;
    if (this.extBpm > 0 && !(Math.abs(this.extBpm - this.dlyBpm) <= 0.01 * this.dlyBpm)) this.dlyBpm = this.extBpm;
  }
  if (this.clockCount % 24 === 0) this.sync++;
  this.clockCount++;
};

// Call regularly (UI tick) with the current time in seconds.
PulsarControls.prototype.tick = function (now) {
  this.now = now;
  if (this.touched[PC.P_CONV] && !this.recording && !this.chHeld() && !this.toHeld() &&
      now - this.padDownAt[PC.P_CONV] > PC.HOLD_SEC) {
    this.recording = true; this._ev('rec-start', 'Recording input…', 0);
  }
  if (this.comboAt >= 0 && !this.recalDone && this.toHeld() && this.chHeld() && now - this.comboAt > PC.RECAL_SEC) {
    this.recalDone = true; this._ev('recal', 'Recalibrating pads', 3);
  }
  if (this.extBpm > 0 && this.lastClockAt >= 0 && now - this.lastClockAt > 0.5) this.extBpm = 0; // clock lost
};

function pcExp(v, lo, hi) { return lo * Math.pow(hi / lo, v); }

// Compute engine params. `out` is a PulsarParams (or plain object) to fill.
PulsarControls.prototype.compute = function (out) {
  var K = this.knob, A = this.alt, range = this.range();
  var key = this.activeKey(), src = key >= 0 ? key : this.lastKey;
  var isMidi = src >= PC.MIDI_KEY, n = src - PC.MIDI_KEY;
  var bpm = this.bpm(), bendMul = Math.pow(2, this.bend * this.bendRange / 12);

  // per-note expression: pads -> touch pressure; MIDI -> velocity + aftertouch
  // released notes (hold, or the release tail) keep the pressure they had when let go
  var press = isMidi ? Math.max(this.midiAT[n], this.chanAT)
            : (this.touched[src] ? this.effPress(src) : this.heldPress[src]);
  var gate = 0;
  if (key >= 0 && isMidi) gate = Math.min(1, (0.3 + 0.7 * this.midiVel[n]) * (0.85 + 0.3 * press));
  else if (key >= 0) gate = 0.55 + 0.45 * press;

  // semitones above C2 for TONE / FREE; subdivision + octave for RHYTHM
  var semis = isMidi ? n - 36 : this.padSemis(src);
  var subIdx = isMidi ? PC.PC_TO_SUBDIV[n % 12] : src - 3;
  var rateMul = isMidi ? Math.pow(2, Math.floor(n / 12) - 4) : Math.pow(2, this.oct); // MIDI C3 = x1

  // ---- fundamental f_p ----
  var fund, glide, glideK = K[PC.K_FUND] * K[PC.K_FUND];
  var thick = 0;
  if (range === 0) {          // TONE: note pitch (pads from C2 + root); right fader = Thick
    fund = 65.406 * Math.pow(2, semis / 12) * bendMul;
    thick = K[PC.K_FUND];
    glide = PC.LEGATO_GLIDE_SEC; // only used for MIDI legato (see below)
  } else if (range === 1) {   // FREE: right fader sweeps 0.25 Hz .. 2 kHz (rhythm -> tone)
    fund = pcExp(K[PC.K_FUND], 0.25, 2048);
    glide = 0.04;
  } else {                    // RHYTHM: note values at tempo (pulsar graph)
    fund = bpm / 60 * PC.SUBDIV[subIdx] * rateMul * bendMul;
    glide = glideK * 4;       // accelerando / ritardando
  }
  if (range === 0 && !(isMidi && this.legato)) glide = 0; // TONE: short glide on MIDI legato only
  if (isMidi && range === 2 && !this.legato) glide = 0;   // RHYTHM via MIDI: glide only when legato

  // ---- formant f_d ----
  var coupled = this.coupled && range !== 2;
  var push = Math.pow(2, A[PC.K_FORMANT] * press * 2 + this.mod * 3); // pressure + mod wheel raise it
  var noteMul = range === 1 ? Math.pow(2, (semis - (isMidi ? 12 : 0)) / 12) * bendMul : 1; // FREE: note plays formant (MIDI C3 = pad C)
  var fd = coupled ? fund * pcExp(K[PC.K_FORMANT], 1, 32) * noteMul : pcExp(K[PC.K_FORMANT], 50, 6400) * noteMul;
  fd *= push;

  var s = K[PC.K_SPREAD], w = A[PC.K_SPREAD];
  out.fundHz = fund;
  out.glideSec = glide;
  out.thick = thick;
  out.formantHz = [fd, fd * (1 + 2.5 * s), fd * (1 + 5.5 * s)];
  out.formantAmp = [1, Math.min(1, s * 3) * 0.7, Math.max(0, Math.min(1, s * 3 - 0.6)) * 0.5];
  out.formantPan = [0, -w, w];
  out.cluster = 1 + K[PC.K_CLUSTER] * 6;
  out.shape = K[PC.K_SHAPE] * 7; // 7 = live input
  out.window = K[PC.K_WINDOW] * 6;
  out.fold = A[PC.K_SHAPE];
  out.edge = A[PC.K_CLUSTER];

  // ---- masking ----
  var m = this.sw[PC.SW_MASK], mv = K[PC.K_MASK];
  if (m === 2) { out.maskMode = 3; out.prob = 1 - 0.97 * mv; out.burst = 1; out.rest = 0; }
  else {
    var tbl = PC.BURSTS, lo = m === 1 ? 11 : 0; // channel masking starts at 1:1 (ping-pong)
    var idx = Math.round(lo + mv * (tbl.length - 1 - lo));
    out.maskMode = m === 1 ? 2 : (idx === 0 ? 0 : 1);
    out.burst = tbl[idx][0]; out.rest = tbl[idx][1]; out.prob = 1;
  }

  // ---- external clock: align pulses to the beat when they divide it evenly ----
  var ppb = fund * 60 / bpm;
  out.sync = range === 2 && this.extBpm > 0 && ppb >= 0.999 && Math.abs(ppb - Math.round(ppb)) < 0.01 ? this.sync : -1;

  out.gate = gate;
  out.attackSec = pcExp(this.ch[PC.K_SHAPE], 0.004, 3); // P11 + S33: 4 ms (fully left) .. 3 s
  out.releaseSec = pcExp(this.ch[PC.K_WINDOW], 0.02, 4); // P11 + S34 (next to attack)
  out.convMix = this.convOn ? this.ch[PC.K_MASK] : 0; // P11 + S35
  out.level = K[PC.K_LEVEL];
  out.drive = A[PC.K_LEVEL];
  out.cutoffHz = pcExp(this.ch[PC.K_FUND], 30, 18000);
  out.resonance = this.ch[PC.K_LEVEL];
  out.inputGain = pcExp(A[PC.K_MASK], 0.25, 4); // P10 + S35: -12..+12 dB, centre = 0 dB
  out.motion = this.ch[PC.K_SPREAD];
  out.chorus = A[PC.K_FUND];
  out.delaySec = Math.min(2.4, 60 / this.delayBpm() * PC.DELAY_BEATS[this.delayStep()]);
  out.delayAmt = this.ch[PC.K_CLUSTER];
  return out;
};

// Human-readable state for the display (OLED on hardware, panel in browser).
PulsarControls.prototype.describe = function (p) {
  var range = this.range(), key = this.activeKey(), src = key >= 0 ? key : this.lastKey;
  var isMidi = src >= PC.MIDI_KEY, n = src - PC.MIDI_KEY;
  var subIdx = isMidi ? PC.PC_TO_SUBDIV[n % 12] : src - 3;
  var mask = p.maskMode === 3 ? 'STOCH ' + Math.round(p.prob * 100) + '%'
           : p.maskMode === 2 ? 'CHAN ' + p.burst + ':' + p.rest
           : p.maskMode === 1 ? 'BURST ' + p.burst + ':' + p.rest : 'NO MASK';
  var noteName = isMidi ? PC.NOTE_NAMES[n % 12] + (Math.floor(n / 12) - 1)
               : PC.NOTE_NAMES[((this.padSemis(src) % 12) + 12) % 12];
  return {
    range: PC.RANGE_NAMES[range] + (this.coupled && range !== 2 ? '' : '-D'),
    fund: p.fundHz, formant: p.formantHz[0],
    note: range === 2 ? PC.SUBDIV_NAMES[subIdx] + ' @ ' + Math.round(this.bpm()) + (this.extBpm > 0 ? ' ext' : '')
                      : (key >= 0 ? noteName : ''),
    mask: mask, scale: this.rootName() + ' ' + PC.SCALES[this.scale][0],
    oct: this.chromatic() ? (this.oct * 7 > 0 ? '+' : '') + this.oct * 7 + ' st' : 'oct ' + (this.oct > 0 ? '+' : '') + this.oct,
    latch: this.latch, conv: this.convOn, rec: this.recording, coupled: this.coupled,
    midi: isMidi && key >= 0, ext: this.extBpm > 0,
  };
};

if (typeof module !== 'undefined') module.exports = { PC: PC, PulsarControls: PulsarControls };
