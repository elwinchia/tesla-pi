# Setup guide — Pi 4 Tesla CarPlay

End-to-end recipe to take a fresh Pi 4 from an unflashed SD card to a working in-car CarPlay box that the Tesla browser connects to over Wi-Fi. (Originally written for the Pi Zero 2 W; the steps are identical on the Pi 4 unless noted.)

> Status: **deployment recipe**, not a teaching doc. Assumes you've read `docs/plan.md` for *why* the architecture looks this way.

> **You probably don't need this page.** Flashing a released image does all of
> it for you — see [Option A in the README](../README.md#option-a--flash-the-image-recommended)
> and [`docs/image-build.md`](image-build.md). Steps 2–12 below are also
> available as one idempotent script: `sudo image/provision.sh` on a live Pi.
> Follow the manual recipe when you want to understand each moving part, or when
> you're deploying onto a box you already have set up your own way.

---

## Prerequisites

**Hardware**
- Raspberry Pi 4 (2 GB is enough; 4 GB gives headroom for the RetroArch addon)
- microSD ≥ 16 GB, A1 rated
- Carlinkit CPC200-CCPA (USB ID `1314:152*`) — wireless CarPlay dongle, plugs straight into a Pi 4 USB-A port
- 12 V → 5 V/3 A buck for in-car (deferred to Phase 4 of `plan.md`)
- iPhone with iOS 16+

**Off-Pi**
- Nothing. You do **not** need a domain, a DNS provider, or a Cloudflare account.
  The device uses the project's shared hostname `device.tesla-pi.humblebees.co`
  and pulls its TLS certificate from the project's cert service — see step 8 and
  `docs/turnkey-shared-domain-plan.md`.
- A `CERT_SYNC_TOKEN` for that service (shipped with prebuilt images; ask if you
  are building from source).

**This repo cloned to your Mac/laptop** at `~/tesla-pi`.

---

## 1. Flash DietPi

1. Download DietPi (64-bit, Raspberry Pi 4 image) from `dietpi.com`.
2. Flash with Raspberry Pi Imager.
3. **Before ejecting**, edit on the boot partition:
   - `dietpi.txt` — set `AUTO_SETUP_NET_WIFI_ENABLED=1`, `AUTO_SETUP_NET_HOSTNAME=tesla-cp`, `AUTO_SETUP_GLOBAL_PASSWORD=<your-password>`, `AUTO_SETUP_AUTOMATED=1`, `AUTO_SETUP_SSH_SERVER_INDEX=-1`.
   - `dietpi-wifi.txt` — your **home** SSID + PSK so first boot reaches the network.
4. (Optional) reserve a DHCP lease for the Pi's wlan0 MAC on your home router so SSH is stable.

Boot the Pi. First boot self-configures for 5–10 min. Find the IP (router admin or `arp-scan`).

## 2. Base packages

SSH in (default user becomes whatever you set; below assume `<user>`):

```bash
ssh pi@raspberrypi.local

sudo dietpi-config           # set timezone, locale; confirm hostname
sudo dietpi-software         # install Node.js (option 9) — pulls Node 20 LTS
sudo apt update
sudo apt install -y git build-essential libusb-1.0-0-dev \
                    hostapd dnsmasq nginx iptables-persistent \
                    curl openssl rfkill
```

> No `certbot` and no `python3-certbot-dns-cloudflare`: the device never issues
> its own certificate. Issuance happens centrally and the Pi only fetches the
> result (`scripts/cert-sync.sh`), so it carries no DNS credential.

## 3. Clone this repo onto the Pi

```bash
cd ~
git clone https://github.com/elwinchia/tesla-pi.git
cd tesla-pi
npm ci
```

## 4. udev rule for Carlinkit

```bash
sudo install -m 0644 conf/52-nodecarplay.rules /etc/udev/rules.d/52-nodecarplay.rules

sudo usermod -a -G plugdev $USER
sudo udevadm control --reload-rules
sudo udevadm trigger
```

The rule used to be echoed inline here, which meant the device carried a
hand-made copy nobody could diff and a reflash lost it silently. It is
`conf/52-nodecarplay.rules` now, and it does two things: the permissions the app
needs, plus `MTP_NO_PROBE=1` so libmtp's prober leaves the dongle alone. That
second line is not cosmetic — the dongle re-enumerates every ~13 s whenever
CarPlay is idle, and each cycle was spawning two `mtp-probe` processes that
opened the device just to conclude it is not a media player. Measured on
a test Pi 4 2026-09-08: 75,176 journal lines in 7 days, the second-largest writer
on the system. After the rule, 0 lines across 9 re-enumerations. See the file's
own comments.

Plug the Carlinkit. Verify: `lsusb | grep 1314` should show it, and
`journalctl -f | grep mtp-probe` should stay silent while it cycles.

## 5. Smoke-test CarPlay before networking

While still on home Wi-Fi:

```bash
cd ~/tesla-pi
node index.js
```

In your laptop browser go to `http://<pi-lan-ip>:8080`. Pair the iPhone via wireless CarPlay. You should see the CarPlay UI render with single-touch click-through. **Stop here and debug** if this doesn't work — the rest of the setup assumes a working dongle pipeline.

`Ctrl+C` to stop.

## 6. Install the application as a service

Symlink the unit file from the repo (so future `git pull` updates the unit definition):

```bash
sudo ln -sf $(pwd)/systemd/tesla-pi.service /etc/systemd/system/tesla-pi.service
sudo systemctl daemon-reload
sudo systemctl enable tesla-pi
```

Don't start yet — the env file isn't in place. Continue to step 7.

## 7. Environment file

```bash
sudo cp conf/tesla-pi.env.template /etc/default/tesla-pi
sudo $EDITOR /etc/default/tesla-pi
# CARPLAY_DOMAIN / CERT_PATH defaults are already correct
# Paste your CERT_SYNC_TOKEN over REPLACE_WITH_DEVICE_TOKEN
sudo chown root:root /etc/default/tesla-pi
sudo chmod 600 /etc/default/tesla-pi     # contains CERT_SYNC_TOKEN
```

## 8. TLS certificate — fetch it

The Pi has no upstream internet in the car, and it holds no DNS credential.
Certificates for `device.tesla-pi.humblebees.co` are issued centrally and the
device just pulls the current one.

Install the sync client where the systemd units expect it, then run it once
**while the Pi still has internet** (i.e. before step 11 flips it to AP mode):

```bash
cd ~/tesla-pi
sudo install -d -m 0755 /opt/tesla-pi/scripts
sudo install -m 0755 scripts/cert-sync.sh /opt/tesla-pi/scripts/cert-sync.sh

sudo /opt/tesla-pi/scripts/cert-sync.sh
```

Expected: `installed cert version <N> (expires …)`. Exit codes are `0` = a newer
cert was installed, `2` = already current, `1` = failed (the existing cert is
left untouched).

Verify:

```bash
sudo openssl x509 -in /etc/letsencrypt/live/device.tesla-pi.humblebees.co/fullchain.pem \
     -noout -subject -dates
```

The client refuses to install a cert that is expired, whose key doesn't match,
or that isn't valid for `device.tesla-pi.humblebees.co` — so a failure here never
breaks a working box.

## 9. AP-mode networking config

All four files come from the repo. Symlink so future updates flow through git.

```bash
cd ~/tesla-pi

# hostapd.conf is NOT symlinked into the repo: Settings → Hotspot rewrites it
# at runtime, so it must be a real root-owned 0600 file (it holds the
# passphrase). Copy it once from the template; the helper owns it thereafter.
sudo install -m 0600 -o root -g root conf/hostapd.conf.template /etc/hostapd/hostapd.conf
sudo ln -sf $(pwd)/conf/dnsmasq.conf            /etc/dnsmasq.conf
sudo ln -sf $(pwd)/conf/sysctl-ip-forward.conf   /etc/sysctl.d/99-ip-forward.conf
# Older installs had the opposite setting here; both would be read and "no"
# sorts last, so it would silently win and switch internet sharing back off.
sudo rm -f /etc/sysctl.d/99-no-forward.conf
sudo mkdir -p /etc/iptables
sudo cp $(pwd)/conf/iptables.ipv4.nat /etc/iptables/rules.v4
sudo ln -sf $(pwd)/conf/nginx-carplay.conf      /etc/nginx/sites-available/carplay
sudo ln -sf /etc/nginx/sites-available/carplay  /etc/nginx/sites-enabled/carplay
sudo rm -f /etc/nginx/sites-enabled/default

# hostapd default-conf pointer
sudo sed -i 's|^#*DAEMON_CONF=.*|DAEMON_CONF="/etc/hostapd/hostapd.conf"|' /etc/default/hostapd

# wlan0-up oneshot + hostapd override (depends on wlan0-up)
sudo ln -sf $(pwd)/systemd/wlan0-ap-up.service  /etc/systemd/system/wlan0-ap-up.service
sudo mkdir -p /etc/systemd/system/hostapd.service.d
sudo ln -sf $(pwd)/systemd/hostapd.service.d/wait-wlan0.conf \
            /etc/systemd/system/hostapd.service.d/wait-wlan0.conf

sudo systemctl daemon-reload
```

> The template ships SSID `Tesla-Pi` / password `12345678`. A flashed image renames itself
> to `Tesla-Pi-XXXX` on first boot (suffix from the Pi's serial) and picks a channel its
> regulatory domain permits — see `scripts/ap-radio-select.sh`. On a hand-built box the
> template's channel 149 / country `MY` applies as-is, so run
> `sudo scripts/ap-radio-select.sh <YOUR-COUNTRY>` if you are not in a region where UNII-3
> is allowed; hostapd exits rather than degrading when the channel is forbidden.
>
> **Change the password before driving anywhere** — it is the only thing protecting the device
> (see [`SECURITY.md`](../SECURITY.md)). Do it from **Settings → Hotspot** in the car; the SPA
> nags with a banner until you do. Edit `/etc/hostapd/hostapd.conf` directly only for radio
> settings (channel/country), not credentials.

## 10. nginx — substitute the domain in the server block

The shipped config carries a literal `CARPLAY_DOMAIN` placeholder:

```bash
sudo sed -i 's|CARPLAY_DOMAIN|device.tesla-pi.humblebees.co|g' \
     /etc/nginx/sites-available/carplay
sudo nginx -t
```

`ssl_certificate` then points at
`/etc/letsencrypt/live/device.tesla-pi.humblebees.co/…`, which step 8 populated.

## 10b. Settings tabs (Hotspot, System, and WiFi if you have a second adapter)

Each privileged Settings pane needs its helper + a path-scoped sudoers entry.
Without this the Hotspot card — and the banner that nags about the default
password — never appears.

```bash
cd ~/tesla-pi
sudo TESLAPI_SERVICE_USER=$USER bash scripts/install-ap-tab.sh
# Restart / Shut down from the car (Settings → System):
sudo TESLAPI_SERVICE_USER=$USER bash scripts/install-power-tab.sh
# Only if a second WiFi adapter (wlan1) is wired in:
sudo TESLAPI_SERVICE_USER=$USER bash scripts/install-wifi-tab.sh
# Write dongle firmware to a USB stick from the car (Settings → Dongle):
sudo TESLAPI_SERVICE_USER=$USER bash scripts/install-dongle-tab.sh
```

Settings → Dongle is the odd one out: it appears without any installer, because
identifying the dongle and downloading firmware need no privilege. Running
`install-dongle-tab.sh` only adds the last step — writing a downloaded image to
a FAT32 stick plugged into the Pi. Nothing in that pane flashes the dongle; the
stick still has to be carried across by hand, which is the only route Carlinkit
offer. See `docs/carlink-protocol-notes.md` for why there is no way around it.

`install-ap-tab.sh` also forces `/etc/hostapd/hostapd.conf` to 0600 root-owned
and replaces it if an older install left it symlinked into the repo.

## 11. Flip to AP mode

The repo ships a script that does the dance correctly. Run it once. Reversible via `dev-mode.sh`.

```bash
cd ~/tesla-pi
sudo scripts/ap-mode.sh
```

It will:
- mark wlan0 unmanaged in NetworkManager
- bring wlan0 up at `192.168.4.254/24`
- apply iptables rules
- start hostapd, dnsmasq, cert-renew-watch
- print state at the end

After this, **eth0 is your only stable SSH path**. The Pi is no longer on home Wi-Fi.

## 12. Auto-sync watcher

```bash
cd ~/tesla-pi
sudo install -m 0755 scripts/cert-renew-watch.sh scripts/cert-renew-now.sh \
     scripts/net-share.sh /opt/tesla-pi/scripts/
# Sourced by all three of the above from their own directory, so it goes with them.
sudo install -m 0644 scripts/cert-renew-lib.sh /opt/tesla-pi/scripts/
sudo ln -sf $(pwd)/systemd/cert-renew-watch.service /etc/systemd/system/cert-renew-watch.service
sudo ln -sf $(pwd)/systemd/cert-renew-now.service   /etc/systemd/system/cert-renew-now.service
sudo ln -sf $(pwd)/systemd/tesla-pi-netshare.service /etc/systemd/system/tesla-pi-netshare.service
sudo cp conf/wpa_supplicant-wlan0-home.conf.template \
       /etc/wpa_supplicant/wpa_supplicant-wlan0-home.conf
sudo $EDITOR /etc/wpa_supplicant/wpa_supplicant-wlan0-home.conf  # fill home SSID + PSK
sudo chmod 600 /etc/wpa_supplicant/wpa_supplicant-wlan0-home.conf
sudo systemctl daemon-reload
sudo systemctl enable --now cert-renew-watch tesla-pi-netshare
```

`tesla-pi-netshare` is what lets the Tesla use the Pi's uplink: it tracks whether one exists and switches dnsmasq between forwarding real queries and the offline walled garden. See "Internet sharing | net-share.sh" in `tesla-doc.md`.

The watcher polls every 60 s and has two ways to pick up a new cert:

1. **Whenever the device has an uplink that isn't its own AP** — eth0, a second
   Wi-Fi adapter, a USB tether — it runs `cert-sync.sh` in place. Nothing is torn
   down and the Tesla stays associated. Every transition to online triggers one
   attempt; while the link stays up it repeats at most once per
   `CERT_SYNC_BACKOFF_S` (default 6 h), or after `CERT_SYNC_ONLINE_RETRY_S`
   (default 10 min) if the attempt failed — a default route is not proof of
   reachability.
2. **With no uplink**, after 10 min with no station associated, it tears down the
   AP, joins home Wi-Fi, runs `cert-sync.sh`, and restores the AP — so bringing
   the Pi indoors also keeps its certificate current. Repeat flips are
   rate-limited by `CERT_SYNC_BACKOFF_S`.

Neither path gates on cert *file age* or days remaining: the service decides when
a new version exists, so a device that has been offline for months picks up a
fresh cert the first time it is online.

The only thing either path does that a live CarPlay stream could notice is
`nginx -s reload`, so it is held back while one is running. `cert-sync.sh` writes
the new pair atomically and touches `/run/cert-renew.deployed`; the watcher
treats that file as "reload pending" and retries every 60 s, reloading as soon as
`/healthz` reports no video clients — or unconditionally after
`CERT_RELOAD_DEFER_MAX_S` (default 24 h). nginx keeps serving the previous cert
until then, which is why waiting is safe.

`cert-renew-now.service` is the on-demand version, triggered by the SPA's
**Renew now** button (`POST /cert/renew`). The unit can still take either path,
but the endpoint only ever dispatches the in-place one: it refuses with 409
unless a non-AP default route exists *and* the cert service answers over it, so
the button cannot tear the hotspot out from under the car that pressed it. The
AP flip is left to `cert-renew-watch.sh`, which waits until the Tesla has been
gone a while first. This unit is deliberately never enabled at boot.

> **The certificate expires (~90 days).** A device that never reaches the
> internet again will eventually serve an expired cert and the Tesla browser will
> refuse it. Day-to-day in-car use is fully offline; the Pi just needs to see home
> Wi-Fi occasionally. The SPA warns when the cert is close to expiry.

## 13. Start CarPlay

```bash
sudo systemctl start tesla-pi
sudo systemctl status tesla-pi
sudo journalctl -u tesla-pi -f
curl -k https://localhost/healthz       # local healthcheck via nginx
```

## 14. Tesla validation

1. From the Tesla → Wi-Fi → join the hotspot (default `Tesla-Pi` / `12345678`, or whatever you set in Settings → Hotspot).
2. Tesla browser → `https://device.tesla-pi.humblebees.co/`
3. CarPlay loads. Single-finger touches forward to iPhone.
4. Bookmark the URL on the Tesla as a homepage favorite.

If Tesla drops the SSID after a few seconds: connectivity probe is failing. See `docs/captive-bypass-troubleshooting.md`.

If the Tesla has no Browser app at all: Controls → Safety → Parental Controls can disable it outright (2026.20+). The Pi will look perfectly healthy while this is on — see `docs/tesla-browser-capabilities.md`.

---

## Operational cheatsheet

| Task | Command |
|---|---|
| Tail CarPlay logs | `sudo journalctl -u tesla-pi -f` |
| Tail watcher logs | `sudo journalctl -u cert-renew-watch -f` |
| Healthcheck | `curl -k https://localhost/healthz` |
| Flip Pi back to home Wi-Fi | `sudo ~/tesla-pi/scripts/dev-mode.sh` |
| Flip Pi back to AP | `sudo ~/tesla-pi/scripts/ap-mode.sh` |
| Cert days remaining | `curl -ks https://localhost/healthz \| jq .cert_days_remaining` |
| Manual cert renew (Pi indoors) | `sudo systemctl start cert-renew-watch.service` (already running; force a cycle by setting `CERT_AGE_THRESHOLD_DAYS=0` temporarily and restarting) |
| Force regenerate iptables | `sudo iptables-restore < /etc/iptables/rules.v4` |
| Hostapd diagnostics | `sudo hostapd_cli -i wlan0 list_sta` |
| Update repo, restart service | `cd ~/tesla-pi && git pull && sudo systemctl restart tesla-pi` |
| Boot timing audit | `systemd-analyze blame \| head -20` |
| Keep logs across reboots | `sudo ~/tesla-pi/scripts/enable-persistent-journal.sh` then `sudo reboot` (see below) |
| Read the previous boot | `sudo journalctl -u tesla-pi -b -1 --no-pager \| tail -200` |

---

## Logs that survive a reboot

Out of the box nothing does. The app's own `/logs` feed (the Status page's
Recent activity) is 200 entries in RAM and is cleared whenever the service
restarts — which the CarPlay start path does to itself: after 20 failed
attempts `start_giving_up` exits and `Restart=always` brings it back. On top of
that, DietPi keeps `/var/log` on a RAM disk and clears it hourly, so the journal
does not outlive a power cycle either.

`scripts/enable-persistent-journal.sh` fixes the second half: it takes
`/var/log` off the RAM disk (commenting the tmpfs line in `/etc/fstab`,
disabling `dietpi-ramlog.service`, and replicating the log directory tree onto
the card first — nginx will not start without `/var/log/nginx`), then writes
`/etc/systemd/journald.conf.d/tesla-pi.conf` with `Storage=persistent` and a
7-day retention capped at 64 MB. A reboot is needed to finish, because the tmpfs
cannot be unmounted while journald is writing to it.

Retention and cap can be overridden at install time:
`JOURNAL_RETENTION_DAYS=14 JOURNAL_MAX_USE=128M sudo ./scripts/enable-persistent-journal.sh`.

For an intermittent fault — CarPlay not starting until the dongle is reseated —
the two things worth reading after the fact are the app's view and the kernel's:

```bash
journalctl -u tesla-pi -b -1 --no-pager | tail -200   # start_failed / carplay_failure / did carplay_started ever land
journalctl -k -b -1 --no-pager | grep -i usb          # did the dongle enumerate at all
```

---

## Common gotchas

- **`hostapd` masked on Debian/DietPi.** First start fails until `sudo systemctl unmask hostapd`. `ap-mode.sh` does this for you.
- **`rfkill` blocks Wi-Fi after first install.** `ap-mode.sh` runs `rfkill unblock wifi`. If you skip the script, run it manually.
- **NetworkManager fights for wlan0.** Both `unmanaged-devices=interface-name:wlan0` (created by `ap-mode.sh`) AND `wlan0-ap-up.service` are required. Removing either causes flapping.
- **Cert path mismatch.** Both `/etc/default/tesla-pi` and the nginx server block hardcode the domain. Keep them in sync — a typo in either silently disables the healthcheck cert-days field or breaks TLS.
- **Parental Controls hide the browser.** Since Tesla 2026.20, Controls → Safety → Parental Controls can switch off Browser/Theater/Arcade. Nothing on the Pi reports this — the hotspot associates, `/healthz` is green, and the car simply has no browser to load the page with.
- **eth0 still useful.** Throughout this guide, eth0 is the safety net. If something breaks AP mode, plug a cable, SSH in via eth0, run `dev-mode.sh`. Don't rely solely on AP-side SSH.

---

## What success looks like

After step 14:
- Pi cold-boots in <20 s to a state where Tesla can associate, render the page, and stream CarPlay video.
- iPhone wireless CarPlay handshake completes within 5–10 s of unlocking the car (assuming the dongle was already powered).
- `cert_days_remaining` ticks down from ~90 between deployments; auto-renewal happens silently when the Pi sits indoors for ≥10 min.
- No internet access on the Tesla via this Wi-Fi (by design — Tesla map tiles fall back to its own LTE/cell, and CarPlay backend traffic rides the iPhone's cell).

If any of these regress, see `docs/perf-optimizations.md` for tuning levers and `docs/captive-bypass-troubleshooting.md` for SSID-drop debugging.
