// The engine sound's dash: the chosen gauge style (static/gauges/) beside a
// column with ENGINE START/STOP and a shortcut to the engine sound's
// settings. Press and hold the rev meter to rev the engine (parked only).
//
// The column sits on the passenger's side of the gauge, away from the
// driver: CarPlay's own drive-side setting (Settings → CarPlay → Drive side)
// puts it on the left in a right-hand-drive car. Used by the dock under
// CarPlay on index.html and by rev.html.
import { Instruments, tachScale, hhmm } from './gauges/kit.js'
import { STYLES, loadStyle, styleKey } from './gauges/index.js'
import { clusterInput } from './rev-gauge.js'
import { FRESH_MS } from './rev-car.js'

const SAVE_KEY = 'revInstruments'
const SAVE_EVERY_MS = 5000

const GEAR_ICON = '<svg viewBox="0 0 24 24" aria-hidden="true"><path fill="currentColor" d="M19.4 13a7.6 7.6 0 0 0 0-2l2.1-1.6-2-3.5-2.5 1a7.5 7.5 0 0 0-1.7-1L15 3.3h-4l-.4 2.6a7.5 7.5 0 0 0-1.7 1l-2.5-1-2 3.5L6.6 11a7.6 7.6 0 0 0 0 2l-2.1 1.6 2 3.5 2.5-1a7.5 7.5 0 0 0 1.7 1l.4 2.6h4l.4-2.6a7.5 7.5 0 0 0 1.7-1l2.5 1 2-3.5zM13 15.5a3.5 3.5 0 1 1 0-7 3.5 3.5 0 0 1 0 7z" transform="translate(-1 0)"/></svg>'
export class Dash {
  // rs: a RevSound. hand(): 1 for a right-hand-drive car, 0 for left.
  // onSettings(): open the engine sound's settings. onEngine(on): the
  // start/stop button turned the engine on or off. car: a CarReader
  // (rev-car.js) for the car's real battery, range and odometer, or null.
  constructor(host, { rs, hand = () => 1, theme = () => 'night', onSettings = null, onEngine = () => {}, storage = globalThis.localStorage, car = null } = {}) {
    this.rs = rs; this.hand = hand; this.theme = theme; this.onEngine = onEngine; this.storage = storage
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
    root.innerHTML =
      '<div class="rvd-side rvd-ign">' +
        (onSettings ? '<button type="button" class="rvd-btn rvd-set" aria-label="Engine sound settings">' + GEAR_ICON + '</button>' : '') +
        '<button type="button" class="rvd-btn rvd-start" aria-pressed="false" aria-label="Engine start and stop">' +
          '<span class="w1">ENGINE</span><span class="w2">START</span><span class="rule"></span><span class="w2">STOP</span></button>' +
      '</div>' +
      '<div class="rvd-gauge" title="Press and hold the rev meter to rev the engine"></div>'
    host.appendChild(root)
    this.gaugeHost = root.querySelector('.rvd-gauge')
    this.startBtn = root.querySelector('.rvd-start')
    const set = root.querySelector('.rvd-set')
    if (set) set.addEventListener('click', () => onSettings())
    this.startBtn.addEventListener('click', () => this.toggleEngine())
    this.listenRev()
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
      this.root.toggleAttribute('data-dark', !!Cls.meta.dark)
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
    this.startBtn.setAttribute('aria-pressed', String(!!st.running))
    // Read the car while the engine sound runs, and never while it is off.
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
    const read = this.inst.step(dt, { running: st.running, rpm: st.rpm, load: st.load, v: st.v, a: st.a, redline: this.scale.redFrom })
    // The car's real charge stands in for the made-up fuel (every battery
    // and fuel gauge), and its range for the made-up one. Resting with the
    // engine off, as every gauge does.
    const real = this.real && Date.now() - this.real.at < FRESH_MS ? this.real : null
    if (real && st.running && real.soc != null) read.fuel = real.soc
    read.rangeKm = real && real.rangeKm != null ? real.rangeKm : null
    read.carReal = !!(real && real.soc != null)
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

  async toggleEngine() {
    const rs = this.rs
    if (rs.running) {
      if (rs.engine.sim) rs.setSim(false)
      if (this.revving != null) this.endRev()
      rs.setRev(0)
      rs.stop()
      this.onEngine(false)
    } else {
      await rs.start()
      if (!rs.running) return
      // The flare of a cold start: a quick rise past idle that settles.
      rs.blip(rs.engine.profile.idle * 1.7)
      this.onEngine(true)
    }
  }

  // Press and hold the rev meter to rev; lifting lets it fall back to idle.
  // Pointer capture keeps the hold when the finger slides off the dial, and
  // lostpointercapture catches every way it ends. With the engine off a
  // press nudges the start button instead. In simulation mode (rev.html)
  // the style's own touch handling sets the rpm, so this stands aside.
  listenRev() {
    const g = this.gaugeHost
    this.revving = null
    g.addEventListener('pointerdown', (e) => {
      const style = this.style
      if (!style || style.touch || this.revving != null) return
      const p = style.toPicture(e)
      if (!p || !style.tachHit(p[0], p[1])) return
      e.preventDefault()
      if (!this.rs.running) {
        this.startBtn.classList.remove('nudge'); void this.startBtn.offsetWidth; this.startBtn.classList.add('nudge')
        return
      }
      if (this.moving) return
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
