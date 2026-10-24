// Host test for the portable C++ engine + controls (no Daisy needed).
//   make -C daisy/test        (builds and runs, then compares with the JS engine)
// 1. Control-layer checks (same expectations as web/test/controls.js).
// 2. Renders shared scenarios to out/<name>.f32 (interleaved stereo float) for
//    compare.js, which renders them again with the JS engine and compares.
#include "../pulsar/core.h"
#include "../pulsar/controls.h"
#include <math.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <chrono>
#include <vector>
#include <string>

using namespace pulsar;

static int g_pass = 0, g_fail = 0;
#define CHECK(cond, msg) do { if (cond) g_pass++; else { g_fail++; printf("FAIL: %s\n", msg); } } while (0)
#define NEAR(a, b, tol, msg) do { double _a = (a), _b = (b); if (fabs(_a - _b) <= (tol)) g_pass++; \
    else { g_fail++; printf("FAIL: %s: got %f want %f\n", msg, _a, _b); } } while (0)

static double mtof(double n) { return 440.0 * pow(2.0, (n - 69) / 12.0); }
static void tap(Controls& c, int i) { c.PadDown(i, .7f); c.PadUp(i); }
static void combo(Controls& c, int mod, int i) { c.PadDown(mod, .7f); tap(c, i); c.PadUp(mod); }
static float fund(const Controls& c) { Params p; c.Compute(p); return p.fundHz; }

static void controlsTests() {
    Controls c;
    c.PadDown(3, .7f); NEAR(fund(c), mtof(36), 0.01, "C major pad 1 = C2"); c.PadUp(3);
    c.PadDown(9, .7f); NEAR(fund(c), mtof(47), 0.01, "C major pad 7 = B2"); c.PadUp(9);
    combo(c, P_CH, 6); CHECK(c.scale == 3, "CH+P06 = Min Pent");
    c.PadDown(8, .7f); NEAR(fund(c), mtof(48), 0.01, "min pent continues to C3"); c.PadUp(8);
    combo(c, P_CH, 3); tap(c, P_OCT_UP);
    c.PadDown(3, .7f); NEAR(fund(c), mtof(43), 0.01, "chromatic page = G2"); c.PadUp(3);
    combo(c, P_TO, 5); CHECK(c.root == 9, "TO + pad sets root A");
    combo(c, P_CH, 4); tap(c, P_OCT_DN);
    c.PadDown(3, .7f); NEAR(fund(c), mtof(45), 0.01, "A major pad 1 = A2"); c.PadUp(3);

    Controls m; combo(m, P_CH, 4);
    m.Midi(0x90, 61, 100, 0); NEAR(fund(m), mtof(61), 0.01, "MIDI chromatic despite pad scale");
    m.Midi(0xE0, 0x7F, 0x7F, 0); NEAR(fund(m), mtof(63), 0.05, "bend +2");
    m.Midi(0xE0, 0, 0x40, 0); m.Midi(0x80, 61, 0, 0); CHECK(m.ActiveKey() == -1, "note off");
    m.Midi(0x90, 60, 127, 0); Params p; m.Compute(p); NEAR(p.gate, 0.85, 0.001, "velocity gate");
    m.Midi(0xD0, 127, 0, 0); m.Compute(p); NEAR(p.gate, 1.0, 0.001, "aftertouch gate");
    m.Midi(0xD0, 0, 0, 0); m.Midi(0x80, 60, 0, 0);
    m.Midi(0x90, 67, 100, 0); m.Midi(0xB0, 64, 127, 0); m.Midi(0x80, 67, 0, 0);
    CHECK(m.ActiveKey() == Controls::kMidiKey + 67, "sustain holds");
    m.Midi(0xB0, 64, 0, 0); CHECK(m.ActiveKey() == -1, "pedal up releases");
    m.Midi(0xB0, 74, 127, 0); NEAR(m.knob[K_FORMANT], 1.0, 1e-6, "CC74");

    Controls k; k.SetSwitch(SW_RANGE, RHYTHM);
    double t = 0; const double tick = 60.0 / 120 / 24;
    for (int i = 0; i < 48; i++) { k.Midi(0xF8, 0, 0, t); t += tick; }
    NEAR(k.Bpm(), 120, 0.5, "clock 120 bpm");
    k.Midi(0x90, 62, 100, t); NEAR(fund(k), 8.0, 0.01, "D4 = 1/8 one octave up");
    k.Tick(t + 1); CHECK(k.extBpm == 0.f, "clock loss");

    Controls th; th.knob[K_FUND] = 0.8f; th.PadDown(3, .7f); th.Compute(p);
    NEAR(p.thick, 0.8, 1e-6, "TONE: right fader = thick"); NEAR(p.glideSec, 0.0, 1e-9, "TONE pads: no glide");
    th.SetSwitch(SW_RANGE, RHYTHM); th.Compute(p); NEAR(p.thick, 0.0, 1e-9, "RHYTHM: no thick");
    th.PadUp(3);

    Controls fl; fl.Compute(p); NEAR(p.cutoffHz, 18000, 0.01, "filter open by default");
    fl.Midi(0xB0, 102, 0, 0); fl.Midi(0xB0, 103, 127, 0); fl.Compute(p);
    NEAR(p.cutoffHz, 30, 0.01, "CC102 = cutoff"); NEAR(p.resonance, 1, 1e-6, "CC103 = resonance");

    { // released pads keep the pressure they had (finger lift ignored)
        Controls h; h.Tick(10); h.PadDown(P_TO, .7f); h.PadDown(P_CH, .7f); h.PadUp(P_CH); h.PadUp(P_TO); // hold on
        h.PadDown(5, 0.4f); h.Tick(10.1); h.PadMove(5, 0.9f); h.Tick(10.4); h.PadMove(5, 0.9f);
        const float lifts[3] = {0.6f, 0.3f, 0.1f};
        for (int k = 0; k < 3; k++) { h.Tick(10.42 + k * 0.02); h.PadMove(5, lifts[k]); }
        h.Tick(10.48); h.PadUp(5); h.Compute(p);
        NEAR(p.gate, 0.55 + 0.45 * 0.9, 1e-5, "hold keeps the released pressure");
    }

    Controls l; l.Tick(10);
    l.PadDown(P_TO, .7f); l.PadDown(P_CH, .7f); l.Tick(10.2); l.PadUp(P_CH); l.PadUp(P_TO);
    CHECK(l.latch, "short TO+CH = hold");
    l.Tick(20); l.PadDown(P_TO, .7f); l.PadDown(P_CH, .7f); l.Tick(21.6);
    bool recal = false; Event e; while (l.PopEvent(e)) if (e.type == EV_RECAL) recal = true;
    CHECK(recal, "long TO+CH = recalibrate");
    l.PadUp(P_CH); l.PadUp(P_TO); CHECK(l.latch, "recal keeps hold state");
}

// ---- scenarios (mirrored in compare.js) ----
static constexpr float SR = 48000.f;
static constexpr int BLOCK = 48;
static Core core;          // big: keep off the stack
static float kernelBuf[200000];
static KernelBuilder kb;
static float pulsBuf[KernelBuilder::kMaxPulsaret];

typedef void (*Script)(Controls&, double t, int block);

// Deterministic test input (also generated in compare.js): two tones + a decaying click every 0.25 s.
static float testInput(int s) {
    const float t = s / SR;
    const float ph = fmodf(t, 0.25f);
    return 0.4f * sinf(2.f * 3.14159265f * 330.f * t) + 0.2f * sinf(2.f * 3.14159265f * 1250.f * t) + 0.5f * expf(-ph * 60.f) * sinf(2.f * 3.14159265f * 90.f * ph);
}

static void render(const char* name, float secs, Script script, bool conv = false, bool input = false) {
    core.Init(SR);
    Controls c;
    const int n = (int)(secs * SR);
    std::vector<float> out(n * 2);
    float L[BLOCK], R[BLOCK], IN[BLOCK];
    double cpu = 0;
    for (int i = 0, b = 0; i < n; i += BLOCK, b++) {
        const double t = i / (double)SR;
        c.Tick(t); script(c, t, b);
        Params p; c.Compute(p);
        if (conv && b == 0) { // kernel = pulsaret (*) test sample, built like the firmware does
            static float smp[14400];
            for (int j = 0; j < 14400; j++) smp[j] = sinf(2 * 3.14159265f * 300 * j / SR) * expf(-j / (SR * 0.05f));
            const size_t pl = core.RenderPulsaret(p, p.formantHz[0], pulsBuf, KernelBuilder::kMaxPulsaret);
            kb.Start(pulsBuf, pl, smp, 14400, kernelBuf, 200000);
            while (!kb.Step(500000)) {}
            core.PostKernel(kernelBuf, kb.Length());
            FILE* kf = fopen((std::string("out/") + name + ".kernel.f32").c_str(), "wb");
            fwrite(kernelBuf, sizeof(float), kb.Length(), kf); fclose(kf);
        }
        core.PostParams(p);
        auto s = std::chrono::high_resolution_clock::now();
        for (int j = 0; j < BLOCK; j++) IN[j] = testInput(i + j);
        core.Process(L, R, input ? IN : nullptr, BLOCK);
        cpu += std::chrono::duration<double>(std::chrono::high_resolution_clock::now() - s).count();
        for (int j = 0; j < BLOCK && i + j < n; j++) { out[(i + j) * 2] = L[j]; out[(i + j) * 2 + 1] = R[j]; }
    }
    double sq = 0, peak = 0; int nan = 0;
    for (int i = 0; i < n * 2; i++) { if (!std::isfinite(out[i])) nan++; sq += out[i] * out[i]; peak = fmax(peak, fabs(out[i])); }
    FILE* f = fopen((std::string("out/") + name + ".f32").c_str(), "wb");
    fwrite(out.data(), sizeof(float), out.size(), f); fclose(f);
    printf("%-14s pulses %5u  rms %.4f  peak %.3f  nan %d  cpu %.2f%% of realtime (host)\n",
           name, core.PulseCount(), sqrt(sq / (n * 2)), peak, nan, cpu / secs * 100);
    CHECK(nan == 0, "no NaN");
}

int main() {
    controlsTests();
    system("mkdir -p out");
    render("tone_melody", 4, [](Controls& c, double t, int) {
        c.knob[K_FORMANT] = 0.2f + 0.6f * (float)(t / 4);
        const int pad = 3 + ((int)floor(t * 2) % 7);
        if (!c.touched[pad]) { for (int i = 3; i < 10; i++) if (c.touched[i]) c.PadUp(i); c.PadDown(pad, 0.7f); }
    });
    render("free_sweep", 6, [](Controls& c, double t, int) {
        c.SetSwitch(SW_RANGE, FREE); c.coupled = false; c.knob[K_FUND] = (float)(t / 6); c.knob[K_FORMANT] = 0.55f;
        c.knob[K_SPREAD] = 0.5f; c.knob[K_WINDOW] = 2.f / 6; if (!c.touched[5]) c.PadDown(5, 0.6f);
    });
    render("rhythm_burst", 4, [](Controls& c, double, int) {
        c.SetSwitch(SW_RANGE, RHYTHM); c.knob[K_MASK] = 0.4f; c.knob[K_CLUSTER] = 0.33f; c.alt[K_CLUSTER] = 0.8f;
        c.knob[K_SPREAD] = 0.6f; c.tempo = 120.f; if (!c.touched[6]) c.PadDown(6, 0.8f);
    });
    render("stoch_fold", 3, [](Controls& c, double, int) {
        c.SetSwitch(SW_MASK, 2); c.knob[K_MASK] = 0.15f; c.alt[K_SHAPE] = 1; c.knob[K_SHAPE] = 0.5f;
        c.knob[K_LEVEL] = 1; c.alt[K_LEVEL] = 0.3f; if (!c.touched[4]) c.PadDown(4, 1);
    });
    render("midi_clock", 4, [](Controls& c, double t, int b) {
        c.SetSwitch(SW_RANGE, RHYTHM); c.SetSwitch(SW_MASK, 1);
        // 120 bpm clock: one tick every 1000 samples (= 1/48 s); blocks are 48 samples
        const double tick = 60.0 / 120 / 24;
        for (int k = (int)ceil((t - 1e-9) / tick); k * tick < t + BLOCK / (double)SR - 1e-9; k++) c.Midi(0xF8, 0, 0, k * tick);
        if (b == 250) c.Midi(0x90, 62, 100, t);
    });
    render("thick", 4, [](Controls& c, double t, int) { // TONE melody, thick sweeping 0 -> 1 (sub comes in)
        c.knob[K_FUND] = (float)(t / 4); c.knob[K_SPREAD] = 0.3f;
        const int pad = 3 + ((int)floor(t * 1.5) % 7);
        if (!c.touched[pad]) { for (int i = 3; i < 10; i++) if (c.touched[i]) c.PadUp(i); c.PadDown(pad, 0.7f); }
    });
    render("filter", 4, [](Controls& c, double t, int) { // square pulsarets, resonant sweep down and up
        c.knob[K_SHAPE] = 0.5f; c.knob[K_FORMANT] = 0.6f; c.knob[K_FUND] = 0.f;
        c.ch[K_FUND] = (float)fabs(1.0 - t / 2.0); c.ch[K_LEVEL] = 0.75f;
        if (!c.touched[5]) c.PadDown(5, 0.7f);
    });
    render("live_input", 3, [](Controls& c, double, int) { // input as waveform, rhythmic gate with masking + fold
        c.SetSwitch(SW_RANGE, RHYTHM); c.coupled = false; c.knob[K_SHAPE] = 1.f; c.knob[K_FORMANT] = 0.1f;
        c.knob[K_CLUSTER] = 1.f; c.knob[K_MASK] = 0.25f; c.alt[K_SHAPE] = 0.2f; c.ch[K_MASK] = 0.6f;
        if (!c.touched[6]) c.PadDown(6, 0.8f);
    }, false, true);
    render("motion", 4, [](Controls& c, double, int) { // 3 formants drifting in stereo, with thick
        c.knob[K_SPREAD] = 0.6f; c.ch[K_SPREAD] = 0.45f; c.knob[K_FUND] = 0.4f;
        if (!c.touched[4]) c.PadDown(4, 0.7f);
    });
    render("chorus", 4, [](Controls& c, double t, int) { // chorus sweeping into ensemble
        c.knob[K_SPREAD] = 0.4f; c.alt[K_FUND] = (float)(t / 4); c.knob[K_FUND] = 0.4f;
        if (!c.touched[5]) c.PadDown(5, 0.7f);
    });
    render("pressure_hold", 3, [](Controls& c, double t, int b) { // play, lift with a falling pressure, hold keeps it
        if (b == 0) { c.knob[K_FUND] = 0.f; c.alt[K_FORMANT] = 0.8f; c.alt[K_WINDOW] = 0.6f; }
        if (b == 10) { c.PadDown(P_TO, .7f); c.PadDown(P_CH, .7f); c.PadUp(P_CH); c.PadUp(P_TO); }
        if (t > 0.3 && t < 1.2 && !c.touched[6]) c.PadDown(6, 0.3f);
        if (c.touched[6]) c.PadMove(6, t < 1.0 ? (float)(0.3 + 0.6 * (t - 0.3) / 0.7) : (float)(0.9 - (t - 1.0) * 4.0));
        if (t >= 1.2 && c.touched[6]) c.PadUp(6);
    });
    render("conv", 3, [](Controls& c, double, int) {
        c.SetSwitch(SW_RANGE, RHYTHM); c.SetSwitch(SW_MASK, 1); c.convOn = true; c.alt[K_MASK] = 1;
        c.knob[K_MASK] = 0.1f; if (!c.touched[7]) c.PadDown(7, 0.7f);
    }, true);
    printf("host checks: %d passed, %d failed\n", g_pass, g_fail);
    return g_fail ? 1 : 0;
}
