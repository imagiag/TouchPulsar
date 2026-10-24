# Porting plan

> **Status:** the Daisy port is in `daisy/` (C++ engine + controls + hardware glue). Its audio matches the JS engine (`make -C daisy/test`); it builds to `daisy/build/PulsarTouch.bin` (115 KB, 87.6% of flash) and runs on the Simple Touch (tested on hardware).

The browser prototype is split the same way the firmware will be:

| Layer | Browser | Daisy Seed (Simple Touch) | iPad |
|---|---|---|---|
| DSP engine | `engine/pulsar-core.js` in an AudioWorklet | `pulsar/core.h/.cpp`, called from the audio callback | the same C++ core inside an AUv3 / standalone app |
| Control mapping | `engine/pulsar-controls.js` on the UI thread | the same logic in the main loop (as `StringUI` in TouchString) | the same C++ class, driven by SwiftUI |
| Surface | DOM board replica | MPR121 pads, ADC knobs, Switch3, LED | touch board (pressure from Pencil / touch position) |
| Offline work | kernel FFT on the main thread | kernel built in the main loop, double-buffered | background queue |

`pulsar-core.js` already follows C-style rules: it allocates nothing in `process()`, stores voices as fixed arrays (struct-of-arrays), uses a xorshift32 RNG, and does control-rate maths once per block. Porting it is close to a line-by-line translation.

## 1. Daisy Seed

### Engine → C++
- `PulsarCore` → `class PulsarCore` with `Process(const float* in, float* outL, float* outR, size_t n)`. Block size 48 at 48 kHz, as in TouchString.
- `PulsarParams` → POD struct. Write it from the main loop into a second copy and swap a pointer (or copy it under `__disable_irq`) so the audio callback never reads a half-written struct.
- Tables: shapes 7×2049 floats (57 KB) and windows 7×1025 (29 KB) → internal SRAM (`DSY_SRAM` or plain globals), not SDRAM, because they are read every sample.
- Kernel (up to 3 s = 576 KB) and record buffer (2 s = 384 KB) → `DSY_SDRAM_BSS`. Use two kernel buffers and swap the pointer once the new kernel is ready.
- Per-sample transcendental functions — replace them:
  - `Math.tanh` (output drive) → rational approximation, e.g. `x*(27+x²)/(27+9x²)`, clamped.
  - `Math.sin` (wavefolder) → 1024-point sine table or `daisysp::fastsin`-style polynomial.
  - `Math.exp/log/pow` happen only once per block — keep `expf`/`logf`.
- Voice counts: `NFORM=3 × NVOICE=8` pulsaret voices + 12 kernel voices. Node renders typical patches at about 0.3% of real time and the stress patch (2 kHz, 3 formants, overlap) at about 1.8%. On a 480 MHz M7, expect very roughly 10–20× that: about 5% typical and up to about 35% worst case. **Measure with `daisy::CpuLoadMeter` before trusting these numbers.** If needed, cap NVOICE at 4 in overlap mode and skip formants whose amplitude is 0 (already done).
- Aliasing: the tables are naive (a saw table at f<sub>d</sub> = 6 kHz aliases). Fix on Daisy with 2–3 band-limited mip levels per shape, picked per voice by `vInc`. Low priority: aliasing is part of the classic pulsar sound, and the browser has the same behaviour.

### Convolution kernel on Daisy
The browser uses a large FFT. On the Seed, use **direct time-domain convolution, done in chunks** in the main loop. The pulsaret is short (cluster/f<sub>d</sub>: 2 cycles at 600 Hz = 160 samples). Cap it at 2048 samples (or decimate it) and compute about 4k output samples per main-loop pass. A 2 s sample × a 160-tap pulsaret is about 15 M MACs, roughly 50 ms of main-loop time spread over a few passes. Start computing when the pulsaret stops changing (the same ~120 ms debounce), and swap buffers when done. For longer pulsarets, use `arm_rfft_fast_f32` (max 4096 points) with overlap-add.

### Surface (reuse the TouchString / simple-touch-instruments drivers)
- `touch/pads.*` already provides `Pressure(pad)` (squared curve, smoothed), `Velocity`, and touch/release callbacks → wire them to `PulsarControls::padDown/padMove/padUp`. Expect note-on latency of about 16–20 ms (strike-window design), which is fine here.
- `touch/knobs.*` → `PulsarControls::turn(i, v)`. **Add soft takeover for the TO layer**: in the browser the on-screen knob jumps to show the alt value, but a physical pot can't. When P10 is pressed, latch each knob's position, and only start writing the alt value after the knob moves by more than 0.02. After P10 is released, the main value is updated again only once the knob passes back through its latched value.
- `touch/switches.*` → `setSwitch(SW_RANGE, B())`, `setSwitch(SW_MASK, A())` (S09/10 = left switch B, S07/08 = right switch A, as in TouchBass).
- **LED**: flash on every emitted (unmasked) pulsar when f<sub>p</sub> < 20 Hz. This makes the pulsar train visible on the hardware. Glow steadily at audio rates. Event confirmations (scale, octave, hold) use blink counts, following TouchString's conventions.
- **Recording**: P01 hold records `in[0]` (the board's line input) into the SDRAM buffer. Same flow as the browser's `startRecord/stopRecord`.

### MIDI
All MIDI handling lives in the control layer: `PulsarControls::midi(status, d1, d2, timeSec)`. Each platform only has to deliver raw bytes. The behaviour and CC map are in the README and are covered by `web/test/controls.js`.
- **Daisy**: USB MIDI device, as in TouchString: `MidiUsbHandler`, poll it in the main loop, then call `midi()` for each message. For clock, timestamp messages with `System::GetUs()`. Tempo is averaged over one beat, and the beat counter `sync` is passed to the engine, which phase-aligns pulses whenever they divide the beat evenly (tested: within 1.5 ms of the beat). Pulse timing on the Daisy depends on the main loop delivering clock messages promptly: keep that loop short (about 4 ms now), or handle clock bytes in the UART/USB callback.
- **Plugging a keyboard straight in** needs either USB host mode (the Seed's USB-C port is a device port) or a TRS/5-pin MIDI input wired to a Seed UART RX pin. Check which pins the Simple Touch board leaves free before adding a jack.
- **Pads stay keyboard-free**: the scales and root key work without any MIDI gear, and MIDI notes ignore the scale.

### Suggested file layout (Daisy project)
```
PulsarTouch/
  PulsarTouch.cpp        main(): hw init, audio callback, main loop
  pulsar/core.h/.cpp     ← engine/pulsar-core.js
  pulsar/controls.h/.cpp ← engine/pulsar-controls.js (+ soft takeover)
  pulsar/kernel.h/.cpp   chunked convolution builder
  touch/                 copied from TouchString
  Makefile, lib/ (libDaisy, DaisySP submodules)
```

## 2. iPad

**Stage 1 — now, no code changes.** Serve `web/` over https (any static host), open it in Safari and use *Add to Home Screen*. AudioWorklet runs on iPadOS 14.5+, and Pencil force already drives pad pressure. The layout keeps the board and display side by side on iPad screens. Worth adding: a web manifest and icon, and a `touchstart` unlock, because some iPadOS versions need audio started on the first touch (already handled by `ensureAudio()` on pad down). **Limitation: Safari has no Web MIDI**, so this stage plays from the pads only; MIDI on iPad arrives in Stage 2.

**Stage 2 — native.** Once the C++ core exists for Daisy, reuse it:
- **AUv3** (so it runs inside AUM, Loopy Pro, Drambo, Logic for iPad) with a SwiftUI version of the board. The C++ core goes behind a small Objective-C++ bridge, or you can use JUCE if a desktop VST/AU is also wanted.
- MIDI: CoreMIDI (USB and Bluetooth keyboards) in the standalone app; in AUv3 the host routes MIDI to the plugin. Both feed the same `midi()` entry point, and MPE pressure maps to aftertouch.
- Multi-touch with `UITouch.force` (fingers without force fall back to touch position, as in the browser).
- Extras the screen allows that the hardware doesn't: the paper's **envelope editors** (draw f<sub>p</sub>/f<sub>d</sub>/amplitude curves over a train's duration, as in the PulsarGenerator UI, Fig. 11), a bank of saved settings with crossfades between them, and sample browsing.

**Single source of truth.** After the C++ port, compile the core to WebAssembly (Emscripten) and load it in the worklet instead of `pulsar-core.js`. Browser, iPad and Daisy then run identical DSP. Keep `web/test/render.js` as a golden-output test: render the same scenarios from JS and C++ and compare the results (the xorshift RNG makes stochastic masking deterministic).

## 3. Open questions / next steps

### Feedback from playing the hardware
- ~~**Right fader (S37) in TONE**: glide is rarely useful musically.~~ **Done (v2):** S37 in TONE is now **Thick**: a detuned second train (3–25 cents) spread L/R, plus a sub-octave sine above 60%. Glide in TONE is now a fixed 60 ms, on MIDI legato only.
- **Done (v3): Filter**: P11 + right fader = low-pass cutoff, P11 + left fader = resonance (TPT state-variable filter, 12 dB/oct, before Drive; CC 102/103).
- **Chorus / ensemble** (option on top of Thick): 2–3 modulated short delays in stereo (~30 ms buffer), for an even lusher sound that also works on the convolved sound. Not built yet. (Noted 2026-10-24.)
- **Silent recording feedback**: recording with nothing on the input still blinks 3× (the old sample stays). Give silence its own blink pattern (e.g. 1 long blink) so it's clear nothing was captured. (Noted 2026-10-24.)
- **Live input processing**: the input jack is only used for P01 recording; nothing is heard live. Idea: let the pulsar train gate the incoming audio in real time ("pulsar-masked input": each pulsaret window opens the input, masking applies), mixed by a control. Cheap on Daisy. (Noted 2026-10-24.)

### Ideas
- Polyphony: the paper's pulsar generator is monophonic. A paraphonic mode (each pad gets its own f<sub>p</sub>, sharing formant settings) is possible but multiplies voices by 7.
- Per-formant spatial *paths* (§3.1) instead of static pans: one slow LFO per formant, controlled by the Width knob.
- More shapes or windows: the bipolar ring-modulator envelope (Fig. 3h) and user tables drawn on the iPad.
- Pulsar graph sequencer: record a pad and fader gesture as an f<sub>p</sub> envelope and loop it (Fig. 5 as a playable object).
