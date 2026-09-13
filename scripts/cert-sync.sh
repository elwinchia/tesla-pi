#!/bin/bash
# cert-sync.sh — pull the shared device certificate from the cert service.
#
# Replaces on-device certbot/DNS-01 issuance. The device holds no Cloudflare
# credential: certs are issued centrally (.github/workflows/renew-cert.yml) and
# fetched here with a bearer token.
#
# Requires internet — call it only while the Pi is on home Wi-Fi. The AP flip is
# the caller's job (scripts/cert-renew-watch.sh does it, and holds the lock).
#
# Exit codes:
#   0  a newer cert was installed  (touches /run/cert-renew.deployed)
#   1  error (network, auth, verification) — existing cert left untouched
#   2  already up to date, nothing to do
#
# Config (from /etc/default/tesla-pi):
#   CARPLAY_DOMAIN    cert subject + /etc/letsencrypt/live/<domain> path
#   CERT_SYNC_URL     base URL of the cert service (no trailing slash)
#   CERT_SYNC_TOKEN   bearer token baked into the image

set -uo pipefail

[ -r /etc/default/tesla-pi ] && . /etc/default/tesla-pi

: "${CARPLAY_DOMAIN:?CARPLAY_DOMAIN must be set in /etc/default/tesla-pi}"
: "${CERT_SYNC_URL:?CERT_SYNC_URL must be set in /etc/default/tesla-pi}"
: "${CERT_SYNC_TOKEN:?CERT_SYNC_TOKEN must be set in /etc/default/tesla-pi}"

LIVE_DIR="/etc/letsencrypt/live/${CARPLAY_DOMAIN}"
VERSION_FILE="${LIVE_DIR}/version"
CURL_TIMEOUT="${CERT_SYNC_TIMEOUT:-30}"

log() { logger -t cert-sync -- "$*"; printf '[%s] %s\n' "$(date -Iseconds)" "$*" >&2; }

fetch() { # fetch <path> <dest>
  curl -fsS --max-time "$CURL_TIMEOUT" \
    -H "Authorization: Bearer ${CERT_SYNC_TOKEN}" \
    -o "$2" "${CERT_SYNC_URL}$1"
}

TMP="$(mktemp -d)" || { log "mktemp failed"; exit 1; }
trap 'rm -rf "$TMP"' EXIT
chmod 700 "$TMP"

# ---- 1. Is a newer version published? ---------------------------------------
if ! fetch /cert/version "$TMP/version.json"; then
  log "version check failed (offline, or token rejected)"
  exit 1
fi

# Avoid a hard jq dependency — the payload is a flat two-key object.
remote_version=$(sed -n 's/.*"version"[[:space:]]*:[[:space:]]*\([0-9]\{1,\}\).*/\1/p' "$TMP/version.json")
if [ -z "$remote_version" ]; then
  log "could not parse remote version from: $(head -c 200 "$TMP/version.json")"
  exit 1
fi

local_version=$(tr -cd '0-9' < "$VERSION_FILE" 2>/dev/null)
local_version=${local_version:-0}

if [ "$remote_version" -le "$local_version" ]; then
  log "up to date (local=$local_version remote=$remote_version)"
  exit 2
fi

log "newer cert available (local=$local_version remote=$remote_version); fetching"

# ---- 2. Fetch the pair ------------------------------------------------------
if ! fetch /cert/fullchain.pem "$TMP/fullchain.pem" || ! fetch /cert/privkey.pem "$TMP/privkey.pem"; then
  log "download failed; keeping existing cert"
  exit 1
fi

# ---- 3. Verify before touching anything live --------------------------------
# A mismatched pair (or a truncated download) would stop nginx from starting on
# reload, taking the whole box down. Verify first, swap second.
if ! openssl x509 -in "$TMP/fullchain.pem" -noout >/dev/null 2>&1; then
  log "fullchain.pem is not a valid certificate; aborting"
  exit 1
fi
if ! openssl pkey -in "$TMP/privkey.pem" -noout >/dev/null 2>&1; then
  log "privkey.pem is not a valid key; aborting"
  exit 1
fi

cert_pub=$(openssl x509 -in "$TMP/fullchain.pem" -noout -pubkey 2>/dev/null | openssl sha256)
key_pub=$(openssl pkey -in "$TMP/privkey.pem" -pubout 2>/dev/null | openssl sha256)
if [ "$cert_pub" != "$key_pub" ]; then
  log "cert/key mismatch; aborting"
  exit 1
fi

# Refuse to install something already expired (a clock problem or a stale bucket).
if ! openssl x509 -in "$TMP/fullchain.pem" -noout -checkend 0 >/dev/null 2>&1; then
  log "fetched cert is already expired; aborting"
  exit 1
fi

# Guard against being handed a cert for a different name.
if ! openssl x509 -in "$TMP/fullchain.pem" -noout -checkhost "$CARPLAY_DOMAIN" >/dev/null 2>&1; then
  log "fetched cert is not valid for ${CARPLAY_DOMAIN}; aborting"
  exit 1
fi

not_after=$(openssl x509 -in "$TMP/fullchain.pem" -noout -enddate | cut -d= -f2)

# ---- 4. Install atomically --------------------------------------------------
install -d -m 0755 "$LIVE_DIR"
# Write to temp names in the destination dir, then rename — rename(2) is atomic
# within a filesystem, so nginx never observes a half-written pair.
install -m 0644 "$TMP/fullchain.pem" "${LIVE_DIR}/.fullchain.pem.new" || { log "write failed"; exit 1; }
install -m 0600 "$TMP/privkey.pem"   "${LIVE_DIR}/.privkey.pem.new"   || { log "write failed"; exit 1; }
mv -f "${LIVE_DIR}/.fullchain.pem.new" "${LIVE_DIR}/fullchain.pem"
mv -f "${LIVE_DIR}/.privkey.pem.new"   "${LIVE_DIR}/privkey.pem"

# Reproduce the rest of certbot's live/ layout, because configs written against
# it reference these by name — conf/nginx-carplay.conf points
# ssl_trusted_certificate at chain.pem, and nginx refuses to start if it is
# missing. fullchain = leaf + intermediates, so:
#   cert.pem  = the leaf only        (first certificate in the file)
#   chain.pem = the intermediates    (everything after the leaf)
awk 'BEGIN{n=0}
     /-----BEGIN CERTIFICATE-----/{n++}
     n==1{print > cert}
     n>1 {print > chain}' \
    cert="${LIVE_DIR}/.cert.pem.new" chain="${LIVE_DIR}/.chain.pem.new" \
    "${LIVE_DIR}/fullchain.pem"

# The leaf always exists — fullchain parsed as a certificate above.
chmod 0644 "${LIVE_DIR}/.cert.pem.new"
mv -f "${LIVE_DIR}/.cert.pem.new" "${LIVE_DIR}/cert.pem"

if [ -s "${LIVE_DIR}/.chain.pem.new" ]; then
  chmod 0644 "${LIVE_DIR}/.chain.pem.new"
  mv -f "${LIVE_DIR}/.chain.pem.new" "${LIVE_DIR}/chain.pem"
else
  # A self-signed / single-cert fullchain has no intermediates to split out.
  rm -f "${LIVE_DIR}/.chain.pem.new"
  log "warn: fullchain had no intermediates; chain.pem not written"
fi

# Version last: if anything above failed we retry next cycle rather than
# recording a version we did not actually install.
printf '%s\n' "$remote_version" > "$VERSION_FILE"

log "installed cert version ${remote_version} (expires ${not_after})"

# Existing hook: cert-renew-watch.sh / cert-renew-now.sh reload nginx on this.
touch /run/cert-renew.deployed
exit 0
