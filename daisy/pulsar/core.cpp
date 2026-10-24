// Audio path: always optimise for speed, even when the firmware is built with -Os.
#if defined(__GNUC__) && !defined(__clang__)
#pragma GCC optimize("O3")
#endif
// pulsar::Core — see core.h. Line-for-line port of web/engine/pulsar-core.js;
// keep the two in step (test/host_test.cpp compares them).
#include "core.h"
#include <math.h>
#include <string.h>

namespace pulsar {

static constexpr float kPi = 3.14159265358979f;

// tanh via a [7/6] Pade approximant: < 1e-4 error for |x| < 3.5, no tanhf per sample.
static inline float fast_tanh(float x) {
    if (x > 4.97f) return 1.f;
    if (x < -4.97f) return -1.f;
    const float x2 = x * x;
    const float num = x * (135135.f + x2 * (17325.f + x2 * (378.f + x2)));
    const float den = 135135.f + x2 * (62370.f + x2 * (3150.f + 28.f * x2));
    const float y = num / den;
    return y > 1.f ? 1.f : (y < -1.f ? -1.f : y);
}

static inline void morph(float pos, int n, int& a, int& b, float& mix) {
    if (pos < 0.f) pos = 0.f;
    if (pos > n - 1) pos = (float)(n - 1);
    a = (int)floorf(pos);
    if (a > n - 2) a = n - 2;
    b = a + 1;
    mix = pos - a;
}

float Core::rand01() {
    uint32_t x = rng_;
    x ^= x << 13; x ^= x >> 17; x ^= x << 5;
    rng_ = x;
    return (float)(x >> 8) * (1.f / 16777216.f); // top 24 bits: exact in float
}

void Core::Init(float sampleRate) {
    sr_ = sampleRate;
    rng_ = 0x9E3779B9u;
    buildShapes();
    buildWindows();
    memset(vOn_, 0, sizeof(vOn_));
    memset(cOn_, 0, sizeof(cOn_));
    memset(ring_, 0, sizeof(ring_));
    for (int v = 0; v < kNV; v++) { vPh_[v] = vInc_[v] = vLen_[v] = vGL_[v] = vGR_[v] = 0.f; vFade_[v] = 1.f; vFadeInc_[v] = 0.f; }
    for (int c = 0; c < kNConv; c++) { cPos_[c] = cGL_[c] = cGR_[c] = 0.f; }
    p_ = Params();
    mailbox_[0] = mailbox_[1] = p_;
    mailRead_ = 0; mailSeq_ = 0; mailSeen_ = 0;
    kernel_ = nullptr; kernelLen_ = 0; pendingKernel_ = nullptr; pendingLen_ = 0; kernelPending_ = false;
    ringW_ = 0; pulseCount_ = 0; lastSync_ = -1;
    phaseB_ = 0.0; subPhase_ = 0.0; pulseCountB_ = 0;
    trainGain_[0] = 1.f; trainGain_[1] = 0.f; trainPan_[0] = trainPan_[1] = 0.f;
    memset(chBufL_, 0, sizeof(chBufL_)); memset(chBufR_, 0, sizeof(chBufR_)); chW_ = 0; chPh_ = 0.0;
    motPh_[0] = 0.f; motPh_[1] = 0.33f; motPh_[2] = 0.67f; motOff_[0] = motOff_[1] = motOff_[2] = 0.f;
    fundLog_ = logf(110.f); fundPhase_ = 0.0; env_ = 0.f;
    dcxL_ = dcyL_ = dcxR_ = dcyR_ = 0.f;
    inPeak_ = 0.f;
    fcLog_ = logf(18000.f); f1L_ = f2L_ = f1R_ = f2R_ = 0.f;
    recBuf_ = nullptr; recCap_ = 0; recPos_ = 0;
}

// Tables are built with float math so the double-precision libm stays out of flash.
void Core::buildShapes() {
    const float tp = 2.f * kPi;
    for (int s = 0; s < kNShape; s++) {
        float* o = shapes_ + s * (kTable + 1);
        for (int i = 0; i < kTable; i++) {
            const float x = (float)i / kTable;
            float v = 0.f;
            switch (s) {
                case 0: v = sinf(tp * x); break;
                case 1: v = x < 0.25f ? 4.f * x : (x < 0.75f ? 2.f - 4.f * x : 4.f * x - 4.f); break;
                case 2: v = 2.f * x - 1.f; break;
                case 3: v = x < 0.5f ? 1.f : -1.f; break;
                case 4: // band-limited pulse (Fig. 2c)
                    for (int k = 1; k <= 12; k++) v += cosf(tp * k * (x - 0.5f)) * (1.f - k / 13.f);
                    break;
                case 5: // "vela": asymmetric multi-hump cosmic pulse
                    v = sinf(tp * x) * (0.6f + 0.4f * cosf(3.f * tp * x)) + 0.35f * sinf(5.f * tp * x) * expf(-3.f * x);
                    break;
                case 6: v = rand01() * 2.f - 1.f; break;
            }
            o[i] = v;
        }
        if (s == 4) {
            float m = 0.f; for (int i = 0; i < kTable; i++) m += o[i];
            m /= kTable;
            for (int i = 0; i < kTable; i++) o[i] -= m;
        }
        float peak = 0.f;
        for (int i = 0; i < kTable; i++) peak = fmaxf(peak, fabsf(o[i]));
        for (int i = 0; i < kTable; i++) o[i] /= peak;
        o[kTable] = o[0];
    }
}

void Core::buildWindows() {
    for (int w = 0; w < kNWin; w++) {
        float* o = wins_ + w * (kWin + 1);
        for (int i = 0; i <= kWin; i++) {
            const float t = (float)i / kWin;
            float v = 0.f;
            switch (w) {
                case 0: { const float g = (t - 0.5f) / 0.16f; v = expf(-0.5f * g * g); break; }      // gaussian
                case 1: v = t < 0.08f ? 0.5f - 0.5f * cosf(kPi * t / 0.08f) : expf(-4.5f * (t - 0.08f)); break; // FOF
                case 2: v = expf(-6.f * t); break;                                                  // expodec
                case 3: v = 1.f - t; break;                                                         // linear decay
                case 4: v = 1.f; break;                                                             // rectangular
                case 5: v = t; break;                                                               // linear attack
                case 6: v = expf(6.f * (t - 1.f)); break;                                           // exp attack
            }
            o[i] = v;
        }
    }
}

// sin(x * pi/2) using the sine table (shape 0), for the wavefolder.
float Core::shapeLookupSin(float x) const {
    float ph = x * 0.25f;
    ph -= floorf(ph);
    const float y = ph * kTable;
    const int i = (int)y;
    const float f = y - i;
    return shapes_[i] + (shapes_[i + 1] - shapes_[i]) * f;
}

void Core::PostParams(const Params& p) {
    const int w = 1 - mailRead_;
    mailbox_[w] = p;
    mailRead_ = w;
    mailSeq_ = mailSeq_ + 1;
}

void Core::PostKernel(const float* data, size_t len) {
    pendingKernel_ = data;
    pendingLen_ = len;
    kernelPending_ = true;
}

void Core::StartRecord(float* buf, size_t capacity) {
    recCap_ = capacity;
    recPos_ = 0;
    recBuf_ = buf;
}

size_t Core::StopRecord() {
    recBuf_ = nullptr;
    return recPos_;
}

int Core::route(uint32_t n) {
    switch (p_.maskMode) {
        case M_BURST: {
            const uint32_t cyc = (uint32_t)(p_.burst + p_.rest);
            return (n % cyc) < (uint32_t)p_.burst ? R_BOTH : R_MUTE;
        }
        case M_CHANNEL: {
            const uint32_t cyc = (uint32_t)(p_.burst + p_.rest);
            return (n % cyc) < (uint32_t)p_.burst ? R_LEFT : R_RIGHT;
        }
        case M_STOCH:
            return rand01() < p_.prob ? R_BOTH : R_MUTE;
    }
    return R_BOTH;
}

void Core::emit(float late, int train) {
    int r;
    if (train) { r = route(pulseCountB_); pulseCountB_++; }
    else {
        r = route(pulseCount_);
        pulseCount_ = pulseCount_ + 1;
        ring_[ringW_ % kRing] = (uint8_t)r;
        ringW_ = ringW_ + 1;
    }
    const int vBase = train * kNForm * kNVoice;

    const bool overlap = p_.edge > 0.5f;
    if (!overlap) {
        // PulWM: the new period cuts the previous pulsaret, crossfaded by `edge`.
        const float edgeSamp = 1.f + p_.edge * 2.f * 0.006f * sr_;
        for (int v = vBase; v < vBase + kNForm * kNVoice; v++)
            if (vOn_[v] && vFadeInc_[v] == 0.f) vFadeInc_[v] = 1.f / edgeSamp;
    }
    if (r == R_MUTE) return;

    const float rl = r == R_RIGHT ? 0.f : 1.f, rr = r == R_LEFT ? 0.f : 1.f;
    const float tg = trainGain_[train], tp = trainPan_[train];
    for (int f = 0; f < kNForm; f++) {
        const float amp = p_.formantAmp[f] * tg, fd = p_.formantHz[f];
        if (amp < 0.001f || fd <= 0.f || fd > sr_ * 0.45f) continue;
        int base = vBase + f * kNVoice, best = base;
        float bestT = -1.f;
        for (int j = base; j < base + kNVoice; j++) {
            if (!vOn_[j]) { best = j; bestT = 2.f; break; }
            const float t = vPh_[j] / vLen_[j];
            if (t > bestT) { bestT = t; best = j; }
        }
        const float inc = fd / sr_;
        const float pan = fminf(1.f, fmaxf(-1.f, p_.formantPan[f] + tp + motOff_[f])) * 0.5f + 0.5f;
        vOn_[best] = 1;
        vInc_[best] = inc;
        vPh_[best] = late * inc;
        vLen_[best] = p_.cluster;
        vGL_[best] = amp * cosf(pan * kPi * 0.5f) * 1.4142f * rl;
        vGR_[best] = amp * sinf(pan * kPi * 0.5f) * 1.4142f * rr;
        vFade_[best] = 1.f;
        vFadeInc_[best] = 0.f;
    }

    if (!train && p_.convMix > 0.001f && kernelLen_ > 0) {
        int c = 0;
        float oldest = -1.f;
        for (int k = 0; k < kNConv; k++) {
            if (!cOn_[k]) { c = k; break; }
            if (cPos_[k] > oldest) { oldest = cPos_[k]; c = k; }
        }
        cOn_[c] = 1; cPos_[c] = late;
        cGL_[c] = rl; cGR_[c] = rr;
    }
}

void Core::Process(float* outL, float* outR, const float* in, size_t n) {
    // ---- mailbox: newest params / kernel from the main loop ----
    if (mailSeq_ != mailSeen_) { mailSeen_ = mailSeq_; p_ = mailbox_[mailRead_]; }
    if (kernelPending_) {
        kernel_ = pendingKernel_; kernelLen_ = pendingLen_;
        for (int c = 0; c < kNConv; c++) cOn_[c] = 0;
        kernelPending_ = false;
    }
    const Params& p = p_;

    // ---- control rate ----
    if (p.sync >= 0 && p.sync != lastSync_) { // beat sync: emit now if late, else re-align
        lastSync_ = p.sync;
        fundPhase_ = fundPhase_ > 0.5 ? 1.0 : 0.0;
    }
    int sa, sb, wa, wb; float sX, wX;
    morph(p.shape, kNShape + 1, sa, sb, sX); // 7 tables + live input (position 7)
    morph(p.window, kNWin, wa, wb, wX);
    const bool bIn = sb == kShapeInput;
    const float* SA = shapes_ + sa * (kTable + 1);
    const float* SB = shapes_ + (bIn ? 0 : sb) * (kTable + 1);
    const float inG = p.inputGain;
    float inPeak = inPeak_ * 0.9f;
    const float* WA = wins_ + wa * (kWin + 1);
    const float* WB = wins_ + wb * (kWin + 1);
    const float foldG = 1.f + p.fold * 6.f;
    const bool doFold = p.fold > 0.001f;

    const float targetLog = logf(fmaxf(0.01f, p.fundHz));
    const float glideK = p.glideSec > 0.001f ? 1.f - expf(-(float)n / (p.glideSec * sr_ * 0.3f)) : 1.f;
    if (env_ < 0.0005f && p.gate > 0.f) fundLog_ = targetLog; // no glide in from silence
    const float fundLog0 = fundLog_;
    fundLog_ += (targetLog - fundLog_) * glideK;
    const double inc0 = (double)expf(fundLog0) / sr_, inc1 = (double)expf(fundLog_) / sr_;
    const double incStep = (inc1 - inc0) / n;

    const float attK = 1.f - expf(-1.f / (fmaxf(0.0005f, p.attackSec) * sr_));
    const float relK = 1.f - expf(-1.f / (fmaxf(0.005f, p.releaseSec) * sr_));
    const float convWet = p.convMix, dryG = 1.f - convWet * convWet;
    const float drv = 1.f + p.drive * 8.f, outG = p.level * p.level;
    const float drvN = 1.f / tanhf(drv * 0.6f);
    const float* kernel = kernel_;
    const size_t kLen = kernelLen_;

    // Thick: detuned second train (3..25 cents), trains spread L/R, sub-octave sine above 0.6
    const float th = p.thick, bAmp = th > 0.f ? fminf(1.f, th * 4.f) : 0.f;
    const float comp = 1.f / sqrtf(1.f + bAmp * bAmp);
    trainGain_[0] = comp; trainGain_[1] = bAmp * comp;
    trainPan_[1] = 0.5f * fminf(1.f, th * 2.f); trainPan_[0] = -trainPan_[1];
    const double detMul = (double)powf(2.f, (3.f + 22.f * th) / 1200.f);
    const float subLvl = th > 0.6f ? (th - 0.6f) / 0.4f * 0.5f : 0.f;

    // Chorus / ensemble: modulated short delays per channel. Lower half = 2 taps (chorus),
    // upper half fades in a third, shared tap (ensemble). LFO uses the sine table.
    const float ca = p.chorus;
    const bool chOn = ca > 0.001f;
    const double chRate = (0.2 + 0.8 * (double)ca) / sr_;
    const float chBase = 0.010f * sr_, chDepth = (0.0015f + 0.0035f * ca) * sr_;
    const float chK3 = fminf(1.f, fmaxf(0.f, (ca - 0.5f) * 2.f)), chDry = 1.f - 0.35f * ca, chWet = 0.75f * fminf(1.f, ca * 2.f);

    // Formant motion: per-formant stereo LFOs (0.05 Hz .. 3 Hz), applied to each pulsar at emission
    static const float kMotRatio[kNForm] = {1.f, 1.37f, 1.73f}, kMotDepth[kNForm] = {0.5f, 0.6f, 0.6f};
    if (p.motion > 0.f) {
        const float mRate = 0.05f * powf(60.f, p.motion), mDepth = fminf(1.f, p.motion * 4.f);
        for (int f = 0; f < kNForm; f++) {
            motPh_[f] += mRate * kMotRatio[f] * (float)n / sr_;
            if (motPh_[f] >= 1.f) motPh_[f] -= 1.f;
            motOff_[f] = mDepth * kMotDepth[f] * sinf(2.f * kPi * motPh_[f]);
        }
    } else { motOff_[0] = motOff_[1] = motOff_[2] = 0.f; }

    // Low-pass filter: TPT state-variable filter (stable while sweeping), cutoff smoothed ~5 ms
    const float fcT = logf(fminf(fmaxf(p.cutoffHz, 20.f), 0.45f * sr_));
    fcLog_ += (fcT - fcLog_) * fminf(1.f, (float)n / (0.005f * sr_));
    const float fw = kPi * expf(fcLog_) / sr_;
    const float fg = sinf(fw) / cosf(fw); // tan via sin/cos (already linked) saves ~4 KB of flash
    const float fk = 1.f / (0.707f + p.resonance * p.resonance * 19.3f); // 1/Q, Q 0.7 .. 20
    const float fa1 = 1.f / (1.f + fg * (fg + fk)), fa2 = fg * fa1, fa3 = fg * fa2;

    for (size_t i = 0; i < n; i++) {
        const float inS = in ? in[i] * inG : 0.f;
        if (inS > inPeak) inPeak = inS; else if (-inS > inPeak) inPeak = -inS;
        // ---- fundamental: pulsar emission clock ----
        const double finc = inc0 + incStep * i;
        fundPhase_ += finc;
        if (fundPhase_ >= 1.0) {
            fundPhase_ -= 1.0;
            if (fundPhase_ >= 1.0) fundPhase_ = 0.0;
            emit((float)(fundPhase_ / finc), 0);
        }
        if (bAmp > 0.f) {
            const double fincB = finc * detMul;
            phaseB_ += fincB;
            if (phaseB_ >= 1.0) {
                phaseB_ -= 1.0;
                if (phaseB_ >= 1.0) phaseB_ = 0.0;
                emit((float)(phaseB_ / fincB), 1);
            }
        } else phaseB_ = fundPhase_; // starts in phase when thick comes in

        float L = 0.f, R = 0.f;
        // ---- pulsaret voices: w(t) * v(t) ----
        for (int v = 0; v < kNV; v++) {
            if (!vOn_[v]) continue;
            const float ph = vPh_[v], len = vLen_[v];
            if (ph >= len) { vOn_[v] = 0; continue; }
            const float fadeInc = vFadeInc_[v];
            if (fadeInc > 0.f) {
                const float fd = vFade_[v] - fadeInc;
                if (fd <= 0.f) { vOn_[v] = 0; continue; }
                vFade_[v] = fd;
            }
            const float x = (ph - floorf(ph)) * kTable;
            const int xi = (int)x; const float xf = x - xi;
            const float wa_ = SA[xi] + (SA[xi + 1] - SA[xi]) * xf;
            const float wb_ = bIn ? inS : SB[xi] + (SB[xi + 1] - SB[xi]) * xf; // live input as waveform
            float w = wa_ + (wb_ - wa_) * sX;
            if (doFold) w = shapeLookupSin(w * foldG); // west-coast fold
            const float y = (ph / len) * kWin;
            const int yi = (int)y; const float yf = y - yi;
            const float ea = WA[yi] + (WA[yi + 1] - WA[yi]) * yf;
            const float eb = WB[yi] + (WB[yi + 1] - WB[yi]) * yf;
            const float s = w * (ea + (eb - ea) * wX) * vFade_[v];
            L += s * vGL_[v]; R += s * vGR_[v];
            vPh_[v] = ph + vInc_[v];
        }
        L *= dryG; R *= dryG;

        // ---- convolved pulsar train ----
        if (convWet > 0.001f && kLen > 0) {
            float cl = 0.f, cr = 0.f;
            for (int c = 0; c < kNConv; c++) {
                if (!cOn_[c]) continue;
                const float pos = cPos_[c];
                const size_t pi = (size_t)pos;
                if (pi + 1 >= kLen) { cOn_[c] = 0; continue; }
                const float ks = kernel[pi] + (kernel[pi + 1] - kernel[pi]) * (pos - pi);
                cl += ks * cGL_[c]; cr += ks * cGR_[c];
                cPos_[c] = pos + 1.f;
            }
            L += cl * convWet; R += cr * convWet;
        }

        // ---- sub-octave sine (thick > 0.6) ----
        if (subLvl > 0.f) {
            subPhase_ += finc * 0.5;
            if (subPhase_ >= 1.0) subPhase_ -= 1.0;
            const float sx = (float)subPhase_ * kTable;
            const int si = (int)sx;
            const float sv = (shapes_[si] + (shapes_[si + 1] - shapes_[si]) * (sx - si)) * subLvl;
            L += sv; R += sv;
        }

        // ---- amplitude envelope ----
        const float g = p.gate;
        env_ += (g - env_) * (g > env_ ? attK : relK);
        L *= env_; R *= env_;

        // ---- DC block, drive, level ----
        float yl = L - dcxL_ + 0.9995f * dcyL_; dcxL_ = L; dcyL_ = yl;
        float yr = R - dcxR_ + 0.9995f * dcyR_; dcxR_ = R; dcyR_ = yr;
        { // low-pass (before drive, so drive saturates the resonance)
            float v3 = yl - f2L_, v1 = fa1 * f1L_ + fa2 * v3, v2 = f2L_ + fa2 * f1L_ + fa3 * v3;
            f1L_ = 2.f * v1 - f1L_; f2L_ = 2.f * v2 - f2L_; yl = v2;
            v3 = yr - f2R_; v1 = fa1 * f1R_ + fa2 * v3; v2 = f2R_ + fa2 * f1R_ + fa3 * v3;
            f1R_ = 2.f * v1 - f1R_; f2R_ = 2.f * v2 - f2R_; yr = v2;
        }
        float oL = fast_tanh(yl * drv * 0.6f) * drvN, oR = fast_tanh(yr * drv * 0.6f) * drvN;

        // ---- chorus / ensemble (delay lines always written, so turning it on is seamless) ----
        const int cw = chW_;
        chBufL_[cw] = oL; chBufR_[cw] = oR; chW_ = (cw + 1) & (kChorusBuf - 1);
        if (chOn) {
            chPh_ += chRate; if (chPh_ >= 1.0) chPh_ -= 1.0;
            double ph1 = chPh_ + 1.0 / 3.0, ph2 = chPh_ + 2.0 / 3.0;
            if (ph1 >= 1.0) ph1 -= 1.0;
            if (ph2 >= 1.0) ph2 -= 1.0;
            const float tA = chTap(chBufL_, cw, chBase + chDepth * 0.5f * (1.f + lfo(chPh_)));
            const float tB = chTap(chBufR_, cw, chBase + chDepth * 0.5f * (1.f + lfo(ph1)));
            const float dC = chBase + chDepth * 0.5f * (1.f + lfo(ph2));
            const float wetL = (tA + chK3 * chTap(chBufL_, cw, dC)) / (1.f + chK3);
            const float wetR = (tB + chK3 * chTap(chBufR_, cw, dC)) / (1.f + chK3);
            oL = oL * chDry + wetL * chWet; oR = oR * chDry + wetR * chWet;
        }
        outL[i] = oL * outG;
        outR[i] = oR * outG;

        // ---- recording (P01 hold) ----
        float* rb = recBuf_;
        if (rb && in && recPos_ < recCap_) { rb[recPos_] = in[i]; recPos_ = recPos_ + 1; }
    }
    inPeak_ = inPeak;
}

// sine LFO from the wavetable (same lookup as the JS engine)
float Core::lfo(double ph) const {
    const double x = ph * kTable;
    const int xi = (int)x;
    const float f = (float)(x - xi);
    return shapes_[xi] + (shapes_[xi + 1] - shapes_[xi]) * f;
}

// read a delay line `d` samples behind write position `w` (linear interpolation)
float Core::chTap(const float* buf, int w, float d) {
    const float pos = (float)w - d;
    const int pi = (int)floorf(pos);
    const float f = pos - pi;
    const float a = buf[pi & (kChorusBuf - 1)], b = buf[(pi + 1) & (kChorusBuf - 1)];
    return a + (b - a) * f;
}

size_t Core::RenderPulsaret(const Params& p, float fd, float* out, size_t maxLen) const {
    int sa, sb, wa, wb; float sX, wX;
    morph(p.shape, kNShape, sa, sb, sX);
    morph(p.window, kNWin, wa, wb, wX);
    size_t len = (size_t)fmaxf(1.f, floorf(p.cluster / fd * sr_));
    if (len > maxLen) len = maxLen;
    const float foldG = 1.f + p.fold * 6.f;
    for (size_t i = 0; i < len; i++) {
        const float ph = i * fd / sr_;
        const int xi = (int)((ph - floorf(ph)) * kTable);
        float w = shapes_[sa * (kTable + 1) + xi] * (1.f - sX) + shapes_[sb * (kTable + 1) + xi] * sX;
        if (p.fold > 0.001f) w = shapeLookupSin(w * foldG);
        int y = (int)((float)i / len * kWin); if (y > kWin) y = kWin;
        const float e = wins_[wa * (kWin + 1) + y] * (1.f - wX) + wins_[wb * (kWin + 1) + y] * wX;
        out[i] = w * e;
    }
    return len;
}

// ---------------------------------------------------------------------------
void KernelBuilder::Start(const float* pulsaret, size_t pLen, const float* sample, size_t sLen, float* out, size_t outCap) {
    if (pLen > kMaxPulsaret) pLen = kMaxPulsaret;
    memcpy(pulsaret_, pulsaret, pLen * sizeof(float));
    pLen_ = pLen;
    sample_ = sample; sLen_ = sLen;
    out_ = out;
    outLen_ = pLen + sLen - 1;
    if (outLen_ > outCap) outLen_ = outCap;
    pos_ = 0; peak_ = 1e-9f;
    state_ = (pLen && sLen) ? CONVOLVE : IDLE;
}

bool KernelBuilder::Step(uint32_t macBudget) {
    if (state_ == CONVOLVE) {
        int64_t budget = macBudget;
        while (budget > 0 && pos_ < outLen_) {
            const size_t n = pos_;
            const size_t k0 = n >= sLen_ ? n - sLen_ + 1 : 0;
            const size_t k1 = n < pLen_ - 1 ? n : pLen_ - 1;
            float acc = 0.f;
            for (size_t k = k0; k <= k1; k++) acc += pulsaret_[k] * sample_[n - k];
            out_[n] = acc;
            const float a = fabsf(acc); if (a > peak_) peak_ = a;
            budget -= (int64_t)(k1 - k0 + 1);
            pos_++;
        }
        if (pos_ >= outLen_) { state_ = NORMALISE; pos_ = 0; }
        return false;
    }
    if (state_ == NORMALISE) {
        const float g = 1.f / peak_;
        const size_t tail = outLen_ < (size_t)(outLen_ * 0.02f) + 32 ? outLen_ : (size_t)(outLen_ * 0.02f) + 32;
        const size_t end = pos_ + 16384 < outLen_ ? pos_ + 16384 : outLen_;
        for (; pos_ < end; pos_++) {
            float v = out_[pos_] * g;
            if (pos_ > outLen_ - tail) v *= (float)(outLen_ - pos_) / tail;
            out_[pos_] = v;
        }
        if (pos_ >= outLen_) state_ = DONE;
        return state_ == DONE;
    }
    return state_ == DONE;
}

} // namespace pulsar
