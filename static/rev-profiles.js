// Engine profiles for the engine sound. The synthesiser in
// static/rev-worklet.js can make each one from these numbers. The numbers are
// our own, chosen by ear to suggest a type of engine, not measured from or
// modelled on any particular car. Names describe a style of engine, never a
// brand.
//
// Fields:
//   name, style, blurb      what the car picker shows
//   idle, redline, launch   rpm
//   revRise, revFall        rpm per second when revving parked (FreeRev)
//   limiter                 ms the rev limiter cuts the engine for each time
//                           it touches the redline: short is a race engine's
//                           hard "brrrap", long is a road car's lazy bounce
//   gears                   road speed (m/s) each gear reaches at redline
//   cylinders               [{ at, bank, delayMs? }]: firing point as a
//                           fraction of the 720° cycle, which exhaust bank
//                           it feeds, and extra header delay (unequal-length
//                           headers are what make a boxer rumble)
//   banks                   per bank: resonances [Hz, Q, gain] of the pipes
//   pulseMs                 width of one exhaust pulse
//   bright                  [base, perLoad] cut-off (Hz) of the tone filter
//   intake                  [centre Hz, level] of the induction noise
//   pops                    chance per firing of an overrun pop on lift-off
//   drive                   how hard the output saturates under load
//   lope                    how unevenly it idles (a big cam): random firing
//                           strength that fades as revs rise

const kmh = (...xs) => xs.map((x) => x / 3.6)

// Cross-plane V8, firing order 1-8-4-3-6-5-7-2 with odd cylinders on the left
// bank: each bank fires L R R L R L L R, unevenly, which is the burble. A
// big cam makes it lope at idle.
const v8 = {
  name: 'V8', style: 'American muscle',
  blurb: 'Cross-plane LS-style V8 from engine-sim: burble, pull and overrun.',
  idle: 650, redline: 6500, launch: 2400, revRise: 8000, revFall: 3800, limiter: 110,
  gears: kmh(58, 92, 130, 165, 200, 235, 270, 300),
  cylinders: [1, 8, 4, 3, 6, 5, 7, 2].map((c, i) => ({ at: i / 8, bank: c % 2 ? 0 : 1 })),
  banks: [
    [[82, 2.4, 1.0], [168, 3.0, 0.55], [400, 4.0, 0.32], [1050, 5.0, 0.14]],
    [[90, 2.4, 1.0], [182, 3.0, 0.55], [430, 4.0, 0.32], [1120, 5.0, 0.14]],
  ],
  pulseMs: 2.4, bright: [650, 2500], intake: [1700, 0.10], pops: 0.07, drive: 1.7, lope: 0.45,
}

// Even-fire V10 at 72 degrees, 1-6-5-10-2-7-3-8-4-9, banks alternating.
// Its sound: engine-sim's LFA-style V10 script.
const lfa = {
  name: 'V10', style: 'LFA-style',
  blurb: 'engine-sim\'s LFA V10: a high, clean howl to 9,000 rpm.',
  idle: 890, redline: 9000, launch: 3200, revRise: 16000, revFall: 7500, limiter: 50,
  gears: kmh(80, 120, 160, 200, 245, 300),
  cylinders: [1, 6, 5, 10, 2, 7, 3, 8, 4, 9].map((c, i) => ({ at: i / 10, bank: c <= 5 ? 0 : 1 })),
  banks: [
    [[210, 3.0, 0.7], [500, 4.0, 0.62], [1250, 5.0, 0.45], [2800, 6.0, 0.24]],
    [[222, 3.0, 0.7], [520, 4.0, 0.62], [1310, 5.0, 0.45], [2900, 6.0, 0.24]],
  ],
  pulseMs: 1.0, bright: [1800, 4200], intake: [3000, 0.14], pops: 0.04, drive: 1.4, lope: 0,
}

// Flat-plane V8, 1-5-3-7-4-8-2-6, the banks alternating evenly: a harder,
// higher note than the cross-plane burble. Its sound: engine-sim's Ferrari
// F136-style script.
const f136 = {
  name: 'V8', style: 'Ferrari-style flat-plane',
  blurb: 'engine-sim\'s F136 flat-plane V8: a hard-edged scream to 9,000 rpm.',
  idle: 1060, redline: 9000, launch: 3000, revRise: 14000, revFall: 6500, limiter: 50,
  gears: kmh(70, 105, 140, 175, 210, 250, 325),
  cylinders: [1, 5, 3, 7, 4, 8, 2, 6].map((c, i) => ({ at: i / 8, bank: c <= 4 ? 0 : 1 })),
  banks: [
    [[150, 3.0, 0.8], [360, 4.0, 0.6], [900, 5.0, 0.4], [2200, 6.0, 0.2]],
    [[158, 3.0, 0.8], [375, 4.0, 0.6], [940, 5.0, 0.4], [2300, 6.0, 0.2]],
  ],
  pulseMs: 1.4, bright: [1300, 3600], intake: [2600, 0.12], pops: 0.05, drive: 1.5, lope: 0,
}

// Flat six, 1-6-2-4-3-5, cylinders 1-3 on one side: the banks alternate
// evenly. Its sound: our own GT3-style engine-sim script
// (scripts/engine-sim/flat6_gt3.mr).
const gt3 = {
  name: 'Flat-6', style: 'GT3-style',
  blurb: 'A GT3-style flat-6 we wrote for engine-sim: rasp and howl to 9,000 rpm.',
  idle: 930, redline: 9000, launch: 3200, revRise: 14000, revFall: 6500, limiter: 60,
  gears: kmh(62, 95, 130, 165, 200, 240, 318),
  cylinders: [1, 6, 2, 4, 3, 5].map((c, i) => ({ at: i / 6, bank: c <= 3 ? 0 : 1, delayMs: c <= 3 ? 0 : 0.35 })),
  banks: [
    [[160, 3.0, 0.7], [410, 4.0, 0.6], [1100, 6.0, 0.5], [2600, 9.0, 0.34]],
    [[168, 3.0, 0.7], [430, 4.0, 0.6], [1160, 6.0, 0.5], [2720, 9.0, 0.34]],
  ],
  pulseMs: 1.1, bright: [1500, 4200], intake: [2900, 0.2], pops: 0.04, drive: 1.6, lope: 0.05,
}

// The cars, in the picker's order. Each one's sound is engine-sim loops
// (static/rev-samples.js); these numbers drive its gearbox and rev range,
// and synthesise it only if the loops cannot be loaded.
export const PROFILES = { v8, lfa, f136, gt3 }
export const DEFAULT_PROFILE = 'v8'
