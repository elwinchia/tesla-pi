// The recorded engine loops (static/sounds/) and their credits
// (static/rev-samples.js, static/sounds/CREDITS.md): every file is there,
// credited, under an allowed licence, from the page it claims, and small.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { SAMPLE_SETS, CREDITS, ALLOWED_LICENCES, loopSeconds, creditsFor, creditLine, hasRecording } from '../static/rev-samples.js'
import { PROFILES } from '../static/rev-profiles.js'

const DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'static', 'sounds')
const BUDGET = 3 * 1024 * 1024 // bytes, all cars together (the car loads only its own)

test('every recorded car is a real car sound with loops at two or more rpm points', () => {
  for (const [car, set] of Object.entries(SAMPLE_SETS)) {
    const p = PROFILES[car]
    assert.ok(p, `${car} is not a car sound`)
    assert.ok(new Set(set.loops.map((l) => l.rpm)).size >= 2, `${car}: one rpm point is not enough to pitch between`)
    for (const l of set.loops) {
      assert.match(l.file, /^[a-z0-9-]+\.ogg$/, l.file)
      assert.ok(['on', 'off', 'any', undefined].includes(l.layer), `${l.file} layer`)
      assert.ok(l.rpm >= p.idle * 0.6 && l.rpm <= p.redline * 1.05, `${l.file}: ${l.rpm} rpm is outside ${car}'s range`)
      assert.ok(l.start >= 0 && l.seconds >= 0.3 && l.seconds <= (l.exact ? 8 : 6), `${l.file} cut`)
      // Rev points are cut to whole cycles; an idle is cut where its own
      // waveform repeats (exact), since it never runs at one steady rpm.
      if (l.exact) assert.equal(loopSeconds(l), l.seconds, `${l.file}: exact`)
      else assert.ok(Math.abs(loopSeconds(l) - l.seconds) <= 120 / l.rpm, `${l.file}: whole cycles`)
      assert.ok(Object.hasOwn(CREDITS, l.src), `${l.file}: no credit for ${l.src}`)
    }
  }
})

test('each idle is fitted: long enough not to repeat audibly, played at its own pitch', () => {
  for (const [car, set] of Object.entries(SAMPLE_SETS)) {
    const idles = set.loops.filter((l) => l.render === 'idle')
    assert.ok(idles.length >= 2, car)
    for (const l of idles) {
      assert.ok(l.exact, `${l.file}: cut to its fitted length`)
      assert.ok(l.seconds >= 4, `${l.file}: ${l.seconds} s repeats too often`)
      // The model idles at the loop's rpm, so the idle is not pitch-shifted.
      assert.equal(l.rpm, PROFILES[car].idle, `${l.file}: ${l.rpm} rpm vs the profile's ${PROFILES[car].idle}`)
    }
  }
})

test('every file is in the folder, is Ogg Opus, and the folder holds nothing else', () => {
  const listed = new Set(Object.values(SAMPLE_SETS).flatMap((s) => s.loops.map((l) => l.file)))
  const present = fs.existsSync(DIR) ? fs.readdirSync(DIR) : []
  for (const f of listed) {
    assert.ok(present.includes(f), `${f} missing`)
    const head = fs.readFileSync(path.join(DIR, f)).subarray(0, 64).toString('latin1')
    assert.ok(head.startsWith('OggS') && head.includes('OpusHead'), `${f} is not Ogg Opus`)
  }
  for (const f of present) assert.ok(listed.has(f) || f === 'CREDITS.md', `${f} is not credited or not used`)
  const total = [...listed].reduce((s, f) => s + fs.statSync(path.join(DIR, f)).size, 0)
  assert.ok(total <= BUDGET, `${(total / 1024).toFixed(0)} kB of loops, budget ${BUDGET / 1024} kB`)
})

test('every credit is an allowed licence, points at its own Freesound page (or the official engine-sim repo), and is used', () => {
  const used = new Set(Object.values(SAMPLE_SETS).flatMap((s) => s.loops.map((l) => l.src)))
  for (const [id, c] of Object.entries(CREDITS)) {
    assert.ok(Object.hasOwn(ALLOWED_LICENCES, c.licence), `${id}: ${c.licence} is not allowed`)
    assert.equal(c.licenceUrl, ALLOWED_LICENCES[c.licence].url, `${id} licence link`)
    assert.ok(used.has(id), `${id} is credited but not used`)
    if (c.kind === 'render') {
      // Our own renders: only from the official engine-sim repo, MIT.
      assert.equal(c.url, 'https://github.com/ange-yaghi/engine-sim')
      assert.equal(c.licence, 'MIT')
      assert.match(c.commit, /^[0-9a-f]{7,40}$/)
      assert.ok(c.engineScripts.length >= 1)
      for (const x of c.engineScripts) assert.match(x, /^(assets\/engines\/.+\.mr|scripts\/engine-sim\/.+\.mr \(ours\))$/)
      // Every set's script is one we ship.
      for (const set of Object.values(SAMPLE_SETS)) assert.ok(fs.existsSync(path.join(DIR, '..', '..', set.script)), set.script)
      continue
    }
    assert.notEqual(c.licence, 'MIT', `${id}: MIT is for renders only`)
    const n = id.replace(/^fs/, '')
    assert.equal(c.url, `https://freesound.org/people/${c.author}/sounds/${n}/`, `${id} page`)
    assert.match(c.audio, new RegExp(`^https://cdn\\.freesound\\.org/previews/${n.slice(0, -3) || '0'}/${n}_\\d+-hq\\.mp3$`), `${id} audio`)
    assert.match(c.fetched, /^\d{4}-\d{2}-\d{2}$/)
    for (const f of ['title', 'author', 'recording']) assert.ok(typeof c[f] === 'string' && c[f].length > 2, `${id}.${f}`)
  }
})

test('CREDITS.md names every recording, its author, page and licence', () => {
  const ids = Object.keys(CREDITS)
  if (!ids.length) return
  const md = fs.readFileSync(path.join(DIR, 'CREDITS.md'), 'utf8')
  for (const id of ids) {
    const c = CREDITS[id]
    for (const s of [c.url, c.author, c.licence, c.kind === 'render' ? c.commit : c.audio]) assert.ok(md.includes(s), `CREDITS.md lacks ${s}`)
  }
})

test('a recorded car shows a credit line that names the work, author and licence', () => {
  for (const car of Object.keys(PROFILES)) {
    const cs = creditsFor(car)
    assert.equal(cs.length > 0, hasRecording(car))
    for (const c of cs) {
      const line = creditLine(c)
      assert.ok(line.includes(c.title) && line.includes(c.author) && line.includes(c.licence))
    }
  }
})

test('a cut is made into a seamless loop, even when it is not a whole number of periods', async () => {
  const { makeLoop } = await import('../scripts/rev-samples.mjs')
  const sr = 48000, len = 30011, fade = 4800
  const seg = new Float32Array(len + fade)
  for (let i = 0; i < seg.length; i++) seg[i] = 0.5 * Math.sin(2 * Math.PI * 101.3 * i / sr) + 0.2 * Math.sin(2 * Math.PI * 233.7 * i / sr)
  const raw = Math.abs(seg[0] - seg[len - 1])
  const x = makeLoop(seg, len, fade)
  assert.equal(x.length, len)
  let worst = 0
  for (let i = 1; i < len; i++) worst = Math.max(worst, Math.abs(x[i] - x[i - 1]))
  const seam = Math.abs(x[0] - x[len - 1])
  assert.ok(seam <= worst, `seam ${seam} vs largest step ${worst}`)
  assert.ok(raw > 5 * worst, 'the plain cut would have clicked')
  assert.throws(() => makeLoop(seg, len + 1, fade))
})

test('an engine-sim car has an on-load and an overrun loop at every rev point, and idles in both, for engine and exhaust', () => {
  for (const [car, set] of Object.entries(SAMPLE_SETS)) {
    if (set.kind !== 'engine-sim') continue
    const groups = [...new Set(set.loops.map((l) => l.group || 'engine'))]
    const points = {}
    for (const g of groups) {
      const loops = set.loops.filter((l) => (l.group || 'engine') === g)
      const on = loops.filter((l) => l.layer === 'on').map((l) => l.rpm).sort((a, b) => a - b)
      const off = loops.filter((l) => l.layer === 'off').map((l) => l.rpm).sort((a, b) => a - b)
      assert.deepEqual(on, off, `${car} ${g}: layers cover different rpm`)
      assert.ok(on.length >= 6, `${car} ${g}: ${on.length} rev points`)
      assert.ok(loops.every((l) => l.src === 'enginesim' && l.level > 0 && l.level <= 1 && typeof l.render === 'string'), `${car} ${g}`)
      // Each step is small enough that no loop is stretched far.
      for (let i = 1; i < on.length; i++) assert.ok(on[i] / on[i - 1] <= 1.75, `${car} ${g}: gap ${on[i - 1]}-${on[i]}`)
      assert.ok(PROFILES[car].redline / on[on.length - 1] < 1.1, `${car} ${g}: the top loop is far below redline`)
      // Overrun is not louder than pulling at the same rpm (allowing the
      // near-equal levels a simulation gives close to the limiter).
      for (const r of on.slice(1)) {
        const a = loops.find((l) => l.layer === 'on' && l.rpm === r), b = loops.find((l) => l.layer === 'off' && l.rpm === r)
        assert.ok(b.level <= a.level * 1.1, `${car} ${g} ${r}: overrun louder than on-load`)
      }
      points[g] = on
      // Every group renders from its own folder through its own impulse response.
      assert.ok(typeof set.renders === 'string' || set.renders[g], `${car} ${g}: no renders`)
      assert.ok(typeof set.ir === 'string' || set.ir[g], `${car} ${g}: no impulse response`)
    }
    if (points.exhaust) assert.deepEqual(points.exhaust, points.engine, `${car}: engine and exhaust at different rpm`)
  }
  assert.equal(SAMPLE_SETS.v8.kind, 'engine-sim')
  assert.ok(SAMPLE_SETS.v8.loops.some((l) => l.group === 'exhaust'), 'the V8 has an exhaust')
})

test('every car plays engine-sim loops, with both an engine and an exhaust group', () => {
  for (const car of Object.keys(PROFILES)) {
    const set = SAMPLE_SETS[car]
    assert.ok(set, `${car} has no loops`)
    assert.equal(set.kind, 'engine-sim', car)
    const groups = new Set(set.loops.map((l) => l.group))
    assert.ok(groups.has('engine') && groups.has('exhaust'), `${car}: ${[...groups]}`)
  }
})
