// The car's own readings for the dash, over Bluetooth: the battery's charge,
// its range, the odometer, the outside and cabin temperatures and the tyre
// pressures. The Pi reads them with a read-only car key
// (GET /telemetry/ble, index.js; docs/telemetry-options.md) when Settings →
// Network → Experimental → "Read telemetry from Bluetooth" is on.
//
// Each read is one short Bluetooth connection, about 3 s, and the car takes
// only three at a time (phone keys hold them). So: one read of each when the
// engine sound starts (charge, drive, climate, tyres), then the charge and
// climate every five minutes while it runs, the tyres every third time
// (fifteen minutes), and nothing at all while it is stopped. They all move
// slowly enough for that. A failed read keeps the last good one; with the
// setting off (403) or the helper missing (404) it stops asking until the
// next start.
//
// parseCar is pure, for node --test (test/rev-car.test.mjs).

export const READ_EVERY_MS = 5 * 60 * 1000
// The tyres are read on every TYRES_EVERY-th interval.
export const TYRES_EVERY = 3
export const START_CATS = ['charge', 'drive', 'climate', 'tire-pressure']
// Older than this, a reading is not shown: the car may have charged or
// driven a long way since.
export const FRESH_MS = 30 * 60 * 1000
const MILE_KM = 1.609344

const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : null)

// tesla-control's JSON for `state charge` and `state drive` (camelCase
// protobuf: vehicle.proto in teslamotors/vehicle-command). Range is in
// miles, as the odometer is ("hundredths of a mile"), whatever the car
// shows on its screen.
export function parseCar({ charge, drive, climate, 'tire-pressure': tyres } = {}) {
  const out = {}
  const cs = (charge && charge.chargeState) || null
  if (cs) {
    const pct = num(cs.usableBatteryLevel) ?? num(cs.batteryLevel)
    if (pct != null && pct >= 0 && pct <= 100) out.soc = pct / 100
    const mi = num(cs.batteryRange) ?? num(cs.estBatteryRange)
    if (mi != null && mi >= 0) out.rangeKm = mi * MILE_KM
  }
  const ds = (drive && drive.driveState) || null
  if (ds) {
    const h = num(ds.odometerInHundredthsOfAMile)
    if (h != null && h > 0) out.odoKm = (h / 100) * MILE_KM
  }
  // Celsius, as the field names say.
  const cm = (climate && climate.climateState) || null
  if (cm) {
    const t = (v) => (v != null && v > -60 && v < 90 ? v : null)
    const o = t(num(cm.outsideTempCelsius) ?? num(cm.outsideTemp))
    const i = t(num(cm.insideTempCelsius) ?? num(cm.insideTemp))
    if (o != null) out.outsideC = o
    if (i != null) out.insideC = i
  }
  // Bar, front left, front right, rear left, rear right; a soft or hard
  // warning on any wheel sets tyreWarn.
  const tp = (tyres && tyres.tirePressureState) || null
  if (tp) {
    const W = ['Fl', 'Fr', 'Rl', 'Rr']
    const ps = W.map((w) => num(tp['tpmsPressure' + w]))
    if (ps.every((p) => p != null && p > 0 && p < 10)) {
      out.tyres = ps
      out.tyreWarn = W.some((w) => !!(tp['tpmsHardWarning' + w] || tp['tpmsSoftWarning' + w]))
    }
  }
  return out
}

export class CarReader {
  // onRead({ soc, rangeKm, odoKm, outsideC, insideC, tyres, tyreWarn, at }):
  // whatever a read found.
  constructor({ onRead = () => {}, fetch = globalThis.fetch?.bind(globalThis), every = READ_EVERY_MS, now = () => Date.now() } = {}) {
    this.onRead = onRead; this.fetch = fetch; this.every = every; this.now = now
    this.timer = null; this.busy = false; this.active = false; this.off = false
  }

  // The engine sound started: read now, then on the interval. Called again
  // while active it does nothing, so a caller may call it on every state.
  start() {
    if (this.active) return
    this.active = true; this.off = false; this.ticks = 0
    this.read(START_CATS)
    this.timer = setInterval(() => {
      this.ticks++
      this.read(this.ticks % TYRES_EVERY === 0 ? ['charge', 'climate', 'tire-pressure'] : ['charge', 'climate'])
    }, this.every)
  }
  stop() {
    this.active = false
    this.clearTimer()
  }
  clearTimer() {
    if (this.timer) clearInterval(this.timer)
    this.timer = null
  }

  async read(cats) {
    if (this.busy || this.off || !this.fetch) return null
    this.busy = true
    const got = {}
    try {
      // One after the other: the Pi serialises Bluetooth anyway, and a
      // second request would only wait in its queue.
      for (const c of cats) {
        if (!this.active) break
        let r
        try { r = await this.fetch('/telemetry/ble?category=' + c, { cache: 'no-store' }) } catch { break }
        // Refused: say nothing more until the next start. Stays active, so
        // the caller does not take it for stopped and start it again.
        if (r.status === 403 || r.status === 404) { this.off = true; this.clearTimer(); break }
        if (!r.ok) continue
        let j = null
        try { j = await r.json() } catch {}
        if (j && j.ok && j.data) got[c] = j.data
      }
    } finally { this.busy = false }
    const out = parseCar(got)
    if (!Object.keys(out).length) return null
    out.at = this.now()
    this.onRead(out)
    return out
  }
}
