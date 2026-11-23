// Engine sound controller: owns the AudioContext, the worklet, the speed
// source (the car's GPS or the simulator) and the settings. Used by
// static/rev.html, and by static/index.html when the owner has turned the
// engine sound on. Nothing here talks to the Pi: the sound is made and played
// by the car's browser, so the Pi's CarPlay service never sees it.

import { PROFILES, DEFAULT_PROFILE } from './rev-profiles.js'
import {
  CARS, DEFAULT_CAR, MODES, DEFAULT_MODE,
  SpeedTracker, Gearbox, FreeRev, SimCar, loadFromMotion, clamp,
} from './rev-model.js'

export { PROFILES, CARS, MODES }

const KEY = 'revSound'
export const DEFAULTS = Object.freeze({
  enabled: false,      // play while driving, on the main page as well as rev.html
  volume: 0.5,         // 0..1, squared into gain
  profile: DEFAULT_PROFILE,
  mode: DEFAULT_MODE,
  car: DEFAULT_CAR,
})
// Below this the car counts as stopped: the gearbox hands over to the free
// revving engine, and the Rev control is allowed. ~4 km/h.
export const STOPPED_MS = 1.0
const TICK_MS = 20

// Settings live in the car browser's localStorage, shared by every page on
// this origin. They are the browser's business only — the Pi neither needs
// nor stores them — and a browser that refuses storage just gets defaults.
export function loadSettings(storage = globalThis.localStorage) {
  let raw = null
  try { raw = JSON.parse(storage.getItem(KEY) || 'null') } catch { raw = null }
  return sanitise(raw)
}
export function saveSettings(s, storage = globalThis.localStorage) {
  const clean = sanitise(s)
  try { storage.setItem(KEY, JSON.stringify(clean)) } catch {}
  return clean
}
export function sanitise(raw) {
  const s = { ...DEFAULTS }
  if (!raw || typeof raw !== 'object') return s
  if (typeof raw.enabled === 'boolean') s.enabled = raw.enabled
  if (Number.isFinite(raw.volume)) s.volume = clamp(raw.volume, 0, 1)
  if (Object.hasOwn(PROFILES, raw.profile)) s.profile = raw.profile
  if (Object.hasOwn(MODES, raw.mode)) s.mode = raw.mode
  if (Object.hasOwn(CARS, raw.car)) s.car = raw.car
  return s
}

// The pure half of the engine: speed fixes and throttle in, rpm/load/gear
// out. Kept apart from the audio so tests can drive it with a fake clock.
export class Engine {
  constructor(settings = DEFAULTS) {
    this.settings = sanitise(settings)
    const p = PROFILES[this.settings.profile]
    this.tracker = new SpeedTracker()
    this.gearbox = new Gearbox(p, this.settings.mode)
    this.free = new FreeRev(p)
    this.load = 0
    this.revThrottle = 0
    this.state = { v: 0, a: 0, load: 0, rpm: p.idle, gear: 0, shifting: false, stale: true, stopped: true }
  }

  configure(settings) {
    const prev = this.settings
    this.settings = sanitise(settings)
    if (this.settings.profile !== prev.profile) {
      const p = PROFILES[this.settings.profile]
      this.gearbox.setProfile(p); this.free.setProfile(p)
    }
    if (this.settings.mode !== prev.mode) this.gearbox.setMode(this.settings.mode)
  }

  get profile() { return PROFILES[this.settings.profile] }

  // Rev while stopped. Ignored while moving: revving the engine is a toy for
  // the car park, not something to reach for at speed.
  setRev(x) { this.revThrottle = clamp(x, 0, 1) }

  fix(t, speed) { this.tracker.push(t, speed) }

  step(t, dt) {
    const est = this.tracker.at(t)
    const stopped = est.v < STOPPED_MS
    const car = CARS[this.settings.car]
    // Load is smoothed over ~150 ms: the estimate moves once per fix, the
    // engine should lean into it rather than jump.
    const target = loadFromMotion(est.v, est.a, car)
    this.load += (target - this.load) * (1 - Math.exp(-dt / 0.15))

    let out
    if (stopped) {
      if (this.state.gear !== 0) this.free.rpm = this.gearbox.rpm
      out = this.free.step(this.revThrottle, dt)
      this.gearbox.gear = 1
      this.gearbox.rpm = out.rpm
    } else {
      out = this.gearbox.step(t, est.v, this.load, dt)
    }
    this.state = { v: est.v, a: est.a, load: out.load, rpm: out.rpm, gear: out.gear,
      shifting: out.shifting, stale: est.stale, stopped }
    return this.state
  }
}

// Fix-rate meter: fixes over the trailing 10 s, per second.
class Rate {
  constructor() { this.ts = [] }
  hit(t) { this.ts.push(t); while (this.ts.length && t - this.ts[0] > 10000) this.ts.shift() }
  get(t) {
    while (this.ts.length && t - this.ts[0] > 10000) this.ts.shift()
    const n = this.ts.length
    return n < 2 ? 0 : (n - 1) / ((this.ts[n - 1] - this.ts[0]) / 1000)
  }
}

export class RevSound {
  // onState(state) is called every tick with the engine state plus
  // { source, fixRate, running, error }.
  constructor({ onState = () => {}, storage = globalThis.localStorage } = {}) {
    this.storage = storage
    this.settings = loadSettings(storage)
    this.engine = new Engine(this.settings)
    this.onState = onState
    this.source = 'gps'
    this.ctx = null; this.node = null; this.gainReady = false
    this.timer = null; this.watchId = null
    this.rate = new Rate()
    this.sim = { car: new SimCar(CARS[this.settings.car]), pedal: 0, brake: 0, fixMs: 1000, lastFix: -Infinity }
    this.error = null
    this.last = 0
    this.onVisibility = () => (document.hidden ? this.pause() : this.resume())
  }

  update(partial) {
    this.settings = saveSettings({ ...this.settings, ...partial }, this.storage)
    this.engine.configure(this.settings)
    this.sim.car.setCar(CARS[this.settings.car])
    if (partial.profile && this.node) this.node.port.postMessage({ profile: this.engine.profile })
    return this.settings
  }

  // 'gps' (the car) or 'sim' (the on-screen pedal).
  setSource(src) {
    if (src !== 'gps' && src !== 'sim') return
    if (src === this.source) return
    this.source = src
    this.engine.tracker.reset()
    this.rate = new Rate()
    this.sim.car.v = 0
    if (this.timer) { this.stopGps(); if (src === 'gps') this.startGps() }
  }
  setPedal(x) { this.sim.pedal = clamp(x, 0, 1) }
  setBrake(x) { this.sim.brake = clamp(x, 0, 1) }
  setSimFixMs(ms) { this.sim.fixMs = clamp(ms, 50, 5000) }
  setRev(x) { this.engine.setRev(x) }

  get running() { return this.timer != null }

  // Must be called from a user gesture the first time: browsers only let a
  // page start sound after a tap.
  async start() {
    if (this.timer) { this.resumeAudio(); return }
    this.error = null
    try {
      await this.ensureAudio()
    } catch (e) {
      this.error = 'Sound could not start: ' + (e && e.message ? e.message : e)
      this.emit(performance.now())
      return
    }
    if (this.source === 'gps') this.startGps()
    this.last = performance.now()
    this.timer = setInterval(() => this.tick(), TICK_MS)
    document.addEventListener('visibilitychange', this.onVisibility)
  }

  stop() {
    if (this.timer) clearInterval(this.timer)
    this.timer = null
    this.stopGps()
    document.removeEventListener('visibilitychange', this.onVisibility)
    if (this.node) this.node.port.postMessage({ params: { gain: 0 } })
    // Let the gain glide to zero before suspending, so it ends without a click.
    const ctx = this.ctx
    if (ctx) setTimeout(() => { if (!this.timer) ctx.suspend().catch(() => {}) }, 250)
    this.emit(performance.now())
  }

  // Hidden tab: no GPS, no sound. The car shows one page at a time and a
  // hidden one should not keep the GPS or the speakers busy.
  pause() {
    if (!this.timer) return
    this.stopGps()
    if (this.ctx) this.ctx.suspend().catch(() => {})
  }
  resume() {
    if (!this.timer) return
    if (this.source === 'gps') this.startGps()
    this.engine.tracker.reset()
    this.resumeAudio()
  }
  resumeAudio() {
    if (this.ctx && this.ctx.state === 'suspended') this.ctx.resume().catch(() => {})
  }

  async ensureAudio() {
    if (this.ctx) { this.resumeAudio(); return }
    const AC = window.AudioContext || window.webkitAudioContext
    if (!AC) throw new Error('this browser has no Web Audio')
    const ctx = new AC({ latencyHint: 'interactive' })
    if (!ctx.audioWorklet) throw new Error('this browser has no AudioWorklet')
    await ctx.audioWorklet.addModule(new URL('./rev-worklet.js', import.meta.url).href)
    const node = new AudioWorkletNode(ctx, 'rev-engine', { numberOfInputs: 0, outputChannelCount: [2] })
    node.connect(ctx.destination)
    node.port.postMessage({ profile: this.engine.profile, params: { gain: 0 } })
    this.ctx = ctx; this.node = node
    if (ctx.state === 'suspended') ctx.resume().catch(() => {})
  }

  startGps() {
    if (this.watchId != null) return
    if (!('geolocation' in navigator)) { this.error = 'This browser does not offer location, so the engine cannot follow the car.'; return }
    // Every fix is timed on arrival. pos.timestamp is not usable on the car:
    // it is not epoch time and does not advance (docs/telemetry-options.md).
    this.watchId = navigator.geolocation.watchPosition(
      (pos) => {
        const t = performance.now()
        this.error = null
        this.rate.hit(t)
        this.engine.fix(t, pos.coords.speed)
      },
      (err) => {
        this.error = err && err.code === 1
          ? 'Location is blocked for this page. Allow it so the engine can follow the car.'
          : 'Waiting for GPS' + (err && err.message ? ' (' + err.message + ')' : '') + '.'
      },
      { enableHighAccuracy: true, maximumAge: 0, timeout: 15000 })
  }
  stopGps() {
    if (this.watchId == null) return
    try { navigator.geolocation.clearWatch(this.watchId) } catch {}
    this.watchId = null
  }

  tick() {
    const t = performance.now()
    // Clamp dt: a throttled timer must not turn into a leap in the model.
    const dt = clamp((t - this.last) / 1000, 0.001, 0.1)
    this.last = t
    if (this.source === 'sim') {
      const v = this.sim.car.step(this.sim.pedal, this.sim.brake, dt)
      // The simulator reports speed the way the car's GPS does: in steps, a
      // few per second at most, so what you hear is what the car would do.
      if (t - this.sim.lastFix >= this.sim.fixMs) {
        this.sim.lastFix = t
        this.rate.hit(t)
        this.engine.fix(t, v)
      }
    }
    const s = this.engine.step(t, dt)
    if (this.node) {
      const v = this.settings.volume
      this.node.port.postMessage({ params: { rpm: s.rpm, load: s.load, gain: v * v } })
    }
    this.emit(t)
  }

  emit(t) {
    this.onState({ ...this.engine.state, source: this.source, fixRate: this.rate.get(t),
      simSpeed: this.sim.car.v, running: this.running, error: this.error,
      redline: this.engine.profile.redline, idle: this.engine.profile.idle })
  }
}
