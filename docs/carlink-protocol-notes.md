# Carlink dongle protocol notes

Reference notes pulled from [lvalen91/Carlink](https://github.com/lvalen91/Carlink) — an independent Flutter/AAOS implementation that targets the same Carlinkit CPC200-CCPA dongle this project uses. The repo's `Documents/Firmware/RE_Documention/` tree contains binary-verified reverse engineering of the dongle firmware (`ARMadb-driver_unpacked`, firmware 2025.10.XX) and is the durable bit — the rest of the Carlink repo itself is marked "consider as-is" by its author.

Not a protocol reference. Pointers to the parts of that tree we've actually needed, plus the one finding that already informed a change in `index.js`.

---

## Wireless CarPlay connection flow

Source: `Documents/Firmware/RE_Documention/02_Protocol_Reference/wireless_carplay.md`.

1. **BLE advertising** by the dongle — iPhone scans, discovers, connects.
2. **Bluetooth Classic / RFCOMM** — iPhone connects to the dongle's `Wireless iAP` SDP record (UUID `00000000-deca-fade-deca-deafdecacafe`, channel 1). WiFi credentials are handed over here.
3. **WiFi join** — iPhone joins the dongle's 5 GHz AP (192.168.43.0/24; dongle is 192.168.43.1).
4. **RTSP on TCP 5000** — `POST /pair-verify` (Curve25519, header `X-Apple-HKP: 2`) for reconnects; `POST /pair-setup` (SRP-6a, 3072-bit, SHA-512) for first-time pairing.
5. **Encrypted streams** — ChaCha20-Poly1305 AEAD; video on TCP 7000, audio on TCP 7001.

Implication for our reconnection problem: the first step on every session is **BLE advertising by the dongle**. If the dongle isn't advertising, the iPhone can only fall back to Classic-BT page-scan, which iOS retries lazily.

---

## Dongle command IDs that matter for connection state

Source: `Documents/Firmware/RE_Documention/02_Protocol_Reference/command_ids.md`. Commands are 4-byte payloads on USB message type `0x08`.

| ID | node-carplay name | Effect |
|---|---|---|
| 28 | — *(not exposed)* | `StartStandbyMode` — dongle enters low-power |
| 29 | — *(not exposed)* | `StopStandbyMode` |
| 30 | — *(not exposed)* | `StartBleAdv` — start BLE advertising |
| 31 | — *(not exposed)* | `StopBleAdv` |
| 1000 | `wifiEnable` | Enable WiFi mode |
| 1001 | `autoConnetEnable` | Enable auto-connect mode |
| **1002** | **`wifiConnect`** | **Initiate auto-connect to last-paired phone** |
| 1011 | `btPairStart` | Begin BT pair search |
| 1012 | `wifiPair` | Enter WiFi pairing mode |

Commands 28–31 are absent from node-carplay's `CommandMapping`; driving them requires patching node-carplay or sending raw `SendCommand` bytes. The rest are wired up via `carplay.sendKey('<name>')`.

### Media commands (200–205) — and the missing playOrPause

Same source. All are "forwarded to phone" by the dongle:

| ID | Firmware name | node-carplay 4.1.0 name |
|---|---|---|
| 200 | MusicACHome | `home` |
| 201 | MusicPlay | `play` |
| 202 | MusicPause | `pause` |
| 203 | MusicPlayOrPause | — *(not exposed)* |
| 204 | MusicNext | `next` |
| 205 | MusicPrev | `prev` |

node-carplay 4.1.0 skips 203, so `sendKey('playOrPause')` looks up
`undefined` and throws (`writeUInt32LE(undefined)`) — the 3-finger-tap
play/pause gesture silently did nothing while next/prev worked. `index.js`
now sends the raw 20-byte command frame (`MessageHeader.asBuffer(0x08, 4)` +
u32LE 203) via the same inline-`serialise` technique as multitouch.

---

## node-carplay's one-shot pairing window — root cause of "have to tap BT"

Sources: `node-carplay/src/modules/DongleDriver.ts` and `node-carplay/src/node/CarplayNode.ts`.

- `DongleDriver.start()` sends the init messages, then `wifiConnect` (1002) at **+1 s**.
- `CarplayNode.start()` sets a `_pairTimeout` that fires `wifiPair` (1012) at **+15 s** if no phone has appeared.
- Both timers are cleared the moment a `Plugged`/`Video`/`Audio`/`Media` message arrives.
- **No further retries.** node-carplay just sits in the read loop.

With an always-on Pi, the iPhone returns hours after boot — long after that 16-second window closed. The dongle is idle and waiting for the iPhone to initiate. Tapping the dongle in iPhone BT Settings works because the iPhone becomes the initiator. Restarting `mytesla.service` works because it re-runs `start()` and re-fires the two pokes.

Our response, in `index.js`:

- **Periodic poke**: re-send `wifiConnect` every 15 s while `!plugged && carplayStarted`. Single 16-byte USB write per tick, negligible cost.
- **WS-wake poke**: when the Tesla browser's control WS reconnects (high-signal "user just got in the car"), fire `wifiConnect` + `wifiPair` immediately so we don't wait up to a full tick.

Logs to verify in `journalctl -u mytesla -f`:

- `autoconnect_poke` (debug) — periodic tick fired.
- `autoconnect_poke_wake` (info) — Tesla browser connected while no phone session.
- `phone_plugged` — dongle handed the iPhone off to us; pokes will stop on their own.

---

## Heartbeat — already correct, listed so future debugging skips it

Source: `Documents/Firmware/RE_Documention/01_Firmware_Architecture/heartbeat_analysis.md`.

- Firmware resets the USB connection if it doesn't see a heartbeat for **15 s** (hardcoded at `0x21112`).
- Recommended interval is **2000 ms**; node-carplay uses exactly that (`DongleDriver.start()` → `setInterval(..., 2000)`).
- Cold start requires heartbeat to begin **before** init messages, or pairing fails with `projectionDisconnected` after ~11.7 s. node-carplay orders this correctly.

Nothing to do here.

---

## MultiTouch (msg type 0x17) — verified working on this dongle, 2026-05-16

Empirical finding (`docs/plan.md:57` previously assumed Apple CarPlay disallows pinch-zoom; that's wrong for this firmware). With the CPC200-CCPA firmware running on our unit, USB message type **0x17** is honored end-to-end and iOS treats simultaneous touches as a gesture source — Apple Maps pinch-zoom works.

The Carlink RE docs in `02_Protocol_Reference/` don't cover 0x17 explicitly. This is the wire format we're using (lifted from upstream `node-carplay` `src/modules/messages/sendable.ts` and confirmed against our dongle):

- **Header** — standard 16-byte `MessageHeader` (`magic=0x55aa55aa`, `length=N*16`, `type=0x17`, `typeCheck=~type`).
- **Body** — N × 16 bytes, one block per finger, in slot-order:

  | Offset | Size | Field | Notes |
  |---|---|---|---|
  | 0x00 | 4 | x | float32 LE, 0.0–1.0 |
  | 0x04 | 4 | y | float32 LE, 0.0–1.0 |
  | 0x08 | 4 | action | u32 LE: 0=Up, 1=Down, 2=Move (NB: different from `SendTouch`'s 14/15/16) |
  | 0x0C | 4 | id | u32 LE, **bound to array index** — caller must ship slot 0 first |

- **No length prefix on the body.** Dongle derives N from `header.length / 16`.
- **No way to rename an id mid-gesture.** When the slot-0 finger lifts mid-pinch and slot 1 survives, do a clean break: send `[{Up, Up}]` for both slots, then `[{Down}]` for the survivor on slot 0. Anything else (e.g. `[{action:Move}]` with the survivor at array-index 0 carrying its old slot-1 position) makes iOS see a teleporting finger and drops the gesture. Implemented in `static/index.html`'s `handleTouchEnd` (the `zeroEnding && survivorIds.length === 1` branch).

**Why we inline the wire format in `index.js` instead of using `SendMultiTouch`**: node-carplay 4.1.0 (pinned in `package.json`) doesn't export `SendMultiTouch` — it was added upstream after our pin. Rather than bump the dep and inherit unrelated upstream changes, `index.js` builds the wire bytes directly using the exported `MessageHeader.asBuffer(0x17, N*16)` and hands an inline `{ serialise }` to `carplay.dongleDriver.send`. The frontend serializes WS payloads as `{ type: 'multitouch', data: [{slot, action, x, y}, ...] }` in slot-order; the server rejects misordered slots with a `multitouch_slot_misorder` warn.

Verified in-car 2026-05-16 — single-tap (via 1-element multitouch), two-finger contact, pinch-zoom on Apple Maps, 3-finger gesture coexistence, and the multi→single clean-break case all pass. The `touchcancel` mid-pinch case (Step F in the plan) is unverified empirically but the handler explicitly flushes Ups for all active slots.

---

## When the Carlink repo is worth re-opening

- Audio routing changes (`UseCarMic`, `UseBoxMic`, mic sample rate) — `command_ids.md` + `host_app_guide.md` audio sections.
- iPhone won't pair on a fresh dongle — `wireless_carplay.md` SRP-6a / pair-setup flow.
- USB enumeration / IDR-frame quirks — `host_app_guide.md`, `02_Protocol_Reference/usb_protocol.md`, `02_Protocol_Reference/video_protocol.md`.
- BoxSettings fields beyond the four node-carplay sends — `host_app_guide.md` lists the full schema, notably `autoConn`, `autoPlay`, `bgMode`, `startDelay`, `WiFiChannel`. node-carplay's `SendBoxSettings` sends only `mediaDelay`, `syncTime`, `androidAutoSizeW/H` — anything else needs a patched build.
- Active-attack ideas against the dongle web UI — `03_Security_Analysis/vulnerabilities.md` documents a `popen()`-via-`wifiName`/`btName` shell injection in `BoxSettings` that runs as root. Useful context, not something we'd ship.
