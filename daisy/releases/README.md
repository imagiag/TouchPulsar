# PulsarTouch releases

Flash these with https://flash.daisy.audio/ (BOOT + RESET, or hold BOOT while plugging in).
`../build/PulsarTouch.bin` is only a working build and may be newer than any release: flash from here.

| File | Date | Changes |
|---|---|---|
| `PulsarTouch-v3-filter.bin` | 2026-10-24 | **Filter**: P11 + right fader = low-pass cutoff, P11 + left fader = resonance (CC 102/103). Fully open at power-up. |
| `PulsarTouch-v2-thick.bin` | 2026-10-24 | Right fader in TONE = **Thick** (detuned second pulse train + stereo width, sub-octave above 60%). TONE glide only on MIDI legato (60 ms). |
| `PulsarTouch-v1.bin` | 2026-10-24 | First hardware version: pulsar engine, 7 scales + root key, USB MIDI with clock sync, convolution with input recording. Right fader in TONE = glide. |
