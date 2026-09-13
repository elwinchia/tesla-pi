// dongle-firmware.js — the firmware library behind Settings → Dongle.
//
// What this can and cannot do, up front, because the shape of the module only
// makes sense once that is clear:
//
//   * It CANNOT flash the dongle. Carlinkit ship exactly two update paths — a
//     FAT32 USB stick the box reads at boot, or the box's own web page on its
//     private Wi-Fi AP — and neither is reachable from here. The USB link we do
//     have carries CarPlay, not firmware: the protocol's only write primitive
//     is SendFile (type 153), which drops a small file at a fixed path like
//     /tmp/screen_dpi. Pushing a 12 MB image at a guessed path and hoping the
//     box's updater notices is how you end up with a brick and no way back.
//   * The box's web page lives on its own AP, which BoxInfo reports as channel
//     36. Our only client radio is an RTL8188EUS — 2.4 GHz only. It cannot
//     associate with that AP at any setting, and it is also the machine's only
//     route to the house, so borrowing it would strand the device anyway.
//
// So the honest job is everything either side of the physical step: know which
// build is running, know which builds exist, fetch one onto the device with its
// integrity checked, and write it to a stick the box will accept — leaving the
// human with one task, moving that stick, instead of five.
//
// Integrity: every build is pinned by size AND by its git blob hash, and the
// download URL names an immutable commit rather than a branch. The blob hash is
// what GitHub itself stores — sha1("blob <len>\0" + bytes) — so we can verify
// bytes we have never seen against a value published independently of the file.
// A mismatch deletes the download rather than offering it to a stick.

import { createHash } from 'node:crypto'
import fs from 'node:fs/promises'
import fsSync from 'node:fs'
import path from 'node:path'

// Pinned commit in den67rus/Carlinkit-CPC200-Autokit-Firmware. A branch name
// here would mean the bytes behind a version could change without the version
// changing — exactly what the size/hash pins exist to rule out. Bump this
// deliberately, and re-pin the table below when you do.
export const FIRMWARE_COMMIT = 'ef5f428ce04e0bef2723b974143e0e50b4c2d54e'
export const FIRMWARE_REPO = 'den67rus/Carlinkit-CPC200-Autokit-Firmware'

const rawUrl = (dir, file) =>
  `https://raw.githubusercontent.com/${FIRMWARE_REPO}/${FIRMWARE_COMMIT}/Firmware/${dir}/${file}`

// Only the CCPA is listed, because it is the only model we can positively
// identify: the box reports productType "A15W", and that string is also the
// name its updater looks for on the stick. Other Carlinkit models (CCPW's
// Auto_Box_Update.img, the U2W line) use the same repo but we have no
// identifying field to match them on, so offering their images would be
// guessing with a flashable payload.
export const MODELS = {
  A15W: {
    productType: 'A15W',
    model: 'CPC200-CCPA',
    aka: 'Carlinkit 3.0 / AutoKit',
    dir: 'CPC200-CCPA',
    // What the box's updater looks for in the root of the stick. The image is
    // stored here under its versioned name and renamed to this on the way out,
    // so a stick can only ever hold one candidate and it is never ambiguous
    // which one the box will take.
    updateName: 'A15W_Update.img',
    prefix: 'A15W_Update_',
    // `rollback` is the version the changelog says this build can be taken back
    // to. A build with no rollback target is a one-way door and the page says
    // so loudly — that is the single most important fact on this list.
    builds: [
      { version: '2022.04.25.1317', size: 11879653, gitSha: 'fb22315d625d2ca1c69c41ff418fa0ac24231a6a', rollback: null },
      { version: '2022.11.19.1218', size: 10681840, gitSha: 'b48e9cc3dc996bd441b757e96f20105af58cbc63', rollback: null },
      { version: '2023.05.29.1924', size: 10815339, gitSha: 'b4063ca08310236160748b09d0de5db43e809349', rollback: '2022.11.19.1218' },
      { version: '2023.09.27.1710', size: 13177318, gitSha: '40d2e4556a7f7f2856f2af80ea395f2b2d1e3d9b', rollback: null },
      { version: '2024.01.19.1541', size: 13182670, gitSha: '9c7f202a62520a6d68e2df7d55c45cd36302efb5', rollback: '2023.09.27.1710' },
      { version: '2024.08.07.2014', size: 11540332, gitSha: 'd68c5d4e132980bc1e6c95e8195d83b066ef5e2f', rollback: '2024.01.19.1541' },
      { version: '2024.09.03.1028', size: 10596018, gitSha: '04353f5b5b0dfbada4a7af180b96a437b6347061', rollback: '2024.01.19.1541' },
    ],
    // Published upstream, deliberately NOT offered. `withheld` is not read by
    // catalogFor() or fetchBuild(), so these never reach the page and cannot be
    // downloaded even by asking for the version directly — but they stay here,
    // with the reason, so a future sync against upstream re-adds them only as a
    // deliberate act rather than by "the catalogue looks out of date".
    //
    // The bar for withholding is `rollback: null` — the changelog names no
    // build this one can be taken back to. That is the whole case, and it is
    // enough: every other build in the list is a mistake you can undo with a
    // second stick, and this one is not.
    //
    // Be precise about the encrypted-framing risk rather than repeating it as
    // fact. The 0x55bb55bb framing this project cannot read is documented
    // against a 2025.10.XX firmware — NEWER than anything in this catalogue —
    // so there is no evidence that this build, or any build listed above,
    // actually ships it. It is an unknown, not a known. An unknown you can roll
    // back from is a risk; an unknown you cannot is a one-way door.
    withheld: [
      {
        version: '2025.02.25.1521',
        size: 12585685,
        gitSha: 'ccd7cf4d119dc40f4d5ddee1c50d50f9bcdb28c9',
        rollback: null,
        reason: 'no rollback target documented, so a bad outcome cannot be '
              + 'undone. Changelog offers nothing but "Bug Fixes and '
              + 'Improvements" against it, so the upside is unknown too.',
      },
    ],
  },
}

// The dongle reports e.g. "2024.01.19.1541CAY": a build stamp with a trailing
// variant tag. The stamp is what matches the catalogue; the tag is carried
// separately so the page can still show the full string it was given.
const VERSION_RE = /^(\d{4}\.\d{2}\.\d{2}\.\d{4})(.*)$/

export function parseVersion(raw) {
  const s = String(raw ?? '').replace(/\0/g, '').trim()
  const m = VERSION_RE.exec(s)
  if (!m) return { raw: s || null, stamp: null, variant: null }
  return { raw: s, stamp: m[1], variant: m[2] || null }
}

export function modelFor(productType) {
  const key = String(productType ?? '').replace(/\0/g, '').trim().toUpperCase()
  return MODELS[key] || null
}

// Sorts by the build stamp, which is already lexicographically chronological.
const cmpVersion = (a, b) => (a < b ? -1 : a > b ? 1 : 0)

// The catalogue as the page wants it: newest first, each build labelled
// relative to what is actually running. `newer`/`older`/`current` drives the
// whole UI, and it is computed here rather than in the browser so that a device
// with an unrecognised firmware string still gets a coherent list.
export function catalogFor(model, runningStamp) {
  if (!model) return []
  return model.builds
    .slice()
    .sort((a, b) => cmpVersion(b.version, a.version))
    .map((b) => ({
      ...b,
      fileName: model.prefix + b.version + '.img',
      url: rawUrl(model.dir, model.prefix + b.version + '.img'),
      current: !!runningStamp && b.version === runningStamp,
      newer: !!runningStamp && cmpVersion(b.version, runningStamp) > 0,
      older: !!runningStamp && cmpVersion(b.version, runningStamp) < 0,
    }))
}

// ---- integrity ------------------------------------------------------------
// GitHub's per-file `sha` is a git blob id, not a hash of the bytes alone:
// sha1("blob " + length + "\0" + content). Reproducing it lets us check a
// download against a value we fetched from a completely different endpoint.
function blobHasher(size) {
  const h = createHash('sha1')
  h.update(Buffer.from(`blob ${size}\0`, 'utf8'))
  return h
}

// ---- the local store ------------------------------------------------------

const PART_SUFFIX = '.part'

// `urlFor` exists so scripts/test-dongle-firmware.mjs can point the downloader
// at a local server and prove the size/hash gates actually reject bad bytes.
// Production never passes it: the URL must come from the pinned catalogue.
export function createFirmwareStore({ dir, log, maxBytes = 64 * 1024 * 1024, urlFor = null }) {
  const buildUrl = urlFor || ((model, name) => rawUrl(model.dir, name))
  // One download at a time. The device has one dongle, one stick and one
  // person pressing buttons; a queue would be machinery with no user.
  let job = null
  let abort = null

  const filePath = (name) => path.join(dir, name)

  // Best-effort. A store that cannot be created is a device where the dongle
  // installer has not run (/var/lib is not ours to write), and that must not be
  // fatal: browsing the catalogue, identifying the box and reading the flashing
  // instructions are the parts of this section that need no disk at all.
  // Throwing here used to take the whole of /dongle/info down — and because the
  // request handler's outer catch answers any exception with a bare 404, the
  // page could not tell "not installed" from "route does not exist".
  // Callers that genuinely need to write (fetchBuild) still surface the failure.
  async function ensureDir({ required = false } = {}) {
    try {
      await fs.mkdir(dir, { recursive: true })
      return true
    } catch (err) {
      if (required) throw err
      return false
    }
  }

  // Free space on the store's filesystem, or null where the runtime cannot say.
  // A 12 MB image onto a full SD card is a failure worth predicting rather than
  // discovering half way through.
  async function freeBytes() {
    try {
      // Own ensureDir rather than relying on a caller's: /dongle/info asks for
      // this and the listing in parallel, and statfs on a directory that the
      // other half is still creating reports nothing at all.
      await ensureDir()
      const st = await fs.statfs(dir)
      return Number(st.bavail) * Number(st.bsize)
    } catch { return null }
  }

  // What is on disk, matched back to the catalogue. Anything that does not
  // match a known build is reported as `unknown` rather than hidden, because a
  // stray .img in this directory is something the operator should see.
  async function list(model) {
    if (!(await ensureDir())) return []
    let names = []
    try { names = await fs.readdir(dir) } catch { return [] }
    const byFile = new Map()
    if (model) for (const b of model.builds) byFile.set(model.prefix + b.version + '.img', b)
    const out = []
    for (const name of names) {
      if (!name.endsWith('.img')) continue
      let st
      try { st = await fs.stat(filePath(name)) } catch { continue }
      const b = byFile.get(name)
      out.push({
        name,
        version: b ? b.version : null,
        bytes: st.size,
        // A file whose size no longer matches the pin is corrupt or truncated;
        // say so rather than letting it look like a usable image.
        ok: b ? st.size === b.size : null,
        at: st.mtimeMs,
      })
    }
    return out.sort((a, b) => (a.name < b.name ? 1 : -1))
  }

  async function has(model, version) {
    const b = model?.builds.find((x) => x.version === version)
    if (!b) return false
    try {
      const st = await fs.stat(filePath(model.prefix + version + '.img'))
      return st.size === b.size
    } catch { return false }
  }

  // Downloads one catalogued build. The version is looked up in the catalogue
  // and the URL is built from it — no caller, and certainly no browser, ever
  // supplies a URL. That is what keeps this from being a fetch-anything proxy
  // that happens to write executable payloads to removable media.
  async function fetchBuild(model, version) {
    if (job && job.state === 'running') return { ok: false, error: 'busy', job: snapshot() }
    const build = model?.builds.find((b) => b.version === version)
    if (!build) return { ok: false, error: 'unknown_version' }
    if (build.size > maxBytes) return { ok: false, error: 'too_large' }

    // This one genuinely needs somewhere to write, so a store that cannot be
    // created is a real error the page must show rather than a silent no-op.
    try { await ensureDir({ required: true }) }
    catch (err) { return { ok: false, error: 'store_unwritable', dir, detail: err.code || err.message } }
    const free = await freeBytes()
    if (free != null && free < build.size * 2) {
      return { ok: false, error: 'no_space', free, need: build.size * 2 }
    }

    const name = model.prefix + version + '.img'
    const url = buildUrl(model, name)
    const dest = filePath(name)
    const part = dest + PART_SUFFIX

    abort = new AbortController()
    job = {
      version, name, state: 'running', received: 0, total: build.size,
      error: null, startedAt: Date.now(), finishedAt: null, gitSha: null,
    }
    log('info', 'firmware_fetch_start', { version, size: build.size, url })

    // Deliberately not awaited: the route answers 202 and the page polls the
    // job, because a 12 MB pull over a phone hotspot outlives any sane
    // request timeout in a car.
    ;(async () => {
      let fh = null
      try {
        const res = await fetch(url, { signal: abort.signal, redirect: 'follow' })
        if (!res.ok || !res.body) throw new Error('http ' + res.status)
        fh = await fs.open(part, 'w')
        const hash = blobHasher(build.size)
        for await (const chunk of res.body) {
          job.received += chunk.length
          // Stop a runaway response before it fills the card, rather than
          // after. The pinned size is the contract; anything longer is wrong
          // whatever it claims to be.
          if (job.received > build.size) throw new Error('oversize')
          hash.update(chunk)
          await fh.write(chunk)
        }
        await fh.close(); fh = null
        if (job.received !== build.size) throw new Error(`size ${job.received} != ${build.size}`)
        const got = hash.digest('hex')
        job.gitSha = got
        if (got !== build.gitSha) throw new Error(`hash ${got} != ${build.gitSha}`)
        await fs.rename(part, dest)
        job.state = 'done'
        job.finishedAt = Date.now()
        log('info', 'firmware_fetch_done', { version, bytes: build.size, gitSha: got })
      } catch (err) {
        if (fh) { try { await fh.close() } catch {} }
        // A part-file that failed verification must not survive: the next call
        // would resume nothing and the stick writer only ever sees whole,
        // checked images.
        try { await fs.unlink(part) } catch {}
        job.state = abort?.signal.aborted ? 'cancelled' : 'error'
        job.error = String(err && err.message)
        job.finishedAt = Date.now()
        log('warn', 'firmware_fetch_failed', { version, state: job.state, msg: job.error })
      } finally {
        abort = null
      }
    })()

    return { ok: true, job: snapshot() }
  }

  function cancel() {
    if (!job || job.state !== 'running') return { ok: false, error: 'idle' }
    abort?.abort()
    return { ok: true }
  }

  async function remove(model, version) {
    const build = model?.builds.find((b) => b.version === version)
    if (!build) return { ok: false, error: 'unknown_version' }
    const name = model.prefix + version + '.img'
    try {
      await fs.unlink(filePath(name))
      log('info', 'firmware_removed', { version })
      return { ok: true }
    } catch (err) {
      if (err.code === 'ENOENT') return { ok: false, error: 'not_present' }
      return { ok: false, error: String(err.message) }
    }
  }

  const snapshot = () => (job ? { ...job } : null)

  return { list, has, fetchBuild, cancel, remove, job: snapshot, freeBytes, dir, filePath }
}

// Whether the store directory is usable at all. A read-only or missing parent
// is a configuration problem the page should state plainly rather than
// surfacing as a failed download three clicks later.
export function storeWritable(dir) {
  try {
    fsSync.mkdirSync(dir, { recursive: true })
    fsSync.accessSync(dir, fsSync.constants.W_OK)
    return true
  } catch { return false }
}
