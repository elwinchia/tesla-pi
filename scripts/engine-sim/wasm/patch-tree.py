#!/usr/bin/env python3
# patch-tree.py <tree-wasm>
#
# The WebAssembly build's own changes, applied on top of make-tree.sh's six
# clang patches, to a separate copy of the tree (.cache/engine-sim/tree-wasm).
# The native tree and es-render are never touched. Nothing here changes what
# the simulation computes:
#
#   1. piranha's Path uses Boost.Filesystem; here it uses std::filesystem
#      (same calls), so the WASM build needs no Boost.
#   2. The synthesizer gets a synchronous, non-blocking render entry point,
#      renderNow(), that turns every input sample the last frame wrote into
#      float audio at once, and skips ConvolutionFilter::f when the
#      convolution amount is 0 (upstream computes it and multiplies it by 0).
#      The rendering thread and the condition-variable waits are compiled
#      out under __EMSCRIPTEN__ (or ES_SINGLE_THREAD, for a native benchmark of
#      the same code): a single-threaded build has nothing to wait
#      for, so nothing can block.
#   3. Simulator::startFrameSteps(n): a frame of exactly n steps, without
#      startFrame's latency feedback (which only makes sense with the thread).
import sys, pathlib

T = pathlib.Path(sys.argv[1])

def patch(rel, a, b, count=1):
    p = T / rel
    s = p.read_text()
    assert s.count(a) == count, f'{rel}: expected {count} of {a[:60]!r}, found {s.count(a)}'
    p.write_text(s.replace(a, b))

# 1. Boost.Filesystem -> std::filesystem.
patch('dependencies/submodules/piranha/include/path.h',
"""// Forward Boost declaration
namespace boost {
    namespace filesystem {
        class path;
    } /* namespace filesystem */
} /* namespace boost */
""",
"""// WASM build: std::filesystem instead of Boost.Filesystem (same calls).
#include <filesystem>
""")
patch('dependencies/submodules/piranha/include/path.h', 'boost::filesystem::path', 'std::filesystem::path', 3)
patch('dependencies/submodules/piranha/src/path.cpp', '#include <boost/filesystem.hpp>', '#include <filesystem>\n#include <system_error>')
patch('dependencies/submodules/piranha/src/path.cpp',
      'return boost::filesystem::equivalent(this->getBoostPath(), path.getBoostPath());',
      'std::error_code ec; return std::filesystem::equivalent(this->getBoostPath(), path.getBoostPath(), ec);')
p = T / 'dependencies/submodules/piranha/src/path.cpp'
p.write_text(p.read_text().replace('boost::filesystem', 'std::filesystem'))

# 2. The synthesizer, single-threaded.
patch('include/synthesizer.h',
"""        int16_t renderAudio(int inputOffset);
""",
"""        int16_t renderAudio(int inputOffset);

        // WASM, single-threaded: render every input sample written since the
        // last call into out (float, in the same units as the int16 output:
        // full scale = 32768), and drop them from the input. No waiting, no
        // rounding, no clipping. Returns the sample count (<= maxSamples).
        int renderNow(float *out, int maxSamples);
        float renderSampleFloat(int inputOffset);
""")
patch('src/synthesizer.cpp',
"""void Synthesizer::startAudioRenderingThread() {
    m_run = true;
    m_thread = new std::thread(&Synthesizer::audioRenderingThread, this);
}""",
"""void Synthesizer::startAudioRenderingThread() {
#if defined(__EMSCRIPTEN__) || defined(ES_SINGLE_THREAD)
    m_run = false; // single-threaded: use renderNow()
#else
    m_run = true;
    m_thread = new std::thread(&Synthesizer::audioRenderingThread, this);
#endif
}""")
patch('src/synthesizer.cpp',
"""void Synthesizer::waitProcessed() {
    {""",
"""void Synthesizer::waitProcessed() {
#if defined(__EMSCRIPTEN__) || defined(ES_SINGLE_THREAD)
    return; // nothing to wait for without the rendering thread
#endif
    {""")
patch('src/synthesizer.cpp',
"""void Synthesizer::renderAudio() {
    std::unique_lock<std::mutex> lk0(m_lock0);
""",
"""void Synthesizer::renderAudio() {
#if defined(__EMSCRIPTEN__) || defined(ES_SINGLE_THREAD)
    return; // the blocking renderer needs the thread; see renderNow()
#endif
    std::unique_lock<std::mutex> lk0(m_lock0);
""")
patch('src/synthesizer.cpp',
"""double Synthesizer::getLevelerGain() {""",
"""int Synthesizer::renderNow(float *out, int maxSamples) {
    if (m_inputChannelCount == 0) return 0;
    const int n = std::min(maxSamples, (int)m_inputChannels[0].data.size());
    for (int i = 0; i < m_inputChannelCount; ++i) {
        m_inputChannels[i].data.read(n, m_inputChannels[i].transferBuffer);
        m_inputChannels[i].data.removeBeginning(n);
    }
    m_inputSamplesRead = 0;
    m_latency = (int)m_inputChannels[0].data.size();

    for (int i = 0; i < m_inputChannelCount; ++i) {
        m_filters[i].airNoiseLowPass.setCutoffFrequency(
            static_cast<float>(m_audioParameters.airNoiseFrequencyCutoff), m_audioSampleRate);
        m_filters[i].jitterFilter.setJitterScale(m_audioParameters.inputSampleNoise);
    }
    for (int i = 0; i < n; ++i) out[i] = renderSampleFloat(i);
    return n;
}

// renderAudio(int), line for line, but float out and no convolution when
// its amount is 0.
float Synthesizer::renderSampleFloat(int inputSample) {
    const float airNoise = m_audioParameters.airNoise;
    const float dF_F_mix = m_audioParameters.dF_F_mix;
    const float convAmount = m_audioParameters.convolution;

    float signal = 0;
    for (int i = 0; i < m_inputChannelCount; ++i) {
        const float jitteredSample =
            m_filters[i].jitterFilter.fast_f(m_inputChannels[i].transferBuffer[inputSample]);

        const float f_in = jitteredSample;
        const float f_dc = m_filters[i].inputDcFilter.fast_f(f_in);
        const float f = f_in - f_dc;
        const float f_p = m_filters[i].derivative.f(f_in);

        const float noise = 2.0 * ((double)rand() / RAND_MAX) - 1.0;
        const float r =
            m_filters->airNoiseLowPass.fast_f(noise);
        const float r_mixed =
            airNoise * r + (1 - airNoise);

        float v_in =
            f_p * dF_F_mix
            + f * r_mixed * (1 - dF_F_mix);
        if (fpclassify(v_in) == FP_SUBNORMAL) {
            v_in = 0;
        }

        const float v = (convAmount == 0)
            ? v_in
            : convAmount * m_filters[i].convolution.f(v_in) + (1 - convAmount) * v_in;

        signal += v;
    }

    signal = m_antialiasing.fast_f(signal);

    m_levelingFilter.p_target = m_audioParameters.levelerTarget;
    return m_levelingFilter.f(signal) * m_audioParameters.volume;
}

double Synthesizer::getLevelerGain() {""")

# 3. A frame of exactly n steps.
patch('include/simulator.h',
"""    virtual void startFrame(double dt);""",
"""    virtual void startFrame(double dt);
    // WASM: a frame of exactly `steps` steps (no latency feedback).
    void startFrameSteps(int steps) {
        m_currentIteration = 0;
        m_synthesizer.setInputSampleRate(m_simulationFrequency * m_simulationSpeed);
        m_steps = steps;
        // as startFrame: the intakes' per-frame flow (a display figure)
        if (m_engine != nullptr && steps > 0) {
            for (int i = 0; i < m_engine->getIntakeCount(); ++i) m_engine->getIntake(i)->m_flowRate = 0;
        }
    }""")
print(f'wasm patches applied: {T}')
