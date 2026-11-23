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
#include "scripting/include/compiler.h"
#include "include/engine.h"
#include "include/simulator.h"
#include "include/units.h"
#include "include/transmission.h"
#include "include/exhaust_system.h"
#include "include/impulse_response.h"

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
    sim->startAudioRenderingThread();
    const double redline = units::toRpm(engine->getRedline());
    double holdRpm = 0, throttle = 0, seconds = 0, warmup = 4;
    if (mode == "hold") {
        holdRpm = std::atof(argv[4]); throttle = std::atof(argv[5]); seconds = std::atof(argv[6]);
        if (argc > 7) warmup = std::atof(argv[7]);
    } else if (mode == "idle") {
        seconds = std::atof(argv[4]); if (argc > 5) warmup = std::atof(argv[5]);
    } else if (mode == "rev") {
        seconds = std::atof(argv[4]); warmup = 0;
    } else { std::fprintf(stderr, "unknown mode\n"); return 2; }

    engine->getIgnitionModule()->m_enabled = true;
    transmission->changeGear(-1);
    const double freq = sim->getSimulationFrequency();
    const double total = warmup + seconds + 1.5; // 1.5 s of starter first
    std::vector<int16_t> out, buf(8192);
    double t = 0, speed = 0, lastLog = -1;
    while (t < total) {
        // Controls for this frame.
        const bool starting = t < 1.5;
        sim->m_starterMotor.m_enabled = starting;
        double target = 0;
        if (mode == "hold") {
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

        sim->startFrame(1.0 / 60);
        while (sim->simulateStep()) {}
        t += sim->getFrameIterationCount() / freq;
        sim->endFrame();
        if (sim->getFrameIterationCount() > 0) sim->synthesizer().waitProcessed();
        for (;;) {
            const int n = sim->readAudioOutput((int)buf.size(), buf.data());
            if (n <= 0) break;
            if (t >= 1.5 + warmup) out.insert(out.end(), buf.begin(), buf.begin() + n);
            if (n < (int)buf.size()) break;
        }
        if (t - lastLog >= 0.5) {
            std::fprintf(stderr, "t=%.2f rpm=%.0f throttle=%.2f dyno=%d\n", t, engine->getRpm(), speed, (int)sim->m_dyno.m_enabled);
            lastLog = t;
        }
    }
    writeWav(outPath, out);
    std::fprintf(stderr, "%s: %.2f s, redline %.0f rpm\n", outPath.c_str(), out.size() / 44100.0, redline);
    sim->endAudioRenderingThread();
    sim->destroy();
    return 0;
}
