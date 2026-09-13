# Pi Zero 2 W → Tesla CarPlay: Project Plan

> **Historical** — written for the Pi Zero 2 W era; current hardware is a Pi 4 (the migration in `docs/pi4-migration-plan.md` is complete). See `README.md` for current state.

**Goal**: Replace the current Pi 4 + Tesla-Android stack with a Pi Zero 2 W running native Linux + `node-carplay`, serving CarPlay to the Tesla Highland browser. Optimize for fast boot and reliability — without losing the ability to roll back.

**Target end-state**:
- Cold boot to interactive CarPlay: **<20 s** (perceived: ~0 s with always-powered trick)
- No upstream internet on the Pi (single USB port goes to CarLinkit) — Tesla stays on the SSID via a fake captive-portal shim
- Pi 4 + Tesla-Android setup preserved as fallback on a separate SD card

---

## Architecture overview

```
[iPhone] <--BT (A2DP/HFP)--> [Tesla speakers + mic]   ← audio path bypasses Pi entirely
[iPhone] --wifi/BT--> [CarLinkit CPC200-CCPA dongle] --USB--> [Pi Zero 2 W]
                                                                  |
                                                                  +-- node-carplay (decodes USB protocol; video+touch only)
                                                                  +-- Node WS+HTTP server :8080 (H.264, touch, static HTML)
                                                                  +-- nginx :443 (TLS termination, reverse-proxy to :8080)
                                                                  +-- nginx :80 default-server (captive-portal 204/Success shim)
                                                                  +-- hostapd (Wi-Fi AP "TeslaCP")
                                                                  +-- dnsmasq (DHCP + DNS, wildcard A → 240.3.3.4)
                                                                  +-- iptables (DNAT 240.3.3.4 → <pi-lan-ip>)
                                                                  |
[Tesla Highland browser] --wifi--> [Pi AP] --https--> renders <canvas> via jmuxer
                                                   --wss--> sends Pointer Events back

# No upstream link from Pi. iPhone carries cellular for CarPlay; Tesla
# carries its own LTE for non-CarPlay needs. The Pi's "Wi-Fi" exists
# only to host the CarPlay URL.
```

> **Note — Pi power is tied to ignition.** The Pi runs off the cigarette
> socket, which only energises when the car is on (or for ~30 min in
> accessory mode after parking). The Pi has no battery and no
> always-on rail, so wall-clock schedulers (cron at 4 am, weekly
> systemd timer, etc.) are useless — the Pi will be off whenever they
> fire. Trigger any periodic on-Pi work on **Pi-observable events**
> instead: boot, hostapd STA-disconnect, no-client-for-N-minutes idle,
> SD-card flag file, etc. This constraint is what shapes the cert
> auto-renewal trigger in Phase 3 (10-min idle → flip to home Wi-Fi).

---

## Phase 0 — Decisions & Bill of Materials

**Effort**: 1 evening · **Goal**: order parts, lock decisions

### Decisions to make first

| Decision | Default recommendation | Notes |
|---|---|---|
| Keep Pi 4 + Tesla-Android as fallback? | **Yes** — separate SD card | Cheap insurance; sell Pi 4 only after Pi Zero solution proves stable for 4+ weeks |
| Provide upstream internet to the Pi? | **No** (revised 2026-05-03) | Single USB port = CarLinkit only. iPhone carries cellular itself for CarPlay; Tesla stays on the SSID via a captive-portal-bypass shim (dnsmasq + nginx 204). LTE modem and phone tether both deleted from the BoM. |
| DietPi vs Raspberry Pi OS Lite? | **DietPi** | ~5 s faster boot; same effort to set up |
| Multi-touch? | **Shipped 2026-05-16** | Original decision said "Apple CarPlay disallows pinch-zoom regardless" — verified wrong for this dongle's firmware. USB msg type 0x17 is honored end-to-end and Apple Maps pinch-zoom works. Wire format + clean-break design in `docs/carlink-protocol-notes.md`. |
| Bench Tesla simulation? | **Chrome on laptop** | Tesla browser is Chromium-based; differences are minor and mostly RFC-1918/origin-related |
| Audio path to Tesla speakers? | **Dongle "phone audio" mode → iPhone BT → Tesla** | Reuses existing Tesla-Android setup. Pi never touches audio. Eliminates BlueZ A2DP-source work and Wi-Fi/BT antenna contention. Setting is stored in the CarLinkit's own NV — confirm it's enabled in your current Tesla-Android setup before swapping. |

### Bill of Materials (Malaysian pricing, May 2026)

**Required**
- Raspberry Pi Zero 2 W: **RM 80–100** (Cytron, MyDuino, Shopee Mall)
- microSD 32 GB A1 (SanDisk Ultra or Samsung Evo Plus): **RM 25–40** — *A1 rating matters for boot speed*
- Powered USB OTG hub, 4-port, micro-USB-B input: **RM 40–80** (UGREEN or Anker preferred; avoid generic)
- 12 V→5 V/3 A buck converter (Pololu D24V50F5 ideal; LM2596-based modules acceptable): **RM 30–60**
- Cigarette-lighter-to-bare-wire adapter with 5 A fuse: **RM 15–25**
- Micro-USB OTG cable (data): **RM 10**
- Micro-USB power cable (cut for buck wiring): **RM 10**
- Pi Zero 2 W case with passive heatsink: **RM 25–40**

**Optional (Phase 5)**
- Small fan if dashboard temps exceed 60 °C: **RM 15**

**Already owned**
- CarLinkit CPC200-CCPA dongle ✓
- Pi 4 4 GB (kept as fallback) ✓

**Total new spend**: **~RM 250–400** before optional modem.

### Pre-flight checks before ordering

- [ ] Confirm CarLinkit model is CPC200-CCPA or CPC200-CCPM (USB ID `1314:152*`)
- [ ] Confirm iPhone is iOS 16+ for stable wireless CarPlay handshake
- [ ] Identify exact 12 V tap point in Highland (cigarette socket vs accessory switched live)
- [ ] Verify USB hub is rated for 5 V / 2 A *output* per port (CarLinkit can pull 500 mA spikes)

---

## Phase 1 — Bench Proof of Concept

**Effort**: 1 weekend · **Goal**: prove `tesla-pi` works on Pi Zero 2 W with current `node-carplay`, on the bench, before any car involvement

### Tasks

1. **Flash DietPi to microSD**
   - Download from `dietpi.com`, image to SD with Raspberry Pi Imager
   - Pre-configure Wi-Fi (your home network) and SSH in `dietpi.txt` and `dietpi-wifi.txt` on the boot partition
   - Reserve `<pi-lan-ip>` for the Pi on your home router (DHCP static lease against the Pi's wlan0 MAC) so SSH access is stable across reboots
   - First-boot will take 5–10 min for self-configuration; let it complete

2. **Base setup via SSH**
   - From your laptop: `ssh pi@raspberrypi.local` (default password `dietpi`; change on first login)
   ```bash
   sudo dietpi-config       # set timezone, locale, hostname=tesla-cp
   sudo dietpi-software     # install Node.js (option 9) — pulls Node 20 LTS
   sudo apt install -y git build-essential libusb-1.0-0-dev
   ```

3. **Fork and clone `marcraft2/tesla-pi`**
   - Fork on GitHub to your account
   - On Pi (via `ssh pi@raspberrypi.local`): `git clone https://github.com/<you>/tesla-pi.git`
   - `cd tesla-pi && npm install`

4. **Bump `node-carplay` to current version**
   ```bash
   npm install node-carplay@latest
   ```
   - This *will* break — the old code uses an outdated API. Expect to rewrite the carplay-instantiation block in `index.js`. Reference the current `node-carplay` README for the new API surface.
   - Budget: 4–8 hours for the upgrade. Most painful part of the whole project.

5. **Add udev rule for CarLinkit USB access**
   ```bash
   echo 'SUBSYSTEM=="usb", ATTR{idVendor}=="1314", ATTR{idProduct}=="152*", MODE="0660", GROUP="plugdev"' | sudo tee /etc/udev/rules.d/52-nodecarplay.rules
   sudo usermod -a -G plugdev dietpi
   sudo udevadm control --reload-rules
   ```

6. **Plug in CarLinkit, run app**
   - Start: `node index.js` (or whatever entry point the fork uses)
   - On laptop browser: navigate to `http://<pi-lan-ip>:3000` (or whatever port)
   - Plug iPhone via wireless CarPlay handshake
   - **Success criterion**: CarPlay screen renders in laptop Chrome with single-touch click-through

### Validation gates

- [ ] CarLinkit USB enumerates (`lsusb` shows `1314:152x`)
- [ ] `node-carplay` connects without errors in stdout
- [ ] iPhone pairs (Bluetooth + Wi-Fi handshake)
- [ ] Video stream visible in laptop Chrome
- [ ] Single-finger click forwards to iPhone (e.g., Maps responds)
- [ ] CPU on Pi Zero 2 W stays <30 % steady state

### Risks at this phase

- **Old `node-carplay` API gap is the #1 blocker.** If the upgrade is too painful, alternative path: extract just the CarPlay handler from `rhysmorgan134/react-carplay` (which already uses current `node-carplay`) and build a new minimal WebSocket server around it. ~200 lines of Node.js.
- **CarLinkit firmware version**: very old dongles (pre-2022) may need firmware update via Carlinkit's Windows tool first.
- **Power**: Pi Zero 2 W on bench needs decent 5 V / 2 A supply; cheap chargers cause random USB resets that look like code bugs.

---

## Phase 2 — Code polish & resilience

**Effort**: 1 weekend · **Goal**: production-quality fork with resilience and auto-start

### Tasks

1. **Add resilience**
   - Auto-reconnect WebSocket on client side (exponential backoff, max 5 s)
   - Server-side: handle CarLinkit disconnect/reconnect cleanly (don't crash)
   - `/healthz` HTTP endpoint returning JSON `{ "carplay": "connected", "phone": "paired", "uptime_s": 1234 }`
   - Log to `journalctl` via systemd, not stdout

2. **Systemd service for auto-start**
   ```ini
   # /etc/systemd/system/tesla-pi.service
   [Unit]
   Description=Tesla CarPlay
   After=network-online.target hostapd.service
   Wants=network-online.target

   [Service]
   Type=simple
   User=dietpi
   WorkingDirectory=/home/dietpi/tesla-pi
   ExecStart=/usr/bin/node /home/dietpi/tesla-pi/index.js
   Restart=always
   RestartSec=5

   [Install]
   WantedBy=multi-user.target
   ```
   - `sudo systemctl enable --now tesla-pi`

3. **Confirm dongle audio routing** (no Pi-side work needed)
   - Verify the CarLinkit is set to "phone audio / phone mic" mode (carry-over from Tesla-Android setup)
   - Smoke-test: play music via CarPlay on the bench, confirm audio comes out of the iPhone (not Pi USB), then hits Tesla via the phone's existing BT pairing
   - Drop `bluez` / `bluetooth-socket` from `package.json` if present in the fork — Pi has no role in audio

4. **Tag a v0.1 release in your fork**
   - Always have a known-good rollback point before the next phase

### Validation gates

- [x] Service auto-restarts after `kill -9 <pid>` (verified: PID 1405 → 1438 in ~6s)
- [x] Service starts within 3 s of boot completion — `tesla-pi.service @11.121s`, immediately after `network-online.target @11.099s` (Type=simple → instant fork)
- [~] Server cleanly recovers from a mid-session dongle disconnect — code path verified firing during initial open/reset (`usb_detach` event + in-flight guard), but a real cable yank with the dongle plugged in still pending
- [ ] Audio plays through Tesla speakers via the phone's existing BT pairing (Pi not involved) — needs in-car bench test

### Phase 2 baseline measurements (2026-05-03, post-reboot)

Measured on the bench Pi Zero 2 W (DietPi, `tesla-pi v0.1.0`, dongle plugged in, laptop browser tab open):

| Milestone | Kernel uptime | Notes |
|---|---|---|
| Kernel handoff to userspace | 4.34s | `systemd-analyze` |
| `network-online.target` reached | 11.10s | dominated by `ifup@wlan0.service` (5.36s) |
| `tesla-pi.service` started | 11.12s | Type=simple, fires immediately after network-online |
| Node `http_listen` on :8080 | ~19.9s | ~4.4s of node ESM module load on the Pi Zero 2 W |
| Dongle found & opened, CarPlay ready | ~31.1s | ~11s reset/re-enumerate cycle (dongle firmware behavior) |
| Total system boot to graphical.target | 15.58s | within `<20s` target from project header |

**Tuning levers if needed later** (none active yet):
- `ifup@wlan0` (5.4s) — addressable in Phase 3 if AP mode boots faster than client mode
- Node ESM load (~4s) — `node --experimental-snapshot` could help; gnarly, defer
- USB reset cycle (~11s) — dongle firmware, not addressable from our side

How to re-measure: `sudo systemd-analyze critical-chain tesla-pi.service` and `journalctl -u tesla-pi -b 0 -o short-monotonic | grep -E "Started|http_listen|carplay_started"`.

### Risks at this phase

- **`node-carplay@4` does not auto-recover from mid-stream USB disconnect** — `DongleDriver.readLoop` keeps issuing transfers against a dead handle indefinitely. Detect-disconnect → tear-down → re-`start()` logic must be added in `index.js` (subscribe to `usb` library `detach` events on the open device).

---

## Phase 3 — Wi-Fi AP, no internet sharing

**Effort**: 1 weekend · **Goal**: Pi serves Tesla a Wi-Fi network it stays associated to despite no upstream; CarPlay site reachable over HTTPS via the `240.3.3.4` shim.

**Superseded in part (2026-08-14):** the Pi 4 has spare USB and a second Wi-Fi adapter, so upstream internet came back — sharing is now on by default whenever an uplink exists, with the walled garden below as the automatic offline fallback. Tasks 3's "no MASQUERADE, `ip_forward=0`" no longer describes the build; see "Internet sharing | net-share.sh" in `tesla-doc.md`.

**Revision (2026-05-03):** the original Phase 3 plan assumed a USB phone tether on the Pi for upstream internet. The Pi Zero 2 W's single USB OTG port is committed to the CarLinkit dongle (Phase 1 confirms `1314:1521` on the inner micro-USB), so a USB hub + phone is parts/heat/cable mess for a feature the user doesn't actually need (iPhone carries cellular for both CarPlay backend and Tesla map tiles). Rescoped to no-internet design with a fake captive-portal layer.

### Tasks

1. **Configure `hostapd` on `wlan0`**
   - SSID `TeslaCP`, channel 6, `hw_mode=g`, 802.11n, CCMP-only, country `MY`
   - Static IP `<pi-lan-ip>/24` on `wlan0` via `/etc/network/interfaces.d/wlan0`
   - Source: `tesla-pi/conf/hostapd.conf`

2. **`dnsmasq` for DHCP + DNS + wildcard A**
   - DHCP `<lan-host>–50`, gateway and DNS = `<pi-lan-ip>`, lease 24h
   - `address=/#/240.3.3.4` resolves every name to the public-IP shim
   - `no-resolv`, `bind-interfaces` — dnsmasq never tries upstream
   - Source: `tesla-pi/conf/dnsmasq.conf`

3. **iptables: keep `240.3.3.4` shim, drop everything else**
   - PREROUTING DNAT `240.3.3.4:80/443` → `<pi-lan-ip>`
   - No MASQUERADE, no FORWARD rules, `net.ipv4.ip_forward=0` *(since revised:
     forwarding is on and interface-scoped MASQUERADE/FORWARD rules exist for the
     optional internet sharing in `scripts/net-share.sh`)*
   - Sources: `tesla-pi/conf/iptables.ipv4.nat`, `tesla-pi/conf/sysctl-ip-forward.conf`

4. **nginx with captive-bypass + CarPlay site**
   - `:80 default_server`: returns 204 for `/generate_204`, success HTML for `/hotspot-detect.html` and `/library/test/success.html`, plain-text "Microsoft NCSI" / "Microsoft Connect Test" for the MS probes, 204 fallback for everything else
   - `:443` server block for the user's domain — reverse-proxies `/` and `/ws/*` to the Node app on :8080
   - Source: `tesla-pi/conf/nginx-carplay.conf`
   - Initial LE cert seeded once from a laptop. Subsequent renewals automated on-Pi (next item).

5. **Auto-renewal on home Wi-Fi** (`cert-renew-watch.service`)
   - Long-running watcher polls `hostapd_cli list_sta` every 60s
   - After 10 min with no STA: tear down hostapd/dnsmasq, `wpa_supplicant` → home SSID, run `scripts/cert-sync.sh` (fetch the centrally-issued cert), restore AP, reload nginx. Gated on remote cert *version*, not local file age, so a long-offline device catches up on its first idle window.
   - Triggered by physically bringing the Pi indoors and powering it on; in the car the Tesla associates within minutes so the idle timer never reaches threshold
   - Sources: `tesla-pi/scripts/cert-renew-watch.sh`, `tesla-pi/scripts/cert-sync.sh`, `tesla-pi/systemd/cert-renew-watch.service`, plus templates: `conf/wpa_supplicant-wlan0-home.conf.template`, `conf/tesla-pi.env.template`
   - The device holds **no** Cloudflare credential — issuance runs in CI (`.github/workflows/renew-cert.yml`). See `docs/turnkey-shared-domain-plan.md`.

6. **Cert-expiry banner in CarPlay UI**
   - `/healthz` returns `cert_days_remaining` (parsed from leaf cert via Node `crypto.X509Certificate`)
   - `static/index.html` polls `/healthz`; when ≤10 days, shows a dismissable red banner above the canvas with copy "TLS certificate expires in N days — bring the Pi indoors so it can auto-renew on home Wi-Fi"
   - Dismiss persists for the browser session via `sessionStorage`

7. **Public DNS A record** for the user's domain → `240.3.3.4`. Pi-side dnsmasq overrides this for clients on the AP, but a matching public record keeps debugging from any other network consistent.

8. **Driveway smoke test**
   - Park, Pi up, Tesla → Wi-Fi → `TeslaCP`
   - Tesla browser → `https://<your-domain>/` → CarPlay loads, single-finger touch works
   - Confirm Tesla doesn't drop the SSID after the connectivity probe

### Validation gates

- [ ] Tesla connects to AP and gets DHCP lease in <lan-host>–50
- [ ] Tesla **stays** on the SSID for ≥10 min idle (probe accepted)
- [ ] Tesla browser loads `https://<domain>/` end-to-end (cert validates, page renders, WS connects)
- [ ] After `nginx -s stop` (dnsmasq still up), Tesla stays associated — confirms the probe is HTTP, gated by nginx's :80 default-server
- [ ] `tcpdump -i wlan0 -nn -s0 'tcp port 80'` during fresh Tesla association captures the actual probe URL Tesla used (record for future-proofing)
- [ ] Latency Pi→Tesla via WebSocket: <30 ms

### Risks at this phase

- **Probe-URL coverage gap (resolved 2026-05-03).** Tesla MCU's connectivity check is **not** a standard captive-portal URL. Tesla queries `connman.vn.tesla.services` (CN: `connman.vn.cloud.tesla.cn`) and looks for response header `X-ConnMan-Status: online`. Found by reading tesla-android's `services/lighttpd/lighttpd.conf`. Fix is one nginx server block that matches the Host header and returns the magic header. Pre-empts the elaborate-bypass approach (universal DNAT, chrony NTP, ICMP DNAT) — none of those are needed because Tesla's probe is HTTP-only with a single specific endpoint. See `docs/captive-bypass-troubleshooting.md`.
- **Cert expiry in the field.** 90-day LE cert. Mitigation: on-Pi auto-renewal triggered by 10-min idle (i.e. the Pi is indoors and Tesla isn't connected), plus a CarPlay-UI banner at ≤10 days remaining as a backstop. If the watcher fails (e.g. CF token expired), the captive layer keeps working so Tesla still associates; only the CarPlay site goes down — manual scp fallback documented in `tesla-doc.md`.
- **Single radio coexistence.** AP mode disables client mode on the Pi Zero 2 W's single 2.4 GHz antenna. The Pi cannot be on home Wi-Fi while also serving Tesla. The cert-renew watcher works around this by tearing down the AP for the renewal cycle (~60 s); acceptable because we only fire it after 10 min of idle, i.e. when the Pi is almost certainly indoors and not in the car.
- **2.4 GHz interference**: real-world test in usual parking spots, deferred to Phase 5.

---

## Phase 4 — In-car physical install

**Effort**: 1 day (half day if competent with 12 V) · **Goal**: clean, hidden install with proper power

### Tasks

1. **Power**
   - Wire 12 V→5 V/3 A buck output to Pi Zero 2 W power input (NOT data)
   - Source 12 V from cigarette lighter socket via fused adapter; DO NOT tap always-on 12 V (kills LV battery in 2–3 days)
   - Verify buck output: 5.0–5.2 V under load with multimeter before connecting Pi
   - Add a 2200 µF capacitor across the 5 V rail near the Pi if voltage dips during car start

2. **Mounting**
   - Glovebox or center console storage — out of direct sun
   - Velcro mount; keep CarLinkit dongle accessible (it occasionally needs firmware updates via PC)
   - Route USB cables to avoid pinch points and heat sources (no near A/C ducts that condense, no near power steering motor)

3. **First boot in car**
   - Power on with engine on
   - SSH from phone hotspot to verify boot OK — note that `<pi-lan-ip>` only resolves on the home network; in-car the Pi will live on its own AP subnet (e.g. `192.168.42.1`), so SSH to that address from a laptop joined to `TeslaCP`
   - Tesla connects to `TeslaCP`
   - Browser → bookmarked URL → CarPlay loads

4. **Bookmark on Tesla**
   - Save the CarPlay URL as a homepage favorite for one-tap access

### Validation gates

- [ ] Pi survives 30-min "engine off, accessory live" period without browning out
- [ ] Pi cold-boots in <20 s after door unlock (cigarette socket re-energizes)
- [ ] No thermal throttling after 30 min idle in 50 °C dashboard sun (`vcgencmd measure_temp` <70 °C)
- [ ] CarPlay loads from cold within 60 s of door unlock (Pi boot + Tesla connect + page load)

### Risks at this phase

- **Cigarette socket cuts power on engine off** in some Tesla configurations — verify in your specific Highland software version. If it cuts immediately, you lose the "always warm" benefit; Pi cold-boots every drive.
- **Voltage dips during car start** can crash Pi mid-task — buck converter + capacitor mitigates but doesn't eliminate. If Pi reboots when you press brake-to-start, add a larger cap or move power to a true accessory bus.
- **Heat in MY tropical climate**: dashboard interior temps in Malaysian midday sun reach 60–70 °C. Pi Zero 2 W tolerates this without active cooling but throttle threshold is 80 °C — monitor for first week.

---

## Phase 5 — Real-world testing & tuning

**Effort**: 1–2 weeks of normal driving · **Goal**: identify and fix actual usage issues

### Test matrix

Drive these scenarios over 1–2 weeks, log issues in a notes file:

| Scenario | What to watch for |
|---|---|
| Quiet residential street | Baseline — should be flawless |
| Mall/grocery parking lot | 2.4 GHz interference (other cars, retail Wi-Fi) |
| Drive-thru queue | Same — typically dense Wi-Fi from store APs |
| Highway @ 110 km/h | Pi vibration, GPS handoff lag |
| Tunnels (KL has a few) | iPhone loses cell → CarPlay UX behavior |
| 30°C ambient | Baseline thermals |
| 35°C+ midday parked | Worst-case thermals |
| Phone battery <20% | Tethering tends to throttle |

### Tuning levers (apply only if needed)

- **Stream too laggy**: drop CarPlay resolution from 1280×720 to 800×600 in `node-carplay` config
- **Stream stutters in dense Wi-Fi**: try AP channel 11 instead of 6, or vice versa; consider channel scanner first
- **Touch lag**: profile WebSocket round-trip; Tesla browser is the bottleneck, not Pi
- **Boot too slow**: `dietpi-config` → Advanced → Boot logs to RAM, disable swap, disable any unused services

### Validation gates (end of Phase 5)

- [ ] 7+ consecutive drives with no manual intervention required
- [ ] Cold boot to interactive: <20 s consistently
- [ ] No thermal throttle events in `journalctl -k`
- [ ] Acceptable performance in your 3 most-frequent driving environments

### Decision point

After 2 weeks of stable use:
- **If stable** → proceed to Phase 6 polish, sell Pi 4 if desired
- **If unstable** → roll back to Pi 4 + Tesla-Android (you kept the SD card!), file GitHub issues on your fork, debug at leisure

---

## Phase 6 — Polish & long-term maintenance (optional)

**Effort**: ongoing · **Goal**: reduce maintenance friction

### Optional improvements

- **OTA update mechanism**: simple `git pull && systemctl restart` script triggered from your home Wi-Fi when the Pi sees it (e.g., when parked at home)
- **Remote monitoring**: push `/healthz` to your home n8n/Home Assistant when in range; alerts if Pi crashes mid-drive
- **Buildroot port** (only if you want sub-10 s boot): expect 40+ hours of work; document if you do this
- **Backup & restore**: weekly `dd` of SD card to your NAS; Pi Zero 2 W is small enough to have a hot-swap spare
- **Read-only rootfs**: prevents SD card corruption from ungraceful power-off (which *will* happen in a car). DietPi has an option for this.

### When to revisit the architecture

- CarLinkit ships a new dongle protocol → check if `node-carplay` keeps up
- Tesla pushes firmware that breaks the browser approach → fall back to Pi 4 / commercial T2C
- You upgrade to a new Tesla → re-test everything; MCU changes can break stack
- Pi Zero 3 ships with 5 GHz Wi-Fi → swap board, keep SD card

---

## Risk register

| Risk | Likelihood | Impact | Mitigation |
|---|---|---|---|
| `node-carplay` API upgrade is harder than expected | High | Blocks Phase 1 | Time-box to 8 hours; if blown, switch to extracting handler from `react-carplay` |
| Tesla drops SSID because connectivity probe doesn't match | Resolved 2026-05-03 — Tesla probes `connman.vn.tesla.services` for header `X-ConnMan-Status: online`. nginx server block in `conf/nginx-carplay.conf` handles it. Future Tesla firmware change could re-trigger; pcap-driven debug ladder in `docs/captive-bypass-troubleshooting.md` | — | — |
| LE cert auto-renewal silently fails for weeks | Low–Medium | CarPlay site fails to load (Tesla still associates via captive shim) | `cert_days_remaining` on `/healthz`, in-CarPlay banner at ≤10d, manual scp fallback documented |
| 2.4 GHz interference unusable in dense urban areas | Medium | Forces fallback or external 5 GHz USB AP | Test in Phase 5 driving; have Pi 4 ready |
| Tesla browser quirk breaks WebSocket video stream | Low | Forces architecture rethink | Keep Pi 4 + Tesla-Android image as instant fallback |
| SD card corruption from car power cycling | Medium over 6 months | 30 min SD restore from backup | Read-only rootfs; weekly backup |
| CarLinkit dongle dies | Low | Order replacement (~RM 200) | Already have one; consider spare |
| CarLinkit "phone audio" mode unsupported by current firmware | Low | Forces Pi-side BlueZ work after all (~1 weekend) | Confirm setting works in Tesla-Android setup before swapping; keep firmware version noted |
| Tesla Highland firmware OTA disables 3rd-party browser usage | Low | Entire approach dies (also kills Pi 4 setup) | No mitigation; this risk is shared with Carlinkit T2C and Tesla-Android too |
| Project becomes orphaned (you lose interest) | Medium | Falls back to Pi 4 / buy T2C | Document setup well; treat as fun project, not critical infra |

---

## Timeline summary

| Phase | Effort | Calendar time |
|---|---|---|
| 0 — Decisions & ordering | 1 evening | 0 (then 1–2 weeks shipping) |
| 1 — Bench POC | 1 weekend | Week 2 |
| 2 — Multi-touch & polish | 1–2 weekends | Weeks 3–4 |
| 3 — AP & networking | 1 weekend | Week 5 |
| 4 — In-car install | 1 day | Week 5 |
| 5 — Real-world testing | 1–2 weeks driving | Weeks 6–7 |
| 6 — Polish | Ongoing | Week 8+ |

**Total to "stable daily-driver state": ~6–8 weeks elapsed, ~5 active weekends.**

---

## Open questions to resolve

- [ ] What's the actual Highland behavior for cigarette socket power on engine off? (Test with multimeter before final wiring)
- [ ] Does your iPhone's wireless CarPlay handshake currently take >10 s? If so, that adds to perceived boot time regardless of Pi
- [ ] Are you OK with single-touch in Phase 1 if multi-touch upgrade in Phase 2 turns out hard?
- [ ] Will you ever want native Android apps (Spotify, YouTube Music) on Tesla? If yes, this whole plan is wrong direction — keep Tesla-Android
- [ ] Do you want a Slack/Telegram alert when Pi crashes mid-drive, or is "look at the screen, see no CarPlay, drive on phone audio" acceptable?

---

## What success looks like at the end

- You start the car. Pi is already alive (cigarette socket kept it on for the last 30 min while you were in the office).
- You unlock the door. Tesla wakes, connects to `TeslaCP` Wi-Fi within 5 s.
- You sit down. Tesla browser auto-loads the bookmarked CarPlay URL.
- iPhone's wireless CarPlay handshakes within 5–10 s.
- Total: **<15 s from unlock to driving with CarPlay**, vs current 80–120 s.
- Pinch-zoom works in Maps via Android Auto leg.
- ~~Tesla itself has no internet on this Wi-Fi (the Pi has none to share).~~ As of 2026-08-14 the Pi shares its uplink when it has one, and falls back to the walled garden when it doesn't. Tesla map tiles and traffic use the Wi-Fi when it is live and LTE otherwise.
- Pi 4 sits in a drawer as known-good fallback.