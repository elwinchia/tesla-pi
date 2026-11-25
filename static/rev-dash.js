// The engine sound's dash: the chosen gauge style (static/gauges/), fed by
// an engine that is always running (rev-sound.js). Press and hold the rev
// meter to rev the engine (parked only); press and hold anywhere else (or
// on the rev meter while moving) to open the engine sound's settings.
//
// Used by the dock under CarPlay on index.html and by rev.html.
import { Instruments, tachScale, hhmm } from './gauges/kit.js'
import { STYLES, loadStyle, styleKey } from './gauges/index.js'
import { clusterInput } from './rev-gauge.js'
import { FRESH_MS } from './rev-car.js'
// A heading older than this is not shown: GPS has gone quiet.
const HEADING_FRESH_MS = 60 * 1000

// How long a press is held to open the settings, and how far it may wander.
export const LONG_PRESS_MS = 600
const LONG_PRESS_SLOP = 12

const SAVE_KEY = 'revInstruments'
const SAVE_EVERY_MS = 5000

export class Dash {
  // rs: a RevSound. hand(): 1 for a right-hand-drive car, 0 for left (set
  // as data-hand on the dash's root). onSettings(): open the engine
  // sound's settings, on a long press. car: a CarReader (rev-car.js) for
  // the car's real battery, range and odometer, or null.
  constructor(host, { rs, hand = () => 1, theme = () => 'night', onSettings = null, storage = globalThis.localStorage, car = null } = {}) {
    this.rs = rs; this.hand = hand; this.theme = theme; this.onSettings = onSettings; this.storage = storage
    // The car's own readings, when there are any: see onCar().
    this.car = car; this.real = null
    if (car) car.onRead = (r) => this.onCar(r)
    this.st = null
    this.style = null; this.styleKey = null; this.loading = null
    this.scale = tachScale(rs.engine.profile.redline, rs.engine.profile.idle)
    this.inst = new Instruments()
    try { this.inst.restore(JSON.parse(storage.getItem(SAVE_KEY) || 'null')) } catch {}
    this.savedAt = 0

    const root = this.root = document.createElement('div')
    root.className = 'rvd'
    root.innerHTML = '<div class="rvd-gauge" title="Hold the rev meter to rev the engine; hold anywhere else for the settings"></div>'
    host.appendChild(root)
    this.gaugeHost = root.querySelector('.rvd-gauge')
    this.listenRev()
    this.listenLongPress()
    this.setHand(hand())
    this.onHide = () => this.save(true)
    addEventListener('pagehide', this.onHide)
  }

  setHand(h) { this.root.dataset.hand = h === 0 ? '0' : '1' }

  async setStyle(key) {
    key = styleKey(key)
    if (key === this.styleKey && (this.style || this.loading)) return this.loading
    this.styleKey = key
    this.loading = loadStyle(key).then((Cls) => {
      if (this.styleKey !== key) return
      const old = this.style
      const touch = this.touchHandlers
      this.style = new Cls(this.gaugeHost, { scale: this.scale, theme: this.theme })
      if (old) old.destroy()
      this.root.dataset.style = key
      if (touch) this.style.setTouch(touch)
      if (this.st) this.push()
    }).catch((e) => { console.warn('gauge style', key, e); if (key !== 'segment') return this.setStyle('segment') })
    return this.loading
  }

  setScale(scale) { this.scale = scale; if (this.style) this.style.setScale(scale) }
  setTouch(handlers) { this.touchHandlers = handlers || null; if (this.style) this.style.setTouch(this.touchHandlers) }
  get touch() { return this.touchHandlers || null }

  // Engine state from RevSound's onState.
  state(st) {
    this.st = st
    this.fitScale()
    // Read the car while the engine runs (always, once the page has started
    // it), and never while it is stopped.
    if (this.car) {
      if (st.running && !this.car.active) this.car.start()
      else if (!st.running && this.car.active) this.car.stop()
    }
    // Revving is for when the car is stopped (RevSound refuses it moving).
    this.moving = !!(st.running && !st.stopped)
    if (this.moving && this.revving != null) this.endRev()
    this.push()
  }
  push() {
    if (!this.style || !this.st) return
    const p = this.rs.engine.profile
    this.style.set({ ...clusterInput(this.st), car: p.name + ' · ' + p.style })
  }

  // The rev meter's scale follows the chosen engine's redline. Checked every
  // frame too: a car picked with the engine stopped sends no state.
  fitScale() {
    const p = this.rs.engine.profile
    if (p !== this.profile) { this.profile = p; this.setScale(tachScale(p.redline, p.idle)) }
  }

  frame(dt) {
    this.fitScale()
    const st = this.st || {}
    // The simulator's pretend car moves the needles but not the trip and
    // odometer, which are the real car's.
    const v = st.source === 'sim' ? 0 : st.v
    const read = this.inst.step(dt, { running: st.running, rpm: st.rpm, load: st.load, v, a: st.a, redline: this.scale.redFrom })
    // The car's real charge stands in for the made-up fuel (every battery
    // and fuel gauge), and its range for the made-up one. Resting with the
    // engine off, as every gauge does.
    const real = this.real && Date.now() - this.real.at < FRESH_MS ? this.real : null
    if (real && st.running && real.soc != null) read.fuel = real.soc
    read.rangeKm = real && real.rangeKm != null ? real.rangeKm : null
    read.carReal = !!(real && real.soc != null)
    // The rest of the car's readings, null until read (or once stale):
    // outside and cabin temperature, the tyres; and the heading from GPS.
    read.outsideC = real && real.outsideC != null ? real.outsideC : null
    read.insideC = real && real.insideC != null ? real.insideC : null
    read.tyres = real && real.tyres ? real.tyres : null
    read.tyreWarn = !!(real && real.tyres && real.tyreWarn)
    const hd = this.rs.heading
    read.heading = hd && Date.now() - hd.at < HEADING_FRESH_MS ? hd.deg : null
    if (this.style) {
      this.style.set({ ...read, clock: new Date() })
      this.style.frame(dt)
    }
    this.save(false)
  }
  save(now) {
    const t = Date.now()
    if (!now && t - this.savedAt < SAVE_EVERY_MS) return
    this.savedAt = t
    try { this.storage.setItem(SAVE_KEY, JSON.stringify(this.inst.snapshot(t))) } catch {}
  }

  // A reading from the car. Its odometer replaces the one counted from GPS
  // (which then carries on from the car's figure between reads).
  onCar(r) {
    this.real = { ...(this.real || {}), ...r }
    if (r.odoKm != null) this.inst.odo = r.odoKm
  }

  // Press and hold the rev meter to rev; lifting lets it fall back to idle.
  // Pointer capture keeps the hold when the finger slides off the dial, and
  // lostpointercapture catches every way it ends. In simulation mode
  // (rev.html) the style's own touch handling sets the rpm, so this stands
  // aside.
  listenRev() {
    const g = this.gaugeHost
    this.revving = null
    g.addEventListener('pointerdown', (e) => {
      const style = this.style
      if (!style || style.touch || this.revving != null) return
      const p = style.toPicture(e)
      if (!p || !style.tachHit(p[0], p[1])) return
      if (!this.rs.running || this.moving) return
      e.preventDefault()
      this.revving = e.pointerId
      try { g.setPointerCapture(e.pointerId) } catch {}
      this.root.classList.add('revving')
      this.rs.setRev(1)
    })
    const end = (e) => { if (this.revving != null && e.pointerId === this.revving) this.endRev() }
    g.addEventListener('pointerup', end)
    g.addEventListener('pointercancel', end)
    g.addEventListener('lostpointercapture', end)
    g.addEventListener('contextmenu', (e) => e.preventDefault())
  }
  // Press and hold anywhere on the dash, away from a rev, to open the
  // settings: LONG_PRESS_MS without lifting or wandering. Not while revving
  // (the rev meter's own hold) or while a simulation drag has the dial.
  listenLongPress() {
    const root = this.root
    let timer = null, at = null
    const cancel = () => { if (timer) clearTimeout(timer); timer = null; at = null }
    root.addEventListener('pointerdown', (e) => {
      cancel()
      if (!this.onSettings || (e.button != null && e.button > 0)) return
      at = [e.clientX, e.clientY]
      timer = setTimeout(() => {
        timer = null; at = null
        if (this.revving != null) return
        const style = this.style
        // A simulation drag on the rev meter (rev.html) is not a long press.
        if (style && style.touch && style.drag) return
        this.onSettings()
      }, LONG_PRESS_MS)
    })
    root.addEventListener('pointermove', (e) => {
      if (at && Math.hypot(e.clientX - at[0], e.clientY - at[1]) > LONG_PRESS_SLOP) cancel()
    })
    root.addEventListener('pointerup', cancel)
    root.addEventListener('pointercancel', cancel)
    root.addEventListener('contextmenu', (e) => e.preventDefault())
  }
  endRev() {
    const id = this.revving
    this.revving = null
    this.root.classList.remove('revving')
    try { this.gaugeHost.releasePointerCapture(id) } catch {}
    this.rs.setRev(0)
  }

  destroy() {
    if (this.car) this.car.stop()
    this.save(true)
    removeEventListener('pagehide', this.onHide)
    if (this.style) this.style.destroy()
    this.root.remove()
  }
}

export { STYLES, hhmm }
export { CarReader } from './rev-car.js'
