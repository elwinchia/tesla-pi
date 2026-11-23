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
    commit: '85f7c3b', engineScript: 'assets/engines/atg-video-2/07_gm_ls.mr',
    recording: 'Rendered offline on our own machine with engine-sim, a physically modelled engine simulator, from its bundled GM LS V8 script: the engine held on its dynamometer at each rpm at full throttle (on-load) and closed throttle (overrun), plus a free-running idle; heard through engine-sim\'s own "real engine" impulse response (the engine group) and its "minimal muffling" one (the exhaust group), with a dry render of the same runs as a low sub layer. scripts/engine-sim/ rebuilds it.',
  },
}

// Per car (keys of PROFILES in rev-profiles.js): the loops, each cut from
// `src` at `start` seconds, `seconds` long, recorded at `rpm`. `layer` is
// 'on' (under load), 'off' (lifting) or 'any'. `seconds` is rounded to whole
// engine cycles (loopSeconds), so the loop's seam falls between firings.
// For an engine-sim set, `render` names the rendered WAV each loop is cut
// from (scripts/engine-sim/render-set.sh), and `level` is its loudness
// relative to the loudest on-load loop, square-rooted so overrun and idle
// stay audible; the idle loop plays in both layers.
const es = (group, rpm, layer, level, render) => ({
  file: `v8-${group === 'exhaust' ? 'ex' : 'es'}-${render}.ogg`, src: 'enginesim', group, render,
  start: 0.4, seconds: 1.5, rpm, layer, level,
})
const v8Group = (group, idle, points) => [
  es(group, 700, 'on', idle, 'idle'), es(group, 700, 'off', idle, 'idle'),
  ...points.flatMap(([rpm, on, off]) => [es(group, rpm, 'on', on, `on-${rpm}`), es(group, rpm, 'off', off, `off-${rpm}`)]),
]
export const SAMPLE_SETS = {
  // V8: rendered with engine-sim (GM LS V8), idle and 8 rpm points, each
  // on-load and overrun. The sampler crossfades the two layers by load, so
  // lifting off plays the overrun loops.
  //
  // Two groups of the same runs, heard from two places: `engine` and
  // `exhaust`. The Exhaust setting crossfades between them.
  v8: {
    kind: 'engine-sim', bitrate: '64k',
    renders: { engine: 'ls-v8', exhaust: 'ls-v8-exhaust' },
    // engine: engine-sim's "real engine" impulse response (ES_IR, see
    // scripts/engine-sim/README.md) rather than the script's smooth_39,
    // which is centred on 320-640 Hz and left the V8 thin. exhaust: its
    // "minimal muffling" response, a near straight pipe: raspier, with the
    // weight at 160-320 Hz.
    ir: {
      engine: 'es/sound-library/archive/test_engine_14_eq_adjusted_16.wav',
      exhaust: 'es/sound-library/new/minimal_muffling_01.wav',
    },
    // For both: the bottom octave lifted and the top softened...
    eq: [{ type: 'lowshelf', hz: 90, db: 10 }, { type: 'highshelf', hz: 3500, db: -4 }],
    // ...and the same simulation rendered dry (ES_CONV=0), low-passed at
    // 100 Hz and mixed under it: the impulse responses strip the lowest
    // octave, where the V8's idle firing note (about 47 Hz) lives.
    sub: { renders: 'ls-v8-dry', lowpass: 100, level: 0.7 },
    // Levels from `node scripts/rev-samples.mjs --print-levels v8`.
    loops: [
      ...v8Group('engine', 0.322, [[1200, 0.537, 0.12], [1800, 0.676, 0.184], [2500, 0.983, 0.297], [3200, 0.825, 0.275],
        [4000, 0.857, 0.361], [4800, 0.907, 0.39], [5600, 1, 0.47], [6300, 0.838, 0.328]]),
      ...v8Group('exhaust', 0.318, [[1200, 0.53, 0.109], [1800, 0.663, 0.153], [2500, 0.815, 0.255], [3200, 0.836, 0.28],
        [4000, 0.719, 0.241], [4800, 0.889, 0.305], [5600, 1, 0.412], [6300, 0.913, 0.43]]),
    ],
  },
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
  const cycle = 120 / loop.rpm // one 720° cycle
  return Math.max(1, Math.round(loop.seconds / cycle)) * cycle
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
