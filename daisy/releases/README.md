# TouchPulsar releases

Firmware files keep the internal name `PulsarTouch-…bin`.

Flash these with https://flash.daisy.audio/ (BOOT + RESET, or hold BOOT while plugging in).
`../build/PulsarTouch.bin` is only a working build and may be newer than any release: flash from here.

| File | Date | Changes |
|---|---|---|
| `PulsarTouch-v12-clock-delay.bin` | 2026-10-30 | Fix: with external MIDI clock the delay time no longer wobbles (the occasional "squeeze" on the repeats). The delay follows the clock tempo only when it changes by more than 1%. |
| `PulsarTouch-v11-layer-swap.bin` | 2026-10-28 | Layer swap: **Attack + Release** now both on P11 (S33/S34) and **Conv mix** on P11 + S35; **Lift** moved to P10 + S34 and **Input gain** to P10 + S35 (input LED meter now while P10 is held). CC numbers unchanged. |
| `PulsarTouch-v10-delay.bin` | 2026-10-25 | **Delay**: ping-pong, P11 + S31 = time (synced to tempo, 1/16 … 1/2), P11 + S32 = amount (CC 108/109). Silent P01 recordings now give 1 long blink and keep the old sample. |
| `PulsarTouch-v9-attack.bin` | 2026-10-24 | **Attack** on P11 + S33: 4 ms (default) to 3 s (CC 107). |
| `PulsarTouch-v8-lift-window.bin` | 2026-10-24 | Pressure uses a look-back window, so finger lifts are no longer heard as a dip (also while still touching). Window on P11 + S34 for tuning: noon = 0.15 s (CC 106). |
| `PulsarTouch-v7-pressure-hold.bin` | 2026-10-24 | Released pads keep the pressure they had (release tail and Hold), instead of dropping to a default; the finger lift is ignored. |
| `PulsarTouch-v6-chorus.bin` | 2026-10-24 | **Chorus / Ensemble** on P10 + right fader (CC 84). Tempo is set only by tapping P10 (LED flashes per tap), P10 + P00/P02, or MIDI clock. |
| `PulsarTouch-v5-motion.bin` | 2026-10-24 | **Formant motion**: P11 + S30 sets the formants drifting around the stereo field (CC 105). Width unchanged. |
| `PulsarTouch-v4-live-input.bin` | 2026-10-24 | **Live input**: Shape fully right = the input jack becomes the pulsaret waveform (rhythmic gate in RHYTHM, ring-mod-like tones in TONE/FREE). P11 + S35 = input gain (CC 104); LED shows input level while P11 is held. |
| `PulsarTouch-v3-filter.bin` | 2026-10-24 | **Filter**: P11 + right fader = low-pass cutoff, P11 + left fader = resonance (CC 102/103). Fully open at power-up. |
| `PulsarTouch-v2-thick.bin` | 2026-10-24 | Right fader in TONE = **Thick** (detuned second pulse train + stereo width, sub-octave above 60%). TONE glide only on MIDI legato (60 ms). |
| `PulsarTouch-v1.bin` | 2026-10-24 | First hardware version: pulsar engine, 7 scales + root key, USB MIDI with clock sync, convolution with input recording. Right fader in TONE = glide. |
