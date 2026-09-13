# Pi 4 migration plan (5 GHz AP for higher-resolution CarPlay)

**Status**: ✅ **completed (2026)** — the stack now runs on a Pi 4 with the
5 GHz AP; see `docs/resolution-tuning.md` for the current bench settings.
Kept for the record. Original framing: recipe for migrating the working
Pi Zero 2 W stack onto a Pi 4 4 GB if/when bandwidth on the Zero's
2.4 GHz radio becomes the limiting factor for the desired resolution.

## Why migrate

Verified on the bench (2026-05-04):

- At `1440 × 1120` the Pi → Tesla stream is **~15.5 Mbps**. On the Pi
  Zero 2 W's single-stream 2.4 GHz Cypress CYW43438, that's near the
  practical ceiling on contested home Wi-Fi (frame stutter / lag).
  In-car (TeslaCP single-client) the same link should be fine, but
  there's no headroom to bump resolution further.
- iOS does shrink the CarPlay home-grid when total pixels cross an
  internal threshold (verified: `1180×919 → 2×4 grid`,
  `1440×1120 → 3×4 grid`). To keep growing the grid (e.g. to chase a
  3×5 layout) we need to push more pixels, which the Zero's radio
  cannot carry comfortably.
- Pi 4's Cypress CYW43455 supports **5 GHz 802.11ac AP mode** with
  practical throughput of 150–300 Mbps. Removes the bandwidth ceiling
  permanently.

## Why **not** migrate (read first)

1. **Burns the fallback.** `plan.md:54` keeps the Pi 4 + Tesla-Android
   image as a known-good rollback for ≥4 weeks of stable use. Migrate
   only after the Zero 2 W stack has banked that reliability *or*
   after buying a second Pi 4 / spare SD card.
2. **In-car heat.** Pi 4 idles ~50 °C, pulls 3–4 W. Pi Zero 2 W idles
   ~44 °C, pulls 1.5–2 W. Malaysian dashboard sun sits at 60–70 °C
   ambient (`plan.md:331`); throttle threshold for both boards is
   80 °C. Pi 4 has less margin.
3. **Cold-boot regression.** Pi 4 DietPi boots ~25–30 s vs measured
   15.6 s on the Zero 2 W (`plan.md:212`). Probably blows the <20 s
   target unless we also do read-only rootfs (Phase 6 territory).
4. **Phase 3 partial redo.** hostapd / dnsmasq / iptables / nginx /
   cert-renewal carry over verbatim **except** for hostapd band &
   channel. Driveway smoke test must be re-run.

If the in-car experience on the Zero 2 W is fine at the resolution you
care about, skip this migration. Switch only if you've measured a real
in-car bandwidth deficit, not just a home-Wi-Fi one.

## What carries over verbatim

No changes needed to any of these:

- `tesla-pi/index.js`, `tesla-pi/static/*` — node-carplay@4
  app code, frontend, worker
- `tesla-pi/systemd/tesla-pi.service`
- `/etc/udev/rules.d/52-nodecarplay.rules` (CarLinkit USB rule)
- `tesla-pi/conf/dnsmasq.conf` (DHCP + DNS wildcard)
- `tesla-pi/conf/iptables.ipv4.nat` (DNAT 240.3.3.4 → AP IP)
- `tesla-pi/conf/sysctl-ip-forward.conf`
- `tesla-pi/conf/nginx-carplay.conf` — including the
  `connman.vn.tesla.services` server block from
  `captive-bypass-troubleshooting.md`
- LE cert + Cloudflare DNS-01 renewal flow
  (`scripts/cert-renew-watch.sh`, the wpa_supplicant/cloudflare
  templates)
- Audio routing (dongle NV "phone audio" mode → iPhone BT → Tesla)

The CarLinkit dongle protocol layer is host-agnostic. Anything above
the network/AP layer ports as-is.

## What changes

### 1. `tesla-pi/conf/hostapd.conf`

Move from 2.4 GHz channel 6 to 5 GHz channel 36 (UNII-1, no DFS,
allowed in MY). Approximate diff:

```diff
-hw_mode=g
-channel=6
-ieee80211n=1
+hw_mode=a
+channel=36
+ieee80211n=1
+ieee80211ac=1
+vht_oper_chwidth=1          # 80 MHz
+vht_oper_centr_freq_seg0_idx=42
+vht_capab=[SHORT-GI-80]
 country_code=MY
 ieee80211d=1
```

Verify in Malaysia regulatory tables that channels 36/40/44/48 are
non-DFS (they are at the time of writing). Avoid 52–144 (DFS — needs
radar detection, not worth the complexity for a car AP).

### 2. Power supply

Pi 4 wants 5 V / 3 A sustained. The buck converter spec'd in
`plan.md:67` is already a Pololu D24V50F5 (5 A) or LM2596-class — both
fine. Re-verify under load with multimeter before connecting.

### 3. USB port choice for the CarLinkit

Pi 4 has 4 ports (2× USB 3.0 blue, 2× USB 2.0 black). **Use a USB 2.0
port** — the dongle is full-speed and USB 3.0 ports on the Pi 4 are
known to spew 2.4 GHz radio noise that can interfere with neighbouring
wireless gear; not relevant for the 5 GHz AP itself, but no upside to
using USB 3.0 either.

### 4. DietPi base image

Re-flash a fresh Pi 4 DietPi image (don't try to migrate the Zero's
SD card — different kernel, different firmware blobs). Same Phase 1
recipe (`phase1-notes.md`) applies for Node 20 install, udev rule,
plugdev group, repo clone.

### 5. Cold-boot baseline

Re-run the Phase 2 measurements (`plan.md:202–219`) on the Pi 4 — the
critical-chain breakdown will be different. Capture and update
expectations.

### 6. Heat monitoring

In-car first week: log `/sys/class/thermal/thermal_zone0/temp` every
60 s to a ring buffer, eyeball after each drive. If sustained >70 °C,
add a small 5 V fan (Phase 5 BoM optional item, `plan.md:74`).

## Step-by-step migration

1. **Buy a spare Pi 4** *or* commit to losing the Tesla-Android
   fallback. Don't do this with the only Pi 4 in the house if Phase 1
   on the Zero 2 W hasn't yet banked 4 weeks of clean driving.
2. Flash a fresh microSD with DietPi for Pi 4. Pre-configure home
   Wi-Fi + SSH per `phase1-notes.md` § Hardware. Reserve a stable
   home-network IP for the Pi 4 (different from the Zero's
   `<pi-lan-ip>`) so both can coexist on the bench.
3. SSH in, run the Phase 1 base setup verbatim (Node 20, build deps,
   udev rule, repo clone).
4. `npm install` in `tesla-pi/`. Plug the CarLinkit dongle into
   a USB 2.0 port. Run `npm start`. Confirm CarPlay reaches the
   laptop browser at the new IP.
5. Edit `conf/hostapd.conf` to the 5 GHz config above. Apply Phase 3:
   start hostapd, dnsmasq, iptables, nginx. Confirm `TeslaCP` is now
   broadcasting on 5 GHz channel 36.
6. From the laptop, join the new `TeslaCP`-on-5 GHz, browse to
   `https://<your-domain>/`, confirm the full path works.
7. Driveway smoke test with the Tesla. Tesla should associate to 5 GHz
   `TeslaCP` (Highland supports both bands). Confirm the
   `connman.vn.tesla.services` probe still passes (nginx config is
   unchanged from Zero 2 W).
8. Re-run Phase 5 driving scenarios (`plan.md:341`). 5 GHz interferes
   with much less in mall / drive-thru parking lots — most of the
   2.4 GHz risk in the original risk register is mooted.
9. Once Pi 4 has a week of clean driving, swap it into the dashboard
   install permanently. Keep the Zero 2 W SD card as the new
   fallback; the original Pi 4 + Tesla-Android image remains
   untouched on its own SD.

## Validation gates

Mirrors `plan.md:276–285`, with the bandwidth-relevant ones updated:

- [ ] Tesla joins `TeslaCP` on 5 GHz, gets DHCP lease in
      `<lan-host>–50`, stays associated ≥10 min idle (probe
      accepted)
- [ ] HTTPS to `<your-domain>` resolves and renders CarPlay
- [ ] `iperf3` from a 5 GHz laptop client to the Pi 4 sustains
      ≥100 Mbps (sanity check the radio is actually 5 GHz/ac, not
      degraded to 2.4)
- [ ] Pi 4 cold-boot to `tesla-pi.service` started: target <25 s
      (revised from <20 s due to Pi 4 boot overhead)
- [ ] Stream at `1920 × 1496` shows no stutter (the original
      bandwidth-bound resolution that pushed the migration)
- [ ] CPU temp <70 °C after 30 min idle in 50 °C dashboard sun

## Risk register additions

| Risk | Likelihood | Impact | Mitigation |
|---|---|---|---|
| Tesla Highland silently prefers 2.4 GHz, ignores 5 GHz `TeslaCP` | Low | Migration blocked | Verify in driveway before tearing down 2.4 GHz config; have hostapd 2.4 GHz fallback config ready |
| Pi 4 thermal throttle in MY dashboard sun | Medium | Stutter / reboot | Active fan; relocate to glovebox if dashboard mount fails |
| 5 GHz channels 36–48 actually DFS in some MY regulatory updates | Low | hostapd refuses to start | Re-check `iw reg get` on first boot; fall back to non-DFS-only `iw list` advertised channels |
| Pi 4 5 V / 3 A sag on car-start brown-out | Medium | Reboot mid-task | Larger smoothing cap (4700 µF), or move power tap to true accessory bus |
| Burning the Tesla-Android fallback before new stack proves stable | Medium (self-inflicted) | No rollback if both fail | Buy a second Pi 4, or wait 4 weeks |

## Rollback

The Zero 2 W SD card stays in a drawer. If the Pi 4 setup misbehaves
in any way that can't be fixed in the parking spot, swap the card and
the dashboard mount back to the Zero. None of the on-Pi state moves
between hosts (Cloudflare token, LE cert, etc. are in
`tesla-pi/conf/*.template`-derived files that get re-rendered on
fresh installs from `tesla-pi.env.template`).

## Decision points

- Defer this migration until the Zero 2 W stack has 4+ weeks of
  clean in-car driving (the same gate as deciding whether to sell
  the Pi 4).
- Trigger this migration only if measured **in-car** bandwidth is
  the bottleneck — not home-Wi-Fi bandwidth, which is a different
  problem with a different (and unrelated) fix path (move closer
  to the home AP, reduce contention).
- If 5 GHz turns out to be unreliable in some specific parking spot
  (rare but possible — concrete walls), the Pi 4 can be dual-band:
  hostapd serving both `TeslaCP` (5 GHz) and `TeslaCP-2` (2.4 GHz)
  using the single radio's two virtual interfaces. Out of scope for
  initial migration.
