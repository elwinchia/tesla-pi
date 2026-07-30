# Security model

**Read this before deploying.** myTesla is an appliance designed to run as its
own isolated in-car Wi-Fi access point. Its trust model is the WPA2 password of
that AP — nothing more.

## There is no application-level authentication — by design

Every HTTP and WebSocket endpoint is **unauthenticated**. Anything that can open
a socket to the server can:

- inject touch, multitouch, and media-key events into the connected CarPlay
  session (`WS /control`),
- start/stop the Android (Waydroid) and RetroArch stacks, inject mock GPS, and
  foreground allowlisted apps (`/android/*`, `/retroarch/*`),
- join the Pi to an arbitrary Wi-Fi network, and drop/delete saved profiles
  (`POST /wifi/connect|disconnect|forget`, which shell out to a `sudo`-scoped
  helper),
- trigger a certificate renewal that tears down the AP for ~1 minute
  (`POST /cert/renew`),
- read device telemetry and recent logs (`GET /healthz`, `GET /logs`).

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

## Hardening notes for adopters

- Set a strong AP passphrase in `conf/hostapd.conf` (never commit the real one;
  it is gitignored).
- The `sudo` grants installed by the addon installers are path-scoped to helper
  scripts that validate their own verbs — keep them that way; do not broaden the
  sudoers entries.
- The Waydroid container's ADB listens **unauthenticated** on its own subnet.
  `scripts/mytesla-android` firewalls it off: AP clients are explicitly denied
  any route into `192.168.240.0/24`, the container may only egress to the
  uplink (never toward the AP), and return traffic is limited to established
  flows. If you edit those rules, keep them scoped **by interface** — a
  subnet-only `ACCEPT` in the `FORWARD` chain would expose an Android shell to
  anyone on the car's Wi-Fi, because the chain's `DROP` is a policy and is only
  consulted after every rule misses.
- Keep secrets out of the repo: `conf/hostapd.conf`, `docs/cloudflare-token.md`,
  `docs/hotspot-credentials.md`, and `logs/` are gitignored for this reason.

## Reporting

This is a hobby project with no formal disclosure process. Open a GitHub issue
for security concerns (omit any sensitive details from the public issue).
