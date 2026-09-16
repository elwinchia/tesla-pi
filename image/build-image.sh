#!/bin/bash
# build-image.sh — build a flashable Tesla-Pi image from a stock DietPi image.
#
#   stock DietPi .img.xz
#     -> grow the rootfs so there is room to install into
#     -> chroot in and run image/provision.sh
#     -> drop tesla-pi.txt on the boot partition
#     -> strip per-device identity (host keys, machine-id, logs)
#     -> shrink the rootfs back to just-big-enough
#     -> xz
#
# Must run on Linux as root, with loop devices available. On macOS use
# image/build-in-docker.sh, which runs this inside a privileged arm64
# container — building natively on Apple silicon means no qemu emulation.
#
# The image is arm64 and provisioning runs binaries from it (npm, node-gyp,
# dpkg maintainer scripts), so the build host must be able to execute aarch64.
# Native arm64 host, or x86_64 with binfmt_misc + qemu-user-static registered.
#
# Env:
#   BASE_URL              stock image URL
#   GROW_MB               working headroom added before provisioning (4096)
#   SLACK_MB              free space left in the shipped image (192)
#   OUT_DIR               where the finished .img.xz lands (./out)
#   KEEP_RAW              1 to keep the uncompressed .img too
#   SKIP_PROVISION        1 to exercise the image plumbing (grow, mount,
#                         overlay, strip, shrink, package) without installing
#                         anything. Produces a non-functional image; useful
#                         only for testing this script.
#   TESLAPI_WITH_RETROARCH / CERT_SYNC_TOKEN / CERT_BUNDLE_DIR
#                         passed through to provision.sh

set -euo pipefail

REPO_DIR="$(cd "$(dirname "$0")/.." && pwd)"

BASE_URL="${BASE_URL:-https://dietpi.com/downloads/images/DietPi_RPi234-ARMv8-Bookworm.img.xz}"
BASE_XZ="$(basename "$BASE_URL")"
BASE_IMG="${BASE_XZ%.xz}"
GROW_MB="${GROW_MB:-4096}"
SLACK_MB="${SLACK_MB:-192}"
WORK_DIR="${WORK_DIR:-$REPO_DIR/.image-build}"
OUT_DIR="${OUT_DIR:-$REPO_DIR/out}"
KEEP_RAW="${KEEP_RAW:-0}"

say() { printf '\n\033[1m=== %s ===\033[0m\n' "$*"; }
note() { echo "  $*"; }
die() { echo "error: $*" >&2; exit 1; }

[[ $EUID -eq 0 ]] || die "run as root (loop devices and chroot)"
[[ "$(uname -s)" == Linux ]] || die "Linux only — use image/build-in-docker.sh on macOS"

for t in losetup sfdisk resize2fs e2fsck dumpe2fs truncate xz curl rsync chroot; do
    command -v "$t" >/dev/null 2>&1 || die "missing required tool: $t"
done

# provision.sh runs aarch64 binaries out of the image.
if [[ "$(uname -m)" != aarch64 ]]; then
    if [[ ! -e /proc/sys/fs/binfmt_misc/qemu-aarch64 ]]; then
        die "host is $(uname -m) and qemu-aarch64 binfmt is not registered — cannot chroot into an arm64 rootfs"
    fi
    note "x86_64 host: using qemu-aarch64 binfmt (slow but works)"
fi

mkdir -p "$WORK_DIR" "$OUT_DIR"
IMG="$WORK_DIR/tesla-pi-work.img"
ROOT="$WORK_DIR/mnt"

# ── teardown ────────────────────────────────────────────────────────────────
# Every exit path unwinds mounts and loop devices. Leaving a loop device
# attached to the image silently corrupts the next run's resize.
LOOP_ROOT=""
LOOP_BOOT=""
cleanup() {
    set +e
    for m in "$ROOT/dev/pts" "$ROOT/dev" "$ROOT/proc" "$ROOT/sys" \
             "$ROOT/boot/firmware" "$ROOT"; do
        mountpoint -q "$m" && umount -lf "$m"
    done
    [[ -n $LOOP_BOOT ]] && losetup -d "$LOOP_BOOT" 2>/dev/null
    [[ -n $LOOP_ROOT ]] && losetup -d "$LOOP_ROOT" 2>/dev/null
    LOOP_BOOT=""; LOOP_ROOT=""
    set -e
}
trap cleanup EXIT

# Read partition geometry from the image rather than hardcoding sector numbers,
# which change whenever DietPi re-cuts its images.
part_field() { # part_field <n> <start|size>  -> sectors
    local n="$1" f="$2"
    sfdisk -d "$IMG" 2>/dev/null \
        | grep -E '^\S+[0-9]+[[:space:]]*:' \
        | sed -n "${n}p" \
        | grep -oE "${f}=[[:space:]]*[0-9]+" \
        | grep -oE '[0-9]+'
}

attach_parts() {
    local bs=$(( $(part_field 1 start) * 512 ))
    local bz=$(( $(part_field 1 size)  * 512 ))
    local rs=$(( $(part_field 2 start) * 512 ))
    local rz=$(( $(part_field 2 size)  * 512 ))
    LOOP_BOOT="$(losetup --find --show --offset "$bs" --sizelimit "$bz" "$IMG")"
    LOOP_ROOT="$(losetup --find --show --offset "$rs" --sizelimit "$rz" "$IMG")"
}

detach_parts() {
    [[ -n $LOOP_BOOT ]] && losetup -d "$LOOP_BOOT" && LOOP_BOOT=""
    [[ -n $LOOP_ROOT ]] && losetup -d "$LOOP_ROOT" && LOOP_ROOT=""
    return 0
}

# ── 1. base image ───────────────────────────────────────────────────────────
say "base image"
if [[ ! -s $WORK_DIR/$BASE_XZ ]]; then
    note "downloading $BASE_URL"
    curl -fL --retry 3 -o "$WORK_DIR/$BASE_XZ" "$BASE_URL"
else
    note "using cached $WORK_DIR/$BASE_XZ"
fi

if [[ -n ${BASE_SHA256:-} ]]; then
    echo "$BASE_SHA256  $WORK_DIR/$BASE_XZ" | sha256sum -c - \
        || die "base image checksum mismatch"
    note "checksum verified"
else
    note "sha256: $(sha256sum "$WORK_DIR/$BASE_XZ" | cut -d' ' -f1)"
    note "(set BASE_SHA256 to pin it)"
fi

say "decompressing"
rm -f "$IMG"
xz -dc "$WORK_DIR/$BASE_XZ" >"$IMG"
note "$(du -h "$IMG" | cut -f1)"

# ── 2. grow ─────────────────────────────────────────────────────────────────
say "growing rootfs by ${GROW_MB} MiB to make room to install"
truncate -s "+${GROW_MB}M" "$IMG"
# Extend the last partition to the end of the (now larger) file. `,+` keeps the
# start and takes everything available.
echo ', +' | sfdisk --no-reread --force -N 2 "$IMG" >/dev/null
attach_parts
e2fsck -fp "$LOOP_ROOT" >/dev/null 2>&1 || true
resize2fs "$LOOP_ROOT" >/dev/null
note "rootfs now $(dumpe2fs -h "$LOOP_ROOT" 2>/dev/null | awk -F: '/Block count/{c=$2} /Block size/{s=$2} END{printf "%.0f MiB", c*s/1048576}')"

# ── 3. mount ────────────────────────────────────────────────────────────────
say "mounting"
mkdir -p "$ROOT"
mount "$LOOP_ROOT" "$ROOT"
mkdir -p "$ROOT/boot/firmware"
mount "$LOOP_BOOT" "$ROOT/boot/firmware"

mount -t proc  proc  "$ROOT/proc"
mount -t sysfs sys   "$ROOT/sys"
mount --bind /dev     "$ROOT/dev"
mount --bind /dev/pts "$ROOT/dev/pts"

# The chroot needs working DNS for apt and npm.
cp -f "$ROOT/etc/resolv.conf" "$ROOT/etc/resolv.conf.orig" 2>/dev/null || true
printf 'nameserver 1.1.1.1\nnameserver 9.9.9.9\n' >"$ROOT/etc/resolv.conf"

# apt drops to the _apt user to fetch, and needs a world-writable /tmp to stage
# its apt-key config. On a booted Pi this never shows: DietPi mounts a tmpfs
# over /tmp, so the on-disk mode is invisible. In a chroot there is no tmpfs and
# apt fails every repo with "Couldn't create temporary file /tmp/apt.conf.XXXXXX
# ... is not signed", which reads like a GPG problem and is not one.
note "/tmp in image was mode $(stat -c '%a' "$ROOT/tmp" 2>/dev/null || echo 'absent')"
mkdir -p "$ROOT/tmp"
chmod 1777 "$ROOT/tmp"

# ── 4. stage the checkout ───────────────────────────────────────────────────
say "staging checkout"
APP_DIR=/opt/tesla-pi/app
mkdir -p "$ROOT$APP_DIR"
rsync -a --delete \
    --exclude '.git' --exclude 'node_modules' --exclude 'logs' \
    --exclude 'out' --exclude '.image-build' --exclude 'retroarch-test' \
    --exclude 'settings.local.json' --exclude 'TODO.md' \
    --exclude '*.local.txt' \
    "$REPO_DIR"/ "$ROOT$APP_DIR"/
note "staged $(du -sh "$ROOT$APP_DIR" | cut -f1)"

# A certificate bundle is passed in by path on the host; copy it somewhere the
# chroot can see, then remove it again afterwards.
CHROOT_CERT_DIR=""
if [[ -n ${CERT_BUNDLE_DIR:-} ]]; then
    [[ -d $CERT_BUNDLE_DIR ]] || die "CERT_BUNDLE_DIR=$CERT_BUNDLE_DIR is not a directory"
    CHROOT_CERT_DIR=/tmp/tesla-pi-cert
    mkdir -p "$ROOT$CHROOT_CERT_DIR"
    cp -f "$CERT_BUNDLE_DIR"/*.pem "$ROOT$CHROOT_CERT_DIR/" 2>/dev/null || true
    [[ -f $CERT_BUNDLE_DIR/version ]] && cp -f "$CERT_BUNDLE_DIR/version" "$ROOT$CHROOT_CERT_DIR/"
    chmod 0600 "$ROOT$CHROOT_CERT_DIR"/privkey.pem 2>/dev/null || true
fi

# ── 5. provision ────────────────────────────────────────────────────────────
if [[ ${SKIP_PROVISION:-0} == 1 ]]; then
say "SKIP_PROVISION=1 — chroot left unprovisioned (plumbing test only)"
chroot "$ROOT" /bin/bash -c 'echo "  chroot works: $(uname -m), $(grep PRETTY /etc/os-release | cut -d= -f2)"'
else
say "provisioning inside the chroot"
chroot "$ROOT" /usr/bin/env -i \
    PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin \
    HOME=/root LC_ALL=C.UTF-8 DEBIAN_FRONTEND=noninteractive \
    TESLAPI_WITH_RETROARCH="${TESLAPI_WITH_RETROARCH:-1}" \
    TESLAPI_SERVICE_USER="${TESLAPI_SERVICE_USER:-tesla-pi}" \
    TESLAPI_APP_DIR="$APP_DIR" \
    CERT_SYNC_TOKEN="${CERT_SYNC_TOKEN:-}" \
    CERT_BUNDLE_DIR="$CHROOT_CERT_DIR" \
    /bin/bash "$APP_DIR/image/provision.sh"
fi

[[ -n $CHROOT_CERT_DIR ]] && rm -rf "$ROOT$CHROOT_CERT_DIR"

# ── 6. boot-partition overlay ───────────────────────────────────────────────
say "boot-partition overlay"
# This is the only thing most owners will ever edit, so it goes on the FAT
# partition where Windows, macOS and Linux can all see it.
#
# tesla-pi.local.txt wins when it exists. It is gitignored, which is the point:
# baking your own hotspot credentials into the cards you flash must not mean
# committing them to a public repo, or shipping them to everyone who builds
# from it. Keep the tracked tesla-pi.txt blank.
OVERLAY="$REPO_DIR/image/overlay/boot"
BOOTCFG_SRC="$OVERLAY/tesla-pi.txt"
if [[ -f "$OVERLAY/tesla-pi.local.txt" ]]; then
    BOOTCFG_SRC="$OVERLAY/tesla-pi.local.txt"
    # Marks the artifact: this one carries the builder's own passwords in
    # cleartext on its FAT partition, so it is a card for you, not a release.
    LOCAL_BOOTCFG=1
    note "using tesla-pi.local.txt — personal build, DO NOT publish this image"
fi
install -m 0644 "$BOOTCFG_SRC" "$ROOT/boot/firmware/tesla-pi.txt"
install -m 0644 "$OVERLAY/README.txt" "$ROOT/boot/firmware/TESLA-PI-README.txt"
note "wrote tesla-pi.txt + TESLA-PI-README.txt"

# ── 7. strip per-device identity ────────────────────────────────────────────
say "stripping identity and build residue"
# Every card is flashed from this file. Anything host-specific left in it is
# either a privacy leak or a collision waiting to happen.
rm -f "$ROOT"/etc/ssh/ssh_host_*                       # regenerated on first boot
: >"$ROOT/etc/machine-id"                              # systemd regenerates at boot
rm -f "$ROOT/var/lib/dbus/machine-id"
rm -rf "$ROOT"/var/lib/tesla-pi/.firstboot-done        # make sure firstboot runs
rm -rf "$ROOT"/var/log/* "$ROOT"/var/tmp/* "$ROOT"/tmp/*
rm -f  "$ROOT"/root/.bash_history "$ROOT"/home/*/.bash_history
rm -f  "$ROOT"/var/lib/dhcp/* "$ROOT"/var/lib/dhcpcd/* 2>/dev/null || true
rm -rf "$ROOT"/var/lib/NetworkManager/*.lease "$ROOT"/etc/NetworkManager/system-connections/* 2>/dev/null || true
rm -rf "$ROOT"/var/lib/apt/lists/* "$ROOT"/var/cache/apt/archives/*.deb
rm -f  "$ROOT"/etc/wpa_supplicant/wpa_supplicant-wlan0-home.conf   # no builder's home Wi-Fi
if [[ -f "$ROOT/etc/resolv.conf.orig" ]]; then
    mv -f "$ROOT/etc/resolv.conf.orig" "$ROOT/etc/resolv.conf"
else
    printf '' >"$ROOT/etc/resolv.conf"
fi
# The staged checkout is a copy, not a clone, so there is no .git to leak.
rm -rf "$ROOT$APP_DIR/.git"

# Free space still holds whatever the deleted files left behind — apt archives,
# build objects, the purged kernel. That garbage compresses poorly, so xz would
# carry it in the download for no reason. Overwrite it with zeros first; dd is
# expected to fail with ENOSPC, that is the exit condition.
say "zeroing free space"
dd if=/dev/zero of="$ROOT/ZEROFILL" bs=4M status=none 2>/dev/null || true
rm -f "$ROOT/ZEROFILL"

sync
cleanup
trap - EXIT

# ── 8. shrink ───────────────────────────────────────────────────────────────
say "shrinking"
attach_parts
e2fsck -fp "$LOOP_ROOT" >/dev/null 2>&1 || true
resize2fs -M "$LOOP_ROOT" >/dev/null

BLOCK_COUNT="$(dumpe2fs -h "$LOOP_ROOT" 2>/dev/null | awk -F: '/^Block count/{gsub(/ /,"",$2); print $2}')"
BLOCK_SIZE="$(dumpe2fs -h "$LOOP_ROOT" 2>/dev/null | awk -F: '/^Block size/{gsub(/ /,"",$2); print $2}')"
[[ -n $BLOCK_COUNT && -n $BLOCK_SIZE ]] || die "could not read filesystem geometry"

# resize2fs -M leaves the filesystem 100% full. Give it room so the box is not
# wedged if first boot's resize fails for any reason.
SLACK_BLOCKS=$(( SLACK_MB * 1024 * 1024 / BLOCK_SIZE ))
TARGET_BLOCKS=$(( BLOCK_COUNT + SLACK_BLOCKS ))
resize2fs "$LOOP_ROOT" "${TARGET_BLOCKS}" >/dev/null
e2fsck -fp "$LOOP_ROOT" >/dev/null 2>&1 || true
detach_parts

FS_BYTES=$(( TARGET_BLOCKS * BLOCK_SIZE ))
ROOT_START="$(part_field 2 start)"
# Round the partition up to a whole MiB so the table stays tidy.
NEW_SECTORS=$(( ( (FS_BYTES + 1048575) / 1048576 ) * 2048 ))
note "rootfs -> $(( FS_BYTES / 1048576 )) MiB, partition -> $(( NEW_SECTORS / 2048 )) MiB"

echo "start=${ROOT_START}, size=${NEW_SECTORS}" | sfdisk --no-reread --force -N 2 "$IMG" >/dev/null
truncate -s $(( (ROOT_START + NEW_SECTORS) * 512 )) "$IMG"

# ── 9. package ──────────────────────────────────────────────────────────────
say "packaging"
VERSION="$(node -p "require('$REPO_DIR/package.json').version" 2>/dev/null \
           || sed -n 's/.*"version"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' "$REPO_DIR/package.json" | head -1)"
VERSION="${VERSION:-0.0.0}"
STAMP="$(date -u +%Y%m%d)"
NAME="tesla-pi-${VERSION}-${STAMP}"
[[ "${TESLAPI_WITH_RETROARCH:-1}" == 1 ]] || NAME="${NAME}-carplay-only"
# Provenance in the filename, so a personal build can't be mistaken for a
# release artifact once it is sitting in out/ next to the real ones. An `if`,
# not `[[ ]] &&` — under `set -e` a false test there would abort the build.
if [[ "${LOCAL_BOOTCFG:-0}" == 1 ]]; then NAME="${NAME}-local"; fi

cp -f "$IMG" "$OUT_DIR/$NAME.img"
note "raw image $(du -h "$OUT_DIR/$NAME.img" | cut -f1)"

rm -f "$OUT_DIR/$NAME.img.xz"
# -9 needs ~700 MB of RAM per thread, so on a memory-capped builder (Docker
# Desktop's VM, for one) xz silently drops to a single thread and takes far
# longer than the rest of the build put together. Override with e.g.
# XZ_OPTS='-6 -T0' to trade a few percent of ratio for wall-clock.
# shellcheck disable=SC2086
xz ${XZ_OPTS:--9 -T0} --keep "$OUT_DIR/$NAME.img"
[[ $KEEP_RAW == 1 ]] || rm -f "$OUT_DIR/$NAME.img"

( cd "$OUT_DIR" && sha256sum "$NAME.img.xz" >"$NAME.img.xz.sha256" )

say "done"
cat <<EOF

  $OUT_DIR/$NAME.img.xz   ($(du -h "$OUT_DIR/$NAME.img.xz" | cut -f1))
  $OUT_DIR/$NAME.img.xz.sha256

  Flash with Raspberry Pi Imager (choose "Use custom"), Balena Etcher, or dd.
  Before ejecting, edit tesla-pi.txt on the boot partition to set your Wi-Fi
  country — everything else has a working default.

EOF
