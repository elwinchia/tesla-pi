// Live engine-sim for the car's browser: engine-sim (MIT,
// github.com/ange-yaghi/engine-sim) compiled to WebAssembly, single-threaded,
// driven one small frame at a time from a Web Worker (static/rev-live-worker.js).
//
// It does what scripts/engine-sim/render.cpp does (compile a script, start
// the engine, hold it on the dynamometer or let it run free), with two
// differences:
//   - The synthesizer runs synchronously after each frame (renderNow, a
//     patch in patch-tree.py): no rendering thread, nothing ever waits.
//   - Its output is the DRY signal (convolution amount 0, the convolution
//     never computed), as float. The page applies the impulse responses with
//     native ConvolverNodes (static/rev-live.js). All exhausts of every
//     script here share one impulse response and one volume, and everything
//     after the per-exhaust convolution is linear (the leveller is pinned to
//     a fixed gain, as ES_GAIN does), so convolving the summed dry signal is
//     the same as engine-sim's per-exhaust convolution.
//
// The JS side calls these C functions (see EXPORTED_FUNCTIONS in CMakeLists.txt).
#include "scripting/include/compiler.h"
#include "include/engine.h"
#include "include/simulator.h"
#include "include/units.h"
#include "include/transmission.h"
#include "include/exhaust_system.h"
#include "include/impulse_response.h"

#include <emscripten/emscripten.h>

#include <algorithm>
#include <cmath>
#include <vector>

namespace {
Engine *engine = nullptr;
Simulator *sim = nullptr;
Transmission *transmission = nullptr;
std::vector<float> audio(44100);
int scriptFrequency = 0;

// Controls, set from JS between frames and applied every step.
int mode = 1;              // 0 = held on the dyno at targetRpm, 1 = free
double targetRpm = 0;      // the dyno's goal (rpm)
double throttleTarget = 0; // 0..1
double throttle = 0;       // smoothed, as the app smooths it
double dynoRpm = 0;        // the dyno's speed now, slewed toward targetRpm
bool held = false;         // the dyno held the engine last step

// Throttle: render.cpp smooths it by half per 60 Hz frame (~24 ms). The dyno
// follows the model's rpm (50 Hz steps) with a 30 ms lag, so its speed never
// jumps: a stiff dyno turns a step in speed into a torque spike, a click.
constexpr double TAU_THROTTLE = 0.024, TAU_DYNO = 0.03;

void applyControls(double dt) {
    throttle += (throttleTarget - throttle) * (1 - std::exp(-dt / TAU_THROTTLE));
    engine->setSpeedControl(throttle);
    const bool hold = mode == 0;
    if (hold && !held) dynoRpm = engine->getRpm(); // engage at the engine's own speed: no clunk
    held = hold;
    if (hold) dynoRpm += (targetRpm - dynoRpm) * (1 - std::exp(-dt / TAU_DYNO));
    sim->m_dyno.m_enabled = hold;
    sim->m_dyno.m_hold = hold;
    sim->m_dyno.m_rotationSpeed = units::rpm(std::max(0.0, dynoRpm));
}
}

extern "C" {

// Compile an engine script and build its simulator. quality: the share of
// the script's simulation frequency to run at (1, 0.75, 0.5). gain: the
// synthesizer's fixed output gain (render-set.sh's ES_GAIN, 0.0006), so the
// output is in the same units as the native renders. Returns 1 on success.
EMSCRIPTEN_KEEPALIVE int es_load(const char *script, double quality, double gain) {
    es_script::Compiler compiler;
    compiler.initialize();
    if (!compiler.compile(script)) { compiler.destroy(); return 0; }
    const es_script::Compiler::Output output = compiler.execute();
    compiler.destroy();
    engine = output.engine;
    transmission = output.transmission;
    if (!engine || !output.vehicle || !transmission) return 0;

    sim = engine->createSimulator(output.vehicle, transmission);
    engine->calculateDisplacement();
    scriptFrequency = (int)engine->getSimulationFrequency();
    sim->setSimulationFrequency(std::max(1000, (int)std::lround(scriptFrequency * quality)));
    sim->setSimulationSpeed(1.0);

    Synthesizer::AudioParameters ap = sim->synthesizer().getAudioParameters();
    ap.inputSampleNoise = (float)engine->getInitialJitter();
    ap.airNoise = (float)engine->getInitialNoise();
    ap.dF_F_mix = (float)engine->getInitialHighFrequencyGain();
    // As render.cpp's ES_GAIN: an unreachable leveller target holds it at
    // its maximum gain, so the gain is fixed. Dry: no convolution.
    ap.levelerTarget = 1e12f;
    ap.volume = (float)gain;
    ap.convolution = 0.0f;
    sim->synthesizer().setAudioParameters(ap);
    // A one-tap impulse response per exhaust, so every filter is in a
    // defined state (it is never run: the convolution amount is 0).
    for (int i = 0; i < engine->getExhaustSystemCount(); ++i) {
        const int16_t one = INT16_MAX;
        sim->synthesizer().initializeImpulseResponse(&one, 1, 1.0f, i);
    }
    sim->startAudioRenderingThread(); // a no-op in this build

    transmission->changeGear(-1); // neutral
    engine->getIgnitionModule()->m_enabled = true;
    sim->m_starterMotor.m_enabled = false;
    mode = 1; throttle = throttleTarget = 0; held = false;
    return 1;
}

EMSCRIPTEN_KEEPALIVE int es_script_frequency() { return scriptFrequency; }
EMSCRIPTEN_KEEPALIVE int es_frequency() { return sim ? sim->getSimulationFrequency() : 0; }
EMSCRIPTEN_KEEPALIVE double es_rpm() { return engine ? engine->getRpm() : 0; }
EMSCRIPTEN_KEEPALIVE double es_redline() { return engine ? units::toRpm(engine->getRedline()) : 0; }
EMSCRIPTEN_KEEPALIVE double es_throttle() { return throttle; }
EMSCRIPTEN_KEEPALIVE int es_held() { return held ? 1 : 0; }
EMSCRIPTEN_KEEPALIVE float *es_audio() { return audio.data(); }
// The impulse-response volume engine-sim gives exhaust i (its script's
// choice): the page scales its impulse responses by it, as
// Synthesizer::initializeImpulseResponse does.
EMSCRIPTEN_KEEPALIVE int es_exhaust_count() { return engine ? engine->getExhaustSystemCount() : 0; }
EMSCRIPTEN_KEEPALIVE double es_ir_volume(int i) {
    if (!engine || i < 0 || i >= engine->getExhaustSystemCount()) return 0;
    return engine->getExhaustSystem(i)->getImpulseResponse()->getVolume();
}

EMSCRIPTEN_KEEPALIVE void es_starter(int on) { if (sim) sim->m_starterMotor.m_enabled = on != 0; }
EMSCRIPTEN_KEEPALIVE void es_ignition(int on) { if (engine) engine->getIgnitionModule()->m_enabled = on != 0; }

// mode 0: the dyno holds the engine at rpm (it drives or brakes it), with the
// throttle at `throttle`. mode 1: free running (idle, or full throttle into
// the engine's own rev limiter), the dyno off.
EMSCRIPTEN_KEEPALIVE void es_control(int m, double rpm, double thr) {
    mode = m;
    targetRpm = rpm;
    throttleTarget = std::min(1.0, std::max(0.0, thr));
}

// Simulate `steps` steps (one frame) and render its audio, dry, into
// es_audio(). Returns the number of 44.1 kHz samples rendered.
EMSCRIPTEN_KEEPALIVE int es_run(int steps) {
    if (!sim) return 0;
    const double dt = sim->getTimestep();
    sim->startFrameSteps(steps);
    for (;;) {
        applyControls(dt);
        if (!sim->simulateStep()) break;
    }
    sim->endFrame();
    return sim->synthesizer().renderNow(audio.data(), (int)audio.size());
}

}
