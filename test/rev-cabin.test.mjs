// The cabin (static/rev-cabin.js): the engine heard through the car's body.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { Cabin, CABIN, cabinDb, shelfDb, openness, cabinSettings, revShare } from '../static/rev-cabin.js'

const SR = 48000

// A sine through a cabin at `load` and `rev` (0..1 of idle to redline),
// its level in dB after the filters settle.
function throughDb(hz, load, on = true, rev = 0) {
  const c = new Cabin(SR)
  c.set({ load, cabin: on, idle: 1000, redline: 7000, rpm: 1000 + rev * 6000 })
  c.load = load; c.rev = rev; c.shelf(); c.mix = on ? 1 : 0
  const n = 128, L = new Float32Array(n)
  let ph = 0, ss = 0, si = 0
  for (let b = 0; b < (0.5 * SR) / n; b++) {
    const x = new Float32Array(n)
    for (let i = 0; i < n; i++) { x[i] = 0.2 * Math.sin(ph); ph += (2 * Math.PI * hz) / SR }
    L.set(x)
    c.process([L], n)
    if (b * n > 0.25 * SR) for (let i = 0; i < n; i++) { ss += L[i] * L[i]; si += x[i] * x[i] }
  }
  return 10 * Math.log10(ss / si)
}

test('low in the revs the firing note comes through; the rasp and hiss do not', () => {
  // The firing note, with the boom's small lift at idle.
  for (const f of [160, 250]) assert.ok(Math.abs(cabinDb(f)) < 2, `${f} Hz within 2 dB`)
  assert.ok(cabinDb(1000) < -6, '1 kHz down')
  assert.ok(cabinDb(4000) < -14, '4 kHz well down')
  assert.ok(cabinDb(8000) < -24, '8 kHz all but gone')
  // Above the boom it only takes away: no band over the make-up gain.
  for (let f = 300; f < 20000; f *= 1.05) {
    for (const load of [-1, 0, 1]) for (const rev of [0, 0.5, 1]) {
      assert.ok(cabinDb(f, load, rev) <= 20 * Math.log10(CABIN.makeup) + 0.3, `${f.toFixed(0)} Hz at load ${load}, rev ${rev}`)
    }
  }
})

test('under load the body booms: the low end grows with the throttle', () => {
  const idle = cabinDb(50, 0), full = cabinDb(50, 1)
  assert.ok(idle > 2 && idle < 5, `idle lift ${idle.toFixed(1)} dB`)
  assert.ok(full - idle > 4, `full load ${full.toFixed(1)} dB`)
  assert.equal(cabinSettings(-1).boomDb, cabinSettings(0).boomDb, 'overrun booms no more than idle')
  // The boom stays below the firing note of a cruise.
  assert.ok(cabinDb(400, 1) - cabinDb(400, 0) < 6)
})

test('high in the revs the top opens up: the scream comes through', () => {
  assert.equal(openness(0, 1), 0)
  assert.equal(openness(CABIN.open.from, 1), 0)
  assert.equal(openness(1, 1), 1)
  assert.equal(openness(1, -1), CABIN.open.overrun)
  for (let r = 0; r < 1; r += 0.05) assert.ok(openness(r + 0.05, 1) >= openness(r, 1))
  // At the redline under load, 2 and 4 kHz are nearly whole; at low revs not.
  assert.ok(cabinDb(2000, 1, 1) > -3 && cabinDb(4000, 1, 1) > -4, `${cabinDb(2000, 1, 1).toFixed(1)}, ${cabinDb(4000, 1, 1).toFixed(1)} dB`)
  assert.ok(cabinDb(4000, 1, 1) > cabinDb(4000, 1, 0) + 8)
  // On overrun at the redline, part of the way.
  const over = cabinDb(4000, -1, 1)
  assert.ok(over > cabinDb(4000, -1, 0) + 3 && over < cabinDb(4000, 1, 1) - 3)
  assert.equal(revShare(500, 800, 6800), 0)
  assert.equal(revShare(3800, 800, 6800), 0.5)
  assert.equal(revShare(9000, 800, 6800), 1)
})

test('pulling opens the top up; overrun is as closed as idle', () => {
  assert.ok(cabinDb(2000, 1) > cabinDb(2000, 0) + 4)
  assert.equal(shelfDb(-1), shelfDb(0))
  assert.equal(shelfDb(1), CABIN.shelf.dbFull)
})

test('the filters do what the response says', () => {
  for (const [hz, load, rev] of [[100, 0, 0], [1000, 0, 0], [4000, 0, 0], [2000, 1, 0], [50, 1, 0], [4000, 1, 1], [4000, -1, 0.8]]) {
    const got = throughDb(hz, load, true, rev), want = cabinDb(hz, load, rev)
    assert.ok(Math.abs(got - want) < 0.3, `${hz} Hz at load ${load}, rev ${rev}: ${got.toFixed(2)} vs ${want.toFixed(2)} dB`)
  }
})

test('outside leaves the sound untouched, and switching over does not jump', () => {
  assert.ok(Math.abs(throughDb(4000, 0, false)) < 0.01)
  // A held level through a switch: no sample moves further than the input's
  // own step plus a little.
  const c = new Cabin(SR), n = 128, L = new Float32Array(n)
  let prev = null, worst = 0, ph = 0
  for (let b = 0; b < 400; b++) {
    if (b === 200) c.set({ cabin: false })
    for (let i = 0; i < n; i++) { L[i] = 0.5 * Math.sin(ph); ph += (2 * Math.PI * 120) / SR }
    c.process([L], n)
    for (let i = 0; i < n; i++) { if (prev != null) worst = Math.max(worst, Math.abs(L[i] - prev)); prev = L[i] }
  }
  assert.ok(worst < 0.02, `largest step ${worst.toFixed(4)}`)
})

test('a rev sweep through the cabin does not click', () => {
  // A held 120 Hz tone while the revs and the load sweep up and back:
  // no sample jumps more than the tone's own step plus a little.
  const c = new Cabin(SR), n = 128, L = new Float32Array(n)
  c.set({ idle: 800, redline: 7000 })
  let prev = null, worst = 0, ph = 0
  for (let b = 0; b < 1500; b++) {
    const u = b < 750 ? b / 750 : (1500 - b) / 750
    c.set({ rpm: 800 + u * 6200, load: u < 0.5 ? u * 2 : 1 - (u - 0.5) })
    for (let i = 0; i < n; i++) { L[i] = 0.3 * Math.sin(ph); ph += (2 * Math.PI * 120) / SR }
    c.process([L], n)
    for (let i = 0; i < n; i++) { if (prev != null) worst = Math.max(worst, Math.abs(L[i] - prev)); prev = L[i] }
  }
  assert.ok(worst < 0.02, `largest step ${worst.toFixed(4)}`)
})
