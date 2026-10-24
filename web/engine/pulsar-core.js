// =============================================================================
// PulsarCore — pulsar synthesis engine after Curtis Roads, "Sound Composition
// with Pulsars" (JAES 49/3, 2001).
//
// Portability rules (this file is the reference for the C++ / Daisy / iOS port):
//  * plain script, no imports/exports, no DOM, no Web Audio — runs in an
//    AudioWorklet, on the main thread, and in Node.
//  * every buffer is allocated in the constructor; process() allocates nothing.
//  * parameters arrive as a flat struct (PulsarParams) in physical units.
//  * randomness is a 32-bit xorshift so the C++ port is bit-compatible.
// =============================================================================

var PS = {
  TABLE: 2048,        // pulsaret waveform table length (power of two)
  WIN: 1024,          // pulsaret envelope table length
  NSHAPE: 7,
  NWIN: 7,
  NFORM: 3,           // formants (pulsar generators sharing one fundamental)
  NVOICE: 8,          // overlapping pulsarets per formant per train (OPulWM limit)
  NTRAIN: 2,          // train 0 = main, train 1 = detuned 'thick' copy
  NCONV: 12,          // overlapping convolved-kernel voices
  MAX_KERNEL_SEC: 3,
  RING: 256,          // pulse event ring for UI (LED / pulse strip)
  SHAPE_NAMES: ['sine', 'triangle', 'saw', 'square', 'pulse', 'vela', 'noise', 'input'],
  SHAPE_INPUT: 7,     // shape position 7 = live input as the pulsaret waveform (no table)
  WIN_NAMES: ['gauss', 'fof', 'expodec', 'lindec', 'rect', 'linatt', 'expatt'],
  // mask routes
  R_MUTE: 0, R_BOTH: 1, R_LEFT: 2, R_RIGHT: 3,
  // mask modes
  M_OFF: 0, M_BURST: 1, M_CHANNEL: 2, M_STOCH: 3,
};

function PulsarParams() {
  this.fundHz = 110;            // pulsar emission rate f_p
  this.glideSec = 0;            // portamento of f_p (log domain)
  this.formantHz = [440, 0, 0]; // f_d per formant (absolute Hz)
  this.formantAmp = [1, 0, 0];
  this.formantPan = [0, 0, 0];  // -1..1
  this.cluster = 1;             // cycles of w per pulsaret, 1..7 (continuous)
  this.shape = 0;               // 0..6 morph across waveform tables
  this.window = 0;              // 0..6 morph across envelope tables
  this.fold = 0;                // 0..1 wavefolding of the pulsaret
  this.edge = 0.3;              // 0..0.5 = PulWM cut crossfade, >0.5 = OPulWM overlap
  this.maskMode = 0;
  this.burst = 1;               // b (pulsars on)
  this.rest = 0;                // r (pulsars masked)
  this.prob = 1;                // stochastic emission probability
  this.gate = 0;                // 0..1 amplitude target (pad pressure folded in)
  this.attackSec = 0.004;
  this.releaseSec = 0.25;
  this.convMix = 0;             // 0..1 dry pulsar <-> convolved sample
  this.level = 0.7;
  this.drive = 0;               // 0..1
  this.sync = -1;               // beat counter from MIDI clock; -1 = free running
  this.thick = 0;               // 0..1: detuned second train + stereo spread, sub above 0.6
  this.inputGain = 1;           // live input level (shape 7)
  this.cutoffHz = 18000;        // low-pass filter cutoff (fully open by default)
  this.resonance = 0;           // 0..1
}

// ---------------------------------------------------------------------------
function PulsarCore(sampleRate) {
  this.sr = sampleRate;
  var T = PS.TABLE, W = PS.WIN;
  this.shapes = new Float32Array(PS.NSHAPE * (T + 1));
  this.wins = new Float32Array(PS.NWIN * (W + 1));
  this.rng = 0x9E3779B9 | 0;
  this._buildShapes();
  this._buildWindows();

  var NV = PS.NTRAIN * PS.NFORM * PS.NVOICE;
  this.vOn = new Uint8Array(NV);
  this.vPh = new Float32Array(NV);     // phase in cycles of w (0..len)
  this.vInc = new Float32Array(NV);
  this.vLen = new Float32Array(NV);    // cluster
  this.vGL = new Float32Array(NV);
  this.vGR = new Float32Array(NV);
  this.vFade = new Float32Array(NV);
  this.vFadeInc = new Float32Array(NV);

  // convolution kernel (= pulsaret (*) sample, computed off the audio thread)
  this.kernel = new Float32Array(Math.ceil(sampleRate * PS.MAX_KERNEL_SEC));
  this.kernelLen = 0;
  this.cOn = new Uint8Array(PS.NCONV);
  this.cPos = new Float32Array(PS.NCONV);
  this.cGL = new Float32Array(PS.NCONV);
  this.cGR = new Float32Array(PS.NCONV);

  // pulse event ring for the UI (route per emitted / masked pulse)
  this.ring = new Uint8Array(PS.RING);
  this.ringT = new Float64Array(PS.RING); // emission time in samples
  this.clock = 0; this._i = 0;
  this.ringW = 0;

  this.p = new PulsarParams();
  this.fundLog = Math.log(110);
  this.fundPhase = 0;
  this.pulseCount = 0;
  this.phaseB = 0;            // second (thick) train
  this.pulseCountB = 0;
  this.subPhase = 0;
  this.trainGain = [1, 0]; this.trainPan = [0, 0];
  this.lastSync = -1;
  this.env = 0;
  this.dcxL = 0; this.dcyL = 0; this.dcxR = 0; this.dcyR = 0;
  this.inPeak = 0;               // input level meter (after gain)
  this.fcLog = Math.log(18000);  // smoothed filter cutoff (log Hz)
  this.f1L = 0; this.f2L = 0; this.f1R = 0; this.f2R = 0; // SVF state
  this.recBuf = null;
}

PulsarCore.prototype.rand = function () { // xorshift32 -> [0,1)
  var x = this.rng;
  x ^= x << 13; x ^= x >>> 17; x ^= x << 5;
  this.rng = x | 0;
  return (x >>> 8) / 16777216; // top 24 bits: exact in float (matches the C++ port)
};

PulsarCore.prototype._buildShapes = function () {
  var T = PS.TABLE, s, i, x, k, peak;
  for (s = 0; s < PS.NSHAPE; s++) {
    var o = s * (T + 1);
    for (i = 0; i < T; i++) {
      x = i / T;
      var v = 0;
      switch (s) {
        case 0: v = Math.sin(2 * Math.PI * x); break;
        case 1: v = x < 0.25 ? 4 * x : (x < 0.75 ? 2 - 4 * x : 4 * x - 4); break;
        case 2: v = 2 * x - 1; break;
        case 3: v = x < 0.5 ? 1 : -1; break;
        case 4: // band-limited pulse (Fig. 2c): centred sum of cosines
          for (k = 1; k <= 12; k++) v += Math.cos(2 * Math.PI * k * (x - 0.5)) * (1 - k / 13);
          break;
        case 5: // "vela": asymmetric multi-hump cosmic pulse (stand-in for Fig. 2e)
          v = Math.sin(2 * Math.PI * x) * (0.6 + 0.4 * Math.cos(6 * Math.PI * x)) +
              0.35 * Math.sin(10 * Math.PI * x) * Math.exp(-3 * x);
          break;
        case 6: v = this.rand() * 2 - 1; break;
      }
      this.shapes[o + i] = v;
    }
    // normalise peak, remove DC for the pulse shape
    if (s === 4) {
      var m = 0; for (i = 0; i < T; i++) m += this.shapes[o + i]; m /= T;
      for (i = 0; i < T; i++) this.shapes[o + i] -= m;
    }
    peak = 0;
    for (i = 0; i < T; i++) peak = Math.max(peak, Math.abs(this.shapes[o + i]));
    for (i = 0; i < T; i++) this.shapes[o + i] /= peak;
    this.shapes[o + T] = this.shapes[o]; // guard point
  }
};

PulsarCore.prototype._buildWindows = function () {
  var W = PS.WIN, w, i, t, v;
  for (w = 0; w < PS.NWIN; w++) {
    var o = w * (W + 1);
    for (i = 0; i <= W; i++) {
      t = i / W;
      switch (w) {
        case 0: v = Math.exp(-0.5 * Math.pow((t - 0.5) / 0.16, 2)); break;            // gaussian
        case 1: v = t < 0.08 ? 0.5 - 0.5 * Math.cos(Math.PI * t / 0.08)                // FOF
                             : Math.exp(-4.5 * (t - 0.08)); break;
        case 2: v = Math.exp(-6 * t); break;                                         // expodec
        case 3: v = 1 - t; break;                                                    // linear decay
        case 4: v = 1; break;                                                        // rectangular
        case 5: v = t; break;                                                        // linear attack
        case 6: v = Math.exp(6 * (t - 1)); break;                                    // exp attack
      }
      this.wins[o + i] = v;
    }
  }
};

// Morph helpers: position 0..N-1 -> (table a, table b, mix)
function psMorph(pos, n, out) {
  if (pos < 0) pos = 0; if (pos > n - 1) pos = n - 1;
  var a = Math.floor(pos); if (a > n - 2) a = n - 2;
  out[0] = a; out[1] = a + 1; out[2] = pos - a;
}

PulsarCore.prototype.setParams = function (src) {
  var p = this.p;
  for (var k in src) {
    if (k === 'formantHz' || k === 'formantAmp' || k === 'formantPan') {
      for (var i = 0; i < PS.NFORM; i++) p[k][i] = src[k][i];
    } else if (k in p) p[k] = src[k];
  }
};

PulsarCore.prototype.setKernel = function (data, len) {
  len = Math.min(len, this.kernel.length);
  this.kernel.set(data.subarray ? data.subarray(0, len) : data.slice(0, len));
  this.kernelLen = len;
  for (var i = 0; i < PS.NCONV; i++) this.cOn[i] = 0;
};

// Masking (paper §3.2): decide what happens to pulse #n.
PulsarCore.prototype._route = function (n) {
  var p = this.p, cyc, idx;
  switch (p.maskMode) {
    case PS.M_BURST:
      cyc = p.burst + p.rest; idx = n % cyc;
      return idx < p.burst ? PS.R_BOTH : PS.R_MUTE;
    case PS.M_CHANNEL:
      cyc = p.burst + p.rest; idx = n % cyc;
      return idx < p.burst ? PS.R_LEFT : PS.R_RIGHT;
    case PS.M_STOCH:
      return this.rand() < p.prob ? PS.R_BOTH : PS.R_MUTE;
  }
  return PS.R_BOTH;
};

// Emit one pulsar. `late` = samples elapsed since the exact emission instant
// (sub-sample accurate start keeps high fundamentals jitter-free).
PulsarCore.prototype._emit = function (late, train) {
  var p = this.p, sr = this.sr;
  var route = this._route(train ? this.pulseCountB++ : this.pulseCount++);
  if (!train) { this.ring[this.ringW] = route; this.ringT[this.ringW] = this.clock + this._i; this.ringW = (this.ringW + 1) % PS.RING; }
  var vBase = train * PS.NFORM * PS.NVOICE;

  var overlap = p.edge > 0.5;
  if (!overlap) {
    // PulWM: the new period cuts the previous pulsaret, crossfaded by `edge`.
    var edgeSamp = 1 + p.edge * 2 * 0.006 * sr; // 0..6 ms
    for (var v = vBase; v < vBase + PS.NFORM * PS.NVOICE; v++) {
      if (this.vOn[v] && this.vFadeInc[v] === 0) this.vFadeInc[v] = 1 / edgeSamp;
    }
  }
  if (route === PS.R_MUTE) return;

  var rl = route === PS.R_RIGHT ? 0 : 1, rr = route === PS.R_LEFT ? 0 : 1;
  var tg = this.trainGain[train], tp = this.trainPan[train];
  for (var f = 0; f < PS.NFORM; f++) {
    var amp = p.formantAmp[f] * tg;
    var fd = p.formantHz[f];
    if (amp < 0.001 || fd <= 0 || fd > sr * 0.45) continue;
    // voice: free slot, else steal the one closest to its end
    var base = vBase + f * PS.NVOICE, best = base, bestT = -1;
    for (var j = base; j < base + PS.NVOICE; j++) {
      if (!this.vOn[j]) { best = j; bestT = 2; break; }
      var t = this.vPh[j] / this.vLen[j];
      if (t > bestT) { bestT = t; best = j; }
    }
    var inc = fd / sr;
    var pan = Math.max(-1, Math.min(1, p.formantPan[f] + tp)) * 0.5 + 0.5;
    this.vOn[best] = 1;
    this.vInc[best] = inc;
    this.vPh[best] = late * inc;
    this.vLen[best] = p.cluster;
    this.vGL[best] = amp * Math.cos(pan * Math.PI * 0.5) * 1.4142 * rl;
    this.vGR[best] = amp * Math.sin(pan * Math.PI * 0.5) * 1.4142 * rr;
    this.vFade[best] = 1;
    this.vFadeInc[best] = 0;
  }

  // convolution: each surviving pulse triggers a copy of (pulsaret (*) sample)
  if (!train && p.convMix > 0.001 && this.kernelLen > 0) {
    var c = 0, oldest = -1;
    for (var k = 0; k < PS.NCONV; k++) {
      if (!this.cOn[k]) { c = k; oldest = -2; break; }
      if (this.cPos[k] > oldest) { oldest = this.cPos[k]; c = k; }
    }
    this.cOn[c] = 1; this.cPos[c] = late;
    this.cGL[c] = rl; this.cGR[c] = rr;
  }
};

var _mS = [0, 0, 0], _mW = [0, 0, 0];

PulsarCore.prototype.process = function (outL, outR, inMono, n) {
  var p = this.p, sr = this.sr, T = PS.TABLE, W = PS.WIN;
  var shapes = this.shapes, wins = this.wins;

  // ---- control rate (once per block, like the Daisy audio callback) ----
  // Beat sync (external clock): emit now if we're late, otherwise re-align quietly.
  if (p.sync >= 0 && p.sync !== this.lastSync) {
    this.lastSync = p.sync;
    if (this.fundPhase > 0.5) this.fundPhase = 1; else this.fundPhase = 0;
  }
  // shape morph runs over 7 tables + live input (position 7)
  psMorph(p.shape, PS.NSHAPE + 1, _mS);
  psMorph(p.window, PS.NWIN, _mW);
  var bIn = _mS[1] === PS.SHAPE_INPUT;
  var sA = _mS[0] * (T + 1), sB = bIn ? 0 : _mS[1] * (T + 1), sX = _mS[2];
  var inG = p.inputGain;
  this.inPeak *= 0.9;
  var wA = _mW[0] * (W + 1), wB = _mW[1] * (W + 1), wX = _mW[2];
  var foldG = 1 + p.fold * 6, doFold = p.fold > 0.001;

  var targetLog = Math.log(Math.max(0.01, p.fundHz));
  var glideK = p.glideSec > 0.001 ? 1 - Math.exp(-n / (p.glideSec * sr * 0.3)) : 1;
  if (this.env < 0.0005 && p.gate > 0) this.fundLog = targetLog; // no glide in from silence
  var fundLog0 = this.fundLog;
  this.fundLog += (targetLog - this.fundLog) * glideK;
  var inc0 = Math.exp(fundLog0) / sr, inc1 = Math.exp(this.fundLog) / sr;
  var incStep = (inc1 - inc0) / n;

  var attK = 1 - Math.exp(-1 / (Math.max(0.0005, p.attackSec) * sr));
  var relK = 1 - Math.exp(-1 / (Math.max(0.005, p.releaseSec) * sr));
  var convWet = p.convMix, dryG = 1 - convWet * convWet;
  var drv = 1 + p.drive * 8, outG = p.level * p.level;
  var drvN = 1 / Math.tanh(drv * 0.6);
  var NV = PS.NTRAIN * PS.NFORM * PS.NVOICE;
  var kernel = this.kernel, kLen = this.kernelLen;

  // Thick: detuned second train (3..25 cents), trains spread L/R, sub-octave sine above 0.6
  var th = p.thick, bAmp = th > 0 ? Math.min(1, th * 4) : 0;
  var comp = 1 / Math.sqrt(1 + bAmp * bAmp);
  this.trainGain[0] = comp; this.trainGain[1] = bAmp * comp;
  this.trainPan[1] = 0.5 * Math.min(1, th * 2); this.trainPan[0] = -this.trainPan[1];
  var detMul = Math.pow(2, (3 + 22 * th) / 1200);
  var subLvl = th > 0.6 ? (th - 0.6) / 0.4 * 0.5 : 0;
  var subT = shapes; // sine table = shape 0

  // Low-pass filter: TPT state-variable filter (stable while sweeping), cutoff smoothed ~5 ms
  var fcT = Math.log(Math.min(Math.max(p.cutoffHz, 20), 0.45 * sr));
  this.fcLog += (fcT - this.fcLog) * Math.min(1, n / (0.005 * sr));
  var fg = Math.tan(Math.PI * Math.exp(this.fcLog) / sr);
  var fk = 1 / (0.707 + p.resonance * p.resonance * 19.3); // 1/Q, Q 0.7 .. 20
  var fa1 = 1 / (1 + fg * (fg + fk)), fa2 = fg * fa1, fa3 = fg * fa2;

  for (var i = 0; i < n; i++) {
    var inS = inMono ? inMono[i] * inG : 0;
    if (inS > this.inPeak) this.inPeak = inS; else if (-inS > this.inPeak) this.inPeak = -inS;
    // ---- fundamental: pulsar emission clock ----
    var finc = inc0 + incStep * i;
    this.fundPhase += finc;
    if (this.fundPhase >= 1) {
      this.fundPhase -= 1;
      if (this.fundPhase >= 1) this.fundPhase = 0;
      this._i = i; this._emit(this.fundPhase / finc, 0);
    }
    if (bAmp > 0) {
      var fincB = finc * detMul;
      this.phaseB += fincB;
      if (this.phaseB >= 1) {
        this.phaseB -= 1;
        if (this.phaseB >= 1) this.phaseB = 0;
        this._emit(this.phaseB / fincB, 1);
      }
    } else this.phaseB = this.fundPhase; // starts in phase when thick comes in

    var L = 0, R = 0;
    // ---- pulsaret voices: w(t) * v(t) ----
    for (var v = 0; v < NV; v++) {
      if (!this.vOn[v]) continue;
      var ph = this.vPh[v], len = this.vLen[v];
      if (ph >= len) { this.vOn[v] = 0; continue; }
      var fadeInc = this.vFadeInc[v];
      if (fadeInc > 0) {
        var fd = this.vFade[v] - fadeInc;
        if (fd <= 0) { this.vOn[v] = 0; continue; }
        this.vFade[v] = fd;
      }
      // waveform (wraps every cycle -> `cluster` cycles per pulsaret)
      var x = (ph - Math.floor(ph)) * T, xi = x | 0, xf = x - xi;
      var a0 = shapes[sA + xi], b0 = shapes[sB + xi];
      var wa = a0 + (shapes[sA + xi + 1] - a0) * xf;
      var wb = bIn ? inS : b0 + (shapes[sB + xi + 1] - b0) * xf; // live input as waveform
      var w = wa + (wb - wa) * sX;
      if (doFold) w = Math.sin(w * foldG * Math.PI * 0.5); // west-coast fold
      // envelope over the whole pulsaret duration d = cluster / f_d
      var y = (ph / len) * W, yi = y | 0, yf = y - yi;
      var c0 = wins[wA + yi], d0 = wins[wB + yi];
      var ea = c0 + (wins[wA + yi + 1] - c0) * yf;
      var eb = d0 + (wins[wB + yi + 1] - d0) * yf;
      var s = w * (ea + (eb - ea) * wX) * this.vFade[v];
      L += s * this.vGL[v]; R += s * this.vGR[v];
      this.vPh[v] = ph + this.vInc[v];
    }
    L *= dryG; R *= dryG;

    // ---- convolved pulsar train ----
    if (convWet > 0.001 && kLen > 0) {
      var cl = 0, cr = 0;
      for (var c = 0; c < PS.NCONV; c++) {
        if (!this.cOn[c]) continue;
        var pos = this.cPos[c], pi = pos | 0;
        if (pi + 1 >= kLen) { this.cOn[c] = 0; continue; }
        var ks = kernel[pi] + (kernel[pi + 1] - kernel[pi]) * (pos - pi);
        cl += ks * this.cGL[c]; cr += ks * this.cGR[c];
        this.cPos[c] = pos + 1;
      }
      L += cl * convWet; R += cr * convWet;
    }

    // ---- sub-octave sine (thick > 0.6) ----
    if (subLvl > 0) {
      this.subPhase += finc * 0.5;
      if (this.subPhase >= 1) this.subPhase -= 1;
      var sx = this.subPhase * T, si = sx | 0;
      var sv = (subT[si] + (subT[si + 1] - subT[si]) * (sx - si)) * subLvl;
      L += sv; R += sv;
    }

    // ---- amplitude envelope (pad gate / pressure) ----
    var g = p.gate;
    this.env += (g - this.env) * (g > this.env ? attK : relK);
    L *= this.env; R *= this.env;

    // ---- DC block, drive, level ----
    var yl = L - this.dcxL + 0.9995 * this.dcyL; this.dcxL = L; this.dcyL = yl;
    var yr = R - this.dcxR + 0.9995 * this.dcyR; this.dcxR = R; this.dcyR = yr;
    // low-pass (before drive, so drive saturates the resonance)
    var v3 = yl - this.f2L, v1 = fa1 * this.f1L + fa2 * v3, v2 = this.f2L + fa2 * this.f1L + fa3 * v3;
    this.f1L = 2 * v1 - this.f1L; this.f2L = 2 * v2 - this.f2L; yl = v2;
    v3 = yr - this.f2R; v1 = fa1 * this.f1R + fa2 * v3; v2 = this.f2R + fa2 * this.f1R + fa3 * v3;
    this.f1R = 2 * v1 - this.f1R; this.f2R = 2 * v2 - this.f2R; yr = v2;
    outL[i] = Math.tanh(yl * drv * 0.6) * drvN * outG;
    outR[i] = Math.tanh(yr * drv * 0.6) * drvN * outG;

    // ---- sample recording (P01 hold) ----
    if (this.recBuf && inMono) {
      if (this.recPos < this.recBuf.length) this.recBuf[this.recPos++] = inMono[i];
    }
  }
  this.clock += n;
};

PulsarCore.prototype.startRecord = function (seconds) {
  if (!this.recBuf || this.recBuf.length !== Math.floor(this.sr * seconds)) {
    this.recBuf = new Float32Array(Math.floor(this.sr * seconds)); // not in process()
  }
  this.recPos = 0;
};
PulsarCore.prototype.stopRecord = function () {
  var b = this.recBuf, n = this.recPos; this.recBuf = null;
  return b ? b.subarray(0, n) : null;
};

// ---------------------------------------------------------------------------
// Offline helpers (main thread / Daisy main loop) — NOT for the audio callback.

// Render a single pulsaret (formant 0, current shape/window/cluster/fold)
// into `out` (length = cluster / fd seconds). Returns sample count.
PulsarCore.prototype.renderPulsaret = function (fd, out, maxLen) {
  var p = this.p, sr = this.sr, T = PS.TABLE, W = PS.WIN;
  psMorph(p.shape, PS.NSHAPE, _mS); psMorph(p.window, PS.NWIN, _mW);
  var len = Math.min(maxLen, Math.max(1, Math.floor(p.cluster / fd * sr)));
  var foldG = 1 + p.fold * 6;
  for (var i = 0; i < len; i++) {
    var ph = i * fd / sr, x = (ph - Math.floor(ph)) * T, xi = x | 0;
    var w = this.shapes[_mS[0] * (T + 1) + xi] * (1 - _mS[2]) + this.shapes[_mS[1] * (T + 1) + xi] * _mS[2];
    if (p.fold > 0.001) w = Math.sin(w * foldG * Math.PI * 0.5);
    var y = Math.min(W, (i / len) * W | 0);
    var e = this.wins[_mW[0] * (W + 1) + y] * (1 - _mW[2]) + this.wins[_mW[1] * (W + 1) + y] * _mW[2];
    out[i] = w * e;
  }
  return len;
};

PulsarCore.prototype.shapeAt = function (ph) { // ph in cycles; current morph + fold
  var T = PS.TABLE; psMorph(this.p.shape, PS.NSHAPE, _mS);
  var x = (ph - Math.floor(ph)) * T, xi = x | 0;
  var w = this.shapes[_mS[0] * (T + 1) + xi] * (1 - _mS[2]) + this.shapes[_mS[1] * (T + 1) + xi] * _mS[2];
  return this.p.fold > 0.001 ? Math.sin(w * (1 + this.p.fold * 6) * Math.PI * 0.5) : w;
};

PulsarCore.prototype.windowAt = function (t) {
  psMorph(this.p.window, PS.NWIN, _mW);
  var y = Math.max(0, Math.min(PS.WIN, Math.round(t * PS.WIN)));
  return this.wins[_mW[0] * (PS.WIN + 1) + y] * (1 - _mW[2]) + this.wins[_mW[1] * (PS.WIN + 1) + y] * _mW[2];
};

// In-place iterative radix-2 complex FFT (re, im length = power of two).
function psFFT(re, im, inverse) {
  var n = re.length, i, j, k, len;
  for (i = 1, j = 0; i < n; i++) {
    var bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) { var t = re[i]; re[i] = re[j]; re[j] = t; t = im[i]; im[i] = im[j]; im[j] = t; }
  }
  for (len = 2; len <= n; len <<= 1) {
    var ang = 2 * Math.PI / len * (inverse ? 1 : -1);
    var wr = Math.cos(ang), wi = Math.sin(ang);
    for (i = 0; i < n; i += len) {
      var cr = 1, ci = 0;
      for (k = 0; k < len / 2; k++) {
        var a = i + k, b = a + len / 2;
        var xr = re[b] * cr - im[b] * ci, xi = re[b] * ci + im[b] * cr;
        re[b] = re[a] - xr; im[b] = im[a] - xi;
        re[a] += xr; im[a] += xi;
        var ncr = cr * wr - ci * wi; ci = cr * wi + ci * wr; cr = ncr;
      }
    }
  }
  if (inverse) for (i = 0; i < n; i++) { re[i] /= n; im[i] /= n; }
}

// Kernel = pulsaret (*) sample, peak-normalised. Linear convolution makes
// train (*) sample == sum over pulses of this kernel, so the audio thread only
// has to trigger copies of it (paper §3.3, exact for a fixed pulsaret).
function psConvolveKernel(pulsaret, pLen, sample, sLen, maxLen) {
  var outLen = Math.min(maxLen, pLen + sLen - 1);
  var n = 1; while (n < pLen + sLen) n <<= 1;
  var ar = new Float64Array(n), ai = new Float64Array(n);
  var br = new Float64Array(n), bi = new Float64Array(n);
  for (var i = 0; i < pLen; i++) ar[i] = pulsaret[i];
  for (i = 0; i < sLen; i++) br[i] = sample[i];
  psFFT(ar, ai, false); psFFT(br, bi, false);
  for (i = 0; i < n; i++) {
    var r = ar[i] * br[i] - ai[i] * bi[i], im = ar[i] * bi[i] + ai[i] * br[i];
    ar[i] = r; ai[i] = im;
  }
  psFFT(ar, ai, true);
  var out = new Float32Array(outLen), peak = 1e-9;
  for (i = 0; i < outLen; i++) { out[i] = ar[i]; peak = Math.max(peak, Math.abs(ar[i])); }
  var tail = Math.min(outLen, Math.floor(outLen * 0.02) + 32);
  for (i = 0; i < outLen; i++) {
    out[i] /= peak;
    if (i > outLen - tail) out[i] *= (outLen - i) / tail; // fade tail
  }
  return out;
}

if (typeof module !== 'undefined') {
  module.exports = { PS: PS, PulsarCore: PulsarCore, PulsarParams: PulsarParams, psConvolveKernel: psConvolveKernel };
}
