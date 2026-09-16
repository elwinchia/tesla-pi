# Turnkey image: shared domain + shared cert, serverless renewal

**Status:** design, not built.
**Goal:** a user burns an SD card, plugs it into a Pi, and it works in their Tesla —
no domain registration, no Cloudflare account, no certbot, no setup.

**Decisions taken:**
| Decision | Choice |
|---|---|
| Device hostname | `device.tesla-pi.humblebees.co` (fixed, same on every device) |
| Renewal infra | Serverless (GitHub Actions cron + Workers KV + Worker) |
| Cert model | **Shared** cert across all devices (v1) |

Prior art: this is the model [tesla-android](https://github.com/tesla-android) uses —
every device hardcodes `device.teslaandroid.com`, and CT logs show a
`*.teslaandroid.com` Let's Encrypt wildcard rotating every ~60–90 days, with
`ota.` / `status.` subdomains for distribution.

---

## 1. Why this shape

The blocker for a turnkey image is **not** serving HTTPS — it's that publicly
trusted certs expire (~90 days), and renewing needs a DNS credential that must
never ship inside an image every user can read.

So: **move renewal off the device and onto infrastructure we run.** Devices ship
with a cert baked in and periodically *pull* a refreshed one. The Cloudflare
token exists only in CI.

Everything in-car stays as it is today: the Pi is its own AP, `dnsmasq` answers
the fixed hostname with the Pi's own LAN IP, nginx terminates TLS, and the
`240.3.3.4` shim bypasses Tesla's private-IP block. The Tesla browser
[does not support SNI](https://teslamotorsclub.com/tmc/threads/web-browser-doesnt-support-lets-encrypt-certificates.84158/),
which is fine — each device serves exactly one cert on its own IP.

---

## 2. Architecture

```
  ┌─────────────── infrastructure we run (serverless) ───────────────┐
  │                                                                  │
  │  GitHub Actions (cron, every ~60d)                               │
  │    certbot/lego --dns-cloudflare  ── CF_API_TOKEN (Actions secret)│
  │    issues cert for device.tesla-pi.humblebees.co                  │
  │            │ upload bundle + bump version                        │
  │            ▼                                                     │
  │      Workers KV  ◄────────  Cloudflare Worker                 │
  │      (fullchain, privkey,       tesla-pi-cert-service.<account>.workers.dev      │
  │       version.json)             token-gated, rate-limited        │
  └──────────────────────────────┬───────────────────────────────────┘
                                 │  HTTPS pull, only when the Pi is
                                 │  on home Wi-Fi (has internet)
                                 ▼
  ┌──────────────── the Pi (burned image) ──────────────────────────┐
  │  cert-sync client  → /etc/letsencrypt/live/device.../ → nginx -s reload
  │  dnsmasq: device.tesla-pi.humblebees.co → 192.168.4.254 (itself) │
  │  nginx :443 ── proxy → node :8080                               │
  └─────────────────────────────────────────────────────────────────┘
                                 ▲
                          Tesla joins the Pi's AP
```

**Two hostnames, deliberately distinct:**

- `device.tesla-pi.humblebees.co` — what the car loads. Public DNS points it at a
  parking IP; **in the car it resolves locally to the Pi** via `dnsmasq`.
- `tesla-pi-cert-service.<account>.workers.dev` — the distribution endpoint. **Must be a
  different name**: `conf/dnsmasq.conf` serves a wildcard A record, so while the
  AP is up *every* name resolves to the Pi. Sync only runs with the AP down
  (real DNS in effect), but keeping the names separate avoids the trap entirely.

---

## 3. Server side — what to build

### 3.1 DNS (one-time)
- `device.tesla-pi.humblebees.co` → A record (any stable IP / Cloudflare proxy).
  Only needed so DNS-01 issuance has a zone entry and the name resolves publicly.
- `tesla-pi-cert-service.<account>.workers.dev` → the Worker route.

### 3.2 Renewal job — GitHub Actions cron
Scheduled workflow (`.github/workflows/renew-cert.yml`), runs ~every 60 days
(and on manual dispatch):

1. `certbot certonly --dns-cloudflare` (or [`lego`](https://github.com/go-acme/lego))
   for `device.tesla-pi.humblebees.co`, using `CF_API_TOKEN` from **Actions
   secrets** — scoped `Zone / DNS / Edit` on `humblebees.co` only.
2. Upload to Workers KV: `fullchain.pem`, `privkey.pem`, and a `version.json`
   (`{version, not_after, sha256}`). Version = monotonic integer or the cert's
   `notBefore` timestamp.
3. Never commit the cert or key to the repo.

This is the same DNS-01 flow `scripts/cert-renew-watch.sh` runs today — just
relocated off-device.

### 3.3 Distribution endpoint — Cloudflare Worker
Fronts Workers KV at `tesla-pi-cert-service.<account>.workers.dev`. Two routes:

| Route | Returns | Notes |
|---|---|---|
| `GET /cert/version` | `{version, not_after}` (JSON) | Cheap; devices poll this |
| `GET /cert/fullchain.pem` | raw PEM | Fetched only when newer |
| `GET /cert/privkey.pem` | raw PEM | Fetched only when newer |

Raw PEM rather than a JSON bundle keeps the device client dependency-free — no
JSON parsing in shell, and `openssl` verifies the pair directly.

- **Auth:** `Authorization: Bearer <DEVICE_TOKEN>` — a shared token baked into
  the image. Reject anything else.
- **Rate-limit** per IP, in the Worker — WAF rules need a zone and
  `*.workers.dev` is not ours. The bundle contains a private key; make scraping
  expensive. Budgets and measured behaviour: `infra/cert-service/README.md` §8.
- **Always HTTPS** (ordinary public cert for `certs.` — unrelated to the shared
  device cert).
- Never publish the bundle as a public GitHub release or unauthenticated URL.

---

## 4. Device side — changes to this repo

### 4.1 Fixed hostname replaces `CARPLAY_DOMAIN`
- `conf/tesla-pi.env.template` — default `CARPLAY_DOMAIN=device.tesla-pi.humblebees.co`
  (keep the var so self-hosters can still override with their own domain).
- `conf/nginx-carplay.conf` — unchanged mechanically; the installer still
  substitutes `CARPLAY_DOMAIN`.
- `conf/dnsmasq.conf` — already serves a wildcard A record → no change.

### 4.2 New: cert-sync client (replaces on-device issuance)
New `scripts/cert-sync.sh`, and rework `scripts/cert-renew-watch.sh` to call it.

**Reuse everything the watcher already does** — it is ~90% of the work:
- idle detection via `sta_count()` (no STA associated for 10 min),
- `attempt_renewal()`'s AP teardown → join home Wi-Fi (`wpa_supplicant` +
  `dhclient`) → `restore_ap()`,
- the `flock` on `/var/lock/tesla-pi-cert-flip` shared with `cert-renew-now.sh`,
- the `nginx -s reload` on success.

**Only the middle changes.** Replace the `certbot renew` block in
`attempt_renewal()` with:

```bash
# 1. GET /cert/version with the device token
# 2. compare to local /etc/letsencrypt/live/$CARPLAY_DOMAIN/version
# 3. if newer: GET /cert/bundle, verify sha256 + that privkey matches fullchain
#    (openssl), write atomically to a temp dir, then swap into place
# 4. touch /run/cert-renew.deployed   (existing hook triggers nginx reload)
```

Also change the trigger condition: today it gates on **cert file age >60 d**
(`cert_age_days()`); switch to gating on **remote version > local version**, so
a device that's been offline picks up a fresh cert immediately rather than
waiting out an age threshold. A fetch is seconds, not a DNS-01 propagation
wait — so `WPA_TIMEOUT`/`DHCP_TIMEOUT` can stay, but the overall flip is much
shorter.

### 4.3 Delete from the device
- `certbot` + `python3-certbot-dns-cloudflare` from the image.
- `/root/.secrets/cloudflare.ini` and `conf/cloudflare.ini.template`.
- The Cloudflare token references in `docs/cloudflare-token-rotation.md`
  (becomes a CI-secret rotation doc instead).

**This is the single biggest security win:** no device carries a credential that
can write DNS for `humblebees.co`.

### 4.4 Image contents (first boot works offline)
Bake in: the current cert bundle, its `version`, and `DEVICE_TOKEN` (in
`/etc/default/tesla-pi`, mode 0600). A freshly flashed card is immediately valid
for the remainder of that cert's life.

### 4.5 UI
Reuse the existing cert-expiry banner in `static/index.html` (already wired to
`cert_days_remaining` from `/healthz`). Change the copy when the cert is close
to expiry: *"Connect the Pi to home Wi-Fi to refresh its certificate."*
Optionally surface last-sync time in Settings → Certificate.

---

## 5. Security posture

**Improves vs. today**
- No DNS-write credential on any device. A stolen SD card no longer exposes the
  `humblebees.co` zone.
- Token is scoped to *fetching a cert*, nothing else.

**Accepted trade-offs (same as tesla-android)**
- **Shared private key.** Anyone who extracts it from an image can serve a
  browser-trusted `device.tesla-pi.humblebees.co`. Bounded in practice: each Pi
  is an isolated single-client AP with no upstream internet, so the MITM
  opportunity is narrow. If it leaks: revoke, re-issue, bump version, devices
  pull the new one through the same channel.
- **Shared device token.** Every image has the same bearer token, so it is a
  weak secret — its length, not the rate limit, is what holds. Rate limiting
  bounds scraping and hides the 401/429 distinction from a guesser; it does not
  help once someone has the token, since one request yields the key. If it
  leaks, rotate it — but note that rotating it strands already-flashed devices,
  so treat it as a v2 problem (see §7).

**Keep**
- `SECURITY.md` still applies unchanged: the app itself remains unauthenticated
  and must never be exposed to the internet. This plan changes *how the cert
  arrives*, not the app's trust model.

---

## 6. Honest limitation: not offline-forever

A device that never reaches the internet again **breaks when its baked cert
expires (~90 days).** Day-to-day in-car use is fully offline; the Pi only needs
to see home Wi-Fi occasionally. Mitigations:

- Renew centrally at ~60 days so devices have a wide window to catch up.
- Warn in the UI well before expiry.
- Note it plainly in the README so adopters aren't surprised.

If *true* offline-forever is ever required, the only route is dropping TLS
(plain HTTP over the `240.3.3.4` shim) and reverting the video path from
WebCodecs to MSE, which does not require a secure context — a real
re-architecture and a performance regression. Out of scope here.

---

## 7. Phasing

**Phase 1 — MVP (this plan)**
Actions renewal job → Worker + KV → hardcode hostname → cert-sync
client → bake bundle + token into image. Delivers "burn → works".

**Phase 2 — operational maturity (only if a real fleet materialises)**
- `status.` page (current version, expiry, sync health). *Not needed for v1.*
- Per-device tokens issued at first boot, so one leak doesn't strand everyone.
- Software OTA (app/OS bundles), not just certs.
- **Per-device certs via [acme-dns](https://github.com/joohoi/acme-dns)** —
  each device gets a unique subdomain and its own cert from a narrowly-scoped
  credential. Removes the shared-key trade entirely. Keep in the back pocket.

---

## 8. Verification

- **Issuance:** trigger the Actions workflow manually; confirm a valid cert for
  `device.tesla-pi.humblebees.co` lands in KV and `version.json` bumps.
- **Endpoint:** `curl -H "Authorization: Bearer $TOKEN" https://tesla-pi-cert-service.<account>.workers.dev/cert/version`
  returns JSON; the same call **without** the token returns 401; repeated calls
  hit the rate limit.
- **Sync:** on a Pi with an intentionally old cert, run `scripts/cert-sync.sh`
  while on home Wi-Fi → new cert written, `nginx -s reload` succeeds,
  `openssl x509 -noout -dates` shows the new expiry, `/healthz`
  `cert_days_remaining` jumps.
- **Key/cert match:** verify `privkey` matches `fullchain` before swapping
  (`openssl rsa -noout -modulus` vs `openssl x509 -noout -modulus`) — a mismatched
  pair would leave nginx unable to start.
- **End-to-end:** flash a clean image, boot with no prior setup, join the AP from
  the Tesla, load `https://device.tesla-pi.humblebees.co` → no cert warning,
  CarPlay video + touch work.
- **Idempotence:** running sync twice in a row makes no changes the second time.

---

## 9. Resolved decisions

1. **Single-name cert** for `device.tesla-pi.humblebees.co` — not a wildcard.
   A wildcard would widen the blast radius of a key that ships in every image.
2. **Cloudflare proxy + landing page** on `device.tesla-pi.humblebees.co`
   (`infra/cert-service/landing/index.html`) explaining the project, rather than
   a dead parking IP. Only ever seen outside the car — in-car, `dnsmasq`
   resolves the name to the Pi.
3. **Renewal cadence is a config value**, not an assumption: `RENEW_BEFORE_DAYS`
   (workflow env, default 60). CA lifetimes are shrinking industry-wide
   (heading to ~47 days by 2029), so the workflow polls weekly and issues only
   when remaining life drops below the threshold.
