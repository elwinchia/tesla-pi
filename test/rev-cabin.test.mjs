// The cabin (static/rev-cabin.js): the engine heard through the car's body.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { Cabin, CABIN, cabinDb, shelfDb } from '../static/rev-cabin.js'

const SR = 48000

// A sine through a cabin at `load`, its level in dB after the filters settle.
function throughDb(hz, load, on = true) {
  const c = new Cabin(SR)
  c.set({ load, cabin: on })
  c.load = load; c.shelf(); c.mix = on ? 1 : 0
  const n = 128, L = new Float32Array(n)
  let ph = 0, ss = 0, si = 0
  for (let b = 0; b < (0.5 * SR) / n; b++) {
    const x = new Float32Array(n)
    for (let i = 0; i < n; i++) { x[i] = 0.5 * Math.sin(ph); ph += (2 * Math.PI * hz) / SR }
    L.set(x)
    c.process([L], n)
    if (b * n > 0.25 * SR) for (let i = 0; i < n; i++) { ss += L[i] * L[i]; si += x[i] * x[i] }
  }
  return 10 * Math.log10(ss / si)
}

test('the firing note comes through whole; the rasp and hiss do not', () => {
  for (const f of [40, 80, 160]) assert.ok(Math.abs(cabinDb(f)) < 1.5, `${f} Hz within 1.5 dB`)
  assert.ok(cabinDb(1000) < -6, '1 kHz down')
  assert.ok(cabinDb(4000) < -14, '4 kHz well down')
  assert.ok(cabinDb(8000) < -24, '8 kHz all but gone')
  // It only takes away: no band is lifted by more than the make-up gain.
  for (let f = 20; f < 20000; f *= 1.05) {
    for (const load of [-1, 0, 1]) assert.ok(cabinDb(f, load) <= 20 * Math.log10(CABIN.makeup) + 0.01)
  }
})

test('pulling opens the top up; overrun is as closed as idle', () => {
  assert.ok(cabinDb(2000, 1) > cabinDb(2000, 0) + 4)
  assert.equal(shelfDb(-1), shelfDb(0))
  assert.equal(shelfDb(1), CABIN.shelf.dbFull)
})

test('the filters do what the response says', () => {
  for (const [hz, load] of [[100, 0], [1000, 0], [4000, 0], [2000, 1]]) {
    const got = throughDb(hz, load), want = cabinDb(hz, load)
    assert.ok(Math.abs(got - want) < 0.3, `${hz} Hz at load ${load}: ${got.toFixed(2)} vs ${want.toFixed(2)} dB`)
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
