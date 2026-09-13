# Reading Tesla telemetry — the options

Status: **Tier 2 is working end to end. Tier 1 measured parked. The Drive run is
the one thing still outstanding.** Nothing is wired into the product UI yet.

Split out of [`llm-companion-options.md`](llm-companion-options.md) §6 when the
companion was shelved (2026-08-27). Telemetry now has to justify itself on its
own, which it does — see §0.

## 0. What it is for

Four uses, in descending order of how much they earn their keep:

1. **Safety gating.** RetroArch currently runs whether or not the car is moving.
   A retro console playable at speed is a liability and nothing stops it today.
   This needs exactly one number — speed — and is the single most valuable thing
   on this page.
2. **Status display.** Battery %, range, charge state, temperatures on the
   launcher. Needs Tier 2; no amount of GPS will produce a state of charge.
3. **Trip logging.** Tier 1 gives the track, Tier 2 adds energy, Tier 3 adds
   everything at high rate.
4. **Knowing what is reachable at all**, which is what the probes answer.

## 1. Three tiers

| | Source | Gives | Costs |
|---|---|---|---|
| **1** | `navigator.geolocation` in the page | position, maybe speed + heading | **nothing** |
| **2** | BLE, Pi-side | charge, climate, tyre pressure, closures, drive data, location | key enrolment + BlueZ stack |
| **3** | CAN via harness | everything, at CAN rates | trim removal + hardware + upkeep |

### Tier 1 — the browser already has GPS

`navigator.geolocation` has worked in the Tesla browser since firmware 5.9 — it
is how web maps locate the car — so position is close to a given. The real
question is narrower: **does this build populate `coords.speed` and
`coords.heading`, or leave them null?** Many Chromium configurations derive
location from network signals and return null for both.

A null is not the end of it. If fixes arrive often enough and accurately enough,
speed can be **derived** from successive positions, and derived speed gates
RetroArch perfectly well. `static/telemetry-probe.html` §4 measures both and
says which to use.

#### Measured parked, 2026-08-27, Chromium 148

**The headline is good: `coords.speed` and `coords.heading` are both
populated.** Speed read 0 (correct, parked), heading 203.77°, altitude 51.35 m.
Permission was already `granted` with no prompt — it persists across sessions,
the same way the cabin mic's does. First fix returned in **12 ms**.

So the question this tier existed to answer is answered, and safety gating does
not need BLE or CAN.

Three anomalies came with it, and all three matter:

| Observed | Meaning |
|---|---|
| `accuracy: 9999.99` | A **placeholder**, not a 10 km error bound. The car reports no real accuracy figure. |
| `timestamp: 17658017000` | **Not epoch milliseconds** — ~101x too small, reads as 1970. Whatever clock this is, it is not one we can use. |
| Same timestamp on every sample | The source clock does not advance between fixes. |
| 3 fixes in 30 s (~0.1 Hz) | Probably a parked artifact — `watchPosition` fires on change, and a stationary car does not change. **Unconfirmed until the Drive run.** |

The first two forced probe changes rather than just being noted. Deriving speed
from `pos.timestamp` divides by zero or by nonsense, so the probe now timestamps
arrivals itself (`Date.now()` on each callback) and computes rate and derived
speed from that, keeping `pos.timestamp` only as a diagnostic. And because a
sentinel accuracy tells us nothing about whether positional wobble is motion, a
sentinel now disqualifies the derived-speed path outright instead of quietly
passing the ≤25 m test.

The verdict logic was also too generous: it returned YES on a populated speed
while the update rate was 0 Hz. A gate that hears about movement every ten
seconds is not a gate, so rate is now judged alongside speed and a slow stream
downgrades to WARN.

#### What the Drive run must still answer

**Update rate while moving.** That is the whole remaining question, and it sets
gate latency. Everything else about Tier 1 is now known.

Since 2026-08-29 this no longer needs a dedicated probe run: Status → Car → This
trip shows the live fix rate over a trailing 30 s window, alongside distance,
moving time, top and average speed, and climb. Drive normally and read it off.
Parked it sits near zero, which is correct — `watchPosition` fires on change and
a stationary car does not change.

That card also consumes the two quirks recorded above, and both had to be
handled rather than noted:

* `accuracy` of 9999.99 renders as **"Not reported"**, never as ±10000 m. The
  first cut of the card did print ±10000 m, which invents a precision claim the
  car never made.
* Distance integrates `coords.speed` over intervals timed with `Date.now()` on
  arrival. `pos.timestamp` is untouched — it is not epoch milliseconds and does
  not advance between fixes, so anything divided by it is nonsense. Distance is
  *not* derived from the gap between positions, because a sentinel accuracy
  makes positional wobble indistinguishable from real movement.

Verified against a stubbed geolocation feeding a constant 20 m/s with the real
quirks present (sentinel accuracy, bogus timestamp): 233 m over 11.6 s, average
72 km/h, climb 24 m from 12 x 2 m steps, fix rate 1.03/s from 12 fixes.

Thresholds it judges against, both chosen for the gating use case: **≥0.5 Hz**
(a gate should notice movement within a second or two) and **≤25 m median
accuracy** (below that, a stationary fix wobbling once a second looks like
walking pace).

### Tier 2 — BLE on the Pi

**Confirmed reachable, 2026-08-27.** An LE scan from the Pi in the car found the
vehicle advertising with the documented Tesla local-name format — `S` + 16 hex
characters + `C`, the hex being the first 8 bytes of SHA1(VIN) — at **RSSI −52
to −66 dBm**. Strong and steady. The MAC and full name are deliberately not
recorded here: the name is VIN-derived.

So the transport is not in question. What remains is the protocol work: enrolling
a key pair in the car, then authenticated sessions that expire and need
refreshing. Over that you can poll charge state, climate, tyre pressure, closures
and drive data — and the VCSEC computer also emits **unsolicited `VehicleStatus`
broadcasts** on the same notification subscription, so state changes can be
received passively rather than polled.

#### Enrol as `vehicle_monitor`, never as `driver`

This is the single most important decision in this tier, and it is a security
one.

Enrolling a key gives whoever holds the private half the ability to act as that
role. A `driver` key can unlock and drive the car. Putting one on this box would
be a serious escalation: [`SECURITY.md`](../SECURITY.md) is explicit that every
HTTP and WebSocket endpoint here is unauthenticated by design and the trust
boundary is the WPA2 password of the in-car AP — a password that ships as
`12345678`. A compromised Pi would become a car key.

Tesla's `Role` enum has a read-only role, and `tesla-control` accepts it. Checked
against the built binary rather than the docs, because a secondary source claimed
only `owner` and `driver` were available:

```
ROLE: One of: owner, driver, fm (fleet manager), vehicle_monitor, charging_manager
```

`vehicle_monitor` reads state and cannot unlock or drive. **Use it.** Even so,
the private key is a credential: keep it `0600` and treat its loss as something
to revoke from the car's key list.

#### What is installed, and what is left

Done on the test Pi (2026-08-27):

- `tesla-control` and `tesla-keygen` v0.4.1, **cross-compiled on the Mac** as
  static `aarch64` binaries and copied to `~/tesla-ble/`. Deliberately not built
  on the Pi: an appliance image should not carry a Go toolchain.
- A P-256 signing keypair in `~/tesla-ble/`, private key `0600`.
- [`scripts/tesla-pi-ble`](../scripts/tesla-pi-ble), which wraps the tool so the
  Bluetooth block is borrowed and returned around every call — including on
  Ctrl-C or error — rather than being left off by a forgotten command. Verified:
  `scan` finds the car and leaves `rfkill` soft-blocked exactly as it found it.

Left, and it needs a human in the car:

1. ~~The **VIN**~~ — set 2026-08-27, and confirmed correct: the car answered
   with a protocol-level error rather than "failed to find BLE beacon", which
   only happens once the beacon matching that VIN has been found and connected
   to. Verifying the VIN this way needs no key card.
2. `tesla-pi-ble enroll`, then **tap the NFC key card on the centre console
   within ~30 seconds**.
3. Confirm the key appears in the car's key list — and that it says monitor, not
   driver.

#### Two things that bite, both found the hard way

**1. `tesla-control` needs `CAP_NET_ADMIN`.** It brings the HCI device up and
down itself, so without the capability every call dies with
`can't down device: operation not permitted`. File capabilities do not survive
a file copy, so a freshly deployed binary loses it. `tesla-pi-ble` now re-applies
it on every run — idempotent, and cheaper than rediscovering this later.

**2. The car accepts only THREE simultaneous BLE connections**, and phone keys
hold them. With three phones/tablets/watches in range, every call returns:

```
Error: the vehicle is already connected to the maximum number of BLE devices
```

Measured 2026-08-27: consistent across repeated attempts and across both `state`
and `body-controller-state`, so it is a hard limit rather than a transient
collision. Clearing it means turning Bluetooth off on a device near the car.

This is a real product constraint, not just a setup nuisance. **A Pi that held a
BLE connection open permanently would occupy one of the car's three slots** — and
the failure mode that produces is somebody's phone key not unlocking the car.
For a telemetry nicety that is an unacceptable trade.

The on-demand design already avoids it: `/telemetry/ble` connects, reads, and
disconnects, with a 20 s cache in front. Nothing holds a slot. That choice was
made for radio coexistence with the AP and turns out to matter twice over — so
**do not "optimise" it later into a persistent connection or a background
poller.**

#### Result: enrolled and working (2026-08-27)

Key enrolled as `vehicle_monitor` and confirmed by reading real data. **Every one
of the twelve categories is permitted to that read-only role**, plus
`body-controller-state`:

```
charge  climate  drive  location  closures  tire-pressure  media
charge-schedule  precondition-schedule  parental-controls
software-update  media-detail
```

So the feared restriction did not materialise — a monitor key sees the whole
read surface, and still cannot unlock or drive.

Round trip is **~2.9 s uncached** through `/telemetry/ble`, which the 20 s cache
then covers.

Notable payload contents:

| Category | Carries |
|---|---|
| `charge` | battery %, usable %, range, charge limits, charger V/A/kW, minutes to full, port door, scheduled charging |
| `drive` | **`shiftState` (the gear)**, `speed`, `speedFloat`, `power`, odometer, active-route ETA and energy at arrival |
| `tire-pressure` | all four pressures in bar, per-corner last-seen times, hard and soft warning flags |
| `closures` | every door, both trunks, charge port, plus `vehicleLockState` |
| `climate` | inside and outside temperature, HVAC state |

Two things worth noting. These payloads carry **proper ISO-8601 timestamps**,
unlike the browser geolocation clock, which is not epoch-based and does not
advance. And `drive.shiftState` is a **better gating signal than speed** — see
below.

#### What this means for safety gating

`shiftState` beats a speed threshold conceptually: "the car is in D" is exactly
the question, where "moving faster than X" is a proxy for it. But BLE is
seconds-per-call and competes for one of three connection slots, so it cannot
drive a live gate.

The sensible split, once the Drive run confirms the browser's update rate:

- **At launch** — one BLE `drive` read. Refuse to start RetroArch unless
  `shiftState` is `P`. Cheap, definitive, happens once.
- **While running** — browser geolocation speed, continuously. No BLE, no slot,
  no radio contention with the AP.

That gets a definitive check where accuracy matters and a free continuous one
where latency matters.

#### ~~Then verify the gate that has not been tested~~ — answered, it passed

Available categories, from the binary:

```
parental-controls, charge, climate, drive, location, closures,
precondition-schedule, media, charge-schedule, tire-pressure,
media-detail, software-update
```

`state drive` is worth a look for gating as a Tier 2 alternative, and
`body-controller-state` is separately useful because it is documented to work
**while infotainment is asleep**, which the other categories are not.

**Operational trap: Bluetooth is `rfkill` soft-blocked on the device.** Found
that way on the test Pi. It is *soft* only — no `disable-bt` overlay in
`config.txt`, the `bluetooth` service is enabled and active, BlueZ is 5.82 (well
past the 5.41 floor) — so `rfkill unblock bluetooth` is the whole fix. But
anything built on Tier 2 must unblock it deliberately and own the consequence,
because the block is probably not accidental: **the Pi's Bluetooth shares
silicon with the `wlan0` radio running the AP, and the AP is the product.**
Measure coexistence under load before shipping, not after.

### Tier 3 — CAN

Tesla has no standard OBD-II port and Highland moved the connector to the
**passenger A-pillar**. Needs a Highland-specific harness inserted between
existing connectors, the car de-energised, trim pulled, and an MCP2515 HAT on
the Pi's SPI with SocketCAN. Scan My Tesla's DBC work is the decoding reference.

Two rules: **sniff read-only, never write to that bus**, and expect signal IDs to
drift across Tesla firmware, so the decode table is upkeep you are signing up
for.

Only worth it for something Tiers 1 and 2 genuinely cannot reach — high-rate
pedal/torque/gear data. For gating and status they cannot be justified.

## 2. The probes

`static/telemetry-probe.html` → `https://<device>/telemetry-probe.html`.
Tier 1 only; Tier 2's equivalent was a one-off `bluetoothctl` scan, already run.

It tags each run Park or Drive, takes one high-accuracy fix, then watches for 30
seconds and reports sample count, update rate, median accuracy, how many fixes
carried speed and heading, and both maximum reported and maximum derived speed —
ending in a plain verdict: *use `coords.speed`* / *derive from fixes* / *browser
GPS cannot gate*.

**Run it in Drive with a second person driving.** A parked car cannot tell you
whether speed is reported.

Coordinates are rounded to ~100 m in the uploaded report unless the box is
ticked; the full-precision fix is held outside the report object so the toggle
recomputes rather than re-rounding, and an unticked report never contains the
exact position. On-screen values are always full precision.

Verified before deployment against a stubbed geolocation simulating 20 m/s: the
derived-speed maths returns 20.0 m/s, and all three verdict paths render.

## 2b. The dashboard

[`static/telemetry.html`](../static/telemetry.html) → `https://<device>/telemetry.html`
shows all three sources on one page. It is a standalone page, **not wired into
the launcher** — that is a product decision, not a diagnostic one.

| Panel | Source | Update |
|---|---|---|
| **Motion** | browser GPS | live, continuous |
| **Device** | `/healthz` | live, every 5 s |
| **Vehicle** | BLE via `scripts/tesla-pi-ble` | **only when you press the button** |

The asymmetry is the point. Motion and Device are free, so they stream. Vehicle
costs radio time that the AP shares silicon with, so **nothing polls it on a
timer** — you pick categories and press Read.

The server side is `GET /telemetry/ble?category=…` in `index.js`, which:

- **404s unless `TESLA_BLE_HELPER` is set**, so a box that was never enrolled has
  no such route — the same shape as `DONGLE_HELPER`.
- **Allowlists the category.** It becomes an `execFile` argument, and the
  allowlist is what keeps it an argument rather than a shell injection.
- **Serialises through a promise chain**, not a boolean flag: two requests
  arriving together queue instead of both deciding hci0 is free.
- **Caches 20 s on success, 5 s on failure.** Failures expire sooner because
  holding "no VIN" for 20 s means someone who fixes the VIN and retries sees the
  stale error and concludes it did not work.
- **Times out at 30 s**, so a hung BLE stack cannot hold an HTTP socket open.

Verified against the running Pi: bad category → 400, real category → a clean 502
carrying the actual reason, cache hits and the 5 s failure TTL both behave, and
two categories requested in parallel serialise without collision.

**The BLE success path has not met the car.** The key is not enrolled yet, so
those rows were verified against a stubbed adapter, not a Tesla. Field names in
the screenshot are illustrative — the page flattens whatever object comes back
rather than assuming a schema, because `tesla-control`'s output shape is not
contractual.

## 2c. The Settings switch

**Settings › Network › Experimental › "Read telemetry from Bluetooth"**,
persisted as `bleEnabled` in `settings.local.json` alongside
`fps`/`hand`/`aspect`. Last group in the pane, beside Internet Passthrough:
nobody should meet either of these before the hotspot and Wi-Fi settings they
actually came for.

Two separate facts drive the UI, and conflating them would produce a dead
control:

- `ble_configured` in `/healthz` — whether `TESLA_BLE_HELPER` is set at all.
  **False hides the row entirely**; a switch that cannot do anything is worse
  than no switch.
- `ble_enabled` — whether the user wants it on. Defaults **off**. The car allows
  only three simultaneous BLE connections and phone keys hold them, so a box
  that reached for one without being asked could be the reason someone's phone
  key fails to unlock the car. That is not a default to assume; it is opt-in.

Off is a hard stop, not a pause: `/telemetry/ble` returns **403 `ble_disabled`**,
the server clears its cache so nothing stale can be presented as live, and the
Car tab greys out with the reason and where to change it. The client also
refuses to fire the five requests at all when it knows the answer.

Verified against the running Pi: switch → control WS → server → `/healthz`
agrees → `settings.local.json` persists → route 403s → switch back → real read
succeeds.

### Field mapping, learned the hard way

`state closures` and `body-controller-state` describe the same car in **two
different vocabularies**, and the first version of the card silently rendered
nothing because it was written against the wrong one:

| | `state closures` | `body-controller-state` |
|---|---|---|
| doors | `doorOpenDriverFront: false` | `frontDriverDoor: "CLOSURESTATE_CLOSED"` |
| locks | `locked: true` | `vehicleLockState: "VEHICLELOCKSTATE_INTERNAL_LOCKED"` |

Both are mapped now. `state closures` also turned out to carry **windows,
sentry mode, user presence and speed-limit mode**, which the earlier
documentation here did not mention — hence the extra rows.

## 3. Suggested order

1. Run the Tier 1 probe in Drive. `coords.speed` is already known to be
   populated, so this run is specifically about **update rate while moving** —
   the number that decides how fast a gate can react.
2. Implement the RetroArch speed gate on whichever of the two the probe blesses.
3. Tier 2 for the status display: set `TESLA_VIN`, run `tesla-pi-ble enroll`,
   tap the card, then confirm `state charge` is permitted for a monitor key.
   Measure BT/AP coexistence under load before shipping anything that polls.
4. Leave Tier 3 alone unless something concrete needs it.

## 4. Sources

- [teslamotors/vehicle-command protocol.md](https://github.com/teslamotors/vehicle-command/blob/main/pkg/protocol/protocol.md) — BLE service UUIDs, the `S…C` name format
- [python-tesla-fleet-api: Bluetooth vehicles](https://github.com/Teslemetry/python-tesla-fleet-api/blob/main/docs/bluetooth_vehicles.md) — readable endpoints and VCSEC broadcasts
- [tesla_ble_mqtt_docker](https://github.com/tesla-local-control/tesla_ble_mqtt_docker) — prior art for BLE state on a Pi
- [Tesla browser GeoLocation API support](https://teslamotorsclub.com/tmc/threads/geolocation-in-v10-web-browser.170574/)
- [Highland OBD2 harness](https://ohptools.com/products/tesla-model-y-3-highland-gen-3-front-installation-connector-harness-obd2-adapter-for-live-data-monitoring-diagnostics) and [tm3-can-logger](https://github.com/k-korn/tm3-can-logger)
