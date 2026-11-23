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
    recording: 'Rendered offline on our own machine with engine-sim, a physically modelled engine simulator, from its bundled GM LS V8 script: the engine held on its dynamometer at each rpm at full throttle (on-load) and closed throttle (overrun), plus a free-running idle. scripts/engine-sim/ rebuilds it.',
  },
  fs112075: {
    title: 'Lambo idle and rev.mp3', author: 'cheesepuff',
    url: 'https://freesound.org/people/cheesepuff/sounds/112075/',
    licence: 'CC0 1.0', licenceUrl: 'https://creativecommons.org/publicdomain/zero/1.0/',
    audio: 'https://cdn.freesound.org/previews/112/112075_682033-hq.mp3', fetched: '2026-11-23',
    recording: 'Lamborghini Murci\u00e9lago LP 670-4 SuperVeloce (V12), idling and revving at a dealer; recorded by the uploader (tags: murcielago, lp-670, superveloce, v12).',
  },
  fs457733: {
    title: 'Audi R8 Idling Reving Backfire.wav', author: 'Jonas_Jocys',
    url: 'https://freesound.org/people/Jonas_Jocys/sounds/457733/',
    licence: 'CC BY 4.0', licenceUrl: 'https://creativecommons.org/licenses/by/4.0/',
    audio: 'https://cdn.freesound.org/previews/457/457733_1900571-hq.mp3', fetched: '2026-11-23',
    recording: 'Audi R8 idling and held at several rpm, recorded by the uploader (MKH 416 above the engine, a condenser behind the car). The page does not say which engine; its harmonics do: the strongest lines are the 2.5th and 5th engine orders, the firing pattern of a V10 (a V8 fires on the 4th).',
  },
  fs669618: {
    title: 'Car Engine Contact Recording-Mini Cooper S 2019.wav', author: 'TheLittleCrow',
    url: 'https://freesound.org/people/TheLittleCrow/sounds/669618/',
    licence: 'CC0 1.0', licenceUrl: 'https://creativecommons.org/publicdomain/zero/1.0/',
    audio: 'https://cdn.freesound.org/previews/669/669618_5672786-hq.mp3', fetched: '2026-11-23',
    recording: '2019 Mini Cooper S (turbocharged inline-4) driven in sport mode, recorded by the uploader with two contact microphones on the chassis and the engine block: the raw engine, no wind or road.',
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
const es = (rpm, layer, level, render) => ({ file: `v8-es-${render}.ogg`, src: 'enginesim', render, start: 0.4, seconds: 1.5, rpm, layer, level })
export const SAMPLE_SETS = {
  // V8: rendered with engine-sim (GM LS V8), idle and 8 rpm points, each
  // on-load and overrun. The sampler crossfades the two layers by load, so
  // lifting off plays the overrun loops.
  v8: {
    kind: 'engine-sim', renders: 'ls-v8', bitrate: '64k',
    loops: [
      es(700, 'on', 0.192, 'idle'), es(700, 'off', 0.192, 'idle'),
      ...[[1200, 0.32, 0.057], [1800, 0.393, 0.09], [2500, 0.475, 0.133], [3200, 0.577, 0.152],
        [4000, 0.641, 0.181], [4800, 0.69, 0.183], [5600, 0.682, 0.223], [6300, 1.0, 0.327]]
        .flatMap(([rpm, on, off]) => [es(rpm, 'on', on, `on-${rpm}`), es(rpm, 'off', off, `off-${rpm}`)]),
    ],
  },
  // V12: a fast idle after start, and one steady rev hold. Firing order
  // lines measured from the recording: 3rd order 59.2 Hz at idle, 145.2 Hz
  // in the hold.
  // Turbo 4: idle, then steady stretches of driving under load in several
  // gears. 2nd order (the firing rate of a four) measured: 30.0 Hz at idle,
  // 99.6, 124.8, 161.4 and 184.7 Hz on the road.
  i4t: {
    loops: [
      { file: 'i4t-900.ogg', src: 'fs669618', start: 0.3, seconds: 1.3, rpm: 900 },
      { file: 'i4t-2988.ogg', src: 'fs669618', start: 10.7, seconds: 1.5, rpm: 2988 },
      { file: 'i4t-3744.ogg', src: 'fs669618', start: 55.6, seconds: 1.5, rpm: 3744 },
      { file: 'i4t-4842.ogg', src: 'fs669618', start: 48.6, seconds: 1.5, rpm: 4842 },
      { file: 'i4t-5541.ogg', src: 'fs669618', start: 42.1, seconds: 1.3, rpm: 5541 },
    ],
  },
  // V10: idle and three steady holds. The 2.5th order (each bank's firing)
  // measured: 33.6 Hz at idle, 80.4, 115.7 and 169.6 Hz in the holds.
  v10: {
    loops: [
      { file: 'v10-806.ogg', src: 'fs457733', start: 0.3, seconds: 1.6, rpm: 806 },
      { file: 'v10-1930.ogg', src: 'fs457733', start: 22.5, seconds: 1.5, rpm: 1930 },
      { file: 'v10-2777.ogg', src: 'fs457733', start: 34.3, seconds: 2.0, rpm: 2777 },
      { file: 'v10-4070.ogg', src: 'fs457733', start: 49.0, seconds: 2.0, rpm: 4070 },
    ],
  },
  v12: {
    loops: [
      { file: 'v12-1184.ogg', src: 'fs112075', start: 3.0, seconds: 2.0, rpm: 1184 },
      { file: 'v12-2904.ogg', src: 'fs112075', start: 58.75, seconds: 0.9, rpm: 2904 },
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
