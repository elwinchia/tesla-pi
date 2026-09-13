#!/usr/bin/env node
// Does merely CLAIMING the dongle stop its idle reset loop?
//
// With nobody holding it open the CPC200 reboots itself on a ~13 s metronome
// (9.4 s attached / 3.4 s gone, measured 2026-09-02). That costs ~600 USB
// enumerations per boot — inrush spikes on a rail already reporting
// undervoltage — and leaves the dongle absent 26% of the time, so one CarPlay
// open in four waits an extra ~1.4 s for it to come back.
//
// The hypothesis is that the reset is a firmware watchdog waiting for a host,
// and that opening + claiming the interface satisfies it WITHOUT running
// node-carplay's init handshake — the part that actually captures the phone.
// If true we can hold the dongle quiet while idle and still not touch the phone.
//
// RESULT (2026-09-02, CPC200-CCPA pid 0x1521): NO EFFECT. baseline 6 cycles /
// claimed 6 / released 7 over 90 s phases. The claim succeeded — the dongle
// simply keeps resetting while a host holds its interface, so "nobody has it
// open" is not the trigger and this avenue is closed. Kept so the experiment is
// not repeated, and because it is a quick way to re-measure the cycle rate.
//
// What the result implies: the dongle wants actual protocol traffic (the init
// handshake), not merely a claimed interface. And it is probably not power —
// during a live CarPlay session, i.e. under HIGHER load, it stayed attached
// 109 s, whereas a brownout-driven oscillation should get worse under load.
// The remaining lever is CARPLAY_ON_DEMAND=off, which keeps the dongle
// initialised at the cost of capturing the phone whenever the Pi is powered.
//
// Three phases, so the comparison is controlled:
//   1 baseline  — watch, touch nothing
//   2 claimed   — open + claim interface 0, watch
//   3 released  — let go, watch (churn should return)
//
// Run with the service idle. It is read-only apart from the claim, and releases
// on any exit path.
import { usb } from 'usb'

const VID = 0x1314
const PIDS = new Set([0x1520, 0x1521])
const PHASE_S = Number(process.env.PHASE_S || 90)

const isDongle = (d) => d.deviceDescriptor.idVendor === VID && PIDS.has(d.deviceDescriptor.idProduct)

let attach = 0, detach = 0
usb.on('attach', (d) => { if (isDongle(d)) attach++ })
usb.on('detach', (d) => { if (isDongle(d)) detach++ })

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const find = () => usb.getDeviceList().find(isDongle)

async function phase(name) {
  attach = 0; detach = 0
  const t0 = Date.now()
  await sleep(PHASE_S * 1000)
  const s = Math.round((Date.now() - t0) / 1000)
  const present = !!find()
  console.log(`  ${name.padEnd(9)} ${s}s: attach=${attach} detach=${detach} ` +
              `cycles/min=${(attach / (s / 60)).toFixed(1)}  present_at_end=${present}`)
  return attach
}

async function waitPresent(timeoutS = 30) {
  const deadline = Date.now() + timeoutS * 1000
  while (Date.now() < deadline) {
    const d = find()
    if (d) return d
    await sleep(250)
  }
  return null
}

let claimed = null, opened = null
function release() {
  try { if (claimed) claimed.release(true, () => {}) } catch {}
  try { if (opened) opened.close() } catch {}
  claimed = null; opened = null
}
process.on('SIGINT', () => { release(); process.exit(130) })
process.on('exit', release)

;(async () => {
  console.log(`dongle idle-claim probe — ${PHASE_S}s per phase`)
  if (!find()) { console.log('  waiting for the dongle to appear…'); if (!await waitPresent()) { console.log('  never appeared — is it plugged in?'); process.exit(1) } }

  const base = await phase('baseline')

  const dev = await waitPresent()
  if (!dev) { console.log('  dongle gone before claim — rerun'); process.exit(1) }
  let held = 0
  try {
    dev.open()
    opened = dev
    const iface = dev.interfaces[0]
    if (iface.isKernelDriverActive()) iface.detachKernelDriver()
    iface.claim()
    claimed = iface
    console.log(`  claimed interface 0 (pid 0x${dev.deviceDescriptor.idProduct.toString(16)})`)
    held = await phase('claimed')
  } catch (e) {
    console.log(`  claim failed: ${e.message}`)
    release()
    process.exit(1)
  }
  release()
  console.log('  released')
  const after = await phase('released')

  console.log('')
  console.log(`verdict: baseline ${base} cycles, claimed ${held}, released ${after}`)
  if (held === 0 && base > 0) console.log('  HOLDING THE CLAIM STOPS THE RESET LOOP.')
  else if (held < base / 2) console.log('  partial effect — claim slows it but does not stop it')
  else console.log('  no effect — the claim does not satisfy the watchdog')
  process.exit(0)
})()
