# Secret rotation — Cloudflare tokens and the device token

All secrets for the certificate pipeline live in **GitHub Actions secrets** and
**Cloudflare**. No device holds any of them except `CERT_SYNC_TOKEN`.

Architecture context: [`turnkey-shared-domain-plan.md`](turnkey-shared-domain-plan.md).
Deployment runbook: [`../infra/cert-service/README.md`](../infra/cert-service/README.md).

| Secret | Where it lives | Blast radius if leaked |
|---|---|---|
| `CLOUDFLARE_DNS_TOKEN` | GitHub Actions secret only | DNS write on the zone → attacker can issue certs for any subdomain, redirect MX, tamper with SPF/DKIM |
| `CLOUDFLARE_API_TOKEN` | GitHub Actions secret only | Read/write the R2 cert bucket (including the private key) |
| `CERT_SYNC_TOKEN` | Worker secret **and** every device image | Lets the holder download the shared cert + private key |

> Rotate promptly on any doubt: accidental commit, screen-share exposure, a
> contributor leaving, or scheduled hygiene (~yearly).

---

## A. Rotate `CLOUDFLARE_DNS_TOKEN` (DNS-01 issuance)

1. **Create the replacement.** Cloudflare → My Profile → API Tokens → Create
   Token → Custom Token.

   | Field | Value |
   |---|---|
   | Permissions | `Zone` / `DNS` / `Edit` |
   | Zone Resources | Include / Specific zone / your zone **only** |
   | Client IP Filtering | leave blank |
   | TTL | blank, or 1 year as a forced-rotation reminder |

   Copy the secret immediately — Cloudflare shows it once.

2. **Smoke-test it** before deploying:
   ```bash
   curl -s https://api.cloudflare.com/client/v4/user/tokens/verify \
     -H "Authorization: Bearer <NEW_TOKEN>"
   ```
   Expect `"status":"active"` and `"success":true`.

3. **Update the Actions secret.** Repo → Settings → Secrets and variables →
   Actions → `CLOUDFLARE_DNS_TOKEN` → Update. (Or `gh secret set CLOUDFLARE_DNS_TOKEN`.)

4. **Prove it works** — Actions → **renew-cert** → Run workflow with
   `force: true`. It must complete and publish a new version. **Do not revoke the
   old token until this passes.**

5. **Revoke the old token** in the Cloudflare dashboard (Delete).

6. **Audit the zone** for anything the leaked token may have changed: unfamiliar
   A/AAAA/CNAME records, unexpected MX or TXT (SPF/DKIM/DMARC tampering enables
   mail spoofing), stray `_acme-challenge` TXT records (someone provisioning a
   cert in your name). Check Cloudflare → Audit Log for the old token's activity
   window.

## B. Rotate `CLOUDFLARE_API_TOKEN` (R2 access)

1. Create a token with Workers R2 read/write on the account.
2. Update the Actions secret (as above).
3. Re-run **renew-cert** with `force: true` to confirm the publish step still works.
4. Delete the old token.

Because this token can read the bucket, treat a leak as also exposing the
**private key** — follow section D as well.

## C. Rotate `CERT_SYNC_TOKEN` (device → cert service)

⚠️ **This one strands already-flashed devices.** A device with the old token gets
`401` on every sync and will stop updating its certificate — it keeps working
until the current cert expires, then breaks.

1. Generate: `openssl rand -hex 32`
2. Update the Worker: `npx wrangler secret put DEVICE_TOKEN` (in `infra/cert-service/`)
3. Update `CERT_SYNC_TOKEN` in `/etc/default/mytesla` on every existing device,
   and in the image build for new ones.
4. Verify: the authenticated call succeeds and an unauthenticated one is rejected.
   ```bash
   curl -H "Authorization: Bearer $NEW" https://certs.<your-domain>/cert/version   # 200
   curl https://certs.<your-domain>/cert/version                                    # 401
   ```

Only rotate this as part of a coordinated re-image, or if the token is known to
be compromised. Per-device tokens (which remove this problem) are a Phase 2 item
in the design doc.

## D. If the shared private key leaks

1. Revoke the certificate at Let's Encrypt.
2. Run **renew-cert** with `force: true` to issue and publish a replacement.
3. Devices pick it up on their next sync — the version bump is what triggers them.
4. Consider whether `CERT_SYNC_TOKEN` also leaked (section C).

---

## Quick checklist

- [ ] New token created with the correct, minimal scope
- [ ] Verified active via the Cloudflare API (DNS token) or a test publish (R2 token)
- [ ] GitHub Actions secret updated
- [ ] **renew-cert** run manually with `force: true` and it succeeded
- [ ] Old token deleted in Cloudflare
- [ ] Zone DNS records + Audit Log reviewed for tampering
- [ ] If `CERT_SYNC_TOKEN` rotated: Worker secret updated, all devices updated

## Not affected

The certificate pipeline holds no other credentials. Unrelated secrets you may
still want to review on the same cadence:

- The AP passphrase in `conf/hostapd.conf` (gitignored) if unchanged for >12 months
- `conf/wpa_supplicant-wlan0-home.conf` — the home Wi-Fi PSK the cert-sync flip uses
