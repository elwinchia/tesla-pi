#!/usr/bin/env bash
# Set CARPLAY_WIDE_HEIGHT on the test Pi and restart, then prove it took.
#
# 840 (the default) makes this dongle drop off the USB bus repeatedly — measured
# 2026-09-02: 3 start_failed / 4 carplay_failure / 8 usb_read_error in 30 min of
# wide, against 0/0/0 for full in the same window. This is the knob for bisecting
# a height it will actually hold. Candidates, all multiples of 16:
#
#   848 -> 521 px band, 398 px dock   880 -> 541/378   960 -> 590/329 (16:8)
#
# The Pi loses power with the car, so this waits for it rather than failing.
#
#   PI=10.0.0.42 ./scripts/set-wide-height.sh 848
#   WAIT_S=0 PI=10.0.0.42 ./scripts/set-wide-height.sh 960   # fail now if it is down
set -euo pipefail

H="${1:?usage: set-wide-height.sh <height>   e.g. 848}"
[[ "$H" =~ ^[0-9]+$ ]] || { echo "height must be a number" >&2; exit 1; }
(( H % 16 == 0 )) || echo "note: $H is not a multiple of 16 (840 was not either, and it failed)"

PI="${PI:?set PI=<device address or hostname>}"
USER_AT="${USER_AT:-tesla-pi}"
WAIT_S="${WAIT_S:-1800}"
SSH_OPTS=(-o ConnectTimeout=8 -o BatchMode=yes -o StrictHostKeyChecking=accept-new)
say() { printf '\033[1m==>\033[0m %s\n' "$*"; }

say "waiting for $PI (up to ${WAIT_S}s)"
deadline=$(( $(date +%s) + WAIT_S ))
until ssh "${SSH_OPTS[@]}" "$USER_AT@$PI" true 2>/dev/null; do
    if [[ $(date +%s) -ge $deadline ]]; then
        echo "  $PI never came up — nothing changed." >&2; exit 1
    fi
    sleep 10
done

say "setting CARPLAY_WIDE_HEIGHT=$H"
ssh "${SSH_OPTS[@]}" "$USER_AT@$PI" "
  set -e
  F=/etc/default/tesla-pi
  sudo touch \"\$F\"
  sudo cp \"\$F\" \"\$F.bak.\$(date +%s)\"
  # idempotent: drop any previous setting, then append the new one
  sudo sed -i '/^CARPLAY_WIDE_HEIGHT=/d' \"\$F\"
  echo 'CARPLAY_WIDE_HEIGHT=$H' | sudo tee -a \"\$F\" >/dev/null
  echo '  now:'; sudo grep -n CARPLAY_WIDE_HEIGHT \"\$F\" | sed 's/^/    /'
"

say "restart + verify"
ssh "${SSH_OPTS[@]}" "$USER_AT@$PI" '
  sudo systemctl restart tesla-pi.service
  sleep 4
  echo "  service: $(systemctl is-active tesla-pi.service)"
  echo -n "  boot:    "
  journalctl -u tesla-pi.service -b -n 200 --no-pager -o cat 2>/dev/null | grep -o "\"evt\":\"boot\".*" | tail -1
'
say "done — switch to split in the car and watch for start_failed / usb_read_error"
