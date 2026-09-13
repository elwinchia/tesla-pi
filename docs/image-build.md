# Building the flashable image

How `tesla-pi-<version>-<date>.img.xz` is produced — the thing an adopter burns
to an SD card and plugs into a Pi.

If you only want to *use* an image, you do not need this document. Download a
release, flash it, and read `TESLA-PI-README.txt` on the boot partition.

---

## What the image is

A stock **DietPi RPi234 ARMv8 Bookworm** image with `docs/setup-guide.md` steps
2–12 already applied, plus a first-boot pass for the things that cannot be baked
into a file every user flashes identically.

```
image/
  build-image.sh          host side: fetch, grow, chroot, strip, shrink, xz
  build-in-docker.sh      wrapper so the above runs on macOS
  provision.sh            setup-guide steps 2-12, executed instead of typed
  firstboot/
    tesla-pi-firstboot.sh per-device setup, runs once on the real hardware
  overlay/boot/
    tesla-pi.txt          the owner's config file, on the FAT partition
    tesla-pi.local.txt    optional, gitignored — your filled-in copy of the above
    README.txt            what they see when they mount the card
```

If `overlay/boot/tesla-pi.local.txt` exists, the build ships that instead of the
blank `tesla-pi.txt`. Use it to bake your own hotspot credentials, Wi-Fi country
and home Wi-Fi into the cards you flash. It is gitignored, so those never reach
the repo — and the tracked `tesla-pi.txt` stays blank for everyone else.

The split matters:

| | runs | decides |
|---|---|---|
| `provision.sh` | at build time, in a chroot | everything identical on every card |
| `tesla-pi-firstboot.sh` | once, on the owner's Pi | everything that must differ per device or per owner |

Anything that ends up in `provision.sh` is shared by every user in the world.
Host keys, hotspot names, Wi-Fi country and passwords therefore belong in
first-boot, not the image.

---

## Building

### On Linux

```bash
sudo ./image/build-image.sh
```

Requires root (loop devices, chroot) and an **arm64** host — provisioning runs
`npm`, `node-gyp` and dpkg maintainer scripts *out of the image*. On x86_64 it
works only with `qemu-user-static` binfmt handlers registered, and it is slow.

### On macOS

```bash
./image/build-in-docker.sh
```

Docker Desktop on Apple silicon runs an arm64 Linux VM, so the container is the
same architecture as the image — no emulation, full speed. The script installs
its own tools inside the container and calls `build-image.sh`.

If your host cannot reach Docker Hub, point it at any Debian/Ubuntu arm64 image
you already have:

```bash
BUILDER_IMAGE=some/cached-debian-arm64 ./image/build-in-docker.sh
```

### In CI

`.github/workflows/build-image.yml` runs on `ubuntu-24.04-arm` (native arm64,
free for public repositories) on any `v*` tag, and attaches the result to the
GitHub Release.

It is deliberately **not** triggered by `pull_request`: the job handles
`CERT_SYNC_TOKEN` and the shared certificate's private key, and a fork PR must
never reach either.

### Knobs

| Env | Default | Meaning |
|---|---|---|
| `TESLAPI_WITH_RETROARCH` | `1` | include the native RetroArch addon |
| `CERT_SYNC_TOKEN` | — | bearer token baked into `/etc/default/tesla-pi` (0600) |
| `CERT_BUNDLE_DIR` | — | directory holding `fullchain.pem` / `privkey.pem` |
| `GROW_MB` | `4096` | working headroom added before provisioning |
| `SLACK_MB` | `192` | free space left in the shipped image |
| `BASE_URL` / `BASE_SHA256` | DietPi RPi234 | base image and its pinned checksum |
| `XZ_OPTS` | `-9 -T0` | compression. `-9` wants ~700 MB RAM per thread, so a memory-capped builder silently drops to one thread and packaging dominates the build. `-6 -T0` is much faster for a few percent of ratio. |
| `SKIP_PROVISION` | `0` | exercise the plumbing without installing anything |

### Image size

With the RetroArch addon the rootfs lands around 3.7 GiB (`retroarch-assets`
alone is 113 MB, plus Qt). `TESLAPI_WITH_RETROARCH=0` cuts that substantially.

A further win is available and **not yet implemented**: `build-essential`, `git`
and the kernel headers exist only so `npm ci` can compile the native `usb`
module, and could be purged afterwards. That would cost the ability to rebuild
native modules on-device after a `git pull`, so it needs a decision rather than
a default.

---

## What the build does to a stock DietPi image

Stock DietPi is *not* the system `docs/setup-guide.md` assumes. Four things
differ, and provisioning fixes each:

1. **`.install_stage` is `-1`** — "this image has never booted", which makes
   `dietpi-firstboot.service` run DietPi's own interactive installer. The build
   sets it to `2` (installed) and takes that unit out of the boot path.
2. **Networking is `ifupdown`, not NetworkManager.** `scripts/ap-mode.sh` and
   `scripts/tesla-pi-wifi` are written entirely against `nmcli`. The build
   installs NetworkManager, disables `networking.service`, and bakes the
   `unmanaged-devices=interface-name:wlan0` rule so the AP survives a cold boot
   without anyone running `ap-mode.sh` first.
3. **dropbear SSH is enabled** with a documented default password. Behind an AP
   whose shipped password is `12345678`, that turns "guessed the Wi-Fi" into
   "root on the box". The build purges dropbear and installs OpenSSH *disabled*.
4. **No `dtoverlay=vc4-kms-v3d`** in `config.txt`. cage/wlroots needs a DRM
   node, so the RetroArch addon has nothing to open without it.

It also strips everything host-specific before packaging: SSH host keys,
`machine-id`, DHCP leases, NetworkManager connection profiles, logs, shell
history, apt lists, and any `wpa_supplicant-wlan0-home.conf` the builder had.

---

## First boot on the owner's Pi

`tesla-pi-firstboot.service` runs once, ordered before `wlan0-ap-up.service` and
`hostapd.service` because it writes the config those consume. It:

- regenerates SSH host keys,
- derives a hotspot name from the Pi's serial (`Tesla-Pi-A3F1`) so two boxes in
  one car park do not collide,
- runs `scripts/ap-radio-select.sh` to choose a channel the owner's regulatory
  domain actually permits,
- applies `tesla-pi.txt` (country, hotspot credentials, home Wi-Fi, SSH),
- grows the root filesystem to fill the card,
- blanks the passwords out of `tesla-pi.txt`, because that partition is FAT and
  readable by anyone holding the card,
- stamps `/var/lib/tesla-pi/.firstboot-done` and does not run again.

To re-apply an edited `tesla-pi.txt`, delete that stamp and reboot.

### Why the radio is chosen at first boot

`conf/hostapd.conf.template` ships channel 149 (UNII-3). That is fine in MY/US
and forbidden across most of the EU — and hostapd does not degrade when handed a
channel its regdomain rejects, it **exits**. On an appliance with no screen, no
keyboard and no SSH, a hostapd that exits is a brick, because the only way in is
the AP it just failed to start.

So `ap-radio-select.sh` sets the regulatory domain, asks the kernel which
channels it will actually let us beacon on, and picks the best available:
80 MHz UNII-3 → 80 MHz UNII-1 → any single 5 GHz channel → 2.4 GHz. DFS channels
are refused deliberately: the mandatory availability check stalls the AP for a
minute on every start, and a radar event would bounce the car off the hotspot
mid-drive.

A blank or wrong `COUNTRY` therefore costs speed, not function.

---

## Release checklist

The cert service must be live before an image is worth publishing — see
`docs/turnkey-shared-domain-plan.md` and `infra/cert-service/README.md`. Without
it `provision.sh` falls back to a **self-signed placeholder** that the Tesla
browser will refuse, and `cert-sync.sh` has nothing to talk to.

1. Cert service deployed, first certificate issued and in KV.
2. Repository secrets set: `CERT_SYNC_URL`, `CERT_SYNC_TOKEN`.
3. Repository variable `DIETPI_BASE_SHA256` pinned to the base image you tested.
4. Tag `vX.Y.Z` and push. CI builds and attaches the image.
5. Flash the published artifact to a real card and run the smoke test below.

### Smoke test on real hardware

- [ ] Boots to a hotspot named `Tesla-Pi-XXXX` within ~2 minutes
- [ ] `df -h /` shows the filesystem grew to the card's size
- [ ] Tesla joins and does **not** drop the SSID after a few seconds
- [ ] `https://device.tesla-pi.humblebees.co` loads with no certificate warning
- [ ] CarPlay pairs and video + touch work
- [ ] Settings → Hotspot shows the default-password banner, and changing the
      password works and survives a reboot
- [ ] A second card from the same image gets a *different* SSID suffix and
      different SSH host keys
- [ ] With `COUNTRY=DE` set, the box still brings up an AP (on 2.4 GHz or a
      permitted 5 GHz channel) rather than no AP at all
