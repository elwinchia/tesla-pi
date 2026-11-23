// Engine profiles for the engine sound. Every one is synthesised from these
// numbers in static/rev-worklet.js; there are no recordings. The numbers are
// our own, chosen by ear to suggest a type of engine, not measured from or
// modelled on any particular car.
//
// Fields:
//   idle, redline, launch   rpm
//   revRise, revFall        rpm per second when revving parked (FreeRev)
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

const kmh = (...xs) => xs.map((x) => x / 3.6)

// Cross-plane V8, firing order 1-8-4-3-6-5-7-2 with odd cylinders on the left
// bank: each bank fires L R R L R L L R, unevenly, which is the burble.
const v8 = {
  name: 'V8',
  idle: 720, redline: 6800, launch: 2400, revRise: 9000, revFall: 4200,
  gears: kmh(58, 92, 130, 165, 200, 235, 270, 300),
  cylinders: [1, 8, 4, 3, 6, 5, 7, 2].map((c, i) => ({ at: i / 8, bank: c % 2 ? 0 : 1 })),
  banks: [
    [[88, 2.4, 1.0], [176, 3.0, 0.55], [410, 4.0, 0.32], [1100, 5.0, 0.14]],
    [[96, 2.4, 1.0], [190, 3.0, 0.55], [440, 4.0, 0.32], [1180, 5.0, 0.14]],
  ],
  pulseMs: 2.2, bright: [700, 2600], intake: [1800, 0.10], pops: 0.05, drive: 1.6,
}

// Inline six, 1-5-3-6-2-4, split front three / rear three into two pipes so
// the banks alternate evenly: smooth and rising.
const i6 = {
  name: 'Inline-6',
  idle: 680, redline: 7200, launch: 2600, revRise: 10000, revFall: 4800,
  gears: kmh(55, 88, 125, 160, 195, 230, 262, 290),
  cylinders: [1, 5, 3, 6, 2, 4].map((c, i) => ({ at: i / 6, bank: c <= 3 ? 0 : 1 })),
  banks: [
    [[135, 3.0, 0.85], [300, 4.0, 0.6], [700, 5.0, 0.36], [1850, 6.0, 0.16]],
    [[142, 3.0, 0.85], [315, 4.0, 0.6], [735, 5.0, 0.36], [1950, 6.0, 0.16]],
  ],
  pulseMs: 1.5, bright: [1100, 3200], intake: [2400, 0.12], pops: 0.03, drive: 1.3,
}

// Even-fire V10 at 72°, 1-6-5-10-2-7-3-8-4-9, banks alternating: high and
// thin, made to be revved.
const v10 = {
  name: 'V10',
  idle: 1000, redline: 8500, launch: 3200, revRise: 15000, revFall: 7000,
  gears: kmh(62, 98, 135, 170, 205, 245, 290),
  cylinders: [1, 6, 5, 10, 2, 7, 3, 8, 4, 9].map((c, i) => ({ at: i / 10, bank: c <= 5 ? 0 : 1 })),
  banks: [
    [[210, 3.0, 0.7], [500, 4.0, 0.62], [1250, 5.0, 0.45], [2800, 6.0, 0.24]],
    [[222, 3.0, 0.7], [520, 4.0, 0.62], [1310, 5.0, 0.45], [2900, 6.0, 0.24]],
  ],
  pulseMs: 1.0, bright: [1800, 4200], intake: [3000, 0.14], pops: 0.04, drive: 1.4,
}

// Flat four with unequal-length headers: pulses from one side arrive late,
// so the four even firings reach the pipe as uneven pairs.
const flat4 = {
  name: 'Flat-4',
  idle: 800, redline: 7000, launch: 3000, revRise: 11000, revFall: 5200,
  gears: kmh(50, 85, 120, 155, 190, 230),
  cylinders: [
    { at: 0.00, bank: 0, delayMs: 0.0 },
    { at: 0.25, bank: 0, delayMs: 2.6 },
    { at: 0.50, bank: 0, delayMs: 0.4 },
    { at: 0.75, bank: 0, delayMs: 3.1 },
  ],
  banks: [
    [[72, 2.0, 1.0], [155, 3.0, 0.6], [370, 4.0, 0.3], [880, 4.0, 0.14]],
  ],
  pulseMs: 2.5, bright: [650, 2200], intake: [1600, 0.10], pops: 0.06, drive: 1.8,
}

export const PROFILES = { v8, i6, v10, flat4 }
export const DEFAULT_PROFILE = 'v8'
