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
//                           Short and close at the bottom, so town driving
//                           runs through the gears (1st about 70 % of a
//                           real car's), the top gear kept, so the engine
//                           is not on the limiter at a Tesla's top speed.
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
  idle: 690, redline: 6500, launch: 2400, revRise: 8000, revFall: 3800, limiter: 110,
  gears: kmh(41, 68, 102, 137, 174, 215, 258, 300),
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
  idle: 901, redline: 9000, launch: 3200, revRise: 16000, revFall: 7500, limiter: 50,
  gears: kmh(56, 91, 131, 176, 230, 300),
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
  idle: 1058, redline: 9000, launch: 3000, revRise: 14000, revFall: 6500, limiter: 50,
  gears: kmh(49, 79, 112, 149, 189, 238, 325),
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
  idle: 923, redline: 9000, launch: 3200, revRise: 14000, revFall: 6500, limiter: 60,
  gears: kmh(43, 71, 104, 140, 180, 228, 318),
  cylinders: [1, 6, 2, 4, 3, 5].map((c, i) => ({ at: i / 6, bank: c <= 3 ? 0 : 1, delayMs: c <= 3 ? 0 : 0.35 })),
  banks: [
    [[160, 3.0, 0.7], [410, 4.0, 0.6], [1100, 6.0, 0.5], [2600, 9.0, 0.34]],
    [[168, 3.0, 0.7], [430, 4.0, 0.6], [1160, 6.0, 0.5], [2720, 9.0, 0.34]],
  ],
  pulseMs: 1.1, bright: [1500, 4200], intake: [2900, 0.2], pops: 0.04, drive: 1.6, lope: 0.05,
}

// Straight six, 1-5-3-6-2-4, the front three and the rear three into their
// own pipes: smooth and even, a turbine-like howl. Its sound: engine-sim's
// 2JZ-style script (no turbo: engine-sim models none).
const i6 = {
  name: 'Inline-6', style: '2JZ-style',
  blurb: 'engine-sim\'s 2JZ straight six: smooth, even and rising to 6,500 rpm.',
  idle: 1023, redline: 6500, launch: 2800, revRise: 9000, revFall: 4500, limiter: 100,
  gears: kmh(48, 79, 115, 155, 205, 275),
  cylinders: [1, 5, 3, 6, 2, 4].map((c, i) => ({ at: i / 6, bank: c <= 3 ? 0 : 1 })),
  banks: [
    [[120, 3.0, 0.8], [330, 4.0, 0.55], [850, 5.0, 0.35], [2100, 6.0, 0.18]],
    [[126, 3.0, 0.8], [345, 4.0, 0.55], [890, 5.0, 0.35], [2200, 6.0, 0.18]],
  ],
  pulseMs: 1.6, bright: [1100, 3200], intake: [2200, 0.12], pops: 0.05, drive: 1.5, lope: 0.05,
}

// Flat four with unequal-length headers, 1-3-2-4: the pulses from the two
// banks arrive unevenly, which is the boxer's off-beat rumble. Its sound:
// engine-sim's EJ25 script, unequal headers.
const boxer = {
  name: 'Flat-4', style: 'Rally boxer',
  blurb: 'engine-sim\'s EJ25 boxer with unequal headers: the off-beat rally rumble.',
  idle: 750, redline: 6500, launch: 3000, revRise: 9000, revFall: 4500, limiter: 160,
  gears: kmh(44, 74, 108, 145, 190, 255),
  cylinders: [1, 3, 2, 4].map((c, i) => ({ at: i / 4, bank: c % 2 ? 0 : 1, delayMs: c % 2 ? 0 : 0.9 })),
  banks: [
    [[95, 2.6, 1.0], [240, 3.5, 0.6], [640, 4.5, 0.35], [1600, 5.0, 0.16]],
    [[102, 2.6, 1.0], [255, 3.5, 0.6], [680, 4.5, 0.35], [1700, 5.0, 0.16]],
  ],
  pulseMs: 2.2, bright: [800, 2600], intake: [1800, 0.12], pops: 0.08, drive: 1.7, lope: 0.1,
}

// Inline four, 1-3-4-2, a high-revving cam-switching (VTEC-style) engine:
// thin at the bottom, hard and loud at the top. Its sound: engine-sim's
// Honda VTEC script (no turbo: engine-sim models none).
const i4 = {
  name: 'Inline-4', style: 'VTEC-style',
  blurb: 'engine-sim\'s VTEC four: buzzy low down, screaming to 8,400 rpm.',
  idle: 748, redline: 8400, launch: 3500, revRise: 13000, revFall: 6500, limiter: 50,
  gears: kmh(46, 76, 108, 142, 182, 240),
  cylinders: [1, 3, 4, 2].map((c, i) => ({ at: i / 4, bank: 0 })),
  banks: [
    [[140, 3.0, 0.8], [380, 4.0, 0.6], [1000, 5.0, 0.42], [2600, 6.0, 0.22]],
    [[140, 3.0, 0.8], [380, 4.0, 0.6], [1000, 5.0, 0.42], [2600, 6.0, 0.22]],
  ],
  pulseMs: 1.3, bright: [1400, 4000], intake: [2800, 0.18], pops: 0.04, drive: 1.6, lope: 0,
}

// 65-degree V12, firing every 60 degrees, the banks alternating: the
// smoothest and highest note here. Its sound: our engine-sim V12, the
// bundled 412 T2 script with a road car's idle (scripts/engine-sim/v12_412.mr).
const v12 = {
  name: 'V12', style: 'Race V12',
  blurb: 'engine-sim\'s 412 T2 V12, tamed to a road car\'s 9,000 rpm: a shrill, seamless wail.',
  idle: 1406, redline: 9000, launch: 3500, revRise: 15000, revFall: 7000, limiter: 60,
  gears: kmh(52, 86, 124, 166, 214, 270, 330),
  cylinders: [1, 12, 5, 8, 3, 10, 6, 7, 2, 11, 4, 9].map((c, i) => ({ at: i / 12, bank: c <= 6 ? 0 : 1 })),
  banks: [
    [[240, 3.0, 0.7], [560, 4.0, 0.6], [1400, 5.0, 0.45], [3100, 6.0, 0.25]],
    [[252, 3.0, 0.7], [585, 4.0, 0.6], [1460, 5.0, 0.45], [3200, 6.0, 0.25]],
  ],
  pulseMs: 0.9, bright: [2000, 4600], intake: [3200, 0.14], pops: 0.03, drive: 1.3, lope: 0.1,
}

// A 1995 Formula 1 V12, 3.0 L, revving to 17,000: the same 65-degree V12 as
// v12 above, unmodified, with its own race idle (~3,800 rpm) and seven
// close gears. Its sound: engine-sim's bundled 412 T2 script as it is.
const f1 = {
  name: 'F1', style: '1995 V12 F1-style',
  blurb: 'engine-sim\'s 412 T2 F1 V12 as built: a race idle and a scream to 17,000 rpm.',
  idle: 3770, redline: 17000, launch: 9000, revRise: 30000, revFall: 14000, limiter: 40,
  gears: kmh(85, 118, 152, 186, 222, 260, 300),
  cylinders: [1, 12, 5, 8, 3, 10, 6, 7, 2, 11, 4, 9].map((c, i) => ({ at: i / 12, bank: c <= 6 ? 0 : 1 })),
  banks: [
    [[420, 3.0, 0.7], [980, 4.0, 0.6], [2300, 5.0, 0.45], [4800, 6.0, 0.25]],
    [[440, 3.0, 0.7], [1020, 4.0, 0.6], [2400, 5.0, 0.45], [5000, 6.0, 0.25]],
  ],
  pulseMs: 0.5, bright: [3000, 6000], intake: [4200, 0.16], pops: 0.02, drive: 1.3, lope: 0.05,
}

// A single-spool turbojet (a 1950s-60s fighter's, about): no gears, the
// spool's speed is the rpm, from a 67 % idle to 100 %. Its sound: our own
// turbine render (scripts/rev-jet.mjs), engine-sim being pistons only.
//   turbine   Gearbox.spool and FreeRev: no gears, the spool chases a demand
//             over spoolUp / spoolDown s; cruise: the demand needed to hold
//             ~120 km/h (more with speed, as drag)
//   governor  held at the top instead of a limiter's bounce
// The cylinders and banks only feed the fallback synthesiser: 48 evenly
// spaced "firings" a cycle make a thin whine at the blade-pass pitch.
const jet = {
  name: 'Jet', style: 'Turbojet',
  blurb: 'Our own turbojet: compressor whine and exhaust roar, spooling with the pedal, no gears.',
  idle: 5000, redline: 7500, launch: 6000, revRise: 1400, revFall: 900, limiter: 50,
  turbine: true, governor: true, spoolUp: 1.4, spoolDown: 2.0, cruise: 0.35,
  gears: kmh(330),
  cylinders: Array.from({ length: 48 }, (_, i) => ({ at: i / 48, bank: i % 2 })),
  banks: [
    [[180, 2.0, 0.6], [900, 3.0, 0.5], [2100, 6.0, 0.6], [4200, 8.0, 0.3]],
    [[190, 2.0, 0.6], [950, 3.0, 0.5], [2200, 6.0, 0.6], [4400, 8.0, 0.3]],
  ],
  pulseMs: 0.2, bright: [2500, 5000], intake: [3000, 0.4], pops: 0, drive: 1.1, lope: 0,
}

// Each idle is the rpm its engine-sim idle actually runs at (--fit-idle in
// scripts/rev-samples.mjs), so the idle loop plays at its own pitch.

// The cars, in the picker's order. Each one's sound is engine-sim loops
// (static/rev-samples.js); these numbers drive its gearbox and rev range,
// and synthesise it only if the loops cannot be loaded.
export const PROFILES = { v8, lfa, f136, gt3, i6, boxer, i4, v12, f1, jet }
export const DEFAULT_PROFILE = 'v8'
