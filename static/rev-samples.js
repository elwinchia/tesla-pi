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

import { PROFILES } from './rev-profiles.js'

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
    recording: 'Rendered offline on our own machine with engine-sim, a physically modelled engine simulator, from engine scripts: the engine held on its dynamometer at each rpm at full throttle (on-load) and closed throttle (overrun), plus a free-running idle; heard through engine-sim\'s own "real engine" impulse response (the engine group) and its "minimal muffling" one (the exhaust group), with a dry render of the same runs as a low sub layer; and each engine started from rest and stopped from idle, its cranking mixed with a starter motor we synthesise. For the optional extras: more rev points, held at light throttle too, and held longer for 4 s loops; the engine free-revving against engine-sim\'s own rev limiter; and upshifts under load, the ignition cut on the dyno while the revs fall to the next gear. scripts/engine-sim/ rebuilds them.',
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
//
// The recorded mix's optional extras (settings in rev-sound.js, each on its
// own so they can be heard one at a time; loopsFor picks what plays). Loops
// that need one carry `opt` (played only when every option named is on),
// and those a long version replaces carry `unless: 'longLoops'`:
//
//   denseRpm      `dense`: a rev point midway (geometrically) between each pair
//                 of the set's own, on-load and overrun, so no loop is
//                 stretched more than ~1.15x and the impulse responses'
//                 resonances slide half as far. [[rpm, on level, off level]...]
//                 per group, cut from 5 s holds (ES_SYNC, see
//                 scripts/engine-sim/README.md).
//   partThrottle  `part`: a light-throttle layer between overrun and full
//                 throttle, held where the engine makes `torque` (a share of
//                 its full-throttle torque at that rpm, measured on the dyno
//                 by `--fit-part`), at every rev point including the dense
//                 ones; `throttle` is the throttle that took, per rpm. The
//                 player maps load onto overrun / part / full (throttlePlace
//                 in rev-sampler.js); at idle it plays the set's own idle.
//   oneShots      `limiter`: the engine free-revving at full throttle against
//                 engine-sim's own ignition-cut rev limiter, set to the
//                 profile's redline and cut length, cut into a loop where the
//                 bouncing repeats (`--fit-limiter`), played at its own pitch
//                 while the model is on the limiter. `corr`: how alike its
//                 engine and exhaust renders are, played in step.
//                 `shifts`: an upshift under full load, rendered on the dyno
//                 (es-render shift): held at `from`, the ignition cut for
//                 SHIFT.cut s while the revs fall to `to` as the model's
//                 gearbox drops them, then firing again. Played when the
//                 model shifts up under load, pitched to follow its rpm.
//                 `engine`/`exhaust`: the level before the cut (the on-load
//                 level at `from`), `engineTo`/`exhaustTo` after it (at `to`).
//   longLoops     every rev-point loop (and the limiter) LONG_SECONDS long
//                 instead of 1.5 s, cut from 5 s holds, at the same level as
//                 the short one, starting where the short one starts. The
//                 idle is already 4.8-6.6 s.
// Levels for all of them come from `--print-levels`, on the same scale as
// the set's own loops (its group's loudest on-load loop).
export const LONG_SECONDS = 4
// The shift clips: the cut starts `at` s into the clip and lasts `cut` s
// (the model's 140 ms upshift); the revs fall with the model's own time
// constants (clipRpm in rev-sampler.js); the clip runs to `seconds`. It is
// cut from es-render's shift mode, whose cut comes `renderAt` s into the
// recording (ES_SHIFT_AT / ES_SHIFT_CUT).
export const SHIFT = { at: 0.1, cut: 0.14, seconds: 0.75, renderAt: 0.5 }
// A dense point: the geometric middle of two rev points, to 50 rpm.
export const midRpm = (a, b) => Math.round(Math.sqrt(a * b) / 50) * 50
// The upshifts rendered per car: from three points across the range the
// model's gearbox shifts at under load (rev-model.js MODES: 0.51-0.97 of
// the redline), each down by 0.7, about a 2nd-3rd gear step. The player
// picks the nearest and pitches it to the model's rpm.
export const SHIFT_POINTS = [0.55, 0.75, 0.92]
export const SHIFT_RATIO = 0.7
const r50 = (x) => Math.round(x / 50) * 50

// What a set's options need rendered, from its own rev points and profile
// (no levels needed): for the render tools in scripts/rev-samples.mjs.
export function extrasPlan(set) {
  const p = PROFILES[set.car], pts = set.points
  return {
    points: pts,
    dense: pts.slice(1).map((r, i) => midRpm(pts[i], r)),
    limiter: { rpm: p.redline, cut: (p.limiter || 70) / 1000 },
    shifts: SHIFT_POINTS.map((k) => { const from = r50(p.redline * k); return { from, to: r50(from * SHIFT_RATIO) } }),
  }
}

// Where each loop starts playing (SampleVoice.setSet): a set's own loops
// at the place they always started, whatever else the options add, and a
// long loop at the place its short twin starts. The engine and exhaust
// loops of one rev point are the same run heard twice, so how far apart
// they start decides how their firing lines up, which moves the level at
// the Exhaust setting's middle by 1 dB and more: this keeps it as it was.
// phaseIndex: the loop's place among the set's own loops sorted by rpm
// (the index the player has always used; the options' loops after them);
// phaseOf: the length of the loop whose start it shares, when that is not
// its own (s).
function withPhases(own, extra) {
  // The options' short loops are numbered on from the set's own, in rpm
  // order, so each starts at the same place whatever else is on.
  const long = (l) => l.file.endsWith('-long.ogg')
  const at = new Map()
  const number = (ls, from) => ls.map((l, i) => [l, i]).sort((a, b) => a[0].rpm - b[0].rpm)
    .forEach(([l], k) => { l.phaseIndex = from + k; at.set(`${l.group}/${l.layer}/${l.rpm}`, l) })
  number(own, 0)
  number(extra.filter((l) => !long(l) && !at.has(`${l.group}/${l.layer}/${l.rpm}`)), own.length)
  for (const l of extra.filter(long)) {
    const twin = at.get(`${l.group}/${l.layer}/${l.rpm}`)
    l.phaseIndex = twin.phaseIndex; l.phaseOf = loopSeconds(twin)
  }
  return [...own, ...extra]
}

// One car's set. The options' loops are made only where their levels have
// been filled in (`--print-levels`), so a half-built set still plays.
function engineSim({ car, renders, script, idle, engine, exhaust, crank, start, dense, part, limiter, shifts, idleThrottle }) {
  const tag = (g) => (g === 'exhaust' ? 'ex' : 'es')
  const loop = (group, rpm, layer, level, render) => ({
    file: `${car}-${tag(group)}-${render}.ogg`, src: 'enginesim', group, render,
    start: 0.4, seconds: 1.5, rpm, layer, level,
  })
  const idleLoop = (group, layer, level) => ({ ...loop(group, idle.rpm, layer, level, 'idle'), start: idle.start, seconds: idle.seconds[group], exact: true })
  // The set's own loops come first, in their original order, so with every
  // option off the player gets exactly what it always did.
  const group = (g, [idleLevel, points]) => [
    idleLoop(g, 'on', idleLevel), idleLoop(g, 'off', idleLevel),
    ...points.flatMap(([rpm, on, off]) => [loop(g, rpm, 'on', on, `on-${rpm}`), loop(g, rpm, 'off', off, `off-${rpm}`)].map((l) => ({ ...l, unless: 'longLoops' }))),
  ]
  // A loop for an option, short (unless longLoops) and long. The long one
  // is cut from `longRender` (the set's own points: a 5 s re-render).
  const both = (l, opt, longRender = l.render) => [
    { ...l, opt, unless: 'longLoops' },
    { ...l, file: `${car}-${tag(l.group)}-${l.render}-long.ogg`, render: longRender, seconds: l.exact ? l.long : LONG_SECONDS, opt: [...opt, 'longLoops'] },
  ]
  const extras = (g, [idleLevel, points]) => {
    const out = []
    // longLoops alone: the set's own points.
    for (const [rpm, on, off] of points) {
      out.push(both(loop(g, rpm, 'on', on, `on-${rpm}`), [], `on-${rpm}-5s`)[1], both(loop(g, rpm, 'off', off, `off-${rpm}`), [], `off-${rpm}-5s`)[1])
    }
    for (const [rpm, on, off] of dense?.[g] || []) out.push(...both(loop(g, rpm, 'on', on, `on-${rpm}`), ['denseRpm']), ...both(loop(g, rpm, 'off', off, `off-${rpm}`), ['denseRpm']))
    if (part?.[g]?.length) {
      const own = new Set(points.map(([rpm]) => rpm))
      // The idle in the part layer stands in for the set's own idle loops
      // (alias): the player hands its weight to them, so it idles as ever.
      out.push({ ...idleLoop(g, 'part', idleLevel), torque: part.torque, alias: 'idle', opt: ['partThrottle'] })
      for (const [rpm, level] of part[g]) out.push(...both({ ...loop(g, rpm, 'part', level, `part-${rpm}`), torque: part.torque }, own.has(rpm) ? ['partThrottle'] : ['partThrottle', 'denseRpm']))
    }
    if (limiter?.[g]?.level) {
      const l = limiter[g], p = PROFILES[car]
      out.push(...both({ ...loop(g, p.redline, 'limiter', l.level, 'limiter'), start: l.start, seconds: l.seconds, long: l.long, exact: true, cut: (p.limiter || 70) / 1000, corr: limiter.corr ?? 0 }, ['oneShots']))
    }
    for (const sh of shifts || []) {
      if (!sh[g]) continue
      out.push({ ...loop(g, sh.from, 'shift', sh[g], `shift-${sh.from}`), levelTo: sh[g + 'To'], from: sh.from, to: sh.to, at: SHIFT.at, cut: SHIFT.cut, corr: sh.corr ?? 0,
        start: SHIFT.renderAt - SHIFT.at, seconds: SHIFT.seconds, exact: true, opt: ['oneShots'] })
    }
    return out
  }
  return {
    // optBitrate / longBitrate: the options' short and long loops, lower than
    // the set's own (64k) to keep them in budget (~10 MB for all four cars).
    kind: 'engine-sim', bitrate: '64k', optBitrate: '40k', longBitrate: '36k', car, script, idleThrottle,
    points: engine[1].map(([rpm]) => rpm),
    renders: { engine: renders, exhaust: `${renders}-exhaust` },
    ir: IR, eq: EQ,
    sub: { renders: `${renders}-dry`, lowpass: 100, level: 0.7 },
    // partThrottle: the torque share and the throttle found for each rpm.
    part: part ? { torque: part.torque, throttle: part.throttle } : null,
    // oneShots: where each group's limiter loop is cut (`--fit-limiter`).
    limiter: limiter || null,
    loops: withPhases([...group('engine', engine), ...group('exhaust', exhaust)], [...extras('engine', engine), ...extras('exhaust', exhaust)]),
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
    part: {
      torque: 0.2,
      throttle: [[1200, 0.099], [1450, 0.122], [1800, 0.159], [2100, 0.178], [2500, 0.193], [2850, 0.206], [3200, 0.216], [3600, 0.225], [4000, 0.232], [4400, 0.243], [4800, 0.253], [5200, 0.265], [5600, 0.277], [5950, 0.286], [6300, 0.296]],
      engine: [[1200, 0.248], [1450, 0.271], [1800, 0.355], [2100, 0.479], [2500, 0.472], [2850, 0.503], [3200, 0.485], [3600, 0.466], [4000, 0.432], [4400, 0.426], [4800, 0.442], [5200, 0.457], [5600, 0.45], [5950, 0.519], [6300, 0.464]],
      exhaust: [[1200, 0.225], [1450, 0.247], [1800, 0.305], [2100, 0.393], [2500, 0.41], [2850, 0.448], [3200, 0.419], [3600, 0.385], [4000, 0.398], [4400, 0.38], [4800, 0.409], [5200, 0.444], [5600, 0.445], [5950, 0.484], [6300, 0.462]],
    },
    dense: {
      engine: [[1450, 0.643, 0.155], [2100, 0.879, 0.258], [2850, 0.964, 0.311], [3600, 0.955, 0.35], [4400, 0.963, 0.426], [5200, 1.044, 0.489], [5950, 1.1, 0.505]],
      exhaust: [[1450, 0.623, 0.137], [2100, 0.758, 0.208], [2850, 0.863, 0.273], [3600, 0.802, 0.275], [4400, 0.865, 0.295], [5200, 0.999, 0.398], [5950, 1.052, 0.431]],
    },
    limiter: {
      corr: 0.15,
      engine: { level: 0.872, start: 1.65, seconds: 1.40773, long: 3.89977 },
      exhaust: { level: 0.84, start: 1.65, seconds: 1.40773, long: 3.89977 },
    },
    shifts: [
      { from: 3600, to: 2500, engine: 0.955, exhaust: 0.802, engineTo: 0.89, exhaustTo: 0.815, corr: -0.05 },
      { from: 4900, to: 3450, engine: 1.011, exhaust: 0.936, engineTo: 0.958, exhaustTo: 0.814, corr: 0.13 },
      { from: 6000, to: 4200, engine: 1.079, exhaust: 1.044, engineTo: 0.951, exhaustTo: 0.864, corr: 0.12 },
    ],
    car: 'v8', renders: 'ls-v8', script: 'scripts/engine-sim/ls_v8.mr', idle: { rpm: 690, start: 1, seconds: { engine: 6.36871, exhaust: 6.36933 } }, crank: 205, start: { catch: 1.25, flare: 1800 },
    engine: [0.378, [[1200, 0.631, 0.15], [1800, 0.771, 0.203], [2500, 0.89, 0.268], [3200, 0.964, 0.336],
      [4000, 0.938, 0.368], [4800, 1, 0.44], [5600, 0.992, 0.426], [6300, 0.966, 0.402]]],
    exhaust: [0.364, [[1200, 0.607, 0.13], [1800, 0.7, 0.172], [2500, 0.815, 0.236], [3200, 0.837, 0.274],
      [4000, 0.862, 0.291], [4800, 0.915, 0.331], [5600, 0.991, 0.402], [6300, 1, 0.451]]],
  }),
  // LFA-style V10, bundled with engine-sim.
  lfa: engineSim({
    part: {
      torque: 0.2,
      throttle: [[1300, 0.083], [1600, 0.09], [2000, 0.107], [2350, 0.124], [2800, 0.146], [3200, 0.167], [3700, 0.196], [4150, 0.218], [4600, 0.233], [5100, 0.247], [5600, 0.261], [6150, 0.276], [6700, 0.289], [7250, 0.302], [7800, 0.316], [8300, 0.325], [8800, 0.33]],
      engine: [[1300, 0.097], [1600, 0.111], [2000, 0.129], [2350, 0.173], [2800, 0.191], [3200, 0.184], [3700, 0.232], [4150, 0.282], [4600, 0.322], [5100, 0.398], [5600, 0.489], [6150, 0.529], [6700, 0.63], [7250, 0.761], [7800, 0.721], [8300, 0.62], [8800, 0.676]],
      exhaust: [[1300, 0.111], [1600, 0.131], [2000, 0.177], [2350, 0.232], [2800, 0.319], [3200, 0.348], [3700, 0.437], [4150, 0.474], [4600, 0.567], [5100, 0.6], [5600, 0.56], [6150, 0.523], [6700, 0.622], [7250, 0.531], [7800, 0.507], [8300, 0.519], [8800, 0.477]],
    },
    dense: {
      engine: [[1600, 0.5, 0.087], [2350, 0.474, 0.092], [3200, 0.373, 0.085], [4150, 0.501, 0.126], [5100, 0.652, 0.162], [6150, 0.822, 0.216], [7250, 1.05, 0.324], [8300, 0.858, 0.296]],
      exhaust: [[1600, 0.511, 0.091], [2350, 0.732, 0.124], [3200, 0.747, 0.131], [4150, 0.874, 0.164], [5100, 0.985, 0.221], [6150, 0.925, 0.228], [7250, 0.86, 0.237], [8300, 0.855, 0.252]],
    },
    limiter: {
      corr: 0.19,
      engine: { level: 0.925, start: 1.7, seconds: 1.64423, long: 3.99515 },
      exhaust: { level: 0.977, start: 1.7, seconds: 1.64423, long: 3.99515 },
    },
    shifts: [
      { from: 4950, to: 3450, engine: 0.62, exhaust: 0.989, engineTo: 0.395, exhaustTo: 0.834, corr: -0.14 },
      { from: 6750, to: 4750, engine: 0.936, exhaust: 0.975, engineTo: 0.578, exhaustTo: 0.995, corr: -0.29 },
      { from: 8300, to: 5800, engine: 0.858, exhaust: 0.855, engineTo: 0.785, exhaustTo: 0.934, corr: 0.31 },
    ],
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
    part: {
      torque: 0.2,
      throttle: [[1300, 0.078], [1600, 0.1], [2000, 0.135], [2350, 0.165], [2800, 0.194], [3200, 0.205], [3700, 0.217], [4150, 0.228], [4600, 0.239], [5100, 0.25], [5600, 0.261], [6150, 0.274], [6700, 0.287], [7250, 0.302], [7800, 0.316], [8300, 0.329], [8800, 0.342]],
      engine: [[1300, 0.192], [1600, 0.212], [2000, 0.265], [2350, 0.332], [2800, 0.329], [3200, 0.315], [3700, 0.322], [4150, 0.292], [4600, 0.327], [5100, 0.353], [5600, 0.361], [6150, 0.373], [6700, 0.397], [7250, 0.369], [7800, 0.509], [8300, 0.61], [8800, 0.672]],
      exhaust: [[1300, 0.198], [1600, 0.208], [2000, 0.278], [2350, 0.424], [2800, 0.416], [3200, 0.441], [3700, 0.496], [4150, 0.549], [4600, 0.545], [5100, 0.555], [5600, 0.568], [6150, 0.602], [6700, 0.552], [7250, 0.538], [7800, 0.534], [8300, 0.489], [8800, 0.512]],
    },
    dense: {
      engine: [[1600, 0.511, 0.072], [2350, 0.6, 0.134], [3200, 0.538, 0.162], [4150, 0.5, 0.164], [5100, 0.601, 0.207], [6150, 0.67, 0.218], [7250, 0.628, 0.208], [8300, 0.931, 0.327]],
      exhaust: [[1600, 0.564, 0.079], [2350, 0.786, 0.151], [3200, 0.726, 0.195], [4150, 0.895, 0.305], [5100, 0.96, 0.339], [6150, 1.097, 0.381], [7250, 0.957, 0.321], [8300, 0.788, 0.289]],
    },
    limiter: {
      corr: 0.32,
      engine: { level: 1.027, start: 2.19, seconds: 1.24042, long: 3.97056 },
      exhaust: { level: 0.725, start: 2.19, seconds: 1.24042, long: 3.97056 },
    },
    shifts: [
      { from: 4950, to: 3450, engine: 0.591, exhaust: 0.948, engineTo: 0.539, exhaustTo: 0.772, corr: 0.06 },
      { from: 6750, to: 4750, engine: 0.686, exhaust: 0.98, engineTo: 0.577, exhaustTo: 0.932, corr: 0.41 },
      { from: 8300, to: 5800, engine: 0.931, exhaust: 0.788, engineTo: 0.643, exhaustTo: 1.035, corr: -0.18 },
    ],
    car: 'f136', renders: 'f136-v8', idleThrottle: 0.02, script: 'scripts/engine-sim/f136_v8.mr', idle: { rpm: 1058, start: 1, seconds: { engine: 5.69869, exhaust: 5.61335 } }, crank: 200, start: { catch: 2.15, flare: 1580 },
    engine: [0.276, [[1300, 0.461, 0.078], [2000, 0.541, 0.116], [2800, 0.59, 0.149], [3700, 0.539, 0.182], [4600, 0.567, 0.185],
      [5600, 0.628, 0.213], [6700, 0.692, 0.225], [7800, 0.822, 0.277], [8800, 1, 0.353]]],
    exhaust: [0.303, [[1300, 0.506, 0.081], [2000, 0.601, 0.108], [2800, 0.75, 0.17], [3700, 0.817, 0.241], [4600, 0.919, 0.312],
      [5600, 1, 0.354], [6700, 0.982, 0.334], [7800, 0.891, 0.325], [8800, 0.797, 0.307]]],
  }),
  // GT3-style flat-6: our own engine script (engine-sim has no flat-6).
  gt3: engineSim({
    part: {
      torque: 0.2,
      throttle: [[1400, 0.072], [1700, 0.085], [2100, 0.104], [2450, 0.121], [2900, 0.152], [3300, 0.191], [3800, 0.221], [4250, 0.24], [4800, 0.258], [5300, 0.271], [5800, 0.281], [6300, 0.29], [6800, 0.3], [7300, 0.308], [7800, 0.315], [8300, 0.322], [8800, 0.332]],
      engine: [[1400, 0.097], [1700, 0.106], [2100, 0.18], [2450, 0.222], [2900, 0.359], [3300, 0.685], [3800, 0.636], [4250, 0.719], [4800, 0.821], [5300, 0.873], [5800, 0.929], [6300, 0.878], [6800, 1], [7300, 0.803], [7800, 0.856], [8300, 0.865], [8800, 0.928]],
      exhaust: [[1400, 0.076], [1700, 0.085], [2100, 0.126], [2450, 0.171], [2900, 0.317], [3300, 0.7], [3800, 0.686], [4250, 0.942], [4800, 1], [5300, 0.915], [5800, 0.946], [6300, 1.01], [6800, 0.964], [7300, 0.961], [7800, 0.828], [8300, 0.824], [8800, 0.775]],
    },
    dense: {
      engine: [[1700, 0.792, 0.1], [2450, 0.971, 0.19], [3300, 1.006, 0.293], [4250, 0.741, 0.293], [5300, 1.009, 0.479], [6300, 0.969, 0.592], [7300, 0.803, 0.66], [8300, 0.865, 0.801]],
      exhaust: [[1700, 0.621, 0.101], [2450, 0.73, 0.185], [3300, 0.96, 0.307], [4250, 0.942, 0.373], [5300, 0.979, 0.459], [6300, 1.01, 0.619], [7300, 0.961, 0.745], [8300, 0.824, 0.767]],
    },
    limiter: {
      corr: -0.04,
      engine: { level: 0.902, start: 1.5, seconds: 1.55725, long: 4.04971 },
      exhaust: { level: 1.059, start: 1.5, seconds: 1.55725, long: 4.04971 },
    },
    shifts: [
      { from: 4950, to: 3450, engine: 0.947, exhaust: 0.993, engineTo: 0.967, exhaustTo: 0.933, corr: 0.66 },
      { from: 6750, to: 4750, engine: 0.997, exhaust: 0.968, engineTo: 0.903, exhaustTo: 0.995, corr: 0.12 },
      { from: 8300, to: 5800, engine: 0.865, exhaust: 0.824, engineTo: 0.974, exhaustTo: 0.946, corr: 0.16 },
    ],
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

// The loops a set plays with the recorded mix's options (settings in
// rev-sound.js: denseRpm, partThrottle, oneShots, longLoops). A loop plays
// when every option in its `opt` is on and none in its `unless` is (each a
// name or a list). With every option off: the set's own loops, as ever.
const names = (x) => (x == null ? [] : Array.isArray(x) ? x : [x])
export function loopsFor(set, options = {}) {
  return set.loops.filter((l) => names(l.opt).every((k) => options[k]) && !names(l.unless).some((k) => options[k]))
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
