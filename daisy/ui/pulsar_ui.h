// =============================================================================
// PulsarUI — Simple Touch hardware glue for pulsar::Controls / pulsar::Core.
// Pads, knobs (with soft takeover for the TO layer), switches, USB MIDI, LED,
// input recording and background convolution-kernel building.
// Runs in the main loop; the audio callback only calls Core::Process.
// =============================================================================
#pragma once
#include <math.h>
#include "daisy_seed.h"
#include "../touch/touch.h"
#include "../pulsar/core.h"
#include "../pulsar/controls.h"

namespace synthux {

// Soft takeover (same behaviour as TouchString's MValue): a knob only starts
// writing its parameter after it moves more than kThreshold from where it was
// when it became active, so switching layers or a MIDI CC never jumps a value.
class Takeover {
public:
    float Process(float v, bool active) {
        if (active && !active_) init_ = v;
        else if (!active && active_) tracking_ = false;
        active_ = active;
        if (!active) return value_;
        if (!tracking_ && fabsf(v - init_) < kThreshold) return value_;
        tracking_ = true;
        value_ = v;
        return value_;
    }
    void Set(float v) { value_ = v; tracking_ = false; active_ = false; }   // external change (MIDI CC, tap tempo)
    void SetTracking(float v) { value_ = init_ = v; tracking_ = true; active_ = true; }
    float Value() const { return value_; }
private:
    static constexpr float kThreshold = 0.02f;
    float value_ = 0.f, init_ = 0.f;
    bool active_ = false, tracking_ = false;
};

class PulsarUI {
public:
    PulsarUI(Touch& touch, pulsar::Core& core) : touch_(touch), core_(core) {}

    // Buffers live in SDRAM (owned by main): two sample slots, two kernel slots.
    void Init(daisy::DaisySeed& hw, float* sampleA, float* sampleB, size_t sampleCap,
              float* kernelA, float* kernelB, size_t kernelCap);
    void Process(daisy::DaisySeed& hw); // UI tick, every ~4 ms
    void PollMidi();                    // every main-loop pass (keeps clock jitter low)
    void Background();                  // bounded kernel-building work, every pass

private:
    double now();
    void readKnobs();
    void handleEvents();
    void updateLed(daisy::DaisySeed& hw);
    void scheduleKernel();
    void makeDefaultSample();
    void blink(uint8_t count, uint32_t onMs, uint32_t offMs);

    Touch& touch_;
    pulsar::Core& core_;
    pulsar::Controls ctl_;
    pulsar::Params params_;
#if !DEBUG
    daisy::MidiUsbHandler midi_;   // USB is the debug log port when DEBUG=1 (as in TouchString)
#endif

    Takeover main_[pulsar::K_COUNT], alt_[pulsar::K_COUNT];
    float writtenKnob_[pulsar::K_COUNT], writtenAlt_[pulsar::K_COUNT];
    bool firstRun_ = true;

    // time (64-bit microsecond accumulator; System::GetUs wraps after ~71 min)
    uint32_t lastUs_ = 0;
    uint64_t usAcc_ = 0;

    // samples & kernels
    float* sample_[2] = {nullptr, nullptr};
    size_t sampleLen_[2] = {0, 0};
    size_t sampleCap_ = 0;
    int activeSample_ = 0;
    uint32_t sampleGen_ = 0;
    float* kernel_[2] = {nullptr, nullptr};
    size_t kernelCap_ = 0;
    pulsar::KernelBuilder builder_;
    float pulsaret_[pulsar::KernelBuilder::kMaxPulsaret];
    int32_t wantKey_[6] = {0};
    bool kernelDirty_ = false;
    double dirtyAt_ = 0;

    // LED
    uint32_t lastRing_ = 0;
    double pulseLedUntil_ = 0;
    uint8_t blinkLeft_ = 0;
    uint32_t blinkOn_ = 0, blinkOff_ = 0;
    double blinkPhaseEnd_ = 0;
    bool blinkLit_ = false;
};

} // namespace synthux
