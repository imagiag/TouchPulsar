// =============================================================================
// pulsar::Core — pulsar synthesis engine (C++ port of web/engine/pulsar-core.js)
// After Curtis Roads, "Sound Composition with Pulsars" (JAES 49/3, 2001).
//
// No platform dependencies: builds for Daisy (arm-none-eabi), iOS and the host
// test in test/. Nothing allocates after Init().
// =============================================================================
#pragma once
#include <stdint.h>
#include <stddef.h>

namespace pulsar {

constexpr int kTable = 2048;   // pulsaret waveform table (power of two)
constexpr int kWin = 1024;     // pulsaret envelope table
constexpr int kNShape = 7;     // waveform tables
constexpr int kShapeInput = 7; // shape position 7 = live input as the pulsaret waveform
constexpr int kNWin = 7;
constexpr int kNForm = 3;      // formants sharing one fundamental
constexpr int kNVoice = 8;     // overlapping pulsarets per formant per train
constexpr int kNTrain = 2;     // train 0 = main, train 1 = detuned 'thick' copy
constexpr int kNConv = 12;     // overlapping convolution-kernel voices
constexpr int kRing = 256;
constexpr int kChorusBuf = 2048; // chorus delay line (power of two, > 25 ms at 48 kHz)     // pulse event ring for the UI (LED)

enum Route : uint8_t { R_MUTE = 0, R_BOTH = 1, R_LEFT = 2, R_RIGHT = 3 };
enum MaskMode : int { M_OFF = 0, M_BURST = 1, M_CHANNEL = 2, M_STOCH = 3 };

struct Params {
    float fundHz = 110.f;        // pulsar emission rate f_p
    float glideSec = 0.f;
    float formantHz[kNForm] = {440.f, 0.f, 0.f};
    float formantAmp[kNForm] = {1.f, 0.f, 0.f};
    float formantPan[kNForm] = {0.f, 0.f, 0.f};
    float cluster = 1.f;         // cycles of w per pulsaret (1..7)
    float shape = 0.f;           // 0..6 waveform morph
    float window = 0.f;          // 0..6 envelope morph
    float fold = 0.f;            // 0..1
    float edge = 0.3f;           // 0..0.5 PulWM crossfade, >0.5 OPulWM overlap
    int maskMode = M_OFF;
    int burst = 1;
    int rest = 0;
    float prob = 1.f;
    float gate = 0.f;            // amplitude target
    float attackSec = 0.004f;
    float releaseSec = 0.25f;
    float convMix = 0.f;
    float level = 0.7f;
    float drive = 0.f;
    int32_t sync = -1;           // beat counter from MIDI clock; -1 = free running
    float thick = 0.f;           // 0..1: detuned second train + stereo spread, sub above 0.6
    float inputGain = 1.f;       // live input level (shape 7)
    float chorus = 0.f;          // 0..1 chorus (lower half) -> ensemble (upper half)
    float motion = 0.f;          // 0..1 formant motion: each formant drifts in stereo (§3.1 spatial paths)
    float cutoffHz = 18000.f;    // low-pass filter cutoff (fully open by default)
    float resonance = 0.f;       // 0..1
};

class Core {
public:
    void Init(float sampleRate);

    // Audio thread: call once per block.
    void Process(float* outL, float* outR, const float* in, size_t n);

    // Main thread → audio thread handoff (single core: the audio ISR never
    // sees a half-written buffer because it reads the other one).
    void PostParams(const Params& p);

    // Kernel buffer is owned by the caller; the swap happens at the next block.
    // Don't write into a buffer that is active or pending.
    void PostKernel(const float* data, size_t len);
    bool KernelPending() const { return kernelPending_; }
    const float* ActiveKernel() const { return kernel_; }

    // Recording from the input (P01 hold). Buffer owned by the caller.
    void StartRecord(float* buf, size_t capacity);
    size_t StopRecord();
    bool Recording() const { return recBuf_ != nullptr; }

    // UI: pulse events (route + count) for the LED.
    uint32_t PulseCount() const { return pulseCount_; }
    uint32_t RingWrite() const { return ringW_; }
    float InputPeak() const { return inPeak_; }     // input level after gain (LED meter)
    uint8_t RingRoute(uint32_t i) const { return ring_[i % kRing]; }

    // Offline helper (main loop, not the audio thread): one pulsaret at
    // formant fd with the given params. Returns sample count (<= maxLen).
    size_t RenderPulsaret(const Params& p, float fd, float* out, size_t maxLen) const;

    float SampleRate() const { return sr_; }
    const Params& CurrentParams() const { return p_; }

private:
    float rand01();
    void buildShapes();
    void buildWindows();
    int route(uint32_t n);
    void emit(float late, int train);
    float shapeLookupSin(float x) const; // sin(x * pi/2) via the sine table

    float sr_ = 48000.f;
    uint32_t rng_ = 0x9E3779B9u;
    float shapes_[kNShape * (kTable + 1)];
    float wins_[kNWin * (kWin + 1)];

    static constexpr int kNV = kNTrain * kNForm * kNVoice;
    uint8_t vOn_[kNV];
    float vPh_[kNV], vInc_[kNV], vLen_[kNV], vGL_[kNV], vGR_[kNV], vFade_[kNV], vFadeInc_[kNV];

    const float* kernel_ = nullptr;
    size_t kernelLen_ = 0;
    const float* volatile pendingKernel_ = nullptr;
    volatile size_t pendingLen_ = 0;
    volatile bool kernelPending_ = false;
    uint8_t cOn_[kNConv];
    float cPos_[kNConv], cGL_[kNConv], cGR_[kNConv];

    uint8_t ring_[kRing];
    volatile uint32_t ringW_ = 0;

    Params p_;
    Params mailbox_[2];
    volatile int mailRead_ = 0;
    volatile uint32_t mailSeq_ = 0;
    uint32_t mailSeen_ = 0;

    float fundLog_ = 4.70048f; // log(110)
    double fundPhase_ = 0.0;   // double: float drifts audibly at slow (rhythm) rates; M7 has a DP FPU
    volatile uint32_t pulseCount_ = 0;
    double phaseB_ = 0.0, subPhase_ = 0.0;
    uint32_t pulseCountB_ = 0;
    float trainGain_[kNTrain] = {1.f, 0.f}, trainPan_[kNTrain] = {0.f, 0.f};
    float motPh_[kNForm] = {0.f, 0.33f, 0.67f}, motOff_[kNForm] = {0.f, 0.f, 0.f}; // formant motion LFOs
    float chBufL_[kChorusBuf], chBufR_[kChorusBuf]; // chorus delay lines
    int chW_ = 0;
    double chPh_ = 0.0;
    float lfo(double ph) const;
    static float chTap(const float* buf, int w, float d);
    int32_t lastSync_ = -1;
    float env_ = 0.f;
    float dcxL_ = 0.f, dcyL_ = 0.f, dcxR_ = 0.f, dcyR_ = 0.f;
    volatile float inPeak_ = 0.f;
    float fcLog_ = 9.79813f;     // log(18000): smoothed filter cutoff
    float f1L_ = 0.f, f2L_ = 0.f, f1R_ = 0.f, f2R_ = 0.f; // SVF state

    float* volatile recBuf_ = nullptr;
    size_t recCap_ = 0;
    volatile size_t recPos_ = 0;
};

// Kernel = pulsaret (*) sample, built in chunks from the main loop by direct
// convolution (pulsarets are short). Peak-normalised, tail faded.
class KernelBuilder {
public:
    static constexpr size_t kMaxPulsaret = 2048;

    // out must hold pLen + sLen - 1 samples (<= outCap).
    void Start(const float* pulsaret, size_t pLen, const float* sample, size_t sLen, float* out, size_t outCap);
    // Do up to `macBudget` multiply-adds. Returns true when the kernel is finished.
    bool Step(uint32_t macBudget);
    bool Busy() const { return state_ != IDLE && state_ != DONE; }
    bool Done() const { return state_ == DONE; }
    size_t Length() const { return outLen_; }
    float* Output() const { return out_; }
    void Reset() { state_ = IDLE; }

private:
    enum State { IDLE, CONVOLVE, NORMALISE, DONE };
    State state_ = IDLE;
    float pulsaret_[kMaxPulsaret];
    size_t pLen_ = 0;
    const float* sample_ = nullptr;
    size_t sLen_ = 0;
    float* out_ = nullptr;
    size_t outLen_ = 0, pos_ = 0;
    float peak_ = 0.f;
};

} // namespace pulsar
