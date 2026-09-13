#!/bin/bash
# test-dongle-helper.sh — offline test for tesla-pi-dongle's target filter.
#
# The filter is the safety boundary: it decides which block devices the sudo
# grant is willing to mount and write to. Getting it wrong means writing over
# the machine's own card, so it is tested against a tree that contains exactly
# the things it must refuse — the boot partition, the root partition, a fixed
# internal disk, and a removable drive with the wrong filesystem — alongside the
# one thing it should accept.
#
# Runs anywhere: `lsblk` is stubbed with a fixture, and only the `targets` verb
# is exercised (`write` needs a real kernel and real root).
#
# Run: bash scripts/test-dongle-helper.sh

set -uo pipefail

HELPER="$(cd "$(dirname "$0")" && pwd)/tesla-pi-dongle"
[[ -r "$HELPER" ]] || { echo "missing $HELPER"; exit 1; }

TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

pass=0; fail=0
ok() { if [[ "$2" == "$3" ]]; then echo "  ok   $1"; pass=$((pass+1));
       else echo "  FAIL $1"; echo "        want: $3"; echo "        got:  $2"; fail=$((fail+1)); fi; }

# A believable Pi: SD card carrying /boot/firmware and /, one USB stick, one
# removable ext4 drive, one fixed internal disk. lsblk emits booleans here (new
# util-linux); the "0"/"1" string form is covered by the second fixture below.
cat > "$TMP/tree.json" <<'JSON'
{"blockdevices":[
 {"name":"mmcblk0","path":"/dev/mmcblk0","pkname":null,"size":31000000000,"fstype":null,"label":null,"mountpoint":null,"rm":false,"hotplug":false,"type":"disk","children":[
   {"name":"mmcblk0p1","path":"/dev/mmcblk0p1","pkname":"mmcblk0","size":536870912,"fstype":"vfat","label":"bootfs","mountpoint":"/boot/firmware","rm":false,"hotplug":false,"type":"part"},
   {"name":"mmcblk0p2","path":"/dev/mmcblk0p2","pkname":"mmcblk0","size":30000000000,"fstype":"ext4","label":"rootfs","mountpoint":"/","rm":false,"hotplug":false,"type":"part"}]},
 {"name":"sda","path":"/dev/sda","pkname":null,"size":8004304896,"fstype":null,"label":null,"mountpoint":null,"rm":true,"hotplug":true,"type":"disk","children":[
   {"name":"sda1","path":"/dev/sda1","pkname":"sda","size":8000000000,"fstype":"vfat","label":"USBSTICK","mountpoint":"","rm":false,"hotplug":false,"type":"part"}]},
 {"name":"sdb","path":"/dev/sdb","pkname":null,"size":500000000000,"fstype":null,"label":null,"mountpoint":null,"rm":true,"hotplug":true,"type":"disk","children":[
   {"name":"sdb1","path":"/dev/sdb1","pkname":"sdb","size":500000000000,"fstype":"ext4","label":"BACKUP","mountpoint":"","rm":false,"hotplug":false,"type":"part"}]},
 {"name":"sdc","path":"/dev/sdc","pkname":null,"size":250000000000,"fstype":null,"label":null,"mountpoint":null,"rm":false,"hotplug":false,"type":"disk","children":[
   {"name":"sdc1","path":"/dev/sdc1","pkname":"sdc","size":250000000000,"fstype":"vfat","label":"FIXED","mountpoint":"","rm":false,"hotplug":false,"type":"part"}]}
]}
JSON

# Same tree, flags as the "0"/"1" strings older util-linux emits. bool("0") is
# True in Python, so this fixture is what stops that bug coming back.
sed -e 's/:true/:"1"/g' -e 's/:false/:"0"/g' "$TMP/tree.json" > "$TMP/tree-strings.json"

mkdir -p "$TMP/bin"
cat > "$TMP/bin/lsblk" <<EOF
#!/bin/bash
cat "\$LSBLK_FIXTURE"
EOF
chmod +x "$TMP/bin/lsblk"
export PATH="$TMP/bin:$PATH"

devices_of() {
    LSBLK_FIXTURE="$1" bash "$HELPER" targets \
        | python3 -c 'import json,sys; d=json.load(sys.stdin); print(",".join(t["device"] for t in d.get("targets",[])) if d.get("ok") else "ERR:"+str(d.get("error")))'
}

echo "target filter"
ok "accepts only the removable FAT stick"        "$(devices_of "$TMP/tree.json")"         "/dev/sda1"
ok "same result when flags are 0/1 strings"      "$(devices_of "$TMP/tree-strings.json")" "/dev/sda1"

# Each exclusion asserted on its own, so a future change that breaks one is not
# masked by another still passing.
out="$(devices_of "$TMP/tree.json")"
ok "never offers the boot partition"   "$(grep -c mmcblk0p1 <<<"$out")" "0"
ok "never offers the root partition"   "$(grep -c mmcblk0p2 <<<"$out")" "0"
ok "skips removable but not FAT"       "$(grep -c sdb1 <<<"$out")"      "0"
ok "skips FAT but not removable"       "$(grep -c sdc1 <<<"$out")"      "0"
ok "never offers a whole disk"         "$(grep -c '/dev/sda,' <<<"$out,")" "0"

echo '{"blockdevices":[]}' > "$TMP/empty.json"
ok "an empty tree is an empty list, not an error" "$(devices_of "$TMP/empty.json")" ""

echo "argument grammar"
# The write verb's guards run before anything is touched, so they are testable
# without root: each of these must die on validation, not on mount.
err_of() {
    LSBLK_FIXTURE="$TMP/tree.json" bash "$HELPER" write "$1" "$2" "$3" 2>/dev/null \
        | python3 -c 'import json,sys; print(json.load(sys.stdin).get("error",""))' 2>/dev/null
}
ok "rejects a path in the image name"     "$(err_of '../../etc/passwd.img' '/dev/sda1' 'A15W_Update.img')" "bad_image_name"
ok "rejects a non-.img image name"        "$(err_of 'payload.sh'           '/dev/sda1' 'A15W_Update.img')" "bad_image_name"
ok "rejects a path in the dest name"      "$(err_of 'x.img' '/dev/sda1' '../../../boot/config.img')"       "bad_dest_name"
ok "rejects the SD card by grammar"       "$(err_of 'x.img' '/dev/mmcblk0p1' 'A15W_Update.img')"           "bad_device"
ok "rejects a whole disk"                 "$(err_of 'x.img' '/dev/sda'       'A15W_Update.img')"           "bad_device"
ok "rejects a device outside /dev"        "$(err_of 'x.img' '/tmp/evil'      'A15W_Update.img')"           "bad_device"
# Grammar passes here, so it gets as far as looking for the file — which proves
# the source directory is the hardcoded one and not anything the caller chose.
ok "a well-formed but absent image stops" "$(err_of 'x.img' '/dev/sda1' 'A15W_Update.img')"                "image_missing"

echo
echo "$pass passed, $fail failed"
[[ $fail -eq 0 ]]
