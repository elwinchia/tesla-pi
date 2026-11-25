// Offline renderer for engine-sim (MIT, github.com/ange-yaghi/engine-sim).
// Runs the simulation as fast as it can, with no window and no audio device,
// and writes what its synthesizer produces to a 44.1 kHz mono WAV.
//
//   es-render <script.mr> <out.wav> hold <rpm> <throttle 0..1> <seconds> [warmup s]
//       The dynamometer holds the engine at <rpm>. Throttle 1 = full load
//       (on-load); throttle 0 = the dyno drives the engine (overrun).
//   es-render <script.mr> <out.wav> idle <seconds> [warmup s]
//       Free-running idle, no dyno: closed throttle, or ES_IDLE_THROTTLE.
//   es-render <script.mr> <out.wav> rev <seconds>
//       Free revving in neutral: idle, blips, a sweep to the limiter.
//   es-render <script.mr> <out.wav> start <seconds>
//       The engine starting, recorded from rest: a moment of silence, the
//       starter cranking it with the ignition off (ES_CRANK s, default 0.5),
//       then the ignition on, with the throttle cracked open as a start
//       would, until it catches (revs well past the starter's own speed),
//       a flare of throttle (ES_FLARE, default 0.25, for 0.3 s) and idle to
//       the end.
//   es-render <script.mr> <out.wav> stop <seconds> [warmup s]
//       The engine stopping: started and idled unrecorded for warmup s,
//       then recorded idling for 0.4 s, the ignition cut, and it running
//       down to rest.
//   es-render <script.mr> <out.wav> limiter <seconds> [warmup s]
//       Free revving in neutral at full throttle, bouncing off engine-sim's
//       own ignition-cut rev limiter (IgnitionModule): idle for warmup s
//       unrecorded (ES_IDLE_THROTTLE), then the throttle opens as the
//       recording starts. ES_REV_LIMIT (rpm) and ES_LIMITER_S (s) replace
//       the script's rev limit and cut length.
//   es-render <script.mr> <out.wav> shift <rpm> <to rpm> <seconds> [warmup s]
//       An upshift under full load: held at <rpm> as in hold, then at
//       ES_SHIFT_AT s into the recording (default 0.5) the ignition is cut
//       for ES_SHIFT_CUT s (0.14) while the dyno brings the revs down to
//       <to rpm> the way the app's gearbox does (rev-model.js: a 60 ms time
//       constant during the shift, 120 ms after), then fires again and holds
//       <to rpm>. ES_SHIFT_THROTTLE: the throttle during the cut (default 1,
//       a flat shift).
// Diagnostics, which leave the WAV as it is: ES_RPM_LOG=<file> writes the
// engine's rpm every millisecond of the recording ("t rpm" per line), and
// ES_TORQUE=1 prints the dyno's mean torque over the recording.
#include "scripting/include/compiler.h"
#include "include/engine.h"
#include "include/simulator.h"
#include "include/units.h"
#include "include/transmission.h"
#include "include/exhaust_system.h"
#include "include/impulse_response.h"

#include <algorithm>
#include <cmath>
#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <string>
#include <vector>

static std::vector<int16_t> readWav16(const std::string &path) {
    std::vector<int16_t> out;
    FILE *f = std::fopen(path.c_str(), "rb");
    if (!f) { std::fprintf(stderr, "cannot open IR %s\n", path.c_str()); return out; }
    char id[4]; uint32_t size;
    std::fread(id, 1, 4, f); std::fread(&size, 4, 1, f); std::fread(id, 1, 4, f); // RIFF, size, WAVE
    uint16_t channels = 1, bits = 16;
    while (std::fread(id, 1, 4, f) == 4 && std::fread(&size, 4, 1, f) == 1) {
        if (!std::memcmp(id, "fmt ", 4)) {
            std::vector<uint8_t> fmt(size); std::fread(fmt.data(), 1, size, f);
            channels = fmt[2] | (fmt[3] << 8); bits = fmt[14] | (fmt[15] << 8);
        } else if (!std::memcmp(id, "data", 4)) {
            std::vector<int16_t> d(size / 2); std::fread(d.data(), 2, d.size(), f);
            if (bits != 16) { std::fprintf(stderr, "IR %s is %d-bit\n", path.c_str(), bits); break; }
            for (size_t i = 0; i < d.size(); i += channels) out.push_back(d[i]);
            break;
        } else std::fseek(f, size + (size & 1), SEEK_CUR);
    }
    std::fclose(f);
    return out;
}

// The ignition module keeps its rev limit and cut length to itself; a
// derived type may name them.
struct IgnitionAccess : IgnitionModule {
    static double IgnitionModule::*revLimit() { return &IgnitionAccess::m_revLimit; }
    static double IgnitionModule::*limiterDuration() { return &IgnitionAccess::m_limiterDuration; }
};

static void writeWav(const std::string &path, const std::vector<int16_t> &s) {
    FILE *f = std::fopen(path.c_str(), "wb");
    uint32_t data = (uint32_t)s.size() * 2, riff = 36 + data, sr = 44100, br = 88200, fmtSize = 16;
    uint16_t pcm = 1, ch = 1, align = 2, bits = 16;
    std::fwrite("RIFF", 1, 4, f); std::fwrite(&riff, 4, 1, f); std::fwrite("WAVEfmt ", 1, 8, f);
    std::fwrite(&fmtSize, 4, 1, f); std::fwrite(&pcm, 2, 1, f); std::fwrite(&ch, 2, 1, f);
    std::fwrite(&sr, 4, 1, f); std::fwrite(&br, 4, 1, f); std::fwrite(&align, 2, 1, f); std::fwrite(&bits, 2, 1, f);
    std::fwrite("data", 1, 4, f); std::fwrite(&data, 4, 1, f); std::fwrite(s.data(), 2, s.size(), f);
    std::fclose(f);
}

int main(int argc, char **argv) {
    if (argc < 5) { std::fprintf(stderr, "usage: see header\n"); return 2; }
    const std::string script = argv[1], outPath = argv[2], mode = argv[3];

    es_script::Compiler compiler;
    compiler.initialize();
    if (!compiler.compile(script.c_str())) { std::fprintf(stderr, "script did not compile\n"); return 1; }
    const es_script::Compiler::Output output = compiler.execute();
    compiler.destroy();
    Engine *engine = output.engine;
    if (!engine || !output.vehicle || !output.transmission) { std::fprintf(stderr, "script made no engine/vehicle/transmission\n"); return 1; }
    Transmission *transmission = output.transmission;

    Simulator *sim = engine->createSimulator(output.vehicle, transmission);
    engine->calculateDisplacement();
    sim->setSimulationFrequency(engine->getSimulationFrequency());
    sim->setSimulationSpeed(1.0);

    Synthesizer::AudioParameters ap = sim->synthesizer().getAudioParameters();
    ap.inputSampleNoise = (float)engine->getInitialJitter();
    ap.airNoise = (float)engine->getInitialNoise();
    ap.dF_F_mix = (float)engine->getInitialHighFrequencyGain();
    // The leveler aims at a peak of 30000; at the app's volume of 1 its
    // peaks clip. ES_VOLUME (default 0.3) keeps the render clean.
    ap.volume = getenv("ES_VOLUME") ? (float)std::atof(getenv("ES_VOLUME")) : 0.3f;
    // ES_GAIN gives a fixed gain instead of the leveler's automatic one, so
    // on-load and overrun keep their natural difference in loudness. (The
    // leveler's min/max are only read at start-up, but its target is read
    // every sample: an unreachable target holds it at its maximum, 1.9x.)
    if (getenv("ES_GAIN")) { ap.levelerTarget = 1e12f; ap.volume = (float)std::atof(getenv("ES_GAIN")); }
    sim->synthesizer().setAudioParameters(ap);
    // ES_CONV: how much of the exhaust impulse response is mixed in (the
    // app's "convolution level", default 1). ES_IR: a different impulse
    // response (a 16-bit WAV) for every exhaust, at the script's volume.
    if (getenv("ES_CONV")) ap.convolution = (float)std::atof(getenv("ES_CONV"));
    sim->synthesizer().setAudioParameters(ap);
    for (int i = 0; i < engine->getExhaustSystemCount(); ++i) {
        ImpulseResponse *ir = engine->getExhaustSystem(i)->getImpulseResponse();
        const std::string irPath = getenv("ES_IR") ? std::string(getenv("ES_IR")) : ir->getFilename();
        std::vector<int16_t> d = readWav16(irPath);
        sim->synthesizer().initializeImpulseResponse(d.data(), (unsigned)d.size(), (float)ir->getVolume(), i);
    }

    // The synthesizer is built around its rendering thread: each frame hands
    // it a block of simulation output (endFrame) and waits until it has been
    // turned into audio (waitProcessed), so nothing is dropped or invented.
    // ES_SYNC=1 renders the audio on this thread, after each frame, instead
    // of on engine-sim's audio thread. Both threads draw from the C library's
    // one rand() (the combustion's flame-speed scatter and the synthesizer's
    // noise), so with the thread a run's noise depends on timing: holds
    // longer than ~6 s came out a few LSB different from run to run. With
    // ES_SYNC every run is identical. The renders the committed loops came
    // from were made without it, and are left so.
    const bool sync = getenv("ES_SYNC") != nullptr;
    if (!sync) sim->startAudioRenderingThread();
    const double redline = units::toRpm(engine->getRedline());
    double holdRpm = 0, throttle = 0, seconds = 0, warmup = 4;
    if (mode == "hold") {
        holdRpm = std::atof(argv[4]); throttle = std::atof(argv[5]); seconds = std::atof(argv[6]);
        if (argc > 7) warmup = std::atof(argv[7]);
    } else if (mode == "idle") {
        seconds = std::atof(argv[4]); if (argc > 5) warmup = std::atof(argv[5]);
    } else if (mode == "rev") {
        seconds = std::atof(argv[4]); warmup = 0;
    } else if (mode == "start") {
        seconds = std::atof(argv[4]); warmup = 0;
    } else if (mode == "stop") {
        seconds = std::atof(argv[4]); if (argc > 5) warmup = std::atof(argv[5]);
    } else if (mode == "limiter") {
        seconds = std::atof(argv[4]); if (argc > 5) warmup = std::atof(argv[5]);
    } else if (mode == "shift") {
        if (argc < 7) { std::fprintf(stderr, "usage: shift <rpm> <to rpm> <seconds> [warmup]\n"); return 2; }
        holdRpm = std::atof(argv[4]); seconds = std::atof(argv[6]); throttle = 1;
        if (argc > 7) warmup = std::atof(argv[7]);
    } else { std::fprintf(stderr, "unknown mode\n"); return 2; }
    const double shiftTo = mode == "shift" ? std::atof(argv[5]) : 0;
    const double shiftAt = getenv("ES_SHIFT_AT") ? std::atof(getenv("ES_SHIFT_AT")) : 0.5;
    const double shiftCut = getenv("ES_SHIFT_CUT") ? std::atof(getenv("ES_SHIFT_CUT")) : 0.14;
    const double shiftThrottle = getenv("ES_SHIFT_THROTTLE") ? std::atof(getenv("ES_SHIFT_THROTTLE")) : 1.0;
    if (getenv("ES_REV_LIMIT")) engine->getIgnitionModule()->*IgnitionAccess::revLimit() = units::rpm(std::atof(getenv("ES_REV_LIMIT")));
    if (getenv("ES_LIMITER_S")) engine->getIgnitionModule()->*IgnitionAccess::limiterDuration() = std::atof(getenv("ES_LIMITER_S"));
    FILE *rpmLog = getenv("ES_RPM_LOG") ? std::fopen(getenv("ES_RPM_LOG"), "w") : nullptr;
    const bool wantTorque = getenv("ES_TORQUE") != nullptr;
    double torqueSum = 0, nextLog = 0; long torqueN = 0;
    const double idleThrottle = getenv("ES_IDLE_THROTTLE") ? std::atof(getenv("ES_IDLE_THROTTLE")) : 0.0;

    // Every mode but start: 1.5 s on the starter with the ignition on, then
    // warmup s unrecorded. start records from rest instead.
    const bool startMode = mode == "start";
    const double recordFrom = startMode ? 0 : 1.5 + warmup;
    const double crank = getenv("ES_CRANK") ? std::atof(getenv("ES_CRANK")) : 0.5;
    const double flare = getenv("ES_FLARE") ? std::atof(getenv("ES_FLARE")) : 0.25;
    const double crankFrom = 0.15, fireFrom = crankFrom + crank;
    double caughtAt = -1, crankRpm = 0;
    engine->getIgnitionModule()->m_enabled = !startMode;
    transmission->changeGear(-1);
    const double freq = sim->getSimulationFrequency();
    const double total = startMode ? seconds : warmup + seconds + 1.5;
    std::vector<int16_t> out, buf(8192);
    double t = 0, speed = 0, lastLog = -1;
    while (t < total) {
        // Controls for this frame.
        bool starting = t < 1.5;
        double target = 0;
        if (startMode) {
            // Crank, fire, and let go of the starter once it has caught (or
            // after 1.2 s of firing, whatever happens).
            const double rpm = engine->getRpm();
            engine->getIgnitionModule()->m_enabled = t >= fireFrom;
            if (t < fireFrom) crankRpm = rpm;
            // Caught: running on its own, well past what the starter spins.
            if (caughtAt < 0 && t >= fireFrom && rpm > std::max(450.0, 1.5 * crankRpm)) caughtAt = t;
            starting = t >= crankFrom && caughtAt < 0 && t < fireFrom + 2.0;
            target = caughtAt >= 0 ? (t - caughtAt < 0.3 ? flare : idleThrottle)
                   : t >= fireFrom ? std::max(idleThrottle, 0.1) : 0.0;
        }
        sim->m_starterMotor.m_enabled = starting;
        if (startMode) {
        } else if (mode == "stop") {
            const double u = t - recordFrom;
            engine->getIgnitionModule()->m_enabled = u < 0.4;
            target = u < 0.4 ? idleThrottle : 0.0;
        } else if (mode == "limiter") {
            target = t >= recordFrom ? 1.0 : idleThrottle;
        } else if (mode == "hold" || mode == "shift") {
            const bool hold = t >= 1.5;
            sim->m_dyno.m_enabled = hold;
            sim->m_dyno.m_hold = hold;
            // Ramp the hold speed up from idle over the first second.
            const double r = std::min(1.0, (t - 1.5) / 1.0);
            sim->m_dyno.m_rotationSpeed = units::rpm(800 + (holdRpm - 800) * std::max(0.0, r));
            target = hold ? throttle : 0.0;
        } else if (mode == "idle") {
            // ES_IDLE_THROTTLE: some scripts (the F136) only keep running
            // with the throttle cracked open, as a real idle valve would.
            target = getenv("ES_IDLE_THROTTLE") ? std::atof(getenv("ES_IDLE_THROTTLE")) : 0.0;
        } else {
            const double u = t - 1.5; // 0 = engine running
            if (u > 2 && u < 2.3) target = 0.6;            // blip
            else if (u > 3.5 && u < 3.9) target = 1.0;     // bigger blip
            else if (u > 5.5 && u < 8.5) target = 1.0;     // sweep into the limiter
            else target = 0;
        }
        speed = target * 0.5 + 0.5 * speed;  // as the app smooths it
        engine->setSpeedControl(speed);

        // The shift is steered step by step: a frame (1/60 s) is too coarse
        // for a 140 ms cut. Other modes only watch.
        const double shiftFrom = recordFrom + shiftAt;
        long k = 0;
        const bool shiftSoon = mode == "shift" && t + 1.0 / 30 >= shiftFrom;
        sim->startFrame(1.0 / 60);
        for (;;) {
            if (shiftSoon) {
                const double ts = t + k / freq, u = ts - shiftFrom;
                const bool cut = u >= 0 && u < shiftCut;
                engine->getIgnitionModule()->m_enabled = !cut;
                engine->setSpeedControl(cut ? shiftThrottle : speed);
                if (u >= 0) {
                    // rev-model.js Gearbox: tau 0.06 s while shifting, 0.12 s after.
                    const double at = holdRpm - shiftTo;
                    const double rc = shiftTo + at * std::exp(-shiftCut / 0.06);
                    const double r = u < shiftCut ? shiftTo + at * std::exp(-u / 0.06)
                                                  : shiftTo + (rc - shiftTo) * std::exp(-(u - shiftCut) / 0.12);
                    sim->m_dyno.m_rotationSpeed = units::rpm(r);
                }
            }
            if (!sim->simulateStep()) break;
            ++k;
            const double ts = t + k / freq;
            if (ts >= recordFrom) {
                if (rpmLog && ts - recordFrom >= nextLog) { std::fprintf(rpmLog, "%.4f %.1f\n", ts - recordFrom, engine->getRpm()); nextLog += 0.001; }
                if (wantTorque) { torqueSum += sim->m_dyno.getTorque(); ++torqueN; }
            }
        }
        t += sim->getFrameIterationCount() / freq;
        sim->endFrame();
        if (sync) { if (sim->getFrameIterationCount() > 0) sim->synthesizer().renderAudio(); }
        else if (sim->getFrameIterationCount() > 0) sim->synthesizer().waitProcessed();
        for (;;) {
            const int n = sim->readAudioOutput((int)buf.size(), buf.data());
            if (n <= 0) break;
            if (t >= recordFrom) out.insert(out.end(), buf.begin(), buf.begin() + n);
            if (n < (int)buf.size()) break;
        }
        if (t - lastLog >= 0.5) {
            std::fprintf(stderr, "t=%.2f rpm=%.0f throttle=%.2f dyno=%d\n", t, engine->getRpm(), speed, (int)sim->m_dyno.m_enabled);
            lastLog = t;
        }
    }
    writeWav(outPath, out);
    if (rpmLog) std::fclose(rpmLog);
    if (wantTorque) std::fprintf(stderr, "torque %.2f N m (mean over the recording)\n", torqueN ? torqueSum / torqueN : 0.0);
    std::fprintf(stderr, "%s: %.2f s, redline %.0f rpm\n", outPath.c_str(), out.size() / 44100.0, redline);
    if (!sync) sim->endAudioRenderingThread();
    sim->destroy();
    return 0;
}
