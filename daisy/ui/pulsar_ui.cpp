#include "pulsar_ui.h"
#include <math.h>
#include <string.h>

using namespace synthux;
using namespace daisy;
using namespace pulsar;

static constexpr float kRecordSec = 2.f;
static constexpr uint32_t kMacBudget = 250000;   // ~0.5–1 ms of convolution per main-loop pass
static constexpr double kKernelDebounce = 0.12;  // rebuild once the pulsaret settles (same as browser)

// ---------------------------------------------------------------------------
void PulsarUI::Init(DaisySeed& hw, float* sampleA, float* sampleB, size_t sampleCap,
                    float* kernelA, float* kernelB, size_t kernelCap) {
    sample_[0] = sampleA; sample_[1] = sampleB; sampleCap_ = sampleCap;
    kernel_[0] = kernelA; kernel_[1] = kernelB; kernelCap_ = kernelCap;
    lastUs_ = System::GetUs();

    // Pads -> controls (callbacks fire inside touch_.Process()).
    touch_.pads().SetOnTouch([this](uint16_t pad) { ctl_.PadDown(pad, touch_.pads().Velocity(pad)); });
    touch_.pads().SetOnRelease([this](uint16_t pad) { ctl_.PadUp(pad); });

    makeDefaultSample();

#if !DEBUG
    MidiUsbHandler::Config midiCfg;
    midi_.Init(midiCfg);
    midi_.StartReceive();
#endif
}

// A short wooden knock so P01 (convolution) does something before anything is recorded.
void PulsarUI::makeDefaultSample() {
    const float sr = core_.SampleRate();
    const size_t n = (size_t)(sr * 0.25f) < sampleCap_ ? (size_t)(sr * 0.25f) : sampleCap_;
    float* d = sample_[0];
    float peak = 1e-9f;
    for (size_t i = 0; i < n; i++) {
        const float t = i / sr;
        d[i] = sinf(2.f * 3.14159265f * 420.f * t) * expf(-t * 40.f)
             + 0.6f * sinf(2.f * 3.14159265f * 1180.f * t) * expf(-t * 70.f)
             + 0.3f * sinf(2.f * 3.14159265f * 2650.f * t) * expf(-t * 120.f);
        peak = fmaxf(peak, fabsf(d[i]));
    }
    for (size_t i = 0; i < n; i++) d[i] /= peak;
    sampleLen_[0] = n; activeSample_ = 0; sampleGen_++;
}

double PulsarUI::now() {
    const uint32_t us = System::GetUs();
    usAcc_ += (uint32_t)(us - lastUs_);
    lastUs_ = us;
    return usAcc_ * 1e-6;
}

// ---------------------------------------------------------------------------
// USB MIDI -> raw bytes -> Controls::Midi (same entry point as browser and iPad)
void PulsarUI::PollMidi() {
#if !DEBUG
    midi_.Listen();
    const double t = now();
    while (midi_.HasEvents()) {
        MidiEvent m = midi_.PopEvent();
        const uint8_t ch = (uint8_t)(m.channel & 0x0F);
        switch (m.type) {
            case NoteOff: case NoteOn: case PolyphonicKeyPressure: case ControlChange:
            case ProgramChange: case ChannelPressure: case PitchBend:
                ctl_.Midi((uint8_t)(0x80 | (m.type << 4) | ch), m.data[0], m.data[1], t);
                break;
            case ChannelMode: // CC 120..127 (all notes off etc.)
                ctl_.Midi((uint8_t)(0xB0 | ch), m.data[0], m.data[1], t);
                break;
            case SystemRealTime:
                ctl_.Midi((uint8_t)(0xF8 + m.srt_type), 0, 0, t);
                break;
            default: break;
        }
    }
#endif
}

// ---------------------------------------------------------------------------
void PulsarUI::readKnobs() {
    Knobs& k = touch_.knobs();
    AnalogControl* phys[K_COUNT] = {&k.s30(), &k.s31(), &k.s32(), &k.s33(), &k.s34(), &k.s35(), &k.s36(), &k.s37()};
    const bool to = ctl_.ToHeld();
    for (int i = 0; i < K_COUNT; i++) {
        const float v = phys[i]->Process();
        if (firstRun_) {
            main_[i].SetTracking(v); ctl_.knob[i] = v;
            alt_[i].Set(ctl_.alt[i]);
            writtenKnob_[i] = ctl_.knob[i]; writtenAlt_[i] = ctl_.alt[i];
            continue;
        }
        // values changed elsewhere (MIDI CC, tap tempo): hold them until the knob moves
        if (ctl_.knob[i] != writtenKnob_[i]) main_[i].Set(ctl_.knob[i]);
        if (ctl_.alt[i] != writtenAlt_[i]) alt_[i].Set(ctl_.alt[i]);

        ctl_.knob[i] = main_[i].Process(v, !to);
        const float a = alt_[i].Process(v, to);
        if (to && a != ctl_.alt[i]) { ctl_.alt[i] = a; ctl_.modUsed[0] = true; }
        writtenKnob_[i] = ctl_.knob[i]; writtenAlt_[i] = ctl_.alt[i];
    }
    firstRun_ = false;
}

static int switchPos(int daisyPos) { // libDaisy: CENTER 0, UP 1, DOWN 2 -> ours: up 0, center 1, down 2
    return daisyPos == Switch3::POS_UP ? 0 : (daisyPos == Switch3::POS_DOWN ? 2 : 1);
}

void PulsarUI::Process(DaisySeed& hw) {
    const double t = now();
    ctl_.Tick(t);
    touch_.Process();                          // fires PadDown / PadUp callbacks
    for (int i = 0; i < 12; i++)
        if (ctl_.touched[i]) ctl_.PadMove(i, touch_.pads().Pressure(i));
    readKnobs();
    ctl_.SetSwitch(SW_RANGE, switchPos(touch_.switches().B())); // left  S09/S10
    ctl_.SetSwitch(SW_MASK, switchPos(touch_.switches().A()));  // right S07/S08
    handleEvents();
    ctl_.Compute(params_);
    core_.PostParams(params_);
    scheduleKernel();
    updateLed(hw);
}

void PulsarUI::blink(uint8_t count, uint32_t onMs, uint32_t offMs) {
    blinkLeft_ = count; blinkOn_ = onMs; blinkOff_ = offMs;
    blinkLit_ = count > 0;
    blinkPhaseEnd_ = now() + onMs * 1e-3;
}

void PulsarUI::handleEvents() {
    Event e;
    while (ctl_.PopEvent(e)) {
        switch (e.type) {
            case EV_REC_START: {
                if (builder_.Busy()) { builder_.Reset(); kernelDirty_ = true; } // don't read a slot being overwritten
                const int slot = 1 - activeSample_;
                core_.StartRecord(sample_[slot], (size_t)(core_.SampleRate() * kRecordSec) < sampleCap_
                                                  ? (size_t)(core_.SampleRate() * kRecordSec) : sampleCap_);
                break;
            }
            case EV_REC_STOP: {
                const size_t n = core_.StopRecord();
                const int slot = 1 - activeSample_;
                float peak = 0.f;
                for (size_t i = 0; i < n; i++) peak = fmaxf(peak, fabsf(sample_[slot][i]));
                if (n > 256 && peak > 1e-4f) { // ignore silence / accidental taps
                    for (size_t i = 0; i < n; i++) sample_[slot][i] /= peak;
                    sampleLen_[slot] = n; activeSample_ = slot; sampleGen_++;
                    ctl_.convOn = true;
                }
                blink(3, 60, 60);
                break;
            }
            case EV_RECAL: {
                touch_.pads().Recalibrate();
                // Recalibration clears pad state without release callbacks: release here.
                for (int i = 0; i < 12; i++) if (ctl_.touched[i]) ctl_.PadUp(i);
                blink(3, 40, 40);
                break;
            }
            case EV_SCALE: blink(e.blinks, 30, 30); break;     // 1..7 quick blinks = scale number
            case EV_OCT:   blink(e.blinks, 25, 25); break;
            case EV_TEMPO: if (e.blinks) blink(1, 20, 0); break;
            default:       if (e.blinks) blink(e.blinks, 60, 80); break;
        }
    }
}

// LED: event blinks > recording flash > one flash per emitted pulsar (rhythm
// rates) or steady glow (audio rates) while a note sounds.
void PulsarUI::updateLed(DaisySeed& hw) {
    const double t = now();
    const uint32_t w = core_.RingWrite();
    if (w - lastRing_ > (uint32_t)kRing) lastRing_ = w - kRing;
    for (; lastRing_ != w; lastRing_++)
        if (core_.RingRoute(lastRing_) != R_MUTE) pulseLedUntil_ = t + 0.03;

    bool led = false;
    if (blinkLeft_) {
        if (t >= blinkPhaseEnd_) {
            if (blinkLit_) { blinkLit_ = false; blinkPhaseEnd_ = t + blinkOff_ * 1e-3; blinkLeft_--; }
            else { blinkLit_ = true; blinkPhaseEnd_ = t + blinkOn_ * 1e-3; }
        }
        led = blinkLit_;
    } else if (core_.Recording()) {
        led = (usAcc_ / 50000u) % 2 == 0; // 10 Hz flash
    } else if (params_.gate > 0.f) {
        led = params_.fundHz > 25.f ? true : t < pulseLedUntil_;
    }
    hw.SetLed(led);
}

// ---------------------------------------------------------------------------
// Convolution kernel = pulsaret (*) sample, rebuilt when the pulsaret settles.
void PulsarUI::scheduleKernel() {
    if (!ctl_.convOn) return;
    const int32_t key[6] = {
        (int32_t)lroundf(params_.shape * 100), (int32_t)lroundf(params_.window * 100),
        (int32_t)lroundf(params_.cluster * 100), (int32_t)lroundf(params_.fold * 100),
        (int32_t)lroundf(fminf(fmaxf(params_.formantHz[0], 30.f), 8000.f)), (int32_t)sampleGen_,
    };
    const double t = now();
    if (memcmp(key, wantKey_, sizeof(key)) != 0) { memcpy(wantKey_, key, sizeof(key)); dirtyAt_ = t; kernelDirty_ = true; }
    if (kernelDirty_ && t - dirtyAt_ > kKernelDebounce && !builder_.Busy() && !core_.KernelPending()) {
        kernelDirty_ = false;
        const float fd = fminf(fmaxf(params_.formantHz[0], 30.f), 8000.f);
        const size_t pl = core_.RenderPulsaret(params_, fd, pulsaret_, KernelBuilder::kMaxPulsaret);
        float* target = core_.ActiveKernel() == kernel_[0] ? kernel_[1] : kernel_[0];
        builder_.Start(pulsaret_, pl, sample_[activeSample_], sampleLen_[activeSample_], target, kernelCap_);
    }
}

void PulsarUI::Background() {
    if (!builder_.Busy()) return;
    if (builder_.Step(kMacBudget)) {
        core_.PostKernel(builder_.Output(), builder_.Length());
        builder_.Reset();
    }
}
