#!/bin/bash
# install-karaoke-addon.sh — installs the Nightingale karaoke addon on the Pi.
#
# Serves the Nightingale self-hosted web app (https://github.com/rzru/nightingale)
# to the Tesla browser. Unlike the RetroArch addon there is NO video pipeline:
# the karaoke app is a normal web app, so the Tesla's own browser renders it,
# plays the audio through the car speakers, and captures the cabin mic for
# pitch scoring. The Pi only serves files. See docs/karaoke-addon.md.
#
# IMPORTANT — this installs the UltraStar (USDX) path, not the ML path.
# Nightingale can also *generate* karaoke tracks from any song using Demucs +
# WhisperX, but that pipeline wants a desktop CPU or a GPU: it takes 10-20 min
# per song on a fast x86 core and peaks at several GB of RAM. On a 4 GB Pi 4
# that is hours per song and an almost certain OOM — with CarPlay as the
# casualty. So we seed the vendor directory just enough to satisfy the app's
# readiness check and rely on UltraStar songs, which ship pre-timed lyrics and
# (usually) ready-made vocal/instrumental tracks and skip the ML pipeline
# entirely. Set KARAOKE_ENABLE_ML=1 to skip the seed and let the in-app setup
# wizard download the full ~6 GB stack instead (not recommended on a Pi 4).
#
# Everything is OFF by default after install: no unit is enabled, boot time is
# untouched, and CarPlay never depends on anything here. The Node server starts
# the server on demand via /usr/local/sbin/tesla-pi-karaoke.
#
# Idempotent. Safe to re-run. Requires internet on the Pi.

set -euo pipefail

[[ $EUID -eq 0 ]] || { echo "run as root"; exit 1; }

SRC_DIR="$(cd "$(dirname "$0")" && pwd)"
# The account the app runs as on THIS device, which is not always the
# image-built default. See scripts/service-user-lib.sh.
. "$SRC_DIR/service-user-lib.sh"
SERVICE_USER="$(resolve_service_user)"
REPO_DIR="$(dirname "$SRC_DIR")"

# Pin a known-good release. Bump deliberately: the frontend is embedded in the
# binary, so a version bump swaps the whole app at once.
NIGHTINGALE_VERSION="${NIGHTINGALE_VERSION:-v1.1.0}"
NIGHTINGALE_REPO="${NIGHTINGALE_REPO:-rzru/nightingale}"
ASSET="nightingale-server-aarch64-unknown-linux-gnu.tar.gz"

DATA_DIR=/var/lib/nightingale
BIN_DST=/usr/local/bin/nightingale
HELPER_SRC="$SRC_DIR/tesla-pi-karaoke"
HELPER_DST=/usr/local/sbin/tesla-pi-karaoke
SUDOERS_DST=/etc/sudoers.d/tesla-pi-karaoke
UNIT_SRC="$REPO_DIR/systemd/nightingale.service"
UNIT_DST=/etc/systemd/system/nightingale.service
NGINX_SRC="$REPO_DIR/conf/nginx-karaoke.conf"
INJECT_SRC="$REPO_DIR/conf/karaoke-inject.js"
INJECT_DST=/etc/nginx/karaoke-inject.js
NGINX_AVAIL=/etc/nginx/sites-available/karaoke
NGINX_ENABLED=/etc/nginx/sites-enabled/karaoke

# True when there is no running systemd — i.e. we are inside the image build
# chroot (image/provision.sh) rather than on a live Pi. Same guard the
# RetroArch installer uses, for the same reason.
in_chroot() { [[ ! -d /run/systemd/system ]]; }

install_if_changed() {
    local src="$1" dst="$2" mode="$3"
    if [[ ! -s "$dst" ]] || ! cmp -s "$src" "$dst"; then
        install -m "$mode" -o root -g root "$src" "$dst"
        echo "  wrote $dst"
    else
        echo "  $dst already up to date"
    fi
}

echo "=== preflight ==="
[[ "$(uname -m)" == "aarch64" ]] || { echo "need a 64-bit (aarch64) kernel"; exit 1; }
id "$SERVICE_USER" >/dev/null || { echo "service user $SERVICE_USER does not exist"; exit 1; }

# The nginx vhost needs the same domain the CarPlay site uses — that is the
# name the device cert is valid for, and the only way this origin is secure
# enough for the browser to hand us the microphone.
CARPLAY_DOMAIN=""
if [[ -r /etc/default/tesla-pi ]]; then
    CARPLAY_DOMAIN="$(sed -n 's/^CARPLAY_DOMAIN=//p' /etc/default/tesla-pi | head -1)"
fi
[[ -n "$CARPLAY_DOMAIN" ]] || { echo "CARPLAY_DOMAIN not set in /etc/default/tesla-pi"; exit 1; }
echo "  aarch64, user $SERVICE_USER, domain $CARPLAY_DOMAIN — ok"

echo "=== packages ==="
# ffmpeg + python3-venv are only here to satisfy Nightingale's readiness check
# (see the vendor seed below); curl/ca-certificates fetch the release.
#
# Only the MISSING ones are installed. A plain `apt-get install` of packages
# that are already present still tries to upgrade them, which turns a stale
# package index into a hard failure of this whole script — a 404 on a superseded
# curl point release is not a reason to refuse to install karaoke. Devices in a
# car go weeks between `apt-get update`s, so that is the normal case, not the
# edge case.
MISSING=()
for pkg in curl ca-certificates ffmpeg python3-venv libnginx-mod-http-subs-filter; do
    if ! dpkg-query -W -f='${Status}' "$pkg" 2>/dev/null | grep -q "ok installed"; then
        MISSING+=("$pkg")
    fi
done
if [[ ${#MISSING[@]} -eq 0 ]]; then
    echo "  curl, ca-certificates, ffmpeg, python3-venv, subs-filter all present — nothing to do"
else
    echo "  installing: ${MISSING[*]}"
    # Refresh first: whatever is missing is likely missing from a stale index too.
    apt-get update -qq || echo "  (apt-get update failed; trying the install anyway)"
    DEBIAN_FRONTEND=noninteractive apt-get install -y "${MISSING[@]}"
fi

echo "=== nightingale server $NIGHTINGALE_VERSION ==="
# Skip the download when the installed binary is already this version. The
# tarball is ~20 MB and a car's uplink can be measured in hundreds of bytes per
# second, so re-fetching it on every idempotent re-run is the difference between
# a 10-second install and a 10-minute one. Delete the stamp to force a refetch.
VERSION_STAMP=/usr/local/bin/nightingale.version
if [[ -x "$BIN_DST" && -r "$VERSION_STAMP" ]] \
   && [[ "$(cat "$VERSION_STAMP")" == "$NIGHTINGALE_VERSION" ]]; then
    echo "  $BIN_DST is already $NIGHTINGALE_VERSION — skipping download"
    SKIP_DOWNLOAD=1
else
    SKIP_DOWNLOAD=0
fi

TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT
BASE="https://github.com/${NIGHTINGALE_REPO}/releases/download/${NIGHTINGALE_VERSION}"
if [[ "$SKIP_DOWNLOAD" == "0" ]]; then
curl -fsSL --retry 3 -o "$TMP/$ASSET" "$BASE/$ASSET"
# Upstream publishes a .sha256 next to each asset. Verify when present rather
# than trusting a plain HTTPS fetch of a binary we are about to run as a service.
if curl -fsSL --retry 2 -o "$TMP/$ASSET.sha256" "$BASE/$ASSET.sha256" 2>/dev/null; then
    want="$(tr -d '\r' < "$TMP/$ASSET.sha256" | awk '{print $1}' | head -1)"
    got="$(sha256sum "$TMP/$ASSET" | awk '{print $1}')"
    [[ "$want" == "$got" ]] || { echo "checksum mismatch: want $want got $got"; exit 1; }
    echo "  sha256 verified"
else
    echo "  no .sha256 published for this release — skipping checksum"
fi
tar xzf "$TMP/$ASSET" -C "$TMP"
[[ -f "$TMP/nightingale" ]] || { echo "tarball did not contain a 'nightingale' binary"; exit 1; }
chmod 0755 "$TMP/nightingale"
install_if_changed "$TMP/nightingale" "$BIN_DST" 0755
printf '%s\n' "$NIGHTINGALE_VERSION" > "$VERSION_STAMP"
fi

echo "=== data directories ==="
# songs/ is where UltraStar folders go; the unit pins the library there so the
# app never has to ask (a browser file picker cannot supply an absolute path).
for d in "" songs cache videos models vendor; do
    install -d -o "$SERVICE_USER" -g "$SERVICE_USER" -m 0755 "$DATA_DIR/$d"
done
echo "  $DATA_DIR/{songs,cache,videos,models,vendor}"

# A karaoke app with an empty library looks broken rather than empty, so seed
# the public-domain songbook. It is generated here, not shipped: the melodies
# and words are old enough that nobody owns them, and rendering on the box
# means the audio is ours too. Idempotent — it only ever rewrites its own
# folders. Set KARAOKE_SKIP_SONGS=1 to leave the library bare.
SONGBOOK="$(dirname "$0")/make-karaoke-songs.py"
if [[ "${KARAOKE_SKIP_SONGS:-0}" == "1" ]]; then
    echo "=== songbook SKIPPED (KARAOKE_SKIP_SONGS=1) ==="
elif [[ ! -x "$SONGBOOK" ]]; then
    echo "=== songbook SKIPPED (no $SONGBOOK) ==="
else
    echo "=== songbook (~5 min of synthesis on a Pi 4) ==="
    if "$SONGBOOK" "$DATA_DIR/songs" --quiet; then
        chown -R "$SERVICE_USER:$SERVICE_USER" "$DATA_DIR/songs"
        echo "  $(find "$DATA_DIR/songs" -name '*.txt' | wc -l | tr -d ' ') songs in $DATA_DIR/songs"
    else
        # Not fatal: the addon works, it just has nothing in it yet.
        echo "  songbook failed — run scripts/make-karaoke-songs.py by hand" >&2
    fi
fi

if [[ "${KARAOKE_ENABLE_ML:-0}" == "1" ]]; then
    echo "=== vendor seed SKIPPED (KARAOKE_ENABLE_ML=1) ==="
    echo "  the in-app setup wizard will download the full ML stack on first open."
    echo "  expect several GB and a very long bootstrap on a Pi 4."
else
    echo "=== vendor seed (UltraStar mode — no ML) ==="
    # Nightingale gates its UI behind a modal setup wizard until is_ready() is
    # true, and that check wants four things to exist: the .ready marker, a
    # vendor ffmpeg, a venv python, and analyzer/analyze.py. None of them are
    # touched when playing an UltraStar song — that path resolves audio straight
    # from the song folder and returns early out of the stem pipeline — so we
    # satisfy the check honestly with the real tools, minus the ML packages
    # nothing here can run.
    VENDOR="$DATA_DIR/vendor"

    # is_file() follows symlinks, so the distro ffmpeg answers for the vendor one.
    if [[ ! -e "$VENDOR/ffmpeg" ]]; then
        ln -sf "$(command -v ffmpeg)" "$VENDOR/ffmpeg"
        echo "  linked $VENDOR/ffmpeg -> $(command -v ffmpeg)"
    else
        echo "  $VENDOR/ffmpeg already present"
    fi

    if [[ ! -x "$VENDOR/venv/bin/python" ]]; then
        # Created as root and chowned below rather than via `sudo -u`: there is
        # no sudo to rely on inside the image-build chroot.
        python3 -m venv "$VENDOR/venv"
        echo "  created $VENDOR/venv (no ML packages — UltraStar needs none)"
    else
        echo "  $VENDOR/venv already present"
    fi

    # Placeholder only: once .ready exists the server overwrites this directory
    # with its own embedded analyzer scripts on next startup. Either way the
    # readiness check passes and nothing here runs for an UltraStar song.
    install -d -o "$SERVICE_USER" -g "$SERVICE_USER" -m 0755 "$VENDOR/analyzer"
    if [[ ! -f "$VENDOR/analyzer/analyze.py" ]]; then
        cat > "$VENDOR/analyzer/analyze.py" <<'PY'
"""Placeholder analyzer — ML analysis is disabled on this device.

The Pi 4 cannot run Nightingale's Demucs + WhisperX pipeline in any useful
time or memory budget, so scripts/install-karaoke-addon.sh seeds the vendor
directory without the ML packages. Play UltraStar (.txt/.usdx) songs, which
carry their own timed lyrics and need no analysis.

To analyse a song, run Nightingale on a desktop and copy the results over,
or reinstall with KARAOKE_ENABLE_ML=1 and accept the download and the wait.
"""

import sys

sys.exit(
    "ML analysis is disabled on this device — add UltraStar songs instead. "
    "See docs/karaoke-addon.md."
)
PY
        chown "$SERVICE_USER:$SERVICE_USER" "$VENDOR/analyzer/analyze.py"
        echo "  wrote $VENDOR/analyzer/analyze.py (placeholder)"
    else
        echo "  $VENDOR/analyzer/analyze.py already present"
    fi

    if [[ ! -f "$VENDOR/.ready" ]]; then
        echo ok > "$VENDOR/.ready"
        chown "$SERVICE_USER:$SERVICE_USER" "$VENDOR/.ready"
        echo "  marked $VENDOR/.ready (skips the setup wizard)"
    else
        echo "  $VENDOR/.ready already present"
    fi
fi

chown -R "$SERVICE_USER:$SERVICE_USER" "$DATA_DIR"

echo "=== installing $UNIT_DST ==="
TMP_UNIT="$(mktemp)"
sed "s|^User=.*|User=$SERVICE_USER|; s|^Group=.*|Group=$SERVICE_USER|" "$UNIT_SRC" > "$TMP_UNIT"
install_if_changed "$TMP_UNIT" "$UNIT_DST" 0644
rm -f "$TMP_UNIT"
in_chroot || systemctl daemon-reload

echo "=== installing $HELPER_DST ==="
install_if_changed "$HELPER_SRC" "$HELPER_DST" 0755

echo "=== installing $SUDOERS_DST ==="
TMP_SUDO="$(mktemp)"
cat > "$TMP_SUDO" <<EOF
# Managed by scripts/install-karaoke-addon.sh — grants the tesla-pi service
# user NOPASSWD on exactly the karaoke lifecycle helper. The helper validates
# verbs, so this entry can't be repurposed for other commands.
$SERVICE_USER ALL=(root) NOPASSWD: $HELPER_DST
EOF
chmod 0440 "$TMP_SUDO"
visudo -cf "$TMP_SUDO" >/dev/null
install_if_changed "$TMP_SUDO" "$SUDOERS_DST" 0440
rm -f "$TMP_SUDO"

echo "=== AP port forward for :8443 ==="
# dnsmasq answers every name with 240.3.3.4 while the AP is up, and the car
# reaches nginx only through the DNAT rules for that address. :80 and :443 are
# forwarded already; without a matching rule the Tesla dials 240.3.3.4:8443 and
# nothing answers. conf/iptables.ipv4.nat carries the rule so it survives the
# iptables-restore in scripts/ap-mode.sh.
IPT_SRC="$REPO_DIR/conf/iptables.ipv4.nat"
IPT_DST=/etc/iptables/rules.v4
if [[ -f "$IPT_DST" ]]; then
    install_if_changed "$IPT_SRC" "$IPT_DST" 0644
else
    echo "  $IPT_DST absent — skipping (AP not configured on this device yet)"
fi
DNAT_RULE=(PREROUTING -d 240.3.3.4/32 -i wlan0 -p tcp -m tcp --dport 8443
           -j DNAT --to-destination 192.168.4.254)
if in_chroot; then
    echo "  chroot: skipping live iptables (restored at boot from $IPT_DST)"
elif iptables -t nat -C "${DNAT_RULE[@]}" 2>/dev/null; then
    echo "  live DNAT rule already present"
else
    # Insert rather than append so it sits with the other 240.3.3.4 rules
    # regardless of what else has accumulated in the chain.
    iptables -t nat -I "${DNAT_RULE[@]}" && echo "  added live DNAT rule for :8443" \
        || echo "  !! could not add the live rule; it will apply on the next AP restart"
fi

echo "=== nginx vhost (:8443, CarPlay-domain cert) ==="
install_if_changed "$INJECT_SRC" "$INJECT_DST" 0644
TMP_NGINX="$(mktemp)"
sed "s|CARPLAY_DOMAIN|$CARPLAY_DOMAIN|g" "$NGINX_SRC" > "$TMP_NGINX"
# The back button and the mic tweak ride in on sub_filter. nginx-light is built
# without ngx_http_sub_module, and an unknown directive is a hard config error —
# so drop those lines rather than leave the whole vhost (and karaoke) broken.
# Debian's nginx has no built-in ngx_http_sub_module, so we rely on the packaged
# dynamic substitutions module. It is installed above; this only has to cope with
# a distro where that package does not exist.
if [[ -e /etc/nginx/modules-enabled/50-mod-http-subs-filter.conf ]] \
   || nginx -V 2>&1 | grep -q -- '--with-http_sub_module'; then
    echo "  substitution filter available — injecting the launcher button + mic fix"
else
    sed -i '/subs_filter/d; /proxy_set_header Accept-Encoding/d' "$TMP_NGINX"
    echo "  !! no substitution filter module — injection disabled."
    echo "     Karaoke still works; there will be no in-app Back button."
fi
install_if_changed "$TMP_NGINX" "$NGINX_AVAIL" 0644
rm -f "$TMP_NGINX"
ln -sf "$NGINX_AVAIL" "$NGINX_ENABLED"
if in_chroot; then
    echo "  chroot: skipping nginx test/reload (applies at boot)"
else
    if nginx -t 2>/dev/null; then
        systemctl reload nginx
        echo "  nginx reloaded"
    else
        echo "  !! nginx -t failed — leaving the vhost linked but NOT reloading."
        echo "     Run 'sudo nginx -t' to see why (a missing cert is the usual cause)."
    fi
fi

echo
echo "=== done ==="
cat <<EOF

Karaoke addon installed (server stays off until the Karaoke tile is tapped).

Songbook:   12 public-domain songs were generated into $DATA_DIR/songs
            (Happy Birthday, Twinkle Twinkle, Ode to Joy, Silent Night, ...).
            Rebuild or list them with scripts/make-karaoke-songs.py.

Add songs:  $DATA_DIR/songs/<Artist> - <Title>/
            UltraStar folders — a .txt (or .usdx) plus its audio, and ideally
            the separate vocal + instrumental tracks the .txt names in
            #VOCALS / #INSTRUMENTAL. Those skip the ML pipeline entirely,
            which is the only thing a Pi 4 can serve well.
            chown -R $SERVICE_USER:$SERVICE_USER $DATA_DIR/songs

Smoke test:
  sudo tesla-pi-karaoke start
  sudo tesla-pi-karaoke status
  curl -sS -o /dev/null -w '%{http_code}\\n' http://127.0.0.1:8088/api/bootstrap
  sudo tesla-pi-karaoke stop

Then restart the Node server so the launcher shows the Karaoke tile:
  sudo systemctl restart tesla-pi.service

In the car the app opens at https://$CARPLAY_DOMAIN:8443/ — a separate origin
from the CarPlay page, so the browser asks for the microphone once more there.
Allow it, or there is no pitch scoring. See docs/karaoke-addon.md.
EOF
