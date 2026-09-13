#!/bin/bash
# Shared service-user resolution for the installers:
#
#   scripts/install-ap-tab.sh          scripts/install-retroarch-addon.sh
#   scripts/install-wifi-tab.sh        scripts/install-karaoke-addon.sh
#   scripts/install-power-tab.sh       scripts/install-dongle-tab.sh
#
# Sourced, never executed.
#
# Why this exists: every installer used to hardcode `${TESLAPI_SERVICE_USER:-tesla-pi}`.
# That default is right for a device built by image/provision.sh — which creates
# the `tesla-pi` account — but wrong for a hand-built box whose tesla-pi.service
# runs as some other account. There the installers would write a unit and a
# sudoers entry for a user that does not exist, which fails preflight at best and
# installs a dead grant at worst. The account the app already runs as is knowable,
# so ask instead of guessing.

# resolve_service_user — print the account that owns the app on THIS device.
#
# In priority order:
#   1. $TESLAPI_SERVICE_USER when set. The explicit contract image/provision.sh
#      and image/build-image.sh already pass down, and the escape hatch for
#      someone who knows better than the checks below.
#   2. The User= of the installed tesla-pi.service. On a device already running
#      the app this is the only answer that can be right.
#   3. tesla-pi — the account image/provision.sh creates, and the correct answer
#      on a fresh image where nothing is installed yet.
resolve_service_user() {
    if [[ -n "${TESLAPI_SERVICE_USER:-}" ]]; then
        printf '%s\n' "$TESLAPI_SERVICE_USER"
        return
    fi

    local u=""
    # Ask systemd first, but only when it is actually running: inside the image
    # build chroot systemctl exists as a binary with nothing to talk to.
    if [[ -d /run/systemd/system ]] && command -v systemctl >/dev/null 2>&1; then
        u="$(systemctl show tesla-pi.service -p User --value 2>/dev/null || true)"
    fi

    # Fall back to reading the unit directly, which also covers the chroot and
    # the case where the unit exists but systemd has not loaded it yet.
    if [[ -z "$u" ]]; then
        u="$(sed -n 's/^User=//p' /etc/systemd/system/tesla-pi.service 2>/dev/null | head -1)"
    fi

    # An unrendered template means the unit was copied but never substituted;
    # treat it as no answer rather than trying to create a user called
    # __TESLAPI_USER__.
    [[ "$u" == "__TESLAPI_USER__" ]] && u=""

    printf '%s\n' "${u:-tesla-pi}"
}
