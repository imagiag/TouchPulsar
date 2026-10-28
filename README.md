# TouchPulsar

### 🌐 Website: **[pulsar.imagiag.com](https://pulsar.imagiag.com)**

**[Download firmware](https://github.com/imagiag/TouchPulsar/releases/latest)** · **[Manual](daisy/README.md)** · **[Website](https://pulsar.imagiag.com)**

A pulsar synthesizer for the **Synthux Simple Touch** (Daisy Seed), prototyped in the browser first.

Based on Curtis Roads, *Sound Composition with Pulsars*, Journal of the Audio Engineering Society, vol. 49, no. 3, March 2001.

## Get it

- **Website:** [pulsar.imagiag.com](https://pulsar.imagiag.com): overview, features and the manual.
- **Firmware for the Touch 2:** download the newest `.bin` from [Releases](https://github.com/imagiag/TouchPulsar/releases) (or `daisy/releases/`) and flash it at [flash.daisy.audio](https://flash.daisy.audio/). Full manual: [`daisy/manual.html`](daisy/manual.html) (open locally) or [`daisy/README.md`](daisy/README.md).
- **Build from source:** `git clone --recurse-submodules https://github.com/imagiag/TouchPulsar.git`, then see [`daisy/README.md`](daisy/README.md#project-setup).
- **Licence:** MIT ([LICENSE](LICENSE)); credits and third-party parts in [CREDITS.md](CREDITS.md).

## Run the browser prototype

```bash
python3 web/serve.py        # local server that never caches, so changes always load
```

Open <http://localhost:8765>, press **Start audio** (or touch any pad), pick a preset. The page has to be served over http (not opened as a file) because the AudioWorklet is loaded with `fetch`.

Offline engine test (renders WAVs, checks for NaN/clipping, measures CPU):

```bash
node web/test/render.js
node web/test/controls.js   # scales, root key, MIDI, clock sync (45 checks)
```

## What the paper describes

A **pulsar** is a short burst of a waveform followed by silence:

```
|<------------- p = 1/fp ------------->|
|<-- d = 1/fd -->|<------- s -------->|
  pulsaret w·v        silence
```

- **f<sub>p</sub>** (fundamental) is how often pulsars are emitted. It runs from 0.25 Hz to 2 kHz. Below about 20 Hz you hear a **rhythm**; above about 40 Hz the pulses fuse into a **tone**. Moving one control across that boundary is the core idea of the technique.
- **f<sub>d</sub>** (formant) is set by the pulsaret's duration. Its energy shows up as a formant peak, so sweeping it sounds like a resonant filter, but no filter is involved.
- **w** is the pulsaret waveform (any shape). **v** is the pulsaret envelope (rectangular, gaussian, exponential decay, FOF…); the envelope shapes the spectrum strongly (Fig. 6).
- **PulWM**: when d > p, the next period cuts the pulsaret off, with a crossfade called the "edge factor". **OPulWM** instead lets pulsarets overlap.
- **Advanced synthesis**: several formants share one f<sub>p</sub>, each with its own position in space. **Masking** removes pulsars from the train: *burst* masking (b:r ratio; at audio rates this produces subharmonics, Fig. 9), *channel* masking (alternates pulsars between outputs) and *stochastic* masking (a probability that each pulsar is emitted; 0.8–0.9 gives an "analog" intermittency).
- **Convolution** with sampled sounds: each pulsar is replaced by a filtered copy of a sample, which maps the sample onto the pulsar rhythm (Fig. 10).

## The instrument

The engine has one pulsar generator with three formants, all sharing one f<sub>p</sub>. The panel copies the real board layout. Every playing control on screen maps to a physical control on the Touch. The display and the sample loader are browser-only extras; on hardware, the Seed LED stands in for the display.

| Control | Main | Hold **P10 (TO)** |
|---|---|---|
| S30 | **Spread**: fades in formants 2 and 3 above f<sub>d</sub> · hold **P11**: **motion** (formants drift in stereo) | **Width**: stereo spread of the formants |
| S31 | **Formant** f<sub>d</sub>: × f<sub>p</sub> when coupled, Hz when free · hold **P11**: **delay time** (synced) | **Push**: how far pad pressure raises the formant |
| S32 | **Cluster**: 1–7 cycles of w per pulsaret · hold **P11**: **delay amount** | **Edge**: cut crossfade (PulWM) → overlap (OPulWM) |
| S33 | **Shape**: sine · tri · saw · square · pulse · vela · noise · **live input** (fully right: the input jack becomes the pulsaret waveform) | **Fold**: wavefolder |
| S34 | **Window**: gauss · FOF · expodec · lindec · rect · linatt · expatt · hold **P11**: **release** | **Lift** (pressure look-back) |
| S35 | **Mask**: burst ratio b:r, or probability · hold **P11**: **conv mix** | **Input gain** (live input) |
| S36 fader | **Level** · hold **P11**: filter **resonance** | **Drive** |
| S37 fader | hold **P11**: filter **cutoff** · TONE: **thick** (detuned second train + stereo width, sub-octave above 60%) · FREE: **fundamental** 0.25 Hz–2 kHz · RHYTHM: **glide** | **Chorus → ensemble** |
| S09/10 switch | **TONE**: pads are scale notes · **FREE**: the fader sets f<sub>p</sub> and the pads play the formant · **RHYTHM**: pads are note values (1/4 … 1/32) at the current tempo, taken from the paper's pulsar graph (Fig. 5); glide here gives accelerando and ritardando | |
| S07/08 switch | **BURST** · **CHANNEL** (bursts left, rests right) · **STOCH** | |
| P03–P09 | notes / note values; pressure sets amplitude and pushes the formant | |
| P00 / P02 | octave − / + (Chromatic: ±7 semitones, so no notes are skipped) | tempo − / + |
| P01 | tap: convolution on/off · hold: record 2 s of input as the sample | |
| P10 | tap tempo (LED flashes per tap); hold for the second knob layer | |
| P11 | hold + P03–P09: pick scale · + P00/P02: cycle scale · + P01: formant coupled/free | |
| P10 + P03–P09 | | set the **root key** to that pad's current note (the scale type is kept) |
| P10 + P11 | quick tap: hold (latch) · hold 1.5 s: recalibrate pads (hardware) | |

### Scales and root key

The scales use TouchString's key combos: hold **P11** and tap **P03–P09** to pick a scale directly, or tap **P00 / P02** to step through them. The LED blinks 1–7 times to confirm.

| Pad | Scale | Notes (root C) |
|---|---|---|
| P03 | Chromatic | C C# D Eb E F F# |
| P04 | Major | C D E F G A B |
| P05 | Natural minor | C D Eb F G Ab Bb |
| P06 | Minor pentatonic | C Eb F G Bb + C Eb |
| P07 | Major pentatonic | C D E G A + C D |
| P08 | Dorian | C D Eb F G A Bb |
| P09 | Harmonic minor | C D Eb F G Ab B |

- **Chromatic** spans only 7 semitones, so in Chromatic P00/P02 shift the pads by 7 semitones (±5 steps) instead of a full octave.
- **Pentatonic** scales continue into the next octave on pads 6–7.
- **Root key**: hold **P10** and tap a note pad; its current note becomes the root. To reach any of the 12 keys, switch to Chromatic, shift to the note you want, then set it.
- The scale and root apply to TONE notes and to FREE formant notes. RHYTHM pads keep their note values.

### MIDI

MIDI notes play **fully chromatic**; the scale only affects the pads. Pads and MIDI share one note stack (mono, last-note priority), so you can mix them.

| MIDI | Effect |
|---|---|
| Note | TONE: pitch · FREE: formant pitch (C3 = no transpose) · RHYTHM: white keys C D E F G A B = 1/4 1/8 1/8T 1/16 1/16Q 1/16T 1/32 at C3, each octave up doubles the rate (black keys use the white key below) |
| Velocity | level |
| Aftertouch (channel, poly, MPE pressure) | same as pad pressure: level and formant push |
| Pitch bend | ±2 semitones (CC88 sets 0–24) |
| Mod wheel (CC1) | raises the formant up to 3 octaves |
| Sustain (CC64) | holds released notes |
| Glide | applies only to legato notes (a new note while another is held) |
| Clock | sets the RHYTHM tempo, which falls back to the internal tempo 0.5 s after the clock stops. When the pulses divide the beat evenly, they lock to it |
| Start | resets the beat count |

| CC | Main layer | CC | TO layer |
|---|---|---|---|
| 77 | spread (S30) | 78 | width |
| 74 | formant (S31) | 79 | push |
| 71 | cluster (S32) | 80 | edge |
| 75 | shape (S33) | 81 | fold |
| 76 | window (S34) | 72 | release |
| 85 | mask (S35) | 82 | conv mix |
| 7 | level (S36) | 83 | drive |
| 5 | thick / fund / glide (S37) | 84 | chorus / ensemble |

Other CCs: 86 range switch (0–42 TONE, 43–85 FREE, 86–127 RHYTHM) · 87 mask switch · 88 bend range · 89 root from MIDI (≥64 = on: the root follows the lowest held note; off by default) · 102 filter cutoff · 103 filter resonance · 104 input gain · 105 formant motion · 108 delay time · 109 delay amount · 120/123 all notes off.

In the browser, MIDI uses Web MIDI (Chrome or Edge on a computer; press **Enable MIDI**). Safari, including on iPad, has no Web MIDI, so on iPad MIDI arrives with the native/AUv3 version. See PORTING.md.

### Browser extras

In the browser: on-screen pressure comes from where you touch a pad (top edge = hardest), or from Apple Pencil force. Keyboard: `A`–`J` play P03–P09, `Z X C` are P00–P02, `Shift`/`Q` is P10, `W` is P11, `Space` toggles hold, `1 2 3` set the range switch, `8 9 0` set the mask switch.

Presets reproduce examples from the paper: Ondioline, the Fig. 9 2:1 subharmonics, CP 1919 (the first pulsar discovered, 1.337 s period), analog intermittency, a thick unison + sub patch and others.

### How convolution works here

Convolution is linear, so *train ∗ sample* = Σ<sub>pulses</sub> (*pulsaret ∗ sample*). Off the audio thread the engine computes **kernel = pulsaret ∗ sample** (by FFT, recomputed ~120 ms after the pulsaret stops changing). The audio thread then only has to start a copy of the kernel on each surviving pulse. For a fixed pulsaret this is exact convolution, and it costs far less than running real-time convolution.

## Files

```
pulsar/
  README.md                 this file
  PORTING.md                plan for Daisy Seed (Simple Touch) and iPad
  daisy/                    Simple Touch firmware (C++ port) — see daisy/README.md
  web/
    index.html, style.css   board replica + display
    app.js                  browser host: UI, audio graph, samples, drawing
    engine/
      pulsar-core.js        DSP engine (portable — reference for the C++ port)
      pulsar-controls.js    Touch surface → engine params (portable "firmware UI")
      pulsar-worklet.js     AudioWorklet wrapper (equivalent of the Daisy audio callback)
    test/render.js          offline render + CPU check in Node
    test/controls.js        control-layer tests: scales, root, MIDI, clock sync
```

## References

- Roads, C. (2001) *Sound Composition with Pulsars*. JAES 49(3). Also *Microsound* (MIT Press, 2001), ch. 4.
- Synthux Academy: [simple-touch-instruments](https://github.com/Synthux-Academy/simple-touch-instruments), [TouchBass](https://github.com/Synthux-Academy/TouchBass); `../TouchString` for the pad, knob and switch drivers.
