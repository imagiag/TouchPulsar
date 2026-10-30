// =============================================================================
// pulsar::Controls — Simple Touch surface + MIDI → pulsar::Params.
// C++ port of web/engine/pulsar-controls.js (keep the two in step).
// No platform dependencies; the hardware glue (ui/pulsar_ui.*) feeds it.
// =============================================================================
#pragma once
#include <stdint.h>
#include <stddef.h>
#include "core.h"

namespace pulsar {

enum Knob { K_SPREAD, K_FORMANT, K_CLUSTER, K_SHAPE, K_WINDOW, K_MASK, K_LEVEL, K_FUND, K_COUNT };
enum Switch { SW_RANGE = 0, SW_MASK = 1 };            // positions: 0 up, 1 center, 2 down
enum Range { TONE = 0, FREE = 1, RHYTHM = 2 };
enum Pad { P_OCT_DN = 0, P_CONV = 1, P_OCT_UP = 2, P_TO = 10, P_CH = 11 };

enum EventType : uint8_t {
    EV_NONE, EV_LATCH, EV_SCALE, EV_COUPLED, EV_TEMPO, EV_ROOT, EV_OCT, EV_CONV,
    EV_REC_START, EV_REC_STOP, EV_RECAL,
};
struct Event { EventType type; uint8_t blinks; };

class Controls {
public:
    static constexpr int kNumScales = 7;
    static constexpr int kMidiKey = 128;   // note-stack keys: pads 3..9, MIDI 128 + note
    static constexpr int kStack = 16;

    Controls();

    // hardware / host input
    void SetSwitch(int i, int pos) { sw[i] = pos; }
    void PadDown(int i, float pressure);
    void PadMove(int i, float pressure);
    void PadUp(int i);
    void Midi(uint8_t status, uint8_t d1, uint8_t d2, double t);
    void Tick(double now);
    void Compute(Params& out) const;

    bool PopEvent(Event& e);

    // state (public, like the JS object; the UI glue reads/writes knob/alt)
    float knob[K_COUNT];
    float alt[K_COUNT];
    float ch[K_COUNT];      // CH layer: ch[K_SPREAD] motion, ch[K_FORMANT] delay time, ch[K_CLUSTER] delay amount, ch[K_SHAPE] attack, ch[K_WINDOW] release, ch[K_MASK] conv mix, ch[K_LEVEL] resonance, ch[K_FUND] cutoff
    int sw[2];
    uint8_t touched[12];
    float pressure[12];
    int oct = 0, scale = 1, root = 0;
    bool latch = false, coupled = true, convOn = false, recording = false;
    bool modUsed[2] = {false, false};
    float bendRange = 2.f;
    bool rootFromMidi = false;
    float extBpm = 0.f;
    float dlyBpm = 0.f;     // clock tempo for the delay: moves only on changes > 1%, so jitter doesn't bend the repeats

    float tempo = 90.f;     // BPM: tap P10, P10 + P00/P02, or MIDI clock
    float Bpm() const { return extBpm > 0.f ? extBpm : tempo; }
    float DelayBpm() const { return extBpm > 0.f && dlyBpm > 0.f ? dlyBpm : tempo; }
    bool ToHeld() const { return touched[P_TO]; }
    bool ChHeld() const { return touched[P_CH]; }
    bool Chromatic() const { return scale == 0; }
    int ActiveKey() const;
    double LiftSec() const;     // P10 + S34: pressure look-back window (noon = 0.15 s)
    float EffPress(int i) const; // max(now, pressure LiftSec() ago): finger lifts aren't heard
    int PadSemis(int pad) const;

private:
    void ev(EventType t, uint8_t blinks);
    void push(int key);
    void pull(int key);
    bool inStack(int key) const;
    int octLimit() const { return Chromatic() ? 5 : 3; }
    int shiftSemis() const { return oct * (Chromatic() ? 7 : 12); }
    void setScale(int s);
    void setRoot(int semis);
    void toggleLatch();
    void tap();
    void noteOn(int n, float vel);
    void noteOff(int n);
    void cc(int c, int v);
    void allNotesOff();
    void clock(double t);

    int stack_[kStack]; int stackN_ = 0;
    int lastKey_ = 3, latchedKey_ = -1;
    double now_ = 0, padDownAt_[12], comboAt_ = -1;
    // pressure look-back (see EffPress): history sampled every 10 ms, > 0.75 s
    static constexpr int kPressHist = 96;
    float pHistV_[12][kPressHist], heldPress_[12];
    double pHistT_[12][kPressHist], pHistLast_[12];
    int pHistW_[12];
    void pressRecord(int i, float v);
    float pressAgo(int i, double tau) const;
    bool recalDone_ = false;
    uint8_t consumed_[12];
    double taps_[4]; int tapN_ = 0;
    Event events_[16]; int evR_ = 0, evW_ = 0;
    // MIDI
    float midiVel_[128], midiAT_[128];
    float chanAT_ = 0.f, bend_ = 0.f, mod_ = 0.f;
    bool sustain_ = false, legato_ = false;
    int sustained_[kStack]; int sustainedN_ = 0;
    double clockTimes_[25]; int clockN_ = 0;
    uint32_t clockCount_ = 0;
    double lastClockAt_ = -1;
    int32_t sync_ = 0;
};

} // namespace pulsar
