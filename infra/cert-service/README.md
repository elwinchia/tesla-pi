# cert-service — shared device certificate distribution

Serves the shared TLS certificate for `device.mytesla.humblebees.co` to myTesla
devices. Devices hold **no** Cloudflare credential; issuance happens centrally in
GitHub Actions and devices pull the finished cert from here.

Design rationale: [`docs/turnkey-shared-domain-plan.md`](../../docs/turnkey-shared-domain-plan.md).

```
GitHub Actions (cron)  --issues cert-->  R2 bucket  <--reads--  Worker  <--pulls--  devices
   holds CF DNS token                  mytesla-certs        certs.mytesla...    (bearer token)
```

## Components

| Path | What it is |
|---|---|
| `src/worker.js` | Cloudflare Worker: token-gated `/cert/*` endpoints backed by R2 |
| `wrangler.toml` | Worker config + R2 binding + route |
| `landing/index.html` | Static page served at `device.mytesla.humblebees.co` (only ever seen outside the car) |
| `../../.github/workflows/renew-cert.yml` | Issues + publishes the cert |

## API

All routes require `Authorization: Bearer <DEVICE_TOKEN>`.

| Route | Returns |
|---|---|
| `GET /cert/version` | `{"version":N,"not_after":"…"}` — devices poll this |
| `GET /cert/fullchain.pem` | raw PEM |
| `GET /cert/privkey.pem` | raw PEM |

Raw PEM (rather than a JSON bundle) keeps the device client dependency-free —
no JSON parsing in shell.

## One-time setup

### 1. DNS (Cloudflare, zone `humblebees.co`)
- `device.mytesla` → **proxied** (orange cloud), pointing at the landing page.
  In the car this name never resolves publicly — `dnsmasq` on the Pi answers it
  with the Pi's own address.
- `certs.mytesla` → the Worker route.

> These must stay **different hostnames**. `conf/dnsmasq.conf` serves a wildcard
> A record, so while the AP is up *every* name resolves to the Pi. Sync only runs
> with the AP down, but separate names remove the trap entirely.

### 2. R2 bucket
```bash
npx wrangler r2 bucket create mytesla-certs
```
Keep it **private** — it holds the private key. Never expose it via a public
r2.dev URL or a custom domain.

### 3. Device token
Generate one and store it in both places:
```bash
DEVICE_TOKEN=$(openssl rand -hex 32)
npx wrangler secret put DEVICE_TOKEN     # paste it
```
The same value goes into device images as `CERT_SYNC_TOKEN` in
`/etc/default/mytesla` (mode 0600) — see `conf/mytesla.env.template`.

### 4. Deploy the Worker
```bash
cd infra/cert-service
npx wrangler deploy
```

### 5. Rate limiting (do not skip)
The bundle contains a private key. Add a Cloudflare WAF rate-limiting rule in
front of the Worker route — e.g. 10 requests / 10 min / IP on
`certs.mytesla.humblebees.co/cert/*`. Devices poll rarely (hours apart), so this
is generous for legitimate use and expensive for scraping.

### 6. GitHub repository secrets
| Secret | Scope |
|---|---|
| `CLOUDFLARE_DNS_TOKEN` | Zone / DNS / Edit on `humblebees.co` **only** (DNS-01) |
| `CLOUDFLARE_API_TOKEN` | Workers R2 read/write (used by wrangler) |
| `CLOUDFLARE_ACCOUNT_ID` | Cloudflare account id |
| `ACME_EMAIL` | Let's Encrypt contact address |

Then run the workflow once manually (**Actions → renew-cert → Run workflow**) to
publish the first cert.

## Operations

**Renewal cadence** is `RENEW_BEFORE_DAYS` in the workflow env (default 60). The
job runs weekly and no-ops until remaining life drops below it. CA lifetimes are
shrinking industry-wide, so lower this rather than assuming 90 days.

**Force a re-issue:** Actions → renew-cert → Run workflow → `force: true`.

**Verify what's published:**
```bash
curl -H "Authorization: Bearer $DEVICE_TOKEN" \
  https://certs.mytesla.humblebees.co/cert/version
# without the token -> 401
```

**If the private key leaks:** revoke the cert, run the workflow with
`force: true`, and devices pick up the replacement through the same channel on
their next sync. Consider rotating `DEVICE_TOKEN` too — but note that rotating it
strands already-flashed images, so it needs a coordinated re-image (see the
per-device-token item in the design doc's Phase 2).

## Security notes

- The Cloudflare DNS token exists **only** in GitHub Actions secrets. It is
  never in the Worker, the bucket, an image, or this repo.
- `DEVICE_TOKEN` is shared across all images, so it is a weak secret by design —
  it gates cert distribution, nothing else. Rate limiting is what makes it hold up.
- The certificate's private key is shared across devices. Bounded because each Pi
  is an isolated single-client AP; recoverable by re-issuing and republishing.
- Publish order in the workflow is PEMs first, `version.json` last — a device
  polling mid-publish sees the old version and simply retries.
