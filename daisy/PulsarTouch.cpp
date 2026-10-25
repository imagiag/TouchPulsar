// Pulsar Touch — pulsar synthesis for the Synthux Simple Touch (Daisy Seed).
// After Curtis Roads, "Sound Composition with Pulsars" (JAES 49/3, 2001).
#include "daisy_seed.h"
#include "touch/touch.h"
#include "pulsar/core.h"
#include "ui/pulsar_ui.h"

const char* USBD_MANUFACTURER_STRING = "Synthux";
const char* USBD_PRODUCT_STRING_HS = "PulsarTouch";
const char* USBD_PRODUCT_STRING_FS = "PulsarTouch";

using namespace daisy;
using namespace synthux;

static constexpr size_t kSampleCap = 48000 * 2;                  // 2 s input recording
static constexpr size_t kKernelCap = kSampleCap + pulsar::KernelBuilder::kMaxPulsaret;

// Large buffers in external SDRAM (64 MB); tables and voices stay in internal SRAM.
static float DSY_SDRAM_BSS sampleA[kSampleCap];
static float DSY_SDRAM_BSS sampleB[kSampleCap];
static float DSY_SDRAM_BSS kernelA[kKernelCap];
static float DSY_SDRAM_BSS kernelB[kKernelCap];
static constexpr size_t kDelayCap = 48000 * 5 / 2;               // 2.5 s ping-pong delay
static float DSY_SDRAM_BSS delayL[kDelayCap];
static float DSY_SDRAM_BSS delayR[kDelayCap];

DaisySeed hw;
Touch touch;
pulsar::Core engine;
PulsarUI ui(touch, engine);

#if DEBUG
CpuLoadMeter cpu;
#endif

void AudioCallback(AudioHandle::InputBuffer in, AudioHandle::OutputBuffer out, size_t size) {
#if DEBUG
    cpu.OnBlockStart();
#endif
    engine.Process(out[0], out[1], in[0], size);
#if DEBUG
    cpu.OnBlockEnd();
#endif
}

int main(void) {
    hw.Init(true); // boost to 480 MHz
    hw.SetAudioBlockSize(48); // 1 ms blocks, as TouchString
    hw.SetAudioSampleRate(SaiHandle::Config::SampleRate::SAI_48KHZ);

#if DEBUG
    hw.StartLog(false);
    cpu.Init(hw.AudioSampleRate(), hw.AudioBlockSize());
#endif

    touch.Init(hw);
    for (int i = 0; i < 40; i++) { touch.Process(); System::Delay(3); } // let MPR121 baselines settle

    engine.Init(hw.AudioSampleRate());
    engine.SetDelayBuffers(delayL, delayR, kDelayCap);
    ui.Init(hw, sampleA, sampleB, kSampleCap, kernelA, kernelB, kKernelCap);
    hw.StartAudio(AudioCallback);

    uint32_t lastUi = System::GetNow();
#if DEBUG
    uint32_t lastLog = lastUi;
#endif
    while (1) {
        ui.PollMidi();                       // every pass: low MIDI clock jitter
        const uint32_t ms = System::GetNow();
        if (ms - lastUi >= 4) { lastUi = ms; ui.Process(hw); }
        ui.Background();                     // convolution kernel, bounded chunks
#if DEBUG
        if (ms - lastLog >= 1000) {
            lastLog = ms;
            hw.PrintLine("cpu avg " FLT_FMT3 "%% max " FLT_FMT3 "%%",
                         FLT_VAR3(cpu.GetAvgCpuLoad() * 100.f), FLT_VAR3(cpu.GetMaxCpuLoad() * 100.f));
        }
#endif
    }
}
