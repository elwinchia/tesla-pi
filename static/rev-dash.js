// The engine sound's dash: the chosen gauge style (static/gauges/) between
// two columns of buttons.
//
//   driver's side      a rev pedal: hold it to rev the engine, parked only
//   the other side     ENGINE START/STOP, and a shortcut to the engine
//                      sound's settings
//
// The driver's side follows CarPlay's own drive-side setting (Settings →
// CarPlay → Drive side): right for a right-hand-drive car. Used by the dock
// under CarPlay on index.html and by rev.html.
import { Instruments, tachScale, hhmm } from './gauges/kit.js'
import { STYLES, loadStyle, styleKey } from './gauges/index.js'
import { clusterInput } from './rev-gauge.js'

const SAVE_KEY = 'revInstruments'
const SAVE_EVERY_MS = 5000

const GEAR_ICON = '<svg viewBox="0 0 24 24" aria-hidden="true"><path fill="currentColor" d="M19.4 13a7.6 7.6 0 0 0 0-2l2.1-1.6-2-3.5-2.5 1a7.5 7.5 0 0 0-1.7-1L15 3.3h-4l-.4 2.6a7.5 7.5 0 0 0-1.7 1l-2.5-1-2 3.5L6.6 11a7.6 7.6 0 0 0 0 2l-2.1 1.6 2 3.5 2.5-1a7.5 7.5 0 0 0 1.7 1l.4 2.6h4l.4-2.6a7.5 7.5 0 0 0 1.7-1l2.5 1 2-3.5zM13 15.5a3.5 3.5 0 1 1 0-7 3.5 3.5 0 0 1 0 7z" transform="translate(-1 0)"/></svg>'
// A drilled aluminium sports pedal with rubber strips.
const PEDAL = '<svg viewBox="0 0 100 160" aria-hidden="true">' +
  '<defs><linearGradient id="rvd-alu" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#e9ecef"/><stop offset=".5" stop-color="#adb5bd"/><stop offset="1" stop-color="#6c757d"/></linearGradient></defs>' +
  '<rect x="6" y="4" width="88" height="152" rx="18" fill="url(#rvd-alu)" stroke="#343a40" stroke-width="3"/>' +
  [0, 1, 2, 3, 4, 5].map((k) => `<rect x="20" y="${18 + k * 22}" width="60" height="10" rx="5" fill="#212529"/>`).join('') +
  [0, 1, 2].map((k) => `<circle cx="${30 + k * 20}" cy="146" r="3.4" fill="#343a40"/>`).join('') + '</svg>'

export class Dash {
  // rs: a RevSound. hand(): 1 for a right-hand-drive car, 0 for left.
  // onSettings(): open the engine sound's settings. onEngine(on): the
  // start/stop button turned the engine on or off.
  constructor(host, { rs, hand = () => 1, theme = () => 'night', onSettings = null, onEngine = () => {}, storage = globalThis.localStorage } = {}) {
    this.rs = rs; this.hand = hand; this.theme = theme; this.onEngine = onEngine; this.storage = storage
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
      '<div class="rvd-gauge"></div>' +
      '<div class="rvd-side rvd-ped">' +
        '<button type="button" class="rvd-btn rvd-pedal" aria-label="Accelerator: hold to rev the engine (parked only)">' + PEDAL + '</button>' +
      '</div>'
    host.appendChild(root)
    this.gaugeHost = root.querySelector('.rvd-gauge')
    this.startBtn = root.querySelector('.rvd-start')
    this.pedalBtn = root.querySelector('.rvd-pedal')
    const set = root.querySelector('.rvd-set')
    if (set) set.addEventListener('click', () => onSettings())
    this.startBtn.addEventListener('click', () => this.toggleEngine())
    this.listenPedal()
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
    const p = this.rs.engine.profile
    if (p !== this.profile) { this.profile = p; this.setScale(tachScale(p.redline, p.idle)) }
    this.startBtn.setAttribute('aria-pressed', String(!!st.running))
    this.pedalBtn.disabled = !!(st.running && !st.stopped)
    this.push()
  }
  push() {
    if (!this.style || !this.st) return
    const p = this.rs.engine.profile
    this.style.set({ ...clusterInput(this.st), car: p.name + ' · ' + p.style })
  }

  frame(dt) {
    const st = this.st || {}
    const read = this.inst.step(dt, { running: st.running, rpm: st.rpm, load: st.load, v: st.v, a: st.a, redline: this.scale.redFrom })
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

  async toggleEngine() {
    const rs = this.rs
    if (rs.running) {
      if (rs.engine.sim) rs.setSim(false)
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

  // Hold to rev. Pointer capture keeps the hold when a finger slides off
  // the pedal; lostpointercapture catches every way it ends. With the
  // engine off it nudges the start button instead.
  listenPedal() {
    const b = this.pedalBtn
    let held = null
    b.addEventListener('pointerdown', (e) => {
      e.preventDefault()
      if (held != null) return
      if (!this.rs.running) {
        this.startBtn.classList.remove('nudge'); void this.startBtn.offsetWidth; this.startBtn.classList.add('nudge')
        return
      }
      held = e.pointerId
      try { b.setPointerCapture(e.pointerId) } catch {}
      b.classList.add('held')
      this.rs.setRev(1)
    })
    const end = (e) => {
      if (held == null || e.pointerId !== held) return
      held = null
      b.classList.remove('held')
      this.rs.setRev(0)
    }
    b.addEventListener('pointerup', end)
    b.addEventListener('pointercancel', end)
    b.addEventListener('lostpointercapture', end)
    b.addEventListener('contextmenu', (e) => e.preventDefault())
  }

  destroy() {
    this.save(true)
    removeEventListener('pagehide', this.onHide)
    if (this.style) this.style.destroy()
    this.root.remove()
  }
}

export { STYLES, hhmm }
