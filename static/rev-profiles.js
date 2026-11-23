// Engine profiles for the engine sound. Every one is synthesised from these
// numbers in static/rev-worklet.js; there are no recordings. The numbers are
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
//   lope                    how unevenly it idles (a big cam, a rotary):
//                           random firing strength that fades as revs rise
//   turbo                   optional { whistle: [Hz at no boost, Hz at full],
//                           level, spool (s), bov }: a whistle that rises
//                           with boost, and a blow-off "pssh" on lift-off

const kmh = (...xs) => xs.map((x) => x / 3.6)

// Cross-plane V8, firing order 1-8-4-3-6-5-7-2 with odd cylinders on the left
// bank: each bank fires L R R L R L L R, unevenly, which is the burble. A
// big cam makes it lope at idle.
const v8 = {
  name: 'V8', style: 'American muscle',
  blurb: 'Cross-plane burble, lumpy idle, lazy limiter.',
  idle: 650, redline: 6500, launch: 2400, revRise: 8000, revFall: 3800, limiter: 110,
  gears: kmh(58, 92, 130, 165, 200, 235, 270, 300),
  cylinders: [1, 8, 4, 3, 6, 5, 7, 2].map((c, i) => ({ at: i / 8, bank: c % 2 ? 0 : 1 })),
  banks: [
    [[82, 2.4, 1.0], [168, 3.0, 0.55], [400, 4.0, 0.32], [1050, 5.0, 0.14]],
    [[90, 2.4, 1.0], [182, 3.0, 0.55], [430, 4.0, 0.32], [1120, 5.0, 0.14]],
  ],
  pulseMs: 2.4, bright: [650, 2500], intake: [1700, 0.10], pops: 0.07, drive: 1.7, lope: 0.45,
}

// 60° V12, 1-7-5-11-3-9-6-12-2-8-4-10, cylinders 1-6 on one bank: the banks
// alternate and twelve even firings per cycle make a smooth, high shriek.
const v12 = {
  name: 'V12', style: 'Italian GT',
  blurb: 'Twelve even pulses: smooth at idle, a shriek at the top.',
  idle: 950, redline: 8700, launch: 3000, revRise: 13000, revFall: 6000, limiter: 60,
  gears: kmh(65, 102, 140, 178, 215, 255, 320),
  cylinders: [1, 7, 5, 11, 3, 9, 6, 12, 2, 8, 4, 10].map((c, i) => ({ at: i / 12, bank: c <= 6 ? 0 : 1 })),
  banks: [
    [[260, 3.0, 0.6], [620, 4.0, 0.62], [1500, 5.0, 0.5], [3300, 6.0, 0.28]],
    [[272, 3.0, 0.6], [650, 4.0, 0.62], [1560, 5.0, 0.5], [3420, 6.0, 0.28]],
  ],
  pulseMs: 0.8, bright: [2000, 4600], intake: [3200, 0.13], pops: 0.03, drive: 1.3, lope: 0,
}

// Flat six, 1-6-2-4-3-5, cylinders 1-3 on one side: the banks alternate
// evenly like an inline six, but the pipes are short and hard, so it rasps,
// and the intake howls at the top of a 9,000 rpm range.
const flat6 = {
  name: 'Flat-6', style: '911-style',
  blurb: 'Metallic rasp and intake howl, revs to 9,000.',
  idle: 850, redline: 9000, launch: 3200, revRise: 14000, revFall: 6500, limiter: 45,
  gears: kmh(62, 95, 130, 165, 200, 240, 300),
  cylinders: [1, 6, 2, 4, 3, 5].map((c, i) => ({ at: i / 6, bank: c <= 3 ? 0 : 1, delayMs: c <= 3 ? 0 : 0.35 })),
  banks: [
    [[160, 3.0, 0.7], [410, 4.0, 0.6], [1100, 6.0, 0.5], [2600, 9.0, 0.34]],
    [[168, 3.0, 0.7], [430, 4.0, 0.6], [1160, 6.0, 0.5], [2720, 9.0, 0.34]],
  ],
  pulseMs: 1.1, bright: [1500, 4200], intake: [2900, 0.2], pops: 0.04, drive: 1.6, lope: 0.05,
}

// Inline six, 1-5-3-6-2-4, split front three / rear three into two pipes so
// the banks alternate evenly: smooth and rising, with a twin-turbo whistle.
const i6 = {
  name: 'Inline-6', style: 'Japanese twin-turbo',
  blurb: 'Silky and rising, turbo whistle and a blow-off on lift.',
  idle: 700, redline: 7200, launch: 2600, revRise: 10000, revFall: 4800, limiter: 80,
  gears: kmh(55, 88, 125, 160, 195, 230),
  cylinders: [1, 5, 3, 6, 2, 4].map((c, i) => ({ at: i / 6, bank: c <= 3 ? 0 : 1 })),
  banks: [
    [[135, 3.0, 0.85], [300, 4.0, 0.6], [700, 5.0, 0.36], [1850, 6.0, 0.16]],
    [[142, 3.0, 0.85], [315, 4.0, 0.6], [735, 5.0, 0.36], [1950, 6.0, 0.16]],
  ],
  pulseMs: 1.5, bright: [1100, 3200], intake: [2400, 0.12], pops: 0.03, drive: 1.3, lope: 0.03,
  turbo: { whistle: [2400, 6800], level: 0.035, spool: 0.6, bov: 0.12 },
}

// Two-rotor rotary. Each rotor fires once per turn of the eccentric shaft,
// so four firings per 720°, through one pipe. Short, sharp pulses and a lot
// of drive make it buzz; a peripheral-port-style lope makes it "brap" at idle.
const rotary = {
  name: 'Rotary', style: 'twin-rotor',
  blurb: 'Buzzing, brapping idle, pops and crackles off throttle.',
  idle: 900, redline: 9000, launch: 3500, revRise: 16000, revFall: 7000, limiter: 50,
  gears: kmh(60, 95, 135, 175, 215, 250),
  cylinders: [0, 1, 0, 1].map((r, i) => ({ at: i / 4, bank: 0, delayMs: r ? 0.15 : 0 })),
  banks: [
    [[118, 2.0, 0.8], [340, 3.0, 0.62], [920, 3.0, 0.46], [2500, 4.0, 0.3]],
  ],
  pulseMs: 1.3, bright: [1500, 4000], intake: [2600, 0.16], pops: 0.14, drive: 2.1, lope: 0.6,
}

// Turbo inline four, 1-3-4-2 into one pipe: a flat, raspy note that the
// turbo fills in with whistle, and a sharp blow-off on every lift.
const i4t = {
  name: 'Turbo 4', style: 'hot hatch',
  blurb: 'Raspy four, loud turbo whistle and blow-off valve.',
  idle: 850, redline: 6800, launch: 3000, revRise: 11000, revFall: 5500, limiter: 90,
  gears: kmh(52, 88, 125, 160, 195, 230),
  cylinders: [1, 3, 4, 2].map((c, i) => ({ at: i / 4, bank: 0 })),
  banks: [
    [[150, 2.6, 0.8], [380, 3.5, 0.6], [980, 4.5, 0.4], [2300, 6.0, 0.22]],
  ],
  pulseMs: 1.7, bright: [900, 3000], intake: [2200, 0.12], pops: 0.05, drive: 1.5, lope: 0.05,
  turbo: { whistle: [2800, 8200], level: 0.055, spool: 0.45, bov: 0.22 },
}

// Even-fire V10 at 72°, 1-6-5-10-2-7-3-8-4-9, banks alternating: high and
// thin, made to be revved.
const v10 = {
  name: 'V10', style: 'supercar',
  blurb: 'High and thin, hard-edged at 8,500 rpm.',
  idle: 1000, redline: 8500, launch: 3200, revRise: 15000, revFall: 7000, limiter: 50,
  gears: kmh(62, 98, 135, 170, 205, 245, 290),
  cylinders: [1, 6, 5, 10, 2, 7, 3, 8, 4, 9].map((c, i) => ({ at: i / 10, bank: c <= 5 ? 0 : 1 })),
  banks: [
    [[210, 3.0, 0.7], [500, 4.0, 0.62], [1250, 5.0, 0.45], [2800, 6.0, 0.24]],
    [[222, 3.0, 0.7], [520, 4.0, 0.62], [1310, 5.0, 0.45], [2900, 6.0, 0.24]],
  ],
  pulseMs: 1.0, bright: [1800, 4200], intake: [3000, 0.14], pops: 0.04, drive: 1.4, lope: 0,
}

// Flat four with unequal-length headers: pulses from one side arrive late,
// so the four even firings reach the pipe as uneven pairs. Turbocharged,
// like a rally car.
const flat4 = {
  name: 'Flat-4', style: 'rally boxer',
  blurb: 'Unequal-length rumble, turbo and crackle.',
  idle: 800, redline: 7000, launch: 3000, revRise: 11000, revFall: 5200, limiter: 70,
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
  pulseMs: 2.5, bright: [650, 2200], intake: [1600, 0.10], pops: 0.06, drive: 1.8, lope: 0.15,
  turbo: { whistle: [1900, 5600], level: 0.03, spool: 0.7, bov: 0.15 },
}

// The car picker shows them in this order.
export const PROFILES = { v8, v12, flat6, i6, rotary, i4t, v10, flat4 }
export const DEFAULT_PROFILE = 'v8'
