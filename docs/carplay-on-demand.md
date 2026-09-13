# CarPlay on demand

## The problem

The CarLinkit dongle is not a passive cable. Once it has been opened over USB it
advertises BLE; a paired iPhone answers, exchanges Wi-Fi credentials over
Bluetooth Classic, and joins the dongle's **own 5 GHz AP** (192.168.43.0/24 —
see [`carlink-protocol-notes.md`](carlink-protocol-notes.md) for the full
handshake). That AP has no internet behind it and is not the point of it: it
carries the CarPlay RTSP session and nothing else.

So a Pi that boots into a CarPlay session and stays there does this:

- the phone leaves home Wi-Fi and joins the dongle whenever it comes in range —
  walking past the car, sitting indoors near a garage, parked on the drive
- the phone's Wi-Fi and Bluetooth radios stay busy holding a link nobody is
  looking at, which costs battery
- iOS keeps trying to reconcile "connected to Wi-Fi" with "this Wi-Fi has no
  route", which is its own source of drain and of apps behaving oddly

Worse, `index.js` used to *actively* court the phone: `pokeAutoconnect` sent
`wifiConnect` (command 1002, "reconnect to the phone you already know") every
15 seconds, forever, regardless of whether any browser was attached.

## The rule

**The dongle is open only while a browser page is open AND on screen.**

Not "on the CarPlay route" — Settings, Monitor, the launcher and the RetroArch
route all mean "someone is in the car using this thing", and gating on the route
would tear the session down every time the user opened Settings, then charge
them a full re-pair to come back. A visible page of any kind is demand.

Leaving is not instant. A grace window (`CARPLAY_IDLE_STOP_MS`, **5 minutes**
— see § Tuning; it was 60 s when this was written)
sits between the last page going away and the dongle closing, because swiping to
the Tesla media app and back, or reloading the page, must not cost a re-pair.

## How demand is signalled

No single browser signal is trustworthy here, so there are four, in decreasing
order of speed:

| Signal | Fires when | Latency |
|---|---|---|
| `visibilitychange` | the browser is swiped away or another tab is shown | immediate |
| `pagehide` | navigating away, closing the tab | immediate |
| `/control` socket closes | the browser is closed, the page crashes, the car leaves the AP | one WS keepalive (≤30 s) |
| heartbeat lapse | everything else | `CARPLAY_DEMAND_TTL_MS` (40 s) |

The heartbeat is the one that matters for correctness. A visible page re-asserts
`{type:'carplayWanted', value:true}` every 15 s; the server treats it as a
**lease**, not a latch, and expires it after 40 s. If the Tesla browser turns out
never to fire `visibilitychange` when it is backgrounded, Chromium still
throttles a hidden tab's timers to roughly one tick a minute — so the heartbeat
lapses past the TTL on its own and demand drops anyway. The feature degrades to
"~40 s slower" rather than "broken".

Demand is tracked **per socket** (`ws.demandUntil`), not as one global timestamp:
a laptop sitting on Settings and the car's browser are independent voters, and
one going hidden must not pull the dongle out from under the other.

### Measured: how long people are actually away

Reported in the car on 2026-08-29: swipe out to change the wipers, swipe back,
and CarPlay has to reconnect. So the journal was read rather than reasoned
about — 18 hide/return episodes across five boots:

```
episodes: 18   came back inside the 60 s grace: 2   after it: 16
shortest 18 s   median 385 s   longest 2 h
reconnect cost after a release: median 14 s, max 70 s
```

The gate was working exactly as designed. **The grace was simply too short.**
Both sub-60 s returns were held correctly; every release followed a genuine
absence of 79 s or more. "I'll just change the wipers" means navigating the
car's own menus, and that runs minutes.

Hence `CARPLAY_IDLE_STOP_MS` is now **5 minutes**. The feature is aimed at the
car parked on the drive with nobody in it, where the absence is hours — five
minutes costs nothing there, and buys back every in-drive excursion.

One caveat that shaped the rest of this section: **the server cannot measure an
absence.** All it sees is when the socket came back, which is the absence *plus*
however long the reconnect took. Those were indistinguishable in the logs above,
so the page now reports its own measurement as `away_ms` on `carplay_demand`.

### Coming back is a signal too

Every signal above is about *leaving*. Returning had no handling at all, which
does not explain the releases above — those were real absences — but does add
avoidable latency on the way back, and can turn a near-miss into a release:

1. `visibilitychange` → the page votes `false`. The 60 s idle timer arms.
2. The browser freezes the backgrounded tab and its sockets close.
3. The retry chain, running throttled or not at all, ratchets its backoff to
   the 5 s cap. The 5 s socket watchdog is throttled to about a tick a minute,
   so it does not help either.
4. The driver comes back. `visibilitychange` fires and the page votes `true` —
   **into a closed socket**. `send()` drops silently on a socket that is not
   open, so the Pi never hears it.
5. The vote only lands when the retry chain reconnects on its own. Until then
   the page shows "Reconnecting…" on a session that is perfectly alive.

And if step 5 takes long enough to cross `CARPLAY_IDLE_STOP_MS`, the release
fires *while the driver is looking at the screen*, and the reconnect stops
being cosmetic: it becomes a real re-pair, which measured 9-70 s here.

This was originally diagnosed as *the* cause of the report above. It was not —
the measurements settled that. It is a real defect worth fixing on its own
terms, and `away_ms` now makes the difference visible in the log.

Two fixes, because there are two failures:

- **The page reconnects before it votes.** `visibilitychange`→visible and
  `pageshow` both call `resumeSockets()`, which cancels any pending retry and
  dials immediately rather than waiting out a backoff earned while nobody was
  looking. `pageshow` is in there because a bfcache restore fires it *instead
  of* `visibilitychange`.
- **A socket that dies mid-view keeps its vote briefly** (`CARPLAY_GHOST_LEASE_MS`,
  15 s). A page that said "hidden" first has already zeroed its lease, so this
  never extends a deliberate departure — it only covers the socket dying with
  nobody having said anything, which is exactly the frozen-tab case. The
  `control_disconnected` log line carries `ghost` so the two are told apart.

## How the dongle is handed back

`releaseDongle()` sends two messages, in this order, before closing the device.
Both matter, and node-carplay's own comments on the message classes say why:

1. **`SendDisconnectPhone`** — *"disconnects phone session - dongle is still open
   and phone can re-connect"*. This is the one that actually returns the phone to
   home Wi-Fi. Without it the phone sits on the dongle's AP until it works out
   for itself that the far end went quiet.
2. **`SendCloseDongle`** — *"disconnects phone and closes dongle - need to send
   open command again"*. Sending open again is precisely what `carplay.start()`
   does, so this is cheap to undo: no re-plug, no power cycle, no `usb reset`
   beyond the one `start()` already performs.

Then `settleThenStop()` unwinds the read pipeline and closes the USB handle, the
same teardown every restart already used.

`SendCloseDongle` is deliberately **not** sent, though it reads like the exact
right message: *"disconnects phone and closes dongle - need to send open command
again"*. Measured on this dongle on 2026-08-28, it changes nothing observable —
see the next section — while being the one message upstream documents as needing
a re-open afterwards. `CARPLAY_CLOSE_DONGLE=on` sends it anyway.

Nor are commands 28/31 (`StartStandbyMode` / `StopBleAdv`) used. Those exist in
the firmware and would be the semantically exact lever, but they are absent from
node-carplay's `CommandMapping`, are documented only against a 2025.10 firmware,
and our dongle is pinned to 2024.01.19 and must not be updated (see
[`carlink-protocol-notes.md`](carlink-protocol-notes.md)). A wedged dongle in the
car is a much worse outcome than a dongle that is merely closed.

## The idle re-enumeration

Measured 2026-08-28, and worth knowing before it is filed as a bug: **a closed
dongle does not sit still.** With no host holding it open it re-enumerates on the
USB bus roughly every 13 seconds — a `usb_detach` then a `usb_attach`, over and
over, apparently rebooting itself each time. It does this whether or not
`CloseDongle` was sent, so it is the dongle's own behaviour with no host, not
something we provoke.

This was invisible before, because the old always-on build re-opened the dongle
within milliseconds and it never got the chance.

It is handled rather than fixed: both USB handlers check demand first and log at
`debug` when there is none. Routing it through `restartCarplay` instead produced
a `restart_begin` + `start_skipped` pair every 13 seconds, forever, which is how
it was found.

What it means for the feature is the open question in the last section: a dongle
that boots every 13 s may be a dongle that advertises every 13 s.

## States

`carplayPhase()` is the single answer to "what is CarPlay doing", used by both
`/healthz` and the `statusReq` message. On-demand adds a fourth value:

| Phase | Meaning |
|---|---|
| `plugged` | phone connected, streaming |
| `unplugged` | dongle open, waiting for a phone |
| `starting` | dongle is being opened |
| `standby` | **new** — dongle deliberately closed, nobody asked |

`standby` is not a fault and the overlay does not present it as one ("Waking the
adapter…", not "Reconnecting…"). In practice the user barely sees it: reaching
the page *is* the request that leaves the state.

## What this costs

CarPlay is no longer already up when you get in. Opening the page now pays for:

- `carplay.start()` — ~3.5 s (0.2 s find + 3.0 s post-reset settle + 0.4 s init)
- BLE advertise → iPhone notices → Bluetooth Classic → Wi-Fi join → RTSP
  pair-verify — call it 10–20 s, and it is the phone's schedule, not ours

So roughly **15–25 s from opening the page to a picture**, against ~0 s before.
That is the trade the feature exists to make. Settings → CarPlay → "Connect only
while this page is open" turns it off for anyone who would rather have the phone
grabbed as they walk up.

## Guards

Every path that could start the dongle behind the user's back now asks first:

- `runRestart()` — before the retry loop, and again inside it (demand can
  evaporate mid-retry when a tab closes)
- the 30 s watchdog — down on purpose is not down broken
- the USB `attach` handler — a dongle reseated while nobody is looking stays shut
- `pokeAutoconnect()` — inside the idle grace window the session is on its way
  out; courting a phone that is about to be released is exactly backwards

`restartCarplay('boot')` is left in place and becomes a `start_skipped` log line
under on-demand, so `CARPLAY_ON_DEMAND=off` still boots straight into a session.

## Tuning

| Env | Default | What it does |
|---|---|---|
| `CARPLAY_ON_DEMAND` | `on` | Shipped default only. The Settings switch persists a choice that wins over it. |
| `CARPLAY_IDLE_STOP_MS` | `300000` | Grace between the last visible page and the dongle closing. |
| `CARPLAY_DEMAND_TTL_MS` | `40000` | How long a page's "I am on screen" lasts without a refresh. |
| `CARPLAY_GHOST_LEASE_MS` | `15000` | How long a vote outlives a socket that died while the page was still on screen. |

## Reading it in the logs

```
carplay_on_demand      {idle_stop_ms, demand_ttl_ms, ghost_lease_ms}  at boot
start_skipped          {reason, why:"no_demand"}       boot did not open the dongle
carplay_demand         {reason:"client_visible"}       a page appeared → opening
carplay_idle_arm       {reason:"client_hidden", ms}    grace started
carplay_release        {reason:"idle", was_started}    handing the phone back
carplay_released       {reason:"idle"}                 dongle closed
start_abandoned        {why:"no_demand"}               tab closed mid-retry
control_disconnected   {clients, ghost}                ghost:true = died mid-view
carplay_demand         {reason, away_ms}               away_ms = the page's own measure
restart_dropped        {reason, why:"session_healthy"} our own reset echoing back (debug)
```

`ghost:true` followed by `carplay_demand` a moment later is the frozen-tab
round trip working: the socket died while the page was on screen, the vote was
held, and the reconnect took it over before the idle timer ever armed.

`GET /healthz` carries `carplay_on_demand` and `carplay_demand` alongside the
`carplay` phase.

## What a cold start actually costs, 2026-09-03

The price of on demand is paid once, on the first page load after the dongle has
been handed back. It is worth knowing exactly what that price is, because most
of it is not ours.

**Warm reconnects are free.** Four demands in one window, straight from the
journal:

```
00:24:22  carplay_demand -> full cold start -> phone_plugged at 00:24:36   14 s
00:25:37  carplay_demand -> no restart at all                            instant
00:27:07  carplay_demand -> no restart at all                            instant
00:27:16  carplay_demand -> no restart at all                            instant
```

Reconnecting inside `CARPLAY_IDLE_STOP_MS` logs `video_connected` and nothing
else. Reloading the page, swiping away and back, opening Settings — all free.

### Anatomy of the cleanest cold start (12 s)

| elapsed | event | what is happening |
|---|---|---|
| 0.0 s | `carplay_demand`, `dongle_absent` | dongle mid-self-re-enumeration, off the bus |
| +2.0 s | `usb_attach` | it comes back |
| +5.0 s | `usb_pipeline_started` | dongle booted, pipeline up |
| +6.0 s | `carplay_started` | handshake: BT name, Wi-Fi name, version, box info |
| **+12.0 s** | `phone_plugged` | **the dongle courts the iPhone over its own 5 GHz AP** |

The last six seconds are Bluetooth credential exchange followed by Wi-Fi
association — `phone_type` logs `wifi:1`. That half is wireless CarPlay itself
and no change on this box can remove it. A phone on a **cable** into the dongle
skips it.

So: **~6 s is inherent, ~6 s is dongle boot and enumeration, 0 s is the browser.**
The page opens its video socket 110 ms after load and shows staged progress
(`setHeadline`) for the whole wait.

### The restart loop (fixed 2026-09-04)

One cold start in four took **40 s**, running four full detach/attach/start
cycles. The signature:

```
carplay_started attempt 1
restart_begin  reason=usb_attach            <- restarts the session just built
usb_read_error LIBUSB_TRANSFER_NO_DEVICE  fatal
carplay_failure
restart_begin  reason=failure_event
usb_detach -> usb_attach -> carplay_started -> and round again
```

The mechanism was a race the `restartPending` design could not see:

1. `restartCarplay` enters the start loop and calls `carplay.start()`, whose
   `device.reset()` makes this dongle re-enumerate.
2. The resulting `attach` fires **while the start is still in flight**. The
   handler's `if (carplayStarted) return` guard misses, because `carplayStarted`
   is not set until `readerHealthy()` has passed.
3. `restartCarplay('usb_attach')` sees `restartInFlight` and arms
   `restartPending`.
4. The start succeeds.
5. The drain serves `restartPending` and tears the healthy session down. That
   teardown resets the dongle, producing the next `attach`, and so on.

**Over one week: 72 `carplay_started` to deliver ~39 sessions. 33 starts — 46 %
— were this loop.**

**Confirmed in the field 2026-09-04**, first cold start after the fix shipped:

```
11:44:02.039 restart_begin    reason=demand
11:44:02.569 usb_detach
11:44:04.573 restart_queued   reason=usb_detach
11:44:05.941 usb_attach
11:44:05.944 restart_queued   reason=usb_attach
11:44:08.659 usb_pipeline_started
11:44:08.912 carplay_started  attempt=1
11:44:08.912 restart_dropped  reason=usb_attach  why=session_healthy
```

Both queued events were our own reset echoing back; both were dropped, and the
session survived. 6.9 s to `carplay_started`, no `start_failed`.

The fix drops a queued `usb_attach`/`usb_detach` when the session came up
healthy. `carplay_started` is only reached after `readerHealthy()` has seen real
USB messages land on the handle, so an up session is proof the device settled and
the queued event was our own reset echoing back. A genuine reseat still arrives
as a `failure` event (the reader dies with `NO_DEVICE`), and the watchdog covers
the rest. Look for `restart_dropped {why:'session_healthy'}` at debug.

### Why the failed first `start()` is not worth "fixing"

A cold start often logs `start_failed ... reset error: LIBUSB_ERROR_NOT_FOUND`
before it succeeds — 32 times in a week. The obvious idea is to stop calling
`start()` into a stale handle and wait for a natural `attach` instead.

**Do not.** Measured on the same journal:

| path | demand → `usb_attach` |
|---|---|
| our `reset()` forces it back | **~3 s** |
| waiting for the idle cycle | ~6.5 s average, up to 13 s |

The dongle re-enumerates on its own every ~13 s while closed (§ The idle
re-enumeration), so waiting for the next one is *slower* than kicking it. The
failed reset is ugly in the log and near-optimal on the clock. Leave it.

### Where the error count comes from

`releaseDongle` kills the reader, so every clean hand-back emits
`usb_read_error` → `carplay_failure` at **error** level. **39 of the 57
error-level lines in that week were this benign artifact.** Any "errors since
restart" check — including the one in `scripts/deploy-fullscreen.sh` — is
counting normal releases unless it excludes them.

## Confirmed in the car, 2026-08-29

**The phone keeps home Wi-Fi while CarPlay is in standby.** Observed directly on
the phone with the Pi sitting in `standby` and the car in range: the iPhone was
on the house network, not on the dongle's `AutoBox-60bf`. That is the whole
point of the feature and it holds.

This matters more than it might look, because the dongle does *not* go quiet when
closed — it re-enumerates every ~13 s (see above). The worry was that a dongle
rebooting that often is a dongle advertising that often, and would go on
capturing the phone regardless of whether we had it open. It does not.

`visibilitychange` behaviour in the Tesla browser is still unmeasured, but it no
longer gates anything: `carplay_idle_arm`'s `reason` records which signal fired
(`client_hidden` = the event, `ttl` = the heartbeat backstop), so it can be read
off a normal session's log whenever anyone cares.

### Do not try to verify this with a LAN sweep

Recorded because it cost three attempts. Ping/ARP sweeping the house subnet from
the Pi and diffing the live-host set across standby / connected / standby
*cannot* see an iPhone: a locked phone with Private Wi-Fi Address does not answer
the probes, so it is absent from every phase, including the phases where it is
provably on the network. The give-away is the control failing — connecting
CarPlay must remove exactly one host from the set, and if nothing is removed the
method is blind, not the answer negative.

Two lesser traps in the same area:

* `ip neigh` keeps **STALE** entries after a host leaves, so "is it in the
  table" counts departed hosts as present. Filter to `REACHABLE`/`DELAY`/`PROBE`.
* `ip neigh flush dev wlan1` drops the ARP entry for your own SSH peer and kills
  the session you are running the test from.

The reliable check is the one that takes two seconds: look at the phone.
