// AudioWorklet wrapper. app.js concatenates pulsar-core.js + this file into one
// Blob module (worklet modules don't share globals), so PulsarCore is in scope.
// Equivalent on Daisy: the audio callback in Pulsar.cpp.

class PulsarProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.core = new PulsarCore(sampleRate);
    this.lastW = 0;
    this.lastPost = 0;
    this.routes = new Uint8Array(PS.RING);
    this.times = new Float64Array(PS.RING);
    this.port.onmessage = (e) => {
      const m = e.data;
      if (m.type === 'params') this.core.setParams(m.p);
      else if (m.type === 'kernel') this.core.setKernel(m.data, m.data.length);
      else if (m.type === 'rec') {
        if (m.on) this.core.startRecord(m.seconds || 2);
        else {
          const b = this.core.stopRecord();
          if (b) { const c = new Float32Array(b); this.port.postMessage({ type: 'rec', data: c }, [c.buffer]); }
        }
      }
    };
  }

  process(inputs, outputs) {
    const out = outputs[0], L = out[0], R = out[1] || out[0];
    const inp = inputs[0] && inputs[0][0] ? inputs[0][0] : null;
    this.core.process(L, R, inp, L.length);

    // forward pulse events (for LED + pulse strip) ~60 times per second
    if (currentTime - this.lastPost > 0.016) {
      const c = this.core, w = c.ringW;
      let n = (w - this.lastW + PS.RING) % PS.RING, k = 0;
      for (let j = this.lastW; k < n; j = (j + 1) % PS.RING, k++) {
        this.routes[k] = c.ring[j]; this.times[k] = c.ringT[j] / sampleRate;
      }
      this.lastW = w; this.lastPost = currentTime;
      this.port.postMessage({ type: 'pulses', n, routes: this.routes.slice(0, n), times: this.times.slice(0, n), count: c.pulseCount, inPeak: c.inPeak });
    }
    return true;
  }
}
registerProcessor('pulsar', PulsarProcessor);
