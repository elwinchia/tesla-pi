#!/usr/bin/env bash
# Remove the split-screen dock from the test Pi and pin CarPlay to full screen.
#
# Replaces scripts/deploy-split-screen.sh. The dock, its layout switcher, both
# ✕ close buttons and the "Beside CarPlay" tile chips are gone from the page;
# the server's carplayClose/carplayOpen handlers are gone with them. CarPlay,
# Games and Karaoke each take the whole screen.
#
# The Pi browns out and loses accessory power with the car, so this waits for
# it rather than failing, then verifies what it pushed instead of assuming.
#
#   PI=10.0.0.42 ./scripts/deploy-fullscreen.sh # wait up to 30 min, deploy
#   WAIT_S=0 ./scripts/deploy-fullscreen.sh     # fail immediately if it is down
set -euo pipefail

PI="${PI:?set PI=<device address or hostname>}"
USER_AT="${USER_AT:-tesla-pi}"
DEST="${DEST:-/home/$USER_AT/tesla-pi}"
WAIT_S="${WAIT_S:-1800}"
SSH_OPTS=(-o ConnectTimeout=8 -o BatchMode=yes -o StrictHostKeyChecking=accept-new)
REPO="$(cd "$(dirname "$0")/.." && pwd)"

say() { printf '\033[1m==>\033[0m %s\n' "$*"; }

# ── wait for it ──────────────────────────────────────────────────────────
say "waiting for $PI (up to ${WAIT_S}s)"
deadline=$(( $(date +%s) + WAIT_S ))
until ssh "${SSH_OPTS[@]}" "$USER_AT@$PI" true 2>/dev/null; do
    if [[ $(date +%s) -ge $deadline ]]; then
        echo "  $PI never came up — nothing was deployed." >&2
        exit 1
    fi
    sleep 10
done
say "$PI is up (uptime $(ssh "${SSH_OPTS[@]}" "$USER_AT@$PI" 'cut -d" " -f1 /proc/uptime')s)"

# ── push ─────────────────────────────────────────────────────────────────
say "rsync static/index.html + static/worker.js + index.js"
rsync -az "$REPO/static/index.html" "$USER_AT@$PI:$DEST/static/"
# The decoder worker. It holds the first-frame announcement the page waits on to
# lift its loading card, so a stale copy here means CarPlay renders under a card
# that never goes away on the second visit — see docs/carplay-on-demand.md.
rsync -az "$REPO/static/worker.js"  "$USER_AT@$PI:$DEST/static/"
rsync -az "$REPO/index.js"          "$USER_AT@$PI:$DEST/"

# Served by nginx from /etc/nginx (see conf/nginx-karaoke.conf), not from the
# repo, so it needs its own hop. The Back button is unconditional again now
# that nothing renders Nightingale in a frame. no-cache is already set on that
# location, so nothing needs reloading.
say "karaoke-inject.js (Back button unconditional again)"
rsync -az "$REPO/conf/karaoke-inject.js" "$USER_AT@$PI:/tmp/karaoke-inject.js.new"
ssh "${SSH_OPTS[@]}" "$USER_AT@$PI" '
  if [[ -f /etc/nginx/karaoke-inject.js ]]; then
    sudo cp /tmp/karaoke-inject.js.new /etc/nginx/karaoke-inject.js
    echo "  updated /etc/nginx/karaoke-inject.js"
  else
    echo "  karaoke addon not installed here — skipped"
  fi
  rm -f /tmp/karaoke-inject.js.new'

# The persisted aspect outranks the new DEFAULT_ASPECT for any Pi that was ever
# switched to wide. Nothing in the UI can switch it back now, so pin it here.
say "pin persisted aspect to full"
ssh "${SSH_OPTS[@]}" "$USER_AT@$PI" "
  f=$DEST/settings.local.json
  if [[ -f \"\$f\" ]]; then
    cp \"\$f\" \"\$f.bak.\$(date +%s)\"
    python3 - \"\$f\" <<'PY'
import json, sys
p = sys.argv[1]
j = json.load(open(p))
was = j.get('aspect')
j['aspect'] = 'full'
json.dump(j, open(p, 'w'), indent=2)
print('  aspect: %s -> full' % (was or '(unset)'))
PY
  else
    echo '  no settings.local.json yet — DEFAULT_ASPECT=full applies'
  fi"

# ── restart + verify ─────────────────────────────────────────────────────
say "restart tesla-pi.service"
ssh "${SSH_OPTS[@]}" "$USER_AT@$PI" 'sudo systemctl restart tesla-pi.service'
sleep 4

# Counts must be ZERO — this deploy is a removal, so absence is the assertion.
say "verify"
ssh "${SSH_OPTS[@]}" "$USER_AT@$PI" "
  cd $DEST
  echo \"  service:         \$(systemctl is-active tesla-pi.service)\"
  echo \"  page:            HTTP \$(curl -sk -o /dev/null -w '%{http_code}' https://127.0.0.1/ 2>/dev/null || curl -s -o /dev/null -w '%{http_code}' http://127.0.0.1/)\"
  echo \"  dock rail:       \$(grep -c 'id=\"dock-rail\"' static/index.html) (want 0)\"
  echo \"  close buttons:   \$(grep -c 'class=\"close-btn\"' static/index.html) (want 0)\"
  echo \"  split chips:     \$(grep -c 'data-split-app' static/index.html) (want 0)\"
  echo \"  close in server: \$(grep -c 'carplayClose' index.js) (want 0)\"
  echo \"  expectFrame:     \$(grep -c expectFrame static/worker.js) + \$(grep -c expectFrame static/index.html) (want 1 + 1)\"
  echo \"  boot line:\"
  journalctl -u tesla-pi.service -b -n 200 --no-pager -o cat 2>/dev/null | grep -o '\"evt\":\"boot\".*' | tail -1
  # carplay_failure is emitted on every clean release too (releaseDongle kills
  # the reader, so transferIn ends with NO_DEVICE). Counting it reports ~39 of
  # 57 weekly \"errors\" that are just normal hand-backs — see
  # docs/carplay-on-demand.md. Count real errors only.
  echo \"  errors since restart: \$(journalctl -u tesla-pi.service --since '-2 min' --no-pager 2>/dev/null | grep '\\\"level\\\":\\\"error\\\"' | grep -vc 'carplay_failure')\"
"
say "done — CarPlay should come up full screen, 1920x1496"
