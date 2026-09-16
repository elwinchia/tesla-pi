# Security model

**Read this before deploying.** Tesla-Pi is an appliance designed to run as its
own isolated in-car Wi-Fi access point. Its trust model is the WPA2 password of
that AP — nothing more.

## There is no application-level authentication — by design

Every HTTP and WebSocket endpoint is **unauthenticated**. Anything that can open
a socket to the server can:

- inject touch, multitouch, and media-key events into the connected CarPlay
  session (`WS /control`),
- start/stop the RetroArch stack, launch allowlisted cores/ROMs, and drive the
  virtual gamepad (`/retroarch/*`),
- join the Pi to an arbitrary Wi-Fi network, and drop/delete saved profiles
  (`POST /wifi/connect|disconnect|forget`, which shell out to a `sudo`-scoped
  helper),
- **change the hotspot's own SSID and password, and restart the radio**
  (`POST /ap/config`, `POST /ap/restart`) — i.e. anyone already on the AP can
  lock the owner out of it. This is a deliberate consequence of the model: the
  AP password is the boundary, so whoever is inside it can move the boundary.
  `GET /ap/status` never returns the passphrase, only the SSID and whether the
  shipped default is still in place,
- **change the Wi-Fi regulatory domain** (`POST /ap/country`), which moves the
  radio to a different band and channel. Nuisance rather than escalation: the
  worst case is the hotspot dropping to 2.4 GHz, since the channel is chosen
  from what the kernel says the domain permits rather than from the request,
- trigger a certificate renewal (`POST /cert/renew`). Bounded: it is refused
  unless the device already has a working internet uplink, so it syncs in place
  and never takes the hotspot down,
- **restart or shut the device down** (`POST /power/reboot|shutdown`, via a
  `sudo`-scoped helper whose verbs take no arguments). A shutdown is the one
  action nothing recovers from remotely: the box stays off until its power is
  cycled. Denial of service only — it grants no access — and it is available at
  all only where `scripts/install-power-tab.sh` has been run,
- read device telemetry and recent logs (`GET /healthz`, `GET /logs`),
- **write a diagnostic file** (`POST /debug/mic-probe`, `/debug/webgpu-probe`,
  `/debug/telemetry-probe`), but only where `PROBE_DIR` (formerly
  `MIC_PROBE_DIR`, still honoured) has been set in the environment. Unset — the default, and the
  state every shipped box is in — the route does not exist and answers 404. When
  it is on, the body is capped at 8 MB and the filename comes from a two-item
  allowlist rather than the request, so it writes a fixed handful of names into
  one directory. It exists to catch the reports from the `static/*-probe.html`
  pages; turn it off when that testing is done.

`static/mic-probe.html` itself is reachable by anyone on the hotspot, like every
other page here. It can turn the cabin microphone on — but only through the
browser's own permission prompt, which a person in the car has to accept, and
Tesla shows the standard recording indicator while it is live. It is a
diagnostic with no link into the product UI; deleting the file is the whole
uninstall.

This is acceptable **only** because the box is meant to be reachable solely from
inside the car, over an AP that one device (the Tesla) joins with a password you
set.

## Do NOT expose this to the internet

- **Never** port-forward, reverse-proxy from a public host, or otherwise route
  public traffic to this service.
- The Node server binds `0.0.0.0:8080`. On the Pi that also makes it reachable
  over `eth0` / a second Wi-Fi during bench/dev mode — fine on a trusted home
  LAN, but treat any network the Pi joins as able to drive every endpoint above.
- Your `CARPLAY_DOMAIN` name exists only to obtain a browser-trusted TLS cert
  for a box the car reaches over the local AP; DNS resolves it to the Pi locally
  via `dnsmasq`. It is not, and must not become, a public endpoint.

## If you want to expose it anyway

You would need to add an authentication layer (shared secret / token / mTLS) in
front of the Node app **and** in the WebSocket `upgrade` handler, and split the
public nginx vhost from the in-car captive-portal config. That work is out of
scope for this project.

## What is inside a published image

Every flashed card is byte-identical, so anything baked in is shared by every
user. Know what that means before flashing one.

- **The TLS private key is shared.** All devices serve the same certificate for
  `device.tesla-pi.humblebees.co`, so anyone who extracts the key from an image
  can serve a browser-trusted page under that name. Bounded in practice — each
  Pi is an isolated single-client AP with no upstream internet — and recoverable:
  revoke, re-issue, bump the version, devices pull the fix. Same trade
  [tesla-android](https://github.com/tesla-android) makes. See
  `docs/turnkey-shared-domain-plan.md` §5.
- **`CERT_SYNC_TOKEN` is shared** and therefore a weak secret. It is scoped to
  fetching a certificate and nothing else, and its length is what makes it hold
  up; the service's rate limiting bounds scraping rather than guarding the key.
  It lives in `/etc/default/tesla-pi`, mode 0600.
- **The hotspot password is the same on every image** (`12345678`). Only the
  SSID differs per device (`Tesla-Pi-XXXX`, derived from the Pi's serial), which
  prevents collisions between neighbouring boxes but is **not** a security
  measure. Until you change the password, any un-onboarded box in Wi-Fi range is
  open to anyone who has read this file.
- **SSH is disabled** and no default login exists. It is enabled only if the
  owner drops an `authorized_keys` file on the boot partition (key auth only) or
  sets `SSH_PASSWORD` in `tesla-pi.txt`. This is a deliberate change from stock
  DietPi, which enables dropbear with a documented default password — behind an
  AP password of `12345678`, that would turn "guessed the Wi-Fi" into "root on
  the box".
- **The boot partition is FAT and world-readable** to anyone holding the card.
  Passwords typed into `tesla-pi.txt` are therefore in the clear until first
  boot, which applies them and then blanks them out of the file. Treat that file
  as a delivery mechanism, not storage.
- **Per-device host keys.** SSH host keys are stripped from the image and
  regenerated on first boot, so devices do not share an identity.

## Hardening notes for adopters

- **Change the default hotspot password immediately.** Images ship with a known
  SSID/passphrase so the box is reachable on first boot; until it is changed,
  anyone who knows the default has full control. The SPA shows a persistent,
  non-dismissible banner until you do (Settings → Hotspot).
- `/etc/hostapd/hostapd.conf` holds that passphrase and must be `0600`
  root-owned — it was historically installed `0644` (world-readable).
  `scripts/install-ap-tab.sh` fixes the mode on existing installs.
- Never commit a real `conf/hostapd.conf`; only the `.template` is tracked.
- The `sudo` grants installed by the addon installers are path-scoped to helper
  scripts that validate their own verbs — keep them that way; do not broaden the
  sudoers entries.
- If you ever add a rule to the `FORWARD` chain, scope it **by interface**, not
  by subnet alone. That chain's `DROP` is a *policy*: it is consulted only after
  every rule has missed, so a broad subnet `ACCEPT` silently grants AP clients a
  route they were never meant to have.
- Keep secrets out of the repo: `conf/hostapd.conf`, `docs/cloudflare-token.md`,
  `docs/hotspot-credentials.md`, and `logs/` are gitignored for this reason.

## Reporting

This is a hobby project with no formal disclosure process. Open a GitHub issue
for security concerns (omit any sensitive details from the public issue).
