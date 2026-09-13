# Tesla "Internet is unreachable" — root cause and fix

## TL;DR

Tesla's MCU connectivity probe is **not** any of the standard captive-portal URLs (`/generate_204`, `/hotspot-detect.html`, `/ncsi.txt`, etc.). Tesla queries a Tesla-specific endpoint and checks for a specific response header:

| Field | Value |
|---|---|
| Hostname probed | `connman.vn.tesla.services` (or `connman.vn.cloud.tesla.cn` in China) |
| Path | any path on that host (per tesla-android's lighttpd config it accepts the bare `/`) |
| Required response | HTTP 200 with header `X-ConnMan-Status: online` |
| Body | irrelevant |
| TLS | not required for the probe (HTTP works); HTTPS works too with any cert (Tesla doesn't seem to validate the chain on this endpoint) |

Source: [tesla-android `services/lighttpd/lighttpd.conf`](https://raw.githubusercontent.com/tesla-android/android-vendor-tesla-android/main/services/lighttpd/lighttpd.conf).

If the probe gets the magic header, Tesla accepts the SSID. If not, Tesla rejects with the dialog "The Internet is unreachable. Please check your firewall settings and Internet connection."

## Our setup

The network plumbing was already correct:

- dnsmasq wildcard `address=/#/240.3.3.4` resolves `connman.vn.tesla.services` to `240.3.3.4`.
- iptables DNATs `240.3.3.4:80/443` to the Pi's nginx at `<pi-lan-ip>`.
- nginx had to grow a Host-matched server block returning the magic header. That's the actual fix.

The added block (in `tesla-pi/conf/nginx-carplay.conf`):

```nginx
server {
    listen 80;
    listen 443 ssl;
    server_name connman.vn.tesla.services connman.vn.cloud.tesla.cn;
    ssl_certificate     /etc/letsencrypt/live/CARPLAY_DOMAIN/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/CARPLAY_DOMAIN/privkey.pem;
    add_header X-ConnMan-Status "online" always;
    add_header X-Cache "Hit from cloudfront" always;
    return 200 "";
}
```

## Run log — what failed before this

| Date | Hypothesis tested | Result |
|---|---|---|
| 2026-05-03 | Hidden SSID + nginx default-server with `/generate_204` etc. | Failed: "Internet is unreachable" |
| 2026-05-03 | Visible SSID, same nginx config | Failed: same dialog |
| 2026-05-03 | (researched, not deployed) Universal DNAT + chrony NTP + ICMP DNAT + DNS wildcard `1.1.1.1` | Pre-empted by finding the real probe URL — would have been more elaborate than needed |
| 2026-05-03 | Add `connman.vn.tesla.services` server block returning `X-ConnMan-Status: online` | **(pending in-car retest)** |

## How to verify the fix

1. **Mac joined to TeslaCP** (need Pi reachable):
   ```bash
   networksetup -setairportnetwork en0 TeslaCP '<your-ap-passphrase>'
   ```

2. **From the Mac on TeslaCP**, push the new nginx config and reload:
   ```bash
   rsync -av \
     ~/tesla-pi/conf/nginx-carplay.conf \
     pi@raspberrypi.local:/home/<user>/tesla-pi/conf/nginx-carplay.conf

   ssh pi@raspberrypi.local 'sudo bash -c "
     sed s/CARPLAY_DOMAIN/$CARPLAY_DOMAIN/g \
       /home/<user>/tesla-pi/conf/nginx-carplay.conf > /etc/nginx/conf.d/carplay.conf
     nginx -t && systemctl reload nginx
   "'
   ```

3. **Smoke-check** the probe response from the Mac:
   ```bash
   # DNS resolves to the shim IP
   dig +short @<pi-lan-ip> connman.vn.tesla.services
   # expect: 240.3.3.4

   # The shim IP DNATs to nginx, which returns the magic header
   curl -i --resolve connman.vn.tesla.services:80:240.3.3.4 \
     http://connman.vn.tesla.services/
   # expect: HTTP/1.1 200 OK
   #         X-ConnMan-Status: online
   #         X-Cache: Hit from cloudfront
   ```

4. **Tesla retry**: Wi-Fi list → tap `TeslaCP` → enter passphrase. Should join cleanly.

## Fallback if it still fails

Tesla firmware may have additional probes we haven't identified. Capture a pcap during the join attempt and look for what else gets queried:

```bash
ssh pi@raspberrypi.local 'sudo tcpdump -i wlan0 -nn -s0 -w /tmp/tesla-probe.pcap "not arp and not (host <pi-lan-ip> and port 22)"'
# (retry Tesla join, then Ctrl-C)
scp pi@raspberrypi.local:/tmp/tesla-probe.pcap ~/Desktop/
```

Open in Wireshark. Filter `dns` to see what hostnames Tesla resolves, then look at HTTP / TLS handshakes that follow. Anything that gets a SYN but no SYN-ACK, or a request but no response, is a missing piece.

## Why hidden vs visible SSID didn't matter

We tested that hypothesis but it was a red herring. The ConnMan probe runs regardless of beacon visibility. Hidden vs visible only affects how the SSID appears in scan lists.

## When this might break

- Tesla firmware moves to a different probe URL or response format.
- Tesla starts validating TLS chains on the connman endpoint.
- Tesla adds parallel probes (NTP, ICMP, additional URLs) and starts requiring all of them to pass.

If any of the above happens, the fix is the same iteration loop: tcpdump → identify the new gap → add a targeted response. The pcap is the canonical artifact; preserve a working capture in this directory once we have one for forensic comparison later.

## Sources

- [tesla-android lighttpd.conf](https://raw.githubusercontent.com/tesla-android/android-vendor-tesla-android/main/services/lighttpd/lighttpd.conf) — the actual spoofing config
- [tesla-android offline-mode docs](https://teslaandroid.com/pages/offline-mode)
- [tesla-android offline-mode config-manager](https://github.com/tesla-android/android-external-tesla-android-configuration-manager)
- [tesla-android discussion #318](https://github.com/orgs/tesla-android/discussions/318) — confirms 172.16.0.1 gateway, 104.248.101.213 spoofed Tesla IP

Scripts staged locally. To apply now:

### Step 1 — join TeslaCP, push scripts, run dev-mode

```bash
# Mac
networksetup -setairportnetwork en0 TeslaCP '<your-ap-passphrase>'

# Push the new scripts to the Pi (and update /opt/ copy that systemd uses)
rsync -av \
  ~/tesla-pi/scripts/ \
  pi@raspberrypi.local:/home/<user>/tesla-pi/scripts/

ssh pi@raspberrypi.local 'sudo cp /home/<user>/tesla-pi/scripts/{dev-mode,ap-mode}.sh /opt/tesla-pi/scripts/ && sudo chmod +x /opt/tesla-pi/scripts/{dev-mode,ap-mode}.sh'

# Flip to dev mode (Pi reboots, joins home wifi)
ssh pi@raspberrypi.local 'sudo /opt/tesla-pi/scripts/dev-mode.sh'
```

The SSH session dies when the reboot fires.

### Step 2 — switch Mac back to home wifi

```bash
networksetup -setairportnetwork en0 <your-home-ssid> <your-home-psk>
```

(or just click home wifi in the menu bar)

### Step 3 — verify Pi is back

```bash
ssh pi@raspberrypi.local 'systemctl is-active hostapd dnsmasq tesla-pi nginx'
# expect: inactive  inactive  active  active
```

### When you want to flip back to AP for car testing

```bash
ssh pi@raspberrypi.local 'sudo /opt/tesla-pi/scripts/ap-mode.sh'
# wait ~30s, switch Mac to TeslaCP, ssh pi@raspberrypi.local
```

The scripts are reversible — toggle as often as you need during dev. Want me to also keep `tesla-pi.service` running in dev mode (so you can hit it on `http://<pi-lan-ip>:8080/healthz` from your Mac), or stop that too?