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

// One car: the V8. Its sound is engine-sim loops (static/rev-samples.js);
// these numbers drive its gearbox and rev range, and synthesise it only if
// the loops cannot be loaded. The other seven engines were removed.
export const PROFILES = { v8 }
export const DEFAULT_PROFILE = 'v8'
