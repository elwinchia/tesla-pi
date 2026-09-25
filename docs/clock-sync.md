# Clock sync from the car

**Status:** implemented 2026-09-25. Settings → System → Date & time.

## The problem

A Pi 4 has no real-time clock. What it has:

1. At boot, systemd advances the clock to the modification time of
   `/var/lib/systemd/timesync/clock`, which `systemd-timesyncd` rewrites about
   once a minute while it runs (`SaveIntervalSec=60`). So a box comes up with
   roughly the last minute it was powered.
2. After that, `systemd-timesyncd` polls the Debian NTP pool over whatever
   default route exists. At home that is `eth0` or `wlan1`. In the car the only
   interface is the hotspot on `wlan0`, and the Tesla joins us rather than the
   other way round — there is no default route and NTP never runs.

Nothing in this repo configured any of this; it is stock DietPi. Measured on
the test box 2026-09-25: network up 08:53, first NTP contact 09:38.

The result is that in-car time is "the last minute the Pi was powered, plus
uptime". A mid-drive power cut costs only the outage. But the lighter socket is
switched, so every morning the Pi wakes with last night's time and keeps it
until it next sees home Wi-Fi. Every journal line from a drive is stamped
wrong by however long the car sat, which is what made the power-cycling
investigation (`docs/plan.md`) so hard to line up with what happened.

What actually depends on the Pi's clock:

- event-log and journal timestamps (the real pain),
- the certificate days-remaining figure in `/healthz` (cosmetic),
- outbound TLS to the cert service and certbot, which need a roughly correct
  clock. That only runs when an uplink exists, which is also when NTP fixes
  the clock, so it is at worst a race at boot.

Not the car trusting the Pi's HTTPS certificate: the browser checks validity
against the car's own clock.

## The source

The car does not hand out time over DHCP, DNS, the connman probe or TLS
(Chromium randomises the ClientHello time), and BLE is rationed and read-only.
The one usable source is the page itself: `Date.now()` in the Tesla browser is
the car's GPS- and LTE-disciplined clock in UTC epoch milliseconds. Time zone
does not matter, and it is accurate to well under a second.

## How it works

**Page → Pi.** `static/index.html` sends `{ type: 'clock', now: Date.now() }`
over the control socket as the first message on every (re)connect, and again
every five minutes. First so that a large correction lands before CarPlay is
asked for, not underneath it.

**Pi.** `index.js` (the *Clock* section) keeps the last report and its offset
from the Pi's own clock, and steps the clock when all of these hold:

| condition | why |
|---|---|
| the Date & time switch is on (`clockSync`, persisted, default on) | the user's call |
| `/usr/local/sbin/tesla-pi-clock` exists | the feature is installed |
| `/run/systemd/timesync/synchronized` does **not** exist | timesyncd has not had an NTP answer this boot; once it has, NTP is the better source and wins |
| the offset is at least 2 s (`CLOCK_AUTO_MIN_MS`) | LAN jitter is milliseconds; anything under this is not worth a sudo spawn |
| no automatic step in the last 30 s | a flapping page cannot re-step the clock every reconnect |

The step goes through the privileged helper (`sudo -n tesla-pi-clock set
<epoch_ms>`), which is the only thing that needs root. The helper checks the
argument is thirteen digits between 2024 and 2100, runs `date -u -s`, and
stamps the timesyncd clock file so a power cut inside the next minute still
boots into the corrected time.

**Anchors.** Everything in `index.js` that measures elapsed time does so with
`Date.now()` deltas: the stall watchdog, the pair window, the demand and ghost
leases, every "seen N s ago". An eight-hour jump forward would read as an
eight-hour stall. `shiftWallClock` moves every such anchor by the step, so they
carry on as if the clock had always been right. Timers are monotonic and need
nothing.

**Manual.** `POST /clock/set { now_ms, source }` sets the clock by hand.
*Sync now* sends the page's `Date.now()`; the date/time field sends what was
typed. Both are the driver asking, so neither defers to NTP — timesyncd simply
wins again at its next poll (up to 34 minutes), and the response's
`ntp_synced` lets the page say so.

**State.** `/healthz.clock` and `GET /clock/status` (which 404s where the
helper is absent, and is how the page decides to show the group):

```json
{ "now_ms": 1790296934107, "tz": "Asia/Kuala_Lumpur", "configured": true,
  "sync_enabled": true, "ntp_synced": false,
  "last_set_at": 1790296930000, "last_source": "browser", "last_delta_ms": 28794000,
  "last_offset_ms": -3, "steps": 1 }
```

`last_source` is `browser` (automatic), `sync` (the button) or `manual` (typed).

## Install

```bash
sudo TESLAPI_SERVICE_USER=$USER bash scripts/install-clock-tab.sh
sudo systemctl restart tesla-pi.service
```

`image/provision.sh` runs the installer, so a flashed image has it. Without it
the group never appears and the clock is never touched.

Test the helper's argument filter offline with `bash scripts/test-clock-helper.sh`.

## Hardware alternative

A DS3231 RTC module on the I²C header with a coin cell fixes this for every
boot, including ones where no page ever connects. The two are complementary;
this one is free.
