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

With an always-on Pi, the iPhone returns hours after boot — long after that 16-second window closed. The dongle is idle and waiting for the iPhone to initiate. Tapping the dongle in iPhone BT Settings works because the iPhone becomes the initiator. Restarting `tesla-pi.service` works because it re-runs `start()` and re-fires the two pokes.

Our response, in `index.js`:

- **Periodic poke**: re-send `wifiConnect` every 15 s while `!plugged && carplayStarted`. Single 16-byte USB write per tick, negligible cost.
- **WS-wake poke**: when the Tesla browser's control WS reconnects (high-signal "user just got in the car"), fire `wifiConnect` + `wifiPair` immediately so we don't wait up to a full tick.

Logs to verify in `journalctl -u tesla-pi -f`:

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

---

## MediaData (msg type 42) — now playing

node-carplay 4.1.0 already decodes this one; we simply ignored it until 2026-08-20,
so it showed up in the logs as `carplay_event_unknown` with `type: "media"`.

Two payload flavours arrive as separate messages, distinguished by a leading u32:

| Payload type | Body | Notes |
|---|---|---|
| 1 (`Data`) | UTF-8 JSON, trailing NUL stripped by node-carplay | `MediaSongName`, `MediaAlbumName`, `MediaArtistName`, `MediaAPPName`, `MediaSongDuration`, `MediaSongPlayTime` |
| 3 (`AlbumCover`) | raw image bytes, base64'd by node-carplay | no content type on the wire — `index.js` sniffs the magic number (`/9j/` → JPEG, `iVBORw0KGgo` → PNG) rather than guessing, because Chromium does not reliably sniff a data: URL that declares the wrong mime |

Handling notes, all in `index.js`'s `handleMedia`:

- **Fields arrive partially.** A payload carrying `MediaSongName` is treated as a
  whole new track; one without it is a position tick and gets merged onto the
  existing state, otherwise the strip blanks itself every second.
- **No play/pause flag exists** anywhere in this message. The client therefore
  never advances the progress bar on its own timer — it would keep crawling
  through a pause and lie about the position.
- **Cover art and track are broadcast separately** so a position tick doesn't
  re-ship tens of KB of artwork, and both are replayed to a control client on
  connect (a browser that loads mid-song would otherwise stay blank until the
  next track change).
- `payload` is `undefined` for media types node-carplay doesn't know (it logs
  `Unexpected media type` and returns) — the handler checks for that.

**Unverified on our firmware.** The dongle on this box runs `2024.01.19.1541CAY`
and no phone has connected since the feature landed. Upstream
[node-CarPlay#95](https://github.com/rhysmorgan134/node-CarPlay/issues/95)
reports a *newer* firmware that stopped sending media data altogether, so this
is worth confirming rather than assuming: with a phone connected,
`journalctl -u tesla-pi | grep now_playing_first` should show one line.

## Correction: upstream multitouch was reverted

The section above says `SendMultiTouch` "was added upstream after our pin". True,
but incomplete: it was added in Jan 2024 (#76) and **reverted in May 2024**
([#86](https://github.com/rhysmorgan134/node-CarPlay/pull/86)). Bumping the
dependency would not hand us a multitouch sender — our inlined 0x17 wire format
is the only implementation either way. npm still carries 4.1.0 (Dec 2023); master
has three commits since, the useful one being
[#91](https://github.com/rhysmorgan134/node-CarPlay/pull/91), which adds command
IDs 113 (`up`), 203 (`playOrPause` — we already send it raw), 300 (`acceptPhone`)
and 301 (`rejectPhone`).

## Audio direction — `audioTransferOn` / `audioTransferOff` (commands 22 / 23)

The flag is inverted relative to how it reads. "Transfer" is the **box** moving
audio to **its own** output — the Bluetooth link to the car — not moving it to
the host.

| `config.audioTransferMode` | command sent | where CarPlay audio goes |
|---|---|---|
| `false` | `audioTransferOff` | PCM streams to us over USB (what `browser` mode needs; node-carplay's default) |
| `true`  | `audioTransferOn`  | the dongle keeps it and plays over its own Bluetooth link (`bluetooth` mode) |

Measured in the car on 2026-08-21. With `true` — which this project hardcoded
from the start — `AudioData` messages arrived carrying only commands
(`AudioSiriStart`/`AudioSiriStop`) with `dataLen: 0`, and not one PCM byte while
music played, both at dongle init and after replaying the command once the phone
had handshaked. With `false`, the first frame appeared within seconds:
`dataLen 11520, decodeType 2, 44100 Hz, 2 ch`.

Corroboration: Carlinkit's own AutoKit app exposes this as an "Audio Channel"
setting whose alternative is Bluetooth, and tesla-android's install guide tells
users to pick Bluetooth so the phone talks straight to the car.

The dongle exposes no USB Audio Class interface (`bInterfaceClass 255`, vendor
specific, `iInterface "Android Accessory Interface"`), so these proprietary
`AudioData` messages are the only route audio can take off the hardware.

`audioTransferFlagFor()` in `index.js` owns the mapping; `CARPLAY_AUDIO_TRANSFER=on|off`
overrides it for testing.

---

## Upstream status, checked 2026-08-21

`node-carplay` on npm is still **4.1.0 (Dec 2023)** — the version we pin. The
repo's `master` has four commits since, the last from June 2025, and every one
of its 18 forks is **0 commits ahead**. There is no upgrade to take and nothing
in flight to wait for. What the unreleased commits contain:

| Upstream | Ours |
|---|---|
| `bitrate` → `bitDepth`, plus `format`/`mimeType` on `AudioFormat` | cosmetic; we read `frequency`/`channel` only |
| `CommandMapping`: `up` 113, `playOrPause` 203, `acceptPhone` 300, `rejectPhone` 301 | adopted — see below |
| `phoneConfig?.[phoneType]` optional chaining, fuller `startNode` defaults | already covered: we merge the driver's own defaults into `config` |
| multi-touch | implemented Jan 2024, **reverted** May 2024; ours is independent (see above) |

Where the ecosystem actually moved: **FastCarPlay** (C++, Pi-optimised, same
dongles) and **LIVI** (a native GStreamer head unit that speaks CarPlay itself
and therefore needs an Apple MFi coprocessor on I²C — not a route open to us).
FastCarPlay is the useful one: same hardware, same problems, several already
solved. Three of the changes below come from reading it.

## More command IDs (113, 300, 301)

Added upstream after our pin, so `sendKey()` cannot reach them; `index.js`
would send them through `sendCommand()` — the same raw 20-byte frame as 203.

| ID | Name | Status here |
|---|---|---|
| 113 | Button Up | wired to `sendCommand()`, no UI |
| 300 | Accept Phone Call | **not used** |
| 301 | Reject Phone Call | **not used** |

300/301 briefly drove an answer/hang-up bar floating above every route, on the
reasoning that CarPlay only draws its own call buttons onto the CarPlay screen.
Removed at the owner's request on 2026-08-21 — handling calls from outside
CarPlay is not wanted. The ids are documented here so nobody has to rediscover
them.

## Pairing: `btPairStart` (1011) is not the same as `wifiConnect` (1002)

`wifiConnect` means *reconnect to the phone you already know*, and this project
sent it on a 15 s timer whenever no phone was attached. That is right almost
always and wrong in exactly one case: while someone is pairing a **new** phone,
each poke lands in the middle of the handshake. Observed 2026-08-21 — the
dongle reported `deviceFound`, then went silent, while the iPhone sat spinning
on the Bluetooth entry and never registered.

`btPairStart` (1011, "begin BT pair search") had never been sent by this
project at all. `POST /carplay/pair` now opens a two-minute window in which the
poke sends `btPairStart` + `wifiPair` instead, and `wifiConnect` is held off
entirely; `POST /carplay/pair/stop` ends it early. That window is what got a
forgotten phone paired again.

## AudioData carries more than PCM

`AudioData` is three different messages sharing one type, told apart by the
payload length after the 12-byte head (`decodeType` u32, `volume` f32,
`audioType` u32):

| Bytes after the head | Meaning |
|---|---|
| 1 | `command` — an `AudioCommand` (stream start/stop; see below) |
| 4 | `volumeDuration` f32 — "ramp this stream to `volume` over this long" |
| anything else | S16LE PCM for the stream `(decodeType, audioType)` |

We used to read `decodeType` and the PCM and drop the rest, which cost us two
things. First, several streams run at once — music, a turn instruction over the
top of it, Siri, a call — and keying one player on `decodeType` alone meant a
nav prompt reset the music's queue on the way in and again on the way out.
Second, `volume`/`volumeDuration` **is** CarPlay doing its own mixing, and we
were ignoring the instruction.

The `/audio` socket now carries the stream identity on every frame: a 4-byte
prefix, `[decodeType, audioType, 0, 0]`, ahead of the PCM (4 rather than 2 so
the PCM stays 2-byte aligned for an `Int16Array` view). Non-PCM messages go up
as JSON `{type:'audioEvent', command, decodeType, audioType, volume,
volumeDuration}`, and the client keeps one player per stream, each with its own
queue, cushion and gain.

`AudioCommand` values worth acting on: 4/5 phone call start/stop, 6/7 nav
start/stop, 8/9 Siri start/stop, 10/11 media start/stop, 12/13 alert
start/stop. The page ducks music to 35% while any of the voice streams is
open — what a car does under a turn instruction — and an explicit
`volume`/`volumeDuration` from the phone overrides that for the stream it names.

Cushions are split by stream, following FastCarPlay (which prebuffers three
times as much for calls as for music): 80 ms for music, 180 ms for voice,
because a dropout in a sentence costs a word while a dropout in a song costs a
glitch. The split is on sample rate, not channel count — decodeType 7 is 16 kHz
*stereo*, so "mono means voice" would get it wrong. Music is 44.1/48 kHz;
everything at or below 24 kHz is Siri, navigation or a call.

## Reading the dongle: keep transfers in flight

node-carplay reads strictly one message at a time, and each costs two round
trips — `await transferIn(16)` for the header, then `await transferIn(length)`
for the body — with nothing queued behind them. Every gap between "libusb hands
us a buffer" and "we submit the next read" is time the dongle is holding data it
cannot give us.

`carplay-reader.js` replaces that loop with N reads outstanding at all times
(16 × 16 KB by default), awaited in submission order — bulk IN transfers are
queued by the kernel and complete in order, so the byte stream reconstructs
exactly. The cost is that a fixed-size read no longer lines up with message
boundaries, so it re-frames itself, and resynchronises by hunting for the magic
if it ever loses the thread (node-carplay cannot: its reads were aligned by
construction, so a desync there is fatal).

FastCarPlay's settings file is the corroboration, in its own words: raise the
number of async USB calls "if you have issues with audio and video lagging
behind", and again "if you have mallformed message errors on RPI". Both are
symptoms we have had.

`CARPLAY_USB_PIPELINE=off` restores node-carplay's loop.
`scripts/test-carplay-reader.mjs` exercises the framing offline — whole
messages, one byte at a time, headers split across reads, and garbage in the
stream.

## Encrypted firmware (magic `0x55bb55bb`)

Newer Carlinkit firmware frames messages with `0x55bb55bb` instead of the
`0x55aa55aa` every version of this protocol documentation assumes, and AES-
encrypts the body. node-carplay hardcodes the old magic and throws "Invalid
magic number" in a loop until its error count trips, which looks exactly like a
broken cable.

We cannot decrypt it. What we can do is say so: the reader recognises the
encrypted magic and logs `dongle_firmware_encrypted` once, with an explanation,
and `/healthz` reports `usb.encrypted`. The practical advice that follows is
short — **do not update this dongle's firmware.**

## Firmware: what this dongle is, and why we cannot flash it

Read live from the box on 2026-08-21 (`journalctl -u tesla-pi | grep dongle_`):

| field | value |
|---|---|
| `SoftwareVersion` | `2024.01.19.1541CAY` |
| `productType` | `A15W` |
| `boxType` | `YA` |
| `hwVersion` | `YMYE-WN87-0003` |
| `MFD` | `20220425` |
| `HiCar` | `1` |
| USB id | `1314:1521` "Magic Communication Tec. Auto Box", `bcdDevice 4.09` |

`2024.01.19.1541` matches `A15W_Update_2024.01.19.1541.img` exactly, which pins
the model: this is a **CPC200-CCPA** (Carlinkit 3.0 / "AutoKit"). `A15W` is both
the product type the box reports and the name its updater looks for on a stick.

Note that carlinkit.com's public "AutoKit" download list is the **CCPM**, a
different product. Official CCPA images are not published; the community archive
at `den67rus/Carlinkit-CPC200-Autokit-Firmware` is what `dongle-firmware.js`
pins, by commit and per-file git blob hash.

Known CCPA builds, and the rollback target each changelog entry names:

| build | rolls back to |
|---|---|
| 2022.04.25.1317 | — |
| 2022.11.19.1218 | — |
| 2023.05.29.1924 | 2022.11.19.1218 |
| 2023.09.27.1710 | — |
| **2024.01.19.1541** (ours) | 2023.09.27.1710 |
| 2024.08.07.2014 | 2024.01.19.1541 |
| 2024.09.03.1028 | 2024.01.19.1541 |
| 2025.02.25.1521 | **none documented** — *withheld, see below* |

Every release note upstream reads "Bug Fixes and Improvements". Combined with the
encrypted-magic risk above, and the newest build being the one with no way back,
the standing decision is to leave this dongle where it is.

**2025.02.25.1521 is withheld from the page** (`MODELS.A15W.withheld` in
`dongle-firmware.js`). It is not listed in Settings → Dongle and cannot be
fetched even by asking for the version directly — `/dongle/firmware/fetch`
answers `unknown_version`. The reason is the missing rollback target and nothing
else: every other build in the list is a mistake a second stick can undo, and
this one is not.

Be careful not to promote the encryption risk to a fact while doing so. The
`0x55bb55bb` framing is documented against a **2025.10.XX** firmware — newer than
every build in this catalogue — so there is no evidence that 2025.02.25.1521, or
2024.08/2024.09, actually ship it. It is an unknown. An unknown you can roll back
from is a risk you can take; an unknown you cannot is a one-way door.

For the same reason 2024.08.07.2014 and 2024.09.03.1028 stay listed: both name
2024.01.19.1541 as their rollback target, so both are recoverable. Neither is
*recommended* — the changelog claims no benefit over what is running — but they
are a choice, not a trap.

### Why Settings → Dongle cannot flash, only prepare

Carlinkit ship two update paths and we can reach neither:

1. **FAT32 stick.** The box reads `A15W_Update.img` from the root of a stick
   inserted while it runs off a wall charger. Physical by construction — and the
   Pi is the USB *host* in our pairing, the dongle the *device*, so the Pi cannot
   present itself as the stick either.
2. **The box's own web page**, at `http://192.168.43.1/` on its private AP.
   `BoxInfo` reports `WiFiChannel: 36`, and the only client radio on this device
   is an RTL8188EUS — 2.4 GHz only, so it cannot associate at any setting. It is
   also the machine's sole route to the house, so borrowing it would strand the
   device. (`CommandMapping.wifi24g` = 24 would move the box's AP to 2.4 GHz,
   which makes the association *possible* — it does not fix the lockout, and it
   would put CarPlay video on 2.4 GHz.)

There is no firmware path in the USB protocol itself. `SendFile` (type 153)
writes a file to a path on the box — `/tmp/screen_dpi`, `/etc/box_name` and so on
— and the path is a free string, so pushing a 12 MB image somewhere the updater
might notice is *possible*. It is also undocumented, unverifiable, and its
failure mode is a brick with no recovery. We do not do it.

So the pane does everything either side of the physical step: identify the box,
list the builds, fetch one with its size and hash checked, and write it to a
stick. What is left for a human is carrying the stick.

---

## `SendDisconnectPhone` / `SendCloseDongle` — the supported way to let a phone go

Reached for while building [CarPlay on demand](carplay-on-demand.md), and worth
recording because the answer was already in node-carplay rather than in the
firmware RE tree.

`node_modules/node-carplay/dist/modules/messages/sendable.js` defines two
zero-payload messages the driver itself never sends, each with a one-line
comment that is the whole specification:

```js
// Disconnects phone and closes dongle - need to send open command again
export class SendCloseDongle extends SendableMessage {
    type = MessageType.CloseDongle;   // 21
}
// Disconnects phone session - dongle is still open and phone can re-connect
export class SendDisconnectPhone extends SendableMessage {
    type = MessageType.DisconnectPhone;   // 15
}
```

Two things follow:

- **`DisconnectPhone` is the one that frees the phone.** Closing the USB handle
  does not: the dongle↔phone Wi-Fi link is between those two, and the phone stays
  on the dongle's AP until it decides for itself that nothing is listening.
- **`CloseDongle` is reversible from software.** "Need to send open command
  again" describes exactly what `carplay.start()` already does, so this is not
  the one-way door that commands 28/31 (`StartStandbyMode` / `StopBleAdv`) might
  be on a firmware they were never documented against.

Both are exported from `node-carplay/node` (`modules/index.js` re-exports all of
`messages/`), so no patching is needed — unlike commands 203 and 0x17, which
still go out as hand-built frames.

Not tried, and deliberately so: commands **28/31**. They are the semantically
exact lever (stop advertising, enter low power) but appear only in the 2025.10
firmware RE notes, and this dongle is pinned to 2024.01.19 and must not be
updated. A dongle wedged in the car is a worse outcome than one merely closed.
