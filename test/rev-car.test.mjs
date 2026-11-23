import { test } from 'node:test'
import assert from 'node:assert/strict'
import { parseCar, CarReader } from '../static/rev-car.js'

const charge = { chargeState: { batteryLevel: 81, usableBatteryLevel: 80, batteryRange: 200, chargingState: { Disconnected: {} } } }
const drive = { driveState: { shiftState: { P: {} }, odometerInHundredthsOfAMile: 4598000, power: 0 } }

test('parseCar: usable charge, range and odometer in km', () => {
  const r = parseCar({ charge, drive })
  assert.equal(r.soc, 0.8)
  assert.ok(Math.abs(r.rangeKm - 321.87) < 0.01)
  assert.ok(Math.abs(r.odoKm - 73997.6) < 0.1)
})

test('parseCar: falls back to battery level, ignores what is missing or absurd', () => {
  assert.deepEqual(parseCar({}), {})
  assert.deepEqual(parseCar({ charge: { chargeState: {} } }), {})
  assert.equal(parseCar({ charge: { chargeState: { batteryLevel: 55 } } }).soc, 0.55)
  assert.deepEqual(parseCar({ charge: { chargeState: { batteryLevel: 140, batteryRange: -3 } } }), {})
  assert.deepEqual(parseCar({ drive: { driveState: { odometerInHundredthsOfAMile: 0 } } }), {})
  assert.deepEqual(parseCar({ charge: { chargeState: { batteryLevel: '81' } } }), {})
})

// A fake /telemetry/ble.
function fakeFetch(answer) {
  const calls = []
  const f = async (url) => {
    calls.push(url)
    const cat = new URL(url, 'http://x').searchParams.get('category')
    const [status, body] = answer(cat)
    return { status, ok: status >= 200 && status < 300, json: async () => body }
  }
  return { f, calls }
}

test('CarReader: reads charge and drive on start, charge alone on the interval, nothing once stopped', async () => {
  const { f, calls } = fakeFetch((cat) => [200, { ok: true, data: cat === 'charge' ? charge : drive }])
  const got = []
  const r = new CarReader({ fetch: f, every: 20, onRead: (x) => got.push(x) })
  r.start()
  await new Promise((ok) => setTimeout(ok, 55))
  r.stop()
  const n = calls.length
  await new Promise((ok) => setTimeout(ok, 50))
  assert.equal(calls.length, n, 'no reads after stop')
  assert.deepEqual(calls.slice(0, 3).map((u) => u.split('=')[1]), ['charge', 'drive', 'charge'])
  assert.ok(got[0].odoKm > 0 && got[0].soc === 0.8)
  assert.equal(got[1].odoKm, undefined, 'interval reads are charge only')
})

test('CarReader: the setting off (403) stops it asking until the next start', async () => {
  const { f, calls } = fakeFetch(() => [403, { ok: false, error: 'ble_disabled' }])
  const got = []
  const r = new CarReader({ fetch: f, every: 10, onRead: (x) => got.push(x) })
  r.start()
  await new Promise((ok) => setTimeout(ok, 45))
  // The dash calls start() on every engine state; refused, that is no read.
  for (let k = 0; k < 50; k++) r.start()
  await new Promise((ok) => setTimeout(ok, 20))
  assert.equal(calls.length, 1)
  assert.equal(got.length, 0)
  // A real stop and start (the engine switched off and on) asks again.
  r.stop(); r.start()
  await new Promise((ok) => setTimeout(ok, 5))
  assert.equal(calls.length, 2)
  r.stop()
})

test('CarReader: a failed read (car busy, 502) reports nothing and keeps going', async () => {
  let fail = true
  const { f, calls } = fakeFetch((cat) => (fail ? [502, { ok: false, error: 'maximum number of BLE devices' }] : [200, { ok: true, data: charge }]))
  const got = []
  const r = new CarReader({ fetch: f, every: 15, onRead: (x) => got.push(x) })
  r.start()
  await new Promise((ok) => setTimeout(ok, 5))
  assert.equal(got.length, 0)
  fail = false
  await new Promise((ok) => setTimeout(ok, 30))
  r.stop()
  assert.ok(calls.length >= 3)
  assert.equal(got[0].soc, 0.8)
})
