// pulsar::Controls — see controls.h. Port of web/engine/pulsar-controls.js.
#include "controls.h"
#include <math.h>
#include <string.h>
#include <stdlib.h>

namespace pulsar {

static const int kScales[Controls::kNumScales][7] = {
    {0, 1, 2, 3, 4, 5, 6},       // Chromatic
    {0, 2, 4, 5, 7, 9, 11},      // Major
    {0, 2, 3, 5, 7, 8, 10},      // Natural minor
    {0, 3, 5, 7, 10, 12, 15},    // Minor pentatonic
    {0, 2, 4, 7, 9, 12, 14},     // Major pentatonic
    {0, 2, 3, 5, 7, 9, 10},      // Dorian
    {0, 2, 3, 5, 7, 8, 11},      // Harmonic minor
};
static const int kSubdiv[7] = {1, 2, 3, 4, 5, 6, 8};               // pulses per beat (Fig. 5)
static const int kPcToSubdiv[12] = {0, 0, 1, 1, 2, 3, 3, 4, 4, 5, 5, 6};
static const int kBursts[][2] = {{1, 0}, {7, 1}, {6, 1}, {5, 1}, {4, 1}, {3, 1}, {5, 2}, {2, 1}, {5, 3}, {3, 2}, {4, 3},
                                 {1, 1}, {3, 4}, {2, 3}, {3, 5}, {1, 2}, {2, 5}, {1, 3}, {1, 4}, {1, 5}, {1, 6}};
static constexpr int kNumBursts = sizeof(kBursts) / sizeof(kBursts[0]);
// CC map: {cc, layer (0 main / 1 alt), index}
static const int kCcMap[16][3] = {
    {77, 0, 0}, {74, 0, 1}, {71, 0, 2}, {75, 0, 3}, {76, 0, 4}, {85, 0, 5}, {7, 0, 6}, {5, 0, 7},
    {78, 1, 0}, {79, 1, 1}, {80, 1, 2}, {81, 1, 3}, {72, 1, 4}, {82, 1, 5}, {83, 1, 6}, {84, 1, 7},
};
enum { CC_CUTOFF = 102, CC_RES = 103, CC_IN_GAIN = 104, CC_MOTION = 105, CC_MOD = 1, CC_SUSTAIN = 64, CC_RANGE = 86, CC_MASKMODE = 87, CC_BEND_RANGE = 88, CC_ROOT_FROM_MIDI = 89 };
static constexpr float kLegatoGlideSec = 0.06f;
static constexpr double kPressPeakSec = 0.15; // on release, keep the highest pressure of this last window
static constexpr double kHoldSec = 0.4, kLatchMaxSec = 1.0, kRecalSec = 1.5;

static inline float pcExp(float v, float lo, float hi) { return lo * powf(hi / lo, v); }
static inline float clampf(float v, float a, float b) { return v < a ? a : (v > b ? b : v); }

Controls::Controls() {
    static const float k[K_COUNT] = {0.15f, 0.45f, 0.f, 0.f, 0.f, 0.f, 0.7f, 0.35f};
    static const float a[K_COUNT] = {0.6f, 0.35f, 0.3f, 0.f, 0.3f, 0.6f, 0.15f, 0.f}; // [7] chorus (off)
    for (int i = 0; i < K_COUNT; i++) { knob[i] = k[i]; alt[i] = a[i]; ch[i] = 0.f; }
    ch[K_FUND] = 1.f;   // filter fully open
    ch[K_MASK] = 0.5f;  // input gain 0 dB
    sw[0] = sw[1] = 0;
    for (int i = 0; i < 12; i++) {
        touched[i] = 0; pressure[i] = 0.f; padDownAt_[i] = 0; consumed_[i] = 0;
        pressPeak_[i] = 0.f; pressPeakAt_[i] = 0; heldPress_[i] = 0.6f;
    }
    for (int i = 0; i < 128; i++) { midiVel_[i] = 0.f; midiAT_[i] = 0.f; }
}

void Controls::ev(EventType t, uint8_t blinks) {
    const int next = (evW_ + 1) % 16;
    if (next == evR_) return; // full: drop
    events_[evW_] = {t, blinks};
    evW_ = next;
}
bool Controls::PopEvent(Event& e) {
    if (evR_ == evW_) return false;
    e = events_[evR_]; evR_ = (evR_ + 1) % 16;
    return true;
}

// ---- note stack ----
bool Controls::inStack(int key) const {
    for (int i = 0; i < stackN_; i++) if (stack_[i] == key) return true;
    return false;
}
void Controls::pull(int key) {
    int j = 0;
    for (int i = 0; i < stackN_; i++) if (stack_[i] != key) stack_[j++] = stack_[i];
    stackN_ = j;
}
void Controls::push(int key) {
    pull(key);
    if (stackN_ == kStack) { for (int i = 1; i < kStack; i++) stack_[i - 1] = stack_[i]; stackN_--; }
    stack_[stackN_++] = key;
    lastKey_ = key;
    if (latch) latchedKey_ = key;
}
int Controls::ActiveKey() const {
    if (stackN_) return stack_[stackN_ - 1];
    if (latch && latchedKey_ >= 0) return latchedKey_;
    return -1;
}
int Controls::PadSemis(int pad) const { return root + kScales[scale][pad - 3] + shiftSemis(); }

void Controls::toggleLatch() {
    latch = !latch;
    latchedKey_ = latch ? (stackN_ ? stack_[stackN_ - 1] : lastKey_) : -1;
    ev(EV_LATCH, latch ? 2 : 1);
}
void Controls::setScale(int s) {
    scale = s;
    const int lim = octLimit();
    if (oct > lim) oct = lim;
    if (oct < -lim) oct = -lim;
    ev(EV_SCALE, (uint8_t)(s + 1));
}
void Controls::setRoot(int semis) {
    root = ((semis % 12) + 12) % 12;
    ev(EV_ROOT, 1);
}

// ---- pads ----
void Controls::PadDown(int i, float pr) {
    touched[i] = 1; pressure[i] = pr; padDownAt_[i] = now_; consumed_[i] = 0;
    pressPeak_[i] = pr; pressPeakAt_[i] = now_;
    const bool to = touched[P_TO], ch = touched[P_CH];

    if ((i == P_TO && ch) || (i == P_CH && to)) { // TO + CH: tap = hold (latch), long = recalibrate
        modUsed[0] = modUsed[1] = true;
        comboAt_ = now_; recalDone_ = false;
        return;
    }
    if (i == P_TO || i == P_CH) { modUsed[i == P_TO ? 0 : 1] = false; return; }

    if (ch) { // CH layer: scales & coupling
        modUsed[1] = true; consumed_[i] = 1;
        if (i == P_OCT_DN || i == P_OCT_UP) setScale((scale + (i == P_OCT_UP ? 1 : 6)) % 7);
        else if (i == P_CONV) { coupled = !coupled; ev(EV_COUPLED, coupled ? 2 : 1); }
        else if (i >= 3 && i <= 9) setScale(i - 3);
        return;
    }
    if (to) { // TO layer: tempo nudge, root key
        modUsed[0] = true; consumed_[i] = 1;
        if (i == P_OCT_DN || i == P_OCT_UP) {
            tempo = clampf(tempo + (i == P_OCT_UP ? 5.f : -5.f), 40.f, 240.f);
            ev(EV_TEMPO, 1);
        } else if (i >= 3 && i <= 9) setRoot(PadSemis(i));
        return;
    }
    if (i == P_OCT_DN || i == P_OCT_UP) {
        const int lim = octLimit();
        oct += i == P_OCT_UP ? 1 : -1;
        if (oct > lim) oct = lim;
        if (oct < -lim) oct = -lim;
        ev(EV_OCT, (uint8_t)(abs(oct) + 1));
        return;
    }
    if (i == P_CONV) return; // resolved on release / hold in Tick()
    if (i >= 3 && i <= 9) push(i);
}

// recent peak: follows rises at once, follows falls only after kPressPeakSec
void Controls::PadMove(int i, float pr) {
    if (!touched[i]) return;
    pressure[i] = pr;
    if (pr >= pressPeak_[i] || now_ - pressPeakAt_[i] > kPressPeakSec) { pressPeak_[i] = pr; pressPeakAt_[i] = now_; }
}

void Controls::PadUp(int i) {
    if (!touched[i]) return;
    touched[i] = 0;
    heldPress_[i] = now_ - pressPeakAt_[i] <= kPressPeakSec ? pressPeak_[i] : pressure[i];
    const double held = now_ - padDownAt_[i];
    if ((i == P_TO || i == P_CH) && comboAt_ >= 0) {
        if (!recalDone_ && now_ - comboAt_ < kLatchMaxSec) toggleLatch();
        comboAt_ = -1;
    } else if (i == P_TO && !modUsed[0] && held < kHoldSec) tap();
    if (i == P_CONV) {
        if (recording) { recording = false; ev(EV_REC_STOP, 3); }
        else if (!consumed_[i]) { convOn = !convOn; ev(EV_CONV, convOn ? 2 : 1); }
    }
    pull(i);
}

void Controls::tap() {
    const double t = now_;
    if (tapN_ && t - taps_[tapN_ - 1] > 2.0) tapN_ = 0;
    if (tapN_ == 4) { for (int i = 1; i < 4; i++) taps_[i - 1] = taps_[i]; tapN_--; }
    taps_[tapN_++] = t;
    if (tapN_ >= 2) tempo = clampf((float)(60.0 * (tapN_ - 1) / (taps_[tapN_ - 1] - taps_[0])), 40.f, 240.f);
    ev(EV_TEMPO, 1); // short LED flash on every tap
}

// ---- MIDI (omni) ----
void Controls::Midi(uint8_t status, uint8_t d1, uint8_t d2, double t) {
    if (status >= 0xF8) {
        if (status == 0xF8) clock(t);
        else if (status == 0xFA) { clockCount_ = 0; clockN_ = 0; sync_++; }
        else if (status == 0xFC) { extBpm = 0.f; lastClockAt_ = -1; }
        return;
    }
    const uint8_t type = status & 0xF0;
    if (type == 0x90 && d2 > 0) noteOn(d1, d2 / 127.f);
    else if (type == 0x80 || type == 0x90) noteOff(d1);
    else if (type == 0xA0) midiAT_[d1 & 127] = d2 / 127.f;
    else if (type == 0xD0) chanAT_ = d1 / 127.f;
    else if (type == 0xE0) bend_ = (float)(((d2 << 7) | d1) - 8192) / 8192.f;
    else if (type == 0xB0) cc(d1, d2);
}

void Controls::noteOn(int n, float vel) {
    const int key = kMidiKey + n;
    legato_ = false;
    for (int i = 0; i < stackN_; i++) if (stack_[i] >= kMidiKey) legato_ = true;
    int j = 0;
    for (int i = 0; i < sustainedN_; i++) if (sustained_[i] != key) sustained_[j++] = sustained_[i];
    sustainedN_ = j;
    midiVel_[n] = vel; midiAT_[n] = 0.f;
    push(key);
    if (rootFromMidi) {
        int lo = 127;
        for (int i = 0; i < stackN_; i++) if (stack_[i] >= kMidiKey && stack_[i] - kMidiKey < lo) lo = stack_[i] - kMidiKey;
        if (lo % 12 != root) setRoot(lo);
    }
}

void Controls::noteOff(int n) {
    const int key = kMidiKey + n;
    if (sustain_) {
        for (int i = 0; i < sustainedN_; i++) if (sustained_[i] == key) return;
        if (sustainedN_ < kStack) sustained_[sustainedN_++] = key;
        return;
    }
    pull(key);
}

void Controls::cc(int c, int v) {
    const float x = v / 127.f;
    for (int i = 0; i < 16; i++)
        if (kCcMap[i][0] == c) { (kCcMap[i][1] ? alt : knob)[kCcMap[i][2]] = x; return; }
    if (c == CC_MOTION) ch[K_SPREAD] = x;
    else if (c == CC_IN_GAIN) ch[K_MASK] = x;
    else if (c == CC_CUTOFF) ch[K_FUND] = x;
    else if (c == CC_RES) ch[K_LEVEL] = x;
    else if (c == CC_MOD) mod_ = x;
    else if (c == CC_SUSTAIN) {
        sustain_ = v >= 64;
        if (!sustain_) { for (int i = 0; i < sustainedN_; i++) pull(sustained_[i]); sustainedN_ = 0; }
    }
    else if (c == CC_RANGE) sw[SW_RANGE] = v / 43 > 2 ? 2 : v / 43;
    else if (c == CC_MASKMODE) sw[SW_MASK] = v / 43 > 2 ? 2 : v / 43;
    else if (c == CC_BEND_RANGE) bendRange = (float)(v > 24 ? 24 : v);
    else if (c == CC_ROOT_FROM_MIDI) rootFromMidi = v >= 64;
    else if (c == 123 || c == 120) allNotesOff();
}

void Controls::allNotesOff() {
    int j = 0;
    for (int i = 0; i < stackN_; i++) if (stack_[i] < kMidiKey) stack_[j++] = stack_[i];
    stackN_ = j; sustainedN_ = 0; sustain_ = false;
}

// 24 PPQN clock -> tempo averaged over one beat + beat sync counter
void Controls::clock(double t) {
    if (lastClockAt_ >= 0 && t - lastClockAt_ > 0.5) clockN_ = 0; // resumed after a gap
    if (clockN_ == 25) { for (int i = 1; i < 25; i++) clockTimes_[i - 1] = clockTimes_[i]; clockN_--; }
    clockTimes_[clockN_++] = t;
    lastClockAt_ = t;
    if (clockN_ >= 7) {
        const float b = (float)(60.0 * (clockN_ - 1) / ((clockTimes_[clockN_ - 1] - clockTimes_[0]) * 24.0));
        if (b > 20.f && b < 400.f) extBpm = extBpm > 0.f ? extBpm + (b - extBpm) * 0.3f : b;
    }
    if (clockCount_ % 24 == 0) sync_++;
    clockCount_++;
}

void Controls::Tick(double now) {
    now_ = now;
    if (touched[P_CONV] && !recording && !ChHeld() && !ToHeld() && now - padDownAt_[P_CONV] > kHoldSec) {
        recording = true; ev(EV_REC_START, 0);
    }
    if (comboAt_ >= 0 && !recalDone_ && ToHeld() && ChHeld() && now - comboAt_ > kRecalSec) {
        recalDone_ = true; ev(EV_RECAL, 3);
    }
    if (extBpm > 0.f && lastClockAt_ >= 0 && now - lastClockAt_ > 0.5) extBpm = 0.f; // clock lost
}

void Controls::Compute(Params& out) const {
    const int range = sw[SW_RANGE];
    const int key = ActiveKey(), src = key >= 0 ? key : lastKey_;
    const bool isMidi = src >= kMidiKey;
    const int n = src - kMidiKey;
    const float bpm = Bpm(), bendMul = powf(2.f, bend_ * bendRange / 12.f);

    // released notes (hold, or the release tail) keep the pressure they had when let go
    const float press = isMidi ? fmaxf(midiAT_[n], chanAT_) : (touched[src] ? pressure[src] : heldPress_[src]);
    float gate = 0.f;
    if (key >= 0 && isMidi) gate = fminf(1.f, (0.3f + 0.7f * midiVel_[n]) * (0.85f + 0.3f * press));
    else if (key >= 0) gate = 0.55f + 0.45f * press;

    const int semis = isMidi ? n - 36 : PadSemis(src);
    const int subIdx = isMidi ? kPcToSubdiv[n % 12] : src - 3;
    const float rateMul = isMidi ? powf(2.f, (float)(n / 12 - 4)) : powf(2.f, (float)oct);

    float fund, glide;
    const float glideK = knob[K_FUND] * knob[K_FUND];
    float thick = 0.f;
    if (range == TONE) { // right fader = Thick; glide only on MIDI legato
        fund = 65.406f * powf(2.f, semis / 12.f) * bendMul;
        thick = knob[K_FUND];
        glide = kLegatoGlideSec;
    } else if (range == FREE) {
        fund = pcExp(knob[K_FUND], 0.25f, 2048.f);
        glide = 0.04f;
    } else {
        fund = bpm / 60.f * kSubdiv[subIdx] * rateMul * bendMul;
        glide = glideK * 4.f;
    }
    if (range == TONE && !(isMidi && legato_)) glide = 0.f;
    if (isMidi && range == RHYTHM && !legato_) glide = 0.f;

    const bool coup = coupled && range != RHYTHM;
    const float push = powf(2.f, alt[K_FORMANT] * press * 2.f + mod_ * 3.f);
    const float noteMul = range == FREE ? powf(2.f, (semis - (isMidi ? 12 : 0)) / 12.f) * bendMul : 1.f;
    float fd = coup ? fund * pcExp(knob[K_FORMANT], 1.f, 32.f) * noteMul : pcExp(knob[K_FORMANT], 50.f, 6400.f) * noteMul;
    fd *= push;

    const float s = knob[K_SPREAD], w = alt[K_SPREAD];
    out.fundHz = fund;
    out.glideSec = glide;
    out.thick = thick;
    out.formantHz[0] = fd; out.formantHz[1] = fd * (1.f + 2.5f * s); out.formantHz[2] = fd * (1.f + 5.5f * s);
    out.formantAmp[0] = 1.f; out.formantAmp[1] = fminf(1.f, s * 3.f) * 0.7f;
    out.formantAmp[2] = clampf(s * 3.f - 0.6f, 0.f, 1.f) * 0.5f;
    out.formantPan[0] = 0.f; out.formantPan[1] = -w; out.formantPan[2] = w;
    out.cluster = 1.f + knob[K_CLUSTER] * 6.f;
    out.shape = knob[K_SHAPE] * 7.f; // 7 = live input
    out.window = knob[K_WINDOW] * 6.f;
    out.fold = alt[K_SHAPE];
    out.edge = alt[K_CLUSTER];

    const int m = sw[SW_MASK];
    const float mv = knob[K_MASK];
    if (m == 2) { out.maskMode = M_STOCH; out.prob = 1.f - 0.97f * mv; out.burst = 1; out.rest = 0; }
    else {
        const int lo = m == 1 ? 11 : 0; // channel masking starts at 1:1
        const int idx = (int)lroundf(lo + mv * (kNumBursts - 1 - lo));
        out.maskMode = m == 1 ? M_CHANNEL : (idx == 0 ? M_OFF : M_BURST);
        out.burst = kBursts[idx][0]; out.rest = kBursts[idx][1]; out.prob = 1.f;
    }

    const float ppb = fund * 60.f / bpm;
    out.sync = (range == RHYTHM && extBpm > 0.f && ppb >= 0.999f && fabsf(ppb - roundf(ppb)) < 0.01f) ? sync_ : -1;

    out.gate = gate;
    out.attackSec = 0.004f;
    out.releaseSec = pcExp(alt[K_WINDOW], 0.02f, 4.f);
    out.convMix = convOn ? alt[K_MASK] : 0.f;
    out.level = knob[K_LEVEL];
    out.drive = alt[K_LEVEL];
    out.cutoffHz = pcExp(ch[K_FUND], 30.f, 18000.f);
    out.resonance = ch[K_LEVEL];
    out.inputGain = pcExp(ch[K_MASK], 0.25f, 4.f); // -12..+12 dB, centre = 0 dB
    out.motion = ch[K_SPREAD];
    out.chorus = alt[K_FUND];
}

} // namespace pulsar
