// Recorded engine sounds: where each loop in static/sounds/ came from, and how
// it was cut. Read by the page (to load the loops and credit them), by
// scripts/rev-samples.mjs (to rebuild them from their sources) and by the
// tests (which check every file is credited under an allowed licence).
//
// Only recordings their own uploader made, under a licence that allows
// reuse in a public repository: CC0, or CC BY with visible credit. Nothing
// NC/ND, nothing ripped from a game, app, video or commercial product, and
// nothing from TesRev. Or loops we render ourselves with engine-sim (MIT),
// a physically modelled engine simulator (scripts/engine-sim/). static/sounds/CREDITS.md has the same list for
// people, and docs/rev-sound.md says what was rejected and why.

export const ALLOWED_LICENCES = {
  'CC0 1.0': { url: 'https://creativecommons.org/publicdomain/zero/1.0/', attribution: false },
  'CC BY 3.0': { url: 'https://creativecommons.org/licenses/by/3.0/', attribution: true },
  'CC BY 4.0': { url: 'https://creativecommons.org/licenses/by/4.0/', attribution: true },
  // The renderer's licence. The loops are our own output; engine-sim is
  // credited anyway.
  'MIT': { url: 'https://github.com/ange-yaghi/engine-sim/blob/master/LICENSE', attribution: true },
}

// One entry per recording. `audio` is the copy Freesound serves on that
// sound's own page (its 128 kbit/s MP3 preview: the original file needs a
// Freesound login); `fetched` is when it was downloaded.
export const CREDITS = {
  enginesim: {
    kind: 'render',
    title: 'engine-sim', author: 'AngeTheGreat',
    url: 'https://github.com/ange-yaghi/engine-sim',
    licence: 'MIT', licenceUrl: 'https://github.com/ange-yaghi/engine-sim/blob/master/LICENSE',
    commit: '85f7c3b',
    // Engine scripts: three bundled with engine-sim (MIT), and our own flat-6.
    engineScripts: [
      'assets/engines/atg-video-2/07_gm_ls.mr', 'assets/engines/atg-video-2/10_lfa_v10.mr',
      'assets/engines/atg-video-2/08_ferrari_f136_v8.mr', 'scripts/engine-sim/flat6_gt3.mr (ours)',
    ],
    recording: 'Rendered offline on our own machine with engine-sim, a physically modelled engine simulator, from engine scripts: the engine held on its dynamometer at each rpm at full throttle (on-load) and closed throttle (overrun), plus a free-running idle; heard through engine-sim\'s own "real engine" impulse response (the engine group) and its "minimal muffling" one (the exhaust group), with a dry render of the same runs as a low sub layer; and each engine started from rest and stopped from idle, its cranking mixed with a starter motor we synthesise. scripts/engine-sim/ rebuilds them.',
  },
}

// Per car (keys of PROFILES in rev-profiles.js): the loops, each cut from
// `src` at `start` seconds, `seconds` long, recorded at `rpm`. `layer` is
// 'on' (under load), 'off' (lifting) or 'any'. `seconds` is rounded to whole
// engine cycles (loopSeconds), so the loop's seam falls between firings.
// Every car is an engine-sim set: the same runs (a free-running idle, then
// dyno holds at each rpm at full throttle, on-load, and closed throttle,
// overrun) heard from two places, `engine` and `exhaust`, which the Exhaust
// setting crossfades. For each loop, `render` names the WAV it is cut from
// (scripts/engine-sim/render-set.sh) and `level` is its loudness relative
// to its group's loudest on-load loop, square-rooted so overrun and idle
// stay audible; the idle loop plays in both layers.
//
//   engine:  engine-sim's "real engine" impulse response (ES_IR, see
//            scripts/engine-sim/README.md). The scripts' own responses left
//            the first car thin (smooth_39 is centred on 320-640 Hz).
//   exhaust: its "minimal muffling" response, a near straight pipe: raspier,
//            with the weight at 160-320 Hz.
// For both: the bottom octave lifted and the top softened, and the same
// runs rendered dry (ES_CONV=0), low-passed at 100 Hz and mixed under, since
// the impulse responses strip the octave where an idle's firing note lives.
const IR = {
  engine: 'es/sound-library/archive/test_engine_14_eq_adjusted_16.wav',
  exhaust: 'es/sound-library/new/minimal_muffling_01.wav',
}
const EQ = [{ type: 'lowshelf', hz: 90, db: 10 }, { type: 'highshelf', hz: 3500, db: -4 }]

// One car's set. engine / exhaust: [idle level, [[rpm, on level, off level]...]],
// from `node scripts/rev-samples.mjs --print-levels <car>`.
//
// idle: { rpm, start, seconds: { engine, exhaust } } from `--fit-idle <car>`
// in scripts/rev-samples.mjs: the idle's real rpm, and for each group a loop
// length where its waveform repeats, so the seam falls between firings. Idle
// loops play at exactly that length (exact), and the car's profile idles at
// the same rpm, so the idle plays at its own pitch.
//
// oneshots: the engine starting and stopping, played once when the engine
// sound starts and stops (`--oneshots` in scripts/rev-samples.mjs, from
// scripts/engine-sim/render-oneshots.sh). Their idle is as loud as the idle
// loop's, and the player hands over to the loops at the start's end.
// crank: the rpm its starter turns it at (for the synthesised starter's
// rhythm, one labour per compression); start: when in the start clip it
// catches (s) and how high it flares (rpm), from the render's log, so the
// rev meter can follow the clip.
function engineSim({ car, renders, script, idle, engine, exhaust, crank, start }) {
  const loop = (group, rpm, layer, level, render) => ({
    file: `${car}-${group === 'exhaust' ? 'ex' : 'es'}-${render}.ogg`, src: 'enginesim', group, render,
    start: 0.4, seconds: 1.5, rpm, layer, level,
  })
  const idleLoop = (group, layer, level) => ({ ...loop(group, idle.rpm, layer, level, 'idle'), start: idle.start, seconds: idle.seconds[group], exact: true })
  const group = (g, [idleLevel, points]) => [
    idleLoop(g, 'on', idleLevel), idleLoop(g, 'off', idleLevel),
    ...points.flatMap(([rpm, on, off]) => [loop(g, rpm, 'on', on, `on-${rpm}`), loop(g, rpm, 'off', off, `off-${rpm}`)]),
  ]
  return {
    kind: 'engine-sim', bitrate: '64k', script,
    renders: { engine: renders, exhaust: `${renders}-exhaust` },
    ir: IR, eq: EQ,
    sub: { renders: `${renders}-dry`, lowpass: 100, level: 0.7 },
    loops: [...group('engine', engine), ...group('exhaust', exhaust)],
    oneshots: {
      crankRpm: crank,
      start: { seconds: 5.5, catch: start.catch, flare: start.flare, engine: `${car}-es-start.ogg`, exhaust: `${car}-ex-start.ogg` },
      stop: { seconds: 1.6, engine: `${car}-es-stop.ogg`, exhaust: `${car}-ex-stop.ogg` },
    },
  }
}

export const SAMPLE_SETS = {
  // GM LS V8, bundled with engine-sim.
  v8: engineSim({
    car: 'v8', renders: 'ls-v8', script: 'scripts/engine-sim/ls_v8.mr', idle: { rpm: 690, start: 1, seconds: { engine: 6.36871, exhaust: 6.36933 } }, crank: 205, start: { catch: 1.25, flare: 1800 },
    engine: [0.378, [[1200, 0.631, 0.15], [1800, 0.771, 0.203], [2500, 0.89, 0.268], [3200, 0.964, 0.336],
      [4000, 0.938, 0.368], [4800, 1, 0.44], [5600, 0.992, 0.426], [6300, 0.966, 0.402]]],
    exhaust: [0.364, [[1200, 0.607, 0.13], [1800, 0.7, 0.172], [2500, 0.815, 0.236], [3200, 0.837, 0.274],
      [4000, 0.862, 0.291], [4800, 0.915, 0.331], [5600, 0.991, 0.402], [6300, 1, 0.451]]],
  }),
  // LFA-style V10, bundled with engine-sim.
  lfa: engineSim({
    car: 'lfa', renders: 'lfa-v10', script: 'scripts/engine-sim/lfa_v10.mr', idle: { rpm: 901, start: 1, seconds: { engine: 5.57081, exhaust: 5.55715 } }, crank: 200, start: { catch: 1.2, flare: 1950 },
    engine: [0.26, [[1300, 0.433, 0.076], [2000, 0.425, 0.082], [2800, 0.459, 0.102], [3700, 0.417, 0.106], [4600, 0.547, 0.141],
      [5600, 0.763, 0.203], [6700, 0.925, 0.263], [7800, 1, 0.327], [8800, 0.925, 0.33]]],
    exhaust: [0.251, [[1300, 0.418, 0.075], [2000, 0.6, 0.103], [2800, 0.887, 0.145], [3700, 0.925, 0.16], [4600, 1, 0.199],
      [5600, 0.939, 0.221], [6700, 0.988, 0.264], [7800, 0.886, 0.241], [8800, 0.886, 0.239]]],
  }),
  // Ferrari F136-style flat-plane V8, bundled with engine-sim. It stalls at
  // a fully closed throttle, so its idle is rendered with ES_IDLE_THROTTLE=0.02
  // (about 1,058 rpm).
  f136: engineSim({
    car: 'f136', renders: 'f136-v8', script: 'scripts/engine-sim/f136_v8.mr', idle: { rpm: 1058, start: 1, seconds: { engine: 5.69869, exhaust: 5.61335 } }, crank: 200, start: { catch: 2.15, flare: 1580 },
    engine: [0.276, [[1300, 0.461, 0.078], [2000, 0.541, 0.116], [2800, 0.59, 0.149], [3700, 0.539, 0.182], [4600, 0.567, 0.185],
      [5600, 0.628, 0.213], [6700, 0.692, 0.225], [7800, 0.822, 0.277], [8800, 1, 0.353]]],
    exhaust: [0.303, [[1300, 0.506, 0.081], [2000, 0.601, 0.108], [2800, 0.75, 0.17], [3700, 0.817, 0.241], [4600, 0.919, 0.312],
      [5600, 1, 0.354], [6700, 0.982, 0.334], [7800, 0.891, 0.325], [8800, 0.797, 0.307]]],
  }),
  // GT3-style flat-6: our own engine script (engine-sim has no flat-6).
  gt3: engineSim({
    car: 'gt3', renders: 'flat6-gt3', script: 'scripts/engine-sim/flat6_gt3.mr', idle: { rpm: 923, start: 1, seconds: { engine: 4.76515, exhaust: 6.59335 } }, crank: 575, start: { catch: 1.2, flare: 3390 },
    engine: [0.488, [[1400, 0.813, 0.084], [2100, 0.991, 0.144], [2900, 0.934, 0.211], [3800, 0.887, 0.305], [4800, 0.92, 0.399],
      [5800, 0.974, 0.537], [6800, 1, 0.673], [7800, 0.856, 0.718], [8800, 0.928, 0.861]]],
    exhaust: [0.35, [[1400, 0.584, 0.089], [2100, 0.644, 0.136], [2900, 0.785, 0.232], [3800, 0.877, 0.332], [4800, 1, 0.439],
      [5800, 0.946, 0.523], [6800, 0.964, 0.657], [7800, 0.828, 0.729], [8800, 0.775, 0.801]]],
  }),
}

// Each file holds the loop with PAD_SECONDS of its own wrap-around before
// and after it, so the codec's start-up and end never fall inside the loop.
// Players take the loop from PAD_SECONDS to PAD_SECONDS + loopSeconds.
export const PAD_SECONDS = 0.02

// The loop part of a decoded file (any sample rate).
export function loopSlice(data, sr, loop) {
  const a = Math.round(PAD_SECONDS * sr), n = Math.round(loopSeconds(loop) * sr)
  return data.slice(a, Math.min(data.length, a + n))
}

export function loopSeconds(loop) {
  if (loop.exact) return loop.seconds
  const cycle = 120 / loop.rpm // one 720° cycle
  return Math.max(1, Math.round(loop.seconds / cycle)) * cycle
}

// Every file a set uses: its loops, and its start and stop.
export function filesOf(set) {
  const os = set.oneshots
  return [...new Set([...set.loops.map((l) => l.file),
    ...(os ? [os.start.engine, os.start.exhaust, os.stop.engine, os.stop.exhaust] : [])])]
}

export const hasRecording = (car) => Object.hasOwn(SAMPLE_SETS, car)
// 'engine-sim', 'recorded' or 'synth': what the car picker shows.
export const soundKind = (car) => (!hasRecording(car) ? 'synth' : SAMPLE_SETS[car].kind === 'engine-sim' ? 'engine-sim' : 'recorded')

// The credits for one car, in the order its sources are listed.
export function creditsFor(car) {
  const set = SAMPLE_SETS[car]
  if (!set) return []
  return [...new Set(set.loops.map((l) => l.src))].map((id) => ({ id, ...CREDITS[id] }))
}

// "Title" by author, licence: the line shown under a recorded car.
export function creditLine(c) {
  if (c.kind === 'render') return `rendered with ${c.title} by ${c.author}, ${c.licence}`
  return `“${c.title}” by ${c.author} (Freesound), ${c.licence}`
}
