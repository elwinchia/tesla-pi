# Setup guide — Pi 4 Tesla CarPlay

End-to-end recipe to take a fresh Pi 4 from an unflashed SD card to a working in-car CarPlay box that the Tesla browser connects to over Wi-Fi. (Originally written for the Pi Zero 2 W; the steps are identical on the Pi 4 unless noted.)

> Status: **deployment recipe**, not a teaching doc. Assumes you've read `docs/plan.md` for *why* the architecture looks this way.

---

## Prerequisites

**Hardware**
- Raspberry Pi 4 (4 GB recommended — required if you want the Android addon, see `docs/android-addon.md`)
- microSD ≥ 16 GB, A1 rated (≥ 32 GB if installing the Android addon)
- Carlinkit CPC200-CCPA (USB ID `1314:152*`) — wireless CarPlay dongle, plugs straight into a Pi 4 USB-A port
- 12 V → 5 V/3 A buck for in-car (deferred to Phase 4 of `plan.md`)
- iPhone with iOS 16+

**Off-Pi**
- Nothing. You do **not** need a domain, a DNS provider, or a Cloudflare account.
  The device uses the project's shared hostname `device.mytesla.humblebees.co`
  and pulls its TLS certificate from the project's cert service — see step 8 and
  `docs/turnkey-shared-domain-plan.md`.
- A `CERT_SYNC_TOKEN` for that service (shipped with prebuilt images; ask if you
  are building from source).

**This repo cloned to your Mac/laptop** at `~/mytesla`.

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
git clone https://github.com/elwinchia/mytesla.git
cd mytesla
npm ci
```

## 4. udev rule for Carlinkit

```bash
echo 'SUBSYSTEM=="usb", ATTR{idVendor}=="1314", ATTR{idProduct}=="152*", MODE="0660", GROUP="plugdev"' \
  | sudo tee /etc/udev/rules.d/52-nodecarplay.rules

sudo usermod -a -G plugdev $USER
sudo udevadm control --reload-rules
sudo udevadm trigger
```

Plug the Carlinkit. Verify: `lsusb | grep 1314` should show it.

## 5. Smoke-test CarPlay before networking

While still on home Wi-Fi:

```bash
cd ~/mytesla
node index.js
```

In your laptop browser go to `http://<pi-lan-ip>:8080`. Pair the iPhone via wireless CarPlay. You should see the CarPlay UI render with single-touch click-through. **Stop here and debug** if this doesn't work — the rest of the setup assumes a working dongle pipeline.

`Ctrl+C` to stop.

## 6. Install the application as a service

Symlink the unit file from the repo (so future `git pull` updates the unit definition):

```bash
sudo ln -sf $(pwd)/systemd/mytesla.service /etc/systemd/system/mytesla.service
sudo systemctl daemon-reload
sudo systemctl enable mytesla
```

Don't start yet — the env file isn't in place. Continue to step 7.

## 7. Environment file

```bash
sudo cp conf/mytesla.env.template /etc/default/mytesla
sudo $EDITOR /etc/default/mytesla
# CARPLAY_DOMAIN / CERT_PATH defaults are already correct
# Paste your CERT_SYNC_TOKEN over REPLACE_WITH_DEVICE_TOKEN
sudo chown root:root /etc/default/mytesla
sudo chmod 600 /etc/default/mytesla     # contains CERT_SYNC_TOKEN
```

## 8. TLS certificate — fetch it

The Pi has no upstream internet in the car, and it holds no DNS credential.
Certificates for `device.mytesla.humblebees.co` are issued centrally and the
device just pulls the current one.

Install the sync client where the systemd units expect it, then run it once
**while the Pi still has internet** (i.e. before step 11 flips it to AP mode):

```bash
cd ~/mytesla
sudo install -d -m 0755 /opt/mytesla/scripts
sudo install -m 0755 scripts/cert-sync.sh /opt/mytesla/scripts/cert-sync.sh

sudo /opt/mytesla/scripts/cert-sync.sh
```

Expected: `installed cert version <N> (expires …)`. Exit codes are `0` = a newer
cert was installed, `2` = already current, `1` = failed (the existing cert is
left untouched).

Verify:

```bash
sudo openssl x509 -in /etc/letsencrypt/live/device.mytesla.humblebees.co/fullchain.pem \
     -noout -subject -dates
```

The client refuses to install a cert that is expired, whose key doesn't match,
or that isn't valid for `device.mytesla.humblebees.co` — so a failure here never
breaks a working box.

## 9. AP-mode networking config

All four files come from the repo. Symlink so future updates flow through git.

```bash
cd ~/mytesla

sudo ln -sf $(pwd)/conf/hostapd.conf            /etc/hostapd/hostapd.conf
sudo ln -sf $(pwd)/conf/dnsmasq.conf            /etc/dnsmasq.conf
sudo ln -sf $(pwd)/conf/sysctl-disable-forward.conf /etc/sysctl.d/99-no-forward.conf
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
sudo ln -sf $(pwd)/systemd/hostapd.service.d/override.conf \
            /etc/systemd/system/hostapd.service.d/override.conf

sudo systemctl daemon-reload
```

> **Edit `conf/hostapd.conf` first** if you want a different SSID, channel, or country code. The repo defaults to `TeslaCP` on 5 GHz channel 36, country `MY`.

## 10. nginx — substitute the domain in the server block

The shipped config carries a literal `CARPLAY_DOMAIN` placeholder:

```bash
sudo sed -i 's|CARPLAY_DOMAIN|device.mytesla.humblebees.co|g' \
     /etc/nginx/sites-available/carplay
sudo nginx -t
```

`ssl_certificate` then points at
`/etc/letsencrypt/live/device.mytesla.humblebees.co/…`, which step 8 populated.

## 11. Flip to AP mode

The repo ships a script that does the dance correctly. Run it once. Reversible via `dev-mode.sh`.

```bash
cd ~/mytesla
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
cd ~/mytesla
sudo install -m 0755 scripts/cert-renew-watch.sh scripts/cert-renew-now.sh \
     /opt/mytesla/scripts/
sudo ln -sf $(pwd)/systemd/cert-renew-watch.service /etc/systemd/system/cert-renew-watch.service
sudo ln -sf $(pwd)/systemd/cert-renew-now.service   /etc/systemd/system/cert-renew-now.service
sudo cp conf/wpa_supplicant-wlan0-home.conf.template \
       /etc/wpa_supplicant/wpa_supplicant-wlan0-home.conf
sudo $EDITOR /etc/wpa_supplicant/wpa_supplicant-wlan0-home.conf  # fill home SSID + PSK
sudo chmod 600 /etc/wpa_supplicant/wpa_supplicant-wlan0-home.conf
sudo systemctl daemon-reload
sudo systemctl enable --now cert-renew-watch
```

The watcher polls `hostapd_cli list_sta` every 60 s. After 10 min with no station
associated, it tears down the AP, joins home Wi-Fi, runs `cert-sync.sh`, and
restores the AP — so bringing the Pi indoors is what keeps its certificate
current. It no longer gates on cert *file age*: the service decides when a new
version exists, so a device that has been offline for months picks up a fresh
cert on its first idle window. Repeat flips are rate-limited by
`CERT_SYNC_BACKOFF_S` (default 6 h).

`cert-renew-now.service` is the same flow on demand, triggered by the SPA's
**Renew now** button (`POST /cert/renew`). It is deliberately never enabled at
boot.

> **The certificate expires (~90 days).** A device that never reaches the
> internet again will eventually serve an expired cert and the Tesla browser will
> refuse it. Day-to-day in-car use is fully offline; the Pi just needs to see home
> Wi-Fi occasionally. The SPA warns when the cert is close to expiry.

## 13. Start CarPlay

```bash
sudo systemctl start mytesla
sudo systemctl status mytesla
sudo journalctl -u mytesla -f
curl -k https://localhost/healthz       # local healthcheck via nginx
```

## 14. Tesla validation

1. From the Tesla → Wi-Fi → join `TeslaCP`, password `<your-ap-passphrase>` (whatever you set in `conf/hostapd.conf`).
2. Tesla browser → `https://device.mytesla.humblebees.co/`
3. CarPlay loads. Single-finger touches forward to iPhone.
4. Bookmark the URL on the Tesla as a homepage favorite.

If Tesla drops the SSID after a few seconds: connectivity probe is failing. See `docs/captive-bypass-troubleshooting.md`.

---

## Operational cheatsheet

| Task | Command |
|---|---|
| Tail CarPlay logs | `sudo journalctl -u mytesla -f` |
| Tail watcher logs | `sudo journalctl -u cert-renew-watch -f` |
| Healthcheck | `curl -k https://localhost/healthz` |
| Flip Pi back to home Wi-Fi | `sudo ~/mytesla/scripts/dev-mode.sh` |
| Flip Pi back to AP | `sudo ~/mytesla/scripts/ap-mode.sh` |
| Cert days remaining | `curl -ks https://localhost/healthz \| jq .cert_days_remaining` |
| Manual cert renew (Pi indoors) | `sudo systemctl start cert-renew-watch.service` (already running; force a cycle by setting `CERT_AGE_THRESHOLD_DAYS=0` temporarily and restarting) |
| Force regenerate iptables | `sudo iptables-restore < /etc/iptables/rules.v4` |
| Hostapd diagnostics | `sudo hostapd_cli -i wlan0 list_sta` |
| Update repo, restart service | `cd ~/mytesla && git pull && sudo systemctl restart mytesla` |
| Boot timing audit | `systemd-analyze blame \| head -20` |

---

## Common gotchas

- **`hostapd` masked on Debian/DietPi.** First start fails until `sudo systemctl unmask hostapd`. `ap-mode.sh` does this for you.
- **`rfkill` blocks Wi-Fi after first install.** `ap-mode.sh` runs `rfkill unblock wifi`. If you skip the script, run it manually.
- **NetworkManager fights for wlan0.** Both `unmanaged-devices=interface-name:wlan0` (created by `ap-mode.sh`) AND `wlan0-ap-up.service` are required. Removing either causes flapping.
- **Cert path mismatch.** Both `/etc/default/mytesla` and the nginx server block hardcode the domain. Keep them in sync — a typo in either silently disables the healthcheck cert-days field or breaks TLS.
- **eth0 still useful.** Throughout this guide, eth0 is the safety net. If something breaks AP mode, plug a cable, SSH in via eth0, run `dev-mode.sh`. Don't rely solely on AP-side SSH.

---

## What success looks like

After step 14:
- Pi cold-boots in <20 s to a state where Tesla can associate, render the page, and stream CarPlay video.
- iPhone wireless CarPlay handshake completes within 5–10 s of unlocking the car (assuming the dongle was already powered).
- `cert_days_remaining` ticks down from ~90 between deployments; auto-renewal happens silently when the Pi sits indoors for ≥10 min.
- No internet access on the Tesla via this Wi-Fi (by design — Tesla map tiles fall back to its own LTE/cell, and CarPlay backend traffic rides the iPhone's cell).

If any of these regress, see `docs/perf-optimizations.md` for tuning levers and `docs/captive-bypass-troubleshooting.md` for SSID-drop debugging.
