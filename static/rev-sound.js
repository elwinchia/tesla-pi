// Engine sound controller: owns the AudioContext, the worklet, the speed
// source (the car's GPS or the simulator) and the settings. Used by
// static/rev.html, and by static/index.html when the owner has turned the
// engine sound on. Nothing here talks to the Pi: the sound is made and played
// by the car's browser, so the Pi's CarPlay service never sees it.

import { PROFILES, DEFAULT_PROFILE } from './rev-profiles.js'
import { SAMPLE_SETS, hasRecording, loopSlice, loopsFor } from './rev-samples.js'
import { DEFAULT_STYLE, styleKey } from './gauges/index.js'
import {
  CARS, DEFAULT_CAR, MODES, DEFAULT_MODE,
  SpeedTracker, Gearbox, FreeRev, SimCar, loadFromMotion, clamp,
} from './rev-model.js'

export { PROFILES, CARS, MODES }

const KEY = 'revSound'
export const DEFAULTS = Object.freeze({
  enabled: false,      // "Play while driving": the engine's sound, here and on the main
                       // page. Off, it is silent; the engine and the gauges run either way.
  volume: 0.7,         // 0..1, squared into gain after the loudness stage (rev-loudness.js)
  profile: DEFAULT_PROFILE,
  mode: DEFAULT_MODE,
  car: DEFAULT_CAR,
  exhaust: 0.5,        // 0 = heard from the engine, 1 = from the exhaust
  cabin: true,         // heard through the car's body (rev-cabin.js), as the driver hears it
  // Where the sound comes from: 'recorded', the engine-sim loops (rev-samples.js),
  // or 'live', engine-sim itself running in the browser (rev-live.js).
  engineSim: 'recorded',
  liveQuality: 1,      // live: the share of the engine script's simulation rate it runs at
  // The recorded mix's optional extras, each on its own so they can be
  // heard one at a time (rev-samples.js):
  denseRpm: false,     // rev points every ~450 rpm instead of every ~900
  partThrottle: false, // light-throttle layers between full throttle and overrun
  oneShots: false,     // the rev limiter and gear-shift cuts, rendered by engine-sim
  longLoops: false,    // 4 s loops instead of 1.5 s, so nothing repeats audibly
  gauge: DEFAULT_STYLE, // the dash's gauge style (static/gauges/index.js)
})
export const LIVE_QUALITIES = [1, 0.75, 0.5]
export const RECORDED_OPTIONS = ['denseRpm', 'partThrottle', 'oneShots', 'longLoops']
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
  if (Number.isFinite(raw.exhaust)) s.exhaust = clamp(raw.exhaust, 0, 1)
  if (typeof raw.cabin === 'boolean') s.cabin = raw.cabin
  if (raw.engineSim === 'recorded' || raw.engineSim === 'live') s.engineSim = raw.engineSim
  if (LIVE_QUALITIES.includes(raw.liveQuality)) s.liveQuality = raw.liveQuality
  for (const k of RECORDED_OPTIONS) if (typeof raw[k] === 'boolean') s[k] = raw[k]
  if (typeof raw.gauge === 'string') s.gauge = styleKey(raw.gauge)
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
    this.sim = false        // simulation mode: the rpm comes from a finger
    this.simEnded = null    // why simulation mode last ended or was refused
    this.state = { v: 0, a: 0, load: 0, rpm: p.idle, gear: 0, shifting: false, stale: true, stopped: true,
      sim: false, touching: false, simEnded: null }
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

  // Simulation mode: the owner sets the rpm by dragging along the rev meter.
  // It is a toy for a parked car, so it is allowed only while the car is
  // stopped: under ~4 km/h, or before the car has reported any speed. A
  // car whose fixes stopped coming while it was moving counts as moving.
  // The moment the car moves, step() ends it and the engine follows the
  // car again. Returns whether simulation mode is on.
  moving(t) { return this.tracker.at(t).v >= STOPPED_MS }
  setSim(on, t) {
    if (on && this.moving(t)) { this.sim = false; this.simEnded = 'moving'; return false }
    this.sim = !!on
    this.simEnded = null
    if (!this.sim) this.free.release()
    return this.sim
  }
  // A finger on the rev meter at `rpm`; release(blip) when it lifts. Ignored
  // outside simulation mode.
  touch(rpm) { if (!this.sim) return false; this.free.hold(rpm); return true }
  untouch(blip = false) { this.free.release(blip) }
  // One blip to `rpm`, to preview an engine. Stopped only, like Rev.
  blip(rpm, t) {
    if (this.moving(t)) return false
    this.free.hold(rpm); this.free.release(true)
    return true
  }

  step(t, dt) {
    const est = this.tracker.at(t)
    const stopped = est.v < STOPPED_MS
    if (this.sim && !stopped) { this.sim = false; this.simEnded = 'moving'; this.free.release() }
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
      shifting: out.shifting, stale: est.stale, stopped,
      sim: this.sim, touching: this.free.touching, simEnded: this.simEnded,
      limiter: stopped && this.free.onLimiter }
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
    // Which sound is playing: 'synth', 'loading' or 'recorded'.
    this.sound = 'synth'
    this.soundNote = null
    this.sampleCache = new Map() // car -> Promise of its decoded loops
    this.live = null             // engine-sim running live (rev-live.js), when chosen
    this.liveFor = null          // 'car@quality' it was started for
    this.liveNote = null         // why it is not playing, when it failed to start
    this.onVisibility = () => (document.hidden ? this.pause() : this.resume())
  }

  update(partial) {
    return this.apply(saveSettings({ ...this.settings, ...partial }, this.storage))
  }
  // Settings another page saved (the settings sheet over CarPlay, a
  // storage event): take them without writing them back.
  reload() { return this.apply(loadSettings(this.storage)) }
  apply(next) {
    const prev = this.settings
    this.settings = next
    this.engine.configure(next)
    this.sim.car.setCar(CARS[next.car])
    if (next.profile !== prev.profile && this.node) this.node.port.postMessage({ profile: this.engine.profile })
    if (next.profile !== prev.profile || RECORDED_OPTIONS.some((k) => next[k] !== prev[k])) this.syncSound()
    else if (next.engineSim !== prev.engineSim || next.liveQuality !== prev.liveQuality || next.enabled !== prev.enabled) this.syncLive()
    // Play while driving switched off: the sound glides out and the audio
    // sleeps; the engine runs on. Switched on, startSound() (from the tap)
    // brings it back.
    if (prev.enabled && !next.enabled) this.mute()
    return next
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
  setSim(on) { const r = this.engine.setSim(on, performance.now()); this.emit(performance.now()); return r }
  touch(rpm) { return this.engine.touch(rpm) }
  untouch(blip) { this.engine.untouch(blip) }
  blip(rpm) { return this.engine.blip(rpm, performance.now()) }

  // The engine is always running once a page has called start(): it follows
  // the car's GPS (or the simulator), so the gauges always work. Its sound
  // is separate (startSound()).
  get running() { return this.timer != null }
  // Heard: the audio is up and Play while driving is on.
  get audible() { return !!(this.ctx && this.settings.enabled) }

  // Start the engine: no tap needed, and nothing heard yet.
  start() {
    if (this.timer) return
    this.error = null
    if (this.source === 'gps') this.startGps()
    this.last = performance.now()
    this.timer = setInterval(() => this.tick(), TICK_MS)
    document.addEventListener('visibilitychange', this.onVisibility)
    this.emit(this.last)
  }
  // Its sound, when Play while driving is on. Call it from a tap the first
  // time: browsers only let a page make sound after one. The loops come in
  // over the player's own glide; the engine is already running.
  async startSound() {
    this.start()
    if (!this.settings.enabled) return
    try {
      await this.ensureAudio()
    } catch (e) {
      this.error = 'Sound could not start: ' + (e && e.message ? e.message : e)
      this.emit(performance.now())
    }
  }
  // Silent: the gain glides to zero, then the audio sleeps (no click).
  mute() {
    if (this.node) this.node.port.postMessage({ params: { gain: 0 } })
    const ctx = this.ctx
    if (ctx) setTimeout(() => { if (!this.audible) ctx.suspend().catch(() => {}) }, 250)
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
    if (this.audible && this.ctx.state === 'suspended') this.ctx.resume().catch(() => {})
  }

  async ensureAudio() {
    if (this.ctx) { this.resumeAudio(); return }
    const AC = window.AudioContext || window.webkitAudioContext
    if (!AC) throw new Error('this browser has no Web Audio')
    const ctx = new AC({ latencyHint: 'interactive' })
    if (!ctx.audioWorklet) throw new Error('this browser has no AudioWorklet')
    await ctx.audioWorklet.addModule(new URL('./rev-worklet.js', import.meta.url).href)
    // One input: live engine-sim, mixed in before the cabin.
    const node = new AudioWorkletNode(ctx, 'rev-engine', { numberOfInputs: 1, outputChannelCount: [2] })
    node.connect(ctx.destination)
    node.port.postMessage({ profile: this.engine.profile, params: { gain: 0, volume: this.settings.volume, cabin: this.settings.cabin } })
    this.ctx = ctx; this.node = node
    if (ctx.state === 'suspended') ctx.resume().catch(() => {})
    this.syncSound()
  }

  // The car's loops when it has them. The synthesiser plays while they
  // load, and stays if they cannot be loaded.
  async syncSound() {
    if (!this.node) return
    const car = this.settings.profile
    this.soundNote = null
    // Live engine-sim, when chosen, starts alongside: the recorded loops
    // play until it is running, and take over again if it cannot keep up.
    this.syncLive()
    if (!hasRecording(car)) {
      this.node.port.postMessage({ samples: null })
      this.sound = 'synth'
      return
    }
    this.node.port.postMessage({ samples: null })
    this.sound = 'loading'
    const want = this.soundFor = car + ':' + this.optionsKey()
    try {
      const set = await this.loadSet(car)
      if (this.soundFor !== want || !this.node) return // changed meanwhile
      // Handed over, not copied: the worklet keeps the only copy (up to
      // ~80 MB with every option on), and the next sync decodes afresh from
      // the browser's cache.
      this.sampleCache.delete(want)
      this.node.port.postMessage({ samples: set }, [...new Set(set.loops.map((l) => l.data.buffer))])
      this.sound = 'recorded'
    } catch (e) {
      this.sampleCache.delete(car + ':' + this.optionsKey())
      if (this.soundFor !== want) return
      this.sound = 'synth'
      this.soundNote = 'The recordings could not be loaded, so this is the synthesised sound. (' + (e && e.message ? e.message : e) + ')'
    }
  }

  // Fetch and decode one car's loops, once. Each file carries a little of
  // its own wrap-around either side; loopSlice takes the exact loop, so the
  // codec's start and end never land in the seam.
  // The recorded mix's options that are on, as a cache key.
  options() { return Object.fromEntries(RECORDED_OPTIONS.map((k) => [k, this.settings[k]])) }
  optionsKey() { return RECORDED_OPTIONS.filter((k) => this.settings[k]).join(',') }

  loadSet(car) {
    const key = car + ':' + this.optionsKey()
    if (!this.sampleCache.has(key)) {
      // Only the set in use is kept decoded: with every option on one car's
      // loops are ~80 MB of Float32, and each car and option set its own.
      // Going back to an earlier one fetches it again (the browser's cache).
      this.sampleCache.clear()
      const ctx = this.ctx
      // One fetch and decode per file: a file can serve both layers.
      const files = new Map()
      const decoded = (file) => {
        if (!files.has(file)) {
          files.set(file, fetch(new URL('./sounds/' + file, import.meta.url)).then((r) => {
            if (!r.ok) throw new Error(file + ': HTTP ' + r.status)
            return r.arrayBuffer()
          }).then((ab) => ctx.decodeAudioData(ab)))
        }
        return files.get(file)
      }
      // The loops the chosen options call for (loopsFor in rev-samples.js);
      // the extra fields a loop carries (its throttle, a one-shot's kind)
      // pass through to the player.
      this.sampleCache.set(key, Promise.all(loopsFor(SAMPLE_SETS[car], this.options()).map(async (l) => {
        const buf = await decoded(l.file)
        const { file, src, render, start, seconds, level, exact, ...rest } = l
        return { ...rest, layer: l.layer || 'any', group: l.group || 'engine', gain: l.gain || 1, data: loopSlice(buf.getChannelData(0), buf.sampleRate, l), sr: buf.sampleRate }
      })).then((loops) => ({ loops, options: this.options() })))
    }
    return this.sampleCache.get(key)
  }

  // ── Live engine-sim (static/rev-live.js) ──
  // Started when chosen, the audio is up and Play while driving is on, for
  // the car and quality chosen; stopped otherwise (it costs a lot of
  // processor, so not while silent). Loaded on demand: the recorded mix never fetches it.
  // It plays into the worklet's input, so it goes through the cabin.
  syncLive() {
    const s = this.settings
    const want = s.engineSim === 'live' && this.audible ? s.profile + '@' + s.liveQuality : null
    if (want === this.liveFor) return
    this.liveFor = want
    this.liveNote = null
    if (this.live) { try { this.live.dispose() } catch {} this.live = null }
    if (!want) return
    // engine-sim simulates piston engines only: the jet always plays its
    // own rendered loops.
    if (SAMPLE_SETS[s.profile]?.kind !== 'engine-sim') {
      this.liveNote = 'Live engine-sim simulates piston engines only, so the ' + this.engine.profile.name + ' plays its rendered loops.'
      return
    }
    import('./rev-live.js')
      .then(async ({ LiveEngine }) => {
        if (this.liveFor !== want) return
        const live = new LiveEngine(this.ctx, this.node)
        this.live = live
        await live.load(s.profile, s.liveQuality)
      })
      .catch((e) => {
        if (this.liveFor !== want) return
        if (this.live) { try { this.live.dispose() } catch {} this.live = null }
        this.liveNote = 'Live engine-sim could not start, so this is the recorded mix. (' + (e && e.message ? e.message : e) + ')'
      })
  }
  // Live is heard only while it keeps up; otherwise the recorded loops are.
  get livePlaying() { return !!(this.live && this.live.playing) }

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
        // The direction of travel, for the dash's compass. The car's
        // browser keeps reporting it while parked.
        const h = pos.coords.heading
        if (Number.isFinite(h)) this.heading = { deg: ((h % 360) + 360) % 360, at: Date.now() }
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
      // gain: 1 while heard, 0 while Play while driving is off (the player
      // glides between them). The Volume is applied after the cabin and the
      // compressor (rev-loudness.js), so the slider turns everything down
      // evenly, live included.
      const gain = this.settings.enabled ? 1 : 0
      const live = this.livePlaying
      this.node.port.postMessage({ params: { rpm: s.rpm, load: s.load, gain: live ? 0 : gain, volume: this.settings.volume, exhaust: this.settings.exhaust, cabin: this.settings.cabin,
        shifting: s.shifting, limiter: !!s.limiter, gear: s.gear } })
      if (this.live) this.live.set({ rpm: s.rpm, load: s.load, gain, exhaust: this.settings.exhaust, idle: this.engine.profile.idle, stopped: s.stopped, limiter: !!s.limiter })
    }
    this.emit(t)
  }

  emit(t) {
    this.onState({ ...this.engine.state, source: this.source, fixRate: this.rate.get(t),
      simSpeed: this.sim.car.v, running: this.running, audible: this.audible, error: this.error,
      sound: this.livePlaying ? 'live' : this.sound, soundNote: this.liveNote || this.soundNote,
      live: this.live ? this.live.status() : null,
      redline: this.engine.profile.redline, idle: this.engine.profile.idle, turbine: !!this.engine.profile.turbine })
  }
}
