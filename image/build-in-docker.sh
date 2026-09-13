#!/bin/bash
# build-in-docker.sh — run image/build-image.sh inside a privileged container.
#
# The build needs loop devices, mount and chroot, none of which macOS provides.
# Docker Desktop on Apple silicon runs an arm64 Linux VM, so the container is
# the same architecture as the image: no qemu, no emulation, full speed.
#
#   ./image/build-in-docker.sh
#   CERT_SYNC_TOKEN=... CERT_BUNDLE_DIR=./certs ./image/build-in-docker.sh
#
# Env:
#   BUILDER_IMAGE   base container image (default debian:bookworm). Any Debian
#                   or Ubuntu arm64 image works — override it if your host
#                   cannot reach Docker Hub but has something suitable cached.
#   Everything build-image.sh understands is passed through.

set -euo pipefail

REPO_DIR="$(cd "$(dirname "$0")/.." && pwd)"
BUILDER_IMAGE="${BUILDER_IMAGE:-debian:bookworm}"

command -v docker >/dev/null 2>&1 || { echo "docker is not installed" >&2; exit 1; }

ARCH="$(docker version --format '{{.Server.Arch}}' 2>/dev/null || echo unknown)"
if [[ $ARCH != arm64 && $ARCH != aarch64 ]]; then
    cat >&2 <<EOF
warning: the Docker engine reports arch '$ARCH', not arm64.

The image is arm64 and provisioning executes binaries from inside it. On a
non-arm64 engine this only works if qemu-user-static binfmt handlers are
registered in the VM, e.g.:

    docker run --privileged --rm tonistiigi/binfmt --install arm64

Continuing anyway.
EOF
fi

# --privileged for loop devices; the repo is bind-mounted so the finished image
# lands in ./out on the host.
exec docker run --rm -it \
    --privileged \
    -v /dev:/dev \
    -v "$REPO_DIR:/repo" \
    -w /repo \
    -e TESLAPI_WITH_RETROARCH="${TESLAPI_WITH_RETROARCH:-1}" \
    -e TESLAPI_SERVICE_USER="${TESLAPI_SERVICE_USER:-tesla-pi}" \
    -e CERT_SYNC_TOKEN="${CERT_SYNC_TOKEN:-}" \
    -e CERT_BUNDLE_DIR="${CERT_BUNDLE_DIR:-}" \
    -e BASE_URL="${BASE_URL:-}" \
    -e BASE_SHA256="${BASE_SHA256:-}" \
    -e GROW_MB="${GROW_MB:-}" \
    -e SLACK_MB="${SLACK_MB:-}" \
    -e KEEP_RAW="${KEEP_RAW:-0}" \
    --entrypoint /bin/bash \
    "$BUILDER_IMAGE" -c '
set -e
export DEBIAN_FRONTEND=noninteractive
apt-get update -qq
apt-get install -y -qq --no-install-recommends \
    util-linux e2fsprogs fdisk xz-utils curl ca-certificates rsync coreutils
# Stale loop devices survive in the Docker VM between runs and would make the
# next resize silently operate on the wrong offsets.
losetup -D 2>/dev/null || true
exec /repo/image/build-image.sh
'
