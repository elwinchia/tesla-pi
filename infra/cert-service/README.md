# cert-service — shared device certificate distribution

Serves the shared TLS certificate for `device.tesla-pi.humblebees.co` to tesla-pi
devices. Devices hold **no** Cloudflare credential; issuance happens centrally
and devices pull the finished cert from here.

Design rationale: [`docs/turnkey-shared-domain-plan.md`](../../docs/turnkey-shared-domain-plan.md).

```
issuance (CI or manual)  --writes-->  Workers KV  <--reads--  Worker  <--pulls--  devices
   holds the CF DNS token             binding CERTS      *.workers.dev      (bearer token)
```

## Components

| Path | What it is |
|---|---|
| `src/worker.js` | Worker: token-gated `/cert/*` endpoints backed by Workers KV |
| `wrangler.toml` | Worker config + KV binding (`workers_dev = true`) |
| `landing/index.html` | Static page for `device.tesla-pi.humblebees.co` (optional; only ever seen outside the car) |
| `../../.github/workflows/renew-cert.yml` | Issues + publishes the cert on a cron |

## API

All routes require `Authorization: Bearer <DEVICE_TOKEN>`.

| Route | Returns |
|---|---|
| `GET /cert/version` | `{"version":N,"not_after":"…"}` — devices poll this |
| `GET /cert/fullchain.pem` | raw PEM |
| `GET /cert/privkey.pem` | raw PEM |

Raw PEM (rather than a JSON bundle) keeps the device client dependency-free —
no JSON parsing in shell.

## Why KV and workers.dev

- **KV, not R2** — the payload is a few KB of text. KV is included in the free
  Workers plan; R2 requires a payment method on file even for its free tier.
  KV's ~60 s eventual consistency is irrelevant for a cert that rotates every
  ~60 days.
- **`*.workers.dev`, not a custom hostname** — `certs.tesla-pi.humblebees.co` is
  two labels deep, and Cloudflare's free Universal SSL only covers the apex and
  a single-label wildcard (`*.humblebees.co`). A two-deep hostname would serve
  an invalid edge certificate and `cert-sync.sh` would fail its TLS handshake.
  Fixing that properly needs Advanced Certificate Manager (paid). workers.dev
  gets valid TLS automatically and needs no DNS record at all.

Neither choice constrains the device hostname: DNS-01 validates via a TXT
record so issuance works at any depth, and in the car `dnsmasq` resolves
`CARPLAY_DOMAIN` to the Pi itself.

---

## Setup

### 1. Authenticate

```bash
npx wrangler login          # browser OAuth; pick the account owning humblebees.co
npx wrangler whoami         # confirm account + note the Account ID
```

### 2. Create the KV namespace

```bash
cd infra/cert-service
npx wrangler kv namespace create CERTS
```

Copy the printed `id` into `wrangler.toml` over the existing `id` under
`[[kv_namespaces]]`, and into `KV_NAMESPACE_ID` in
`.github/workflows/renew-cert.yml`.

### 3. Device token

```bash
openssl rand -hex 32                 # generate
npx wrangler secret put DEVICE_TOKEN # paste it
```

The same value goes into `/etc/default/tesla-pi` (mode 0600) on every device as
`CERT_SYNC_TOKEN`.

### 4. Deploy

```bash
npx wrangler deploy
```

Note the printed URL — `https://tesla-pi-cert-service.<account>.workers.dev`.
That is `CERT_SYNC_URL`.

### 5. DNS-01 token (for issuing the certificate)

`wrangler login` does **not** grant DNS edit rights, so certbot needs its own
token. Cloudflare dashboard → My Profile → API Tokens → Create Custom Token:

| Field | Value |
|---|---|
| Permissions | `Zone` / `DNS` / `Edit` |
| Zone Resources | Include / Specific zone / `humblebees.co` |
| Client IP Filtering | leave blank |

```bash
mkdir -p ~/.secrets && chmod 700 ~/.secrets
printf 'dns_cloudflare_api_token = <TOKEN>\n' > ~/.secrets/cloudflare.ini
chmod 600 ~/.secrets/cloudflare.ini
```

### 6. Issue and publish the first certificate

Either run the GitHub workflow (**Actions → renew-cert → Run workflow**,
`force: true`), or do it locally with the same container:

```bash
DOMAIN=device.tesla-pi.humblebees.co
mkdir -p out
docker run --rm \
  -v "$HOME/.secrets:/secrets:ro" -v "$PWD/out:/etc/letsencrypt" \
  certbot/dns-cloudflare:latest certonly \
    --dns-cloudflare --dns-cloudflare-credentials /secrets/cloudflare.ini \
    --dns-cloudflare-propagation-seconds 30 \
    -d "$DOMAIN" --non-interactive --agree-tos -m <you@example.com> --key-type ecdsa

live="out/live/$DOMAIN"
sudo cp "$live/fullchain.pem" "$live/privkey.pem" . && sudo chown "$USER" *.pem

# Verify the pair BEFORE publishing — a mismatch stops nginx on every device.
diff <(openssl x509 -in fullchain.pem -noout -pubkey) \
     <(openssl pkey -in privkey.pem -pubout) && echo "pair OK"

not_after=$(date -u -d "$(openssl x509 -in fullchain.pem -noout -enddate | cut -d= -f2)" +%Y-%m-%dT%H:%M:%SZ)
version=$(date -u +%s)
printf '{"version":%s,"not_after":"%s"}\n' "$version" "$not_after" > version.json

NS=<kv-namespace-id>
for f in fullchain.pem privkey.pem version.json; do   # version.json LAST
  npx wrangler kv key put "$f" --path="$f" --namespace-id "$NS" --remote \
    --metadata "{\"version\":\"$version\"}"
done
```

> Publish order matters: PEMs first, `version.json` last. A device polling
> mid-publish then sees the old version and simply retries, rather than
> fetching a half-updated pair.

### 7. Verify

```bash
URL=https://tesla-pi-cert-service.<account>.workers.dev
curl -sS -H "Authorization: Bearer $DEVICE_TOKEN" "$URL/cert/version"   # 200 + JSON
curl -sS -o /dev/null -w '%{http_code}\n' "$URL/cert/version"           # 401
```

### 8. Rate limiting (already configured)

Already configured in `wrangler.toml` — nothing to do in the dashboard. The
bundle contains a private key, so the Worker charges every request against two
per-IP budgets using Workers rate-limit bindings:

| Binding | Budget | Charged on |
|---|---|---|
| `RL_REQUESTS` | 10 / 60 s | every request, before the path lookup |
| `RL_AUTH_FAILURES` | 3 / 60 s | additionally, on a wrong or missing token |

Over the limit the answer is `429` with `Retry-After: 60`, which also means a
guesser stops being able to tell a wrong token from a right one.

A device polls hours apart and fetches three objects per rotation, so this is
far above legitimate use.

> **Not a WAF rule.** WAF rate-limiting rules attach to a zone, and
> `*.workers.dev` is Cloudflare's zone rather than ours, so there is no zone
> here to attach one to. The limit has to live in the Worker.

> **The limiter is deliberately permissive.** Counters are per Cloudflare
> location and eventually consistent. Measured 2026-09-16 against the deployed
> Worker: a cold burst of 35 rapid requests got only ~2 rejections, while a
> sustained 100 got 60 — it converges to ~95% blocked rather than clamping the
> first burst. Size the budgets for that: it makes bulk pulling expensive, it
> does not make a short burst impossible. The token, not this, is what actually
> guards the key.

---

## Operations

**Renewal cadence** is `RENEW_BEFORE_DAYS` in the workflow env (default 60). The
job runs weekly and no-ops until remaining life drops below it. CA lifetimes are
shrinking industry-wide, so lower this rather than assuming 90 days.

**Force a re-issue:** Actions → renew-cert → Run workflow → `force: true`.

**Inspect what's published:**
```bash
npx wrangler kv key get version.json --namespace-id "$NS" --remote
```

**If the private key leaks:** revoke the cert, re-issue (`force: true`), and
devices pick up the replacement on their next sync. Consider rotating
`DEVICE_TOKEN` too — but note that strands already-flashed images, so it needs a
coordinated re-image (see the design doc's Phase 2).

## Security notes

- The Cloudflare DNS token exists **only** in GitHub Actions secrets (or your
  local `~/.secrets`). It is never in the Worker, KV, an image, or this repo.
- `DEVICE_TOKEN` is shared across all images, so it is a weak secret by design —
  it gates cert distribution, nothing else. Its 256 bits are what make it hold
  up; the rate limiting in §8 bounds bulk scraping and removes the 401/429
  oracle, but one successful request yields the key, so it is not the guard.
  Per-device tokens would make a leak revocable — Phase 2 in
  `docs/turnkey-shared-domain-plan.md`, deliberately not built yet.
- The certificate's private key is shared across devices. Bounded because each Pi
  is an isolated single-client AP; recoverable by re-issuing and republishing.
