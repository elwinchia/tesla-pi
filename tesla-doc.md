
## Installation guide for tesla navigator

> ## ⚠️ Historical — superseded by [`docs/setup-guide.md`](docs/setup-guide.md)
>
> This is the original install walkthrough, kept for background and for the
> pieces the current guide doesn't repeat (the captive-portal reasoning, the
> nginx/iptables derivation, upstream attribution).
>
> **Do not follow its certificate steps.** They describe the old flow where you
> owned a domain, ran `certbot` on a laptop, and kept a Cloudflare token on the
> Pi. None of that applies now: devices use the shared hostname
> `device.tesla-pi.humblebees.co`, certificates are issued in CI, and the Pi holds
> no DNS credential. See [`docs/setup-guide.md`](docs/setup-guide.md) and
> [`docs/turnkey-shared-domain-plan.md`](docs/turnkey-shared-domain-plan.md).

We are going to create a Wi-Fi network from a Raspberry Pi. Tesla will connect to this Wi-Fi, and CarPlay will be available through a website hosted on the Raspberry Pi in the Tesla browser. Audio routes via the CarLinkit dongle's "phone audio" mode → iPhone → Tesla's existing Bluetooth pairing, so the Pi never touches audio.

**No-internet design (Phase 3, May 2026 revision):** the Pi has no upstream connectivity by design — the iPhone carries cellular for CarPlay backend traffic and the Tesla has its own LTE, so a 4G modem or USB-Ethernet uplink on the Pi would add cost and failure modes for nothing. (On the original Pi Zero 2 W this was also forced by hardware: its single USB OTG port was committed to the CarLinkit dongle. The Pi 4 has four USB ports, but the design stands as a choice.) Instead, the Pi runs a fake captive-portal layer (dnsmasq + nginx default-server) that satisfies the Tesla's connectivity probe so the car stays associated to the SSID despite no real internet.

Requirement
------
 - Raspberry Pi 4 (4 GB recommended; the project originally ran on a Pi Zero 2 W)
 - Micro SD Card
 - CarLinkit dongle (CPC200-CCPA, USB ID `1314:152*`)
 - Powered 5 V supply (in-car: 12 V → 5 V buck from the cigarette socket)
 - A real public domain you control (any TLD), with a DNS provider that supports DNS-01 challenges (Cloudflare, Namecheap, etc.) — used for the manual off-Pi cert renewal flow
 - A laptop with `certbot` (or compatible ACME client) for issuing/renewing the cert; the Pi never talks to Let's Encrypt directly


OS Installation | Raspberry Pi OS (Debian based)
------

Insert the Micro SD Card into your computer.


First download [Raspberry Pi OS Downloader](https://www.raspberrypi.com/software/), install and run it.



For OS select => `Raspberry Pi OS Other` => `Raspberry Pi OS Lite (64-bit)`

Select your memory card and click `Write`

Prepare your 4G dongle on another device, setting up the pin code is all it takes to get the 4G dongle ready to work.


You can now insert your Micro SD Card in your Raspberry Pi, connect a keyboard, ethernet cable, 4G Dongle as well as a screen. Then the power cable. Wait while Debian starts up.

- user : `pi`
- password : `raspberry`


You are now connected to a command terminal, with that we will be able to control your Raspberry Pi.

Warning: the keyboard is a QWERTY on startup!

First, we will make all the updates available. (Typing is command followed by entering)

```
sudo apt install update
sudo apt install upgrade -y
```

Config raspi os :
```
raspi-config
```
use `pi` like default

- Select `Localisation Options` => `Locale` => Select the right option
- Select `Localisation Options` => `Timezone` => Select the right option
- Select `Localisation Options` => `Keyboard` => Select the right option
- Select `Localisation Options` => `WLAN Country` => Select the right option


Enable SSH
------
We will define a password for our user `root`, Use `root` as the password. (user: `root`, password: `root`)

```
sudo passwd root
```
It is normal that nothing is displayed when you type your password. You just have to press Enter when you have finished typing it.

Change user to root
```
su - root
```
password : `root`


We configure SSH. For that we will use the `nano` text editor :
```
nano /etc/ssh/sshd_config
```

Find the line that contains `PermitRootLogin`, you can move around with the arrows on your keyboard.
Remove `#` in front of `PermitRootLogin`, and set it to `yes` :
```
PermitRootLogin yes
```
You can now save the file with `CTRL + O` then `Enter`. And quit `nano` text editor with `CTRL + X`

Restart the ssh service to apply the changes.
```
systemctl restart sshd
```

SSH Connection
------

Look at the ip address of your `eth0` (or something like `enp0s3`) ethernet interface :
```
ip a
```
It should look like 192.168.X.X or 10.X.X.X on this interface

At home I received this ip address 192.168.1.68, yours will certainly be different.

We will now be able to leave the Raspberry Pi aside, and access it remotely using ssh. This will make it easier for us to copy paste.

For this on windows [download Putty](https://www.putty.org/) software and install it. Open Putty, in `Host Name (or IP address)` set your ip (me it's 192.168.1.68) (Port: `22`, Connection type: `SSH`) and click `Open` to open the ssh connection.

On linux/macOS you can open the terminal application then type the following command:
```
ssh root@192.168.X.X
```

Enter username and password (user: `root`, password: `root`)

You should now be connected to a terminal of your Raspberry Pi.


Confirm `wlan0` is up (it'll switch to AP mode in the hostapd step) and the CarLinkit dongle is enumerating:
```
ip a
lsusb | grep -i 1314
```
The dongle reports as USB ID `1314:152*` ("Magic Communication Tec. Auto Box").



Rename Raspberry Pi | Change hostname
------

We configure the hostname :

```
echo 'carplay' > /etc/hostname
```

To apply the change you must restart the Raspberry Pi :

```
reboot
```
(You will need to reopen your ssh connection when the system will be started)


Creation of the Wi-Fi network | hostapd
------

At first we will create the wifi networks with the wifi antenna integrated in the Raspberry Pi.

We configure the wifi interface. For that we will use the `nano` text editor :

```
nano /etc/network/interfaces.d/wlan0
```

Add this below the comment :
```
auto wlan0
iface wlan0 inet static
    address <pi-lan-ip>/24
#    up iptables-restore < /etc/iptables.save
#    up systemctl restart udhcpd
```
You can now save the file with `CTRL + O` then `Enter`. And quit `nano` text editor with `CTRL + X`


We apply the configuration:
```
systemctl restart networking
```
(You may need to reopen your ssh connection after that)



Now we should see the ip address `<pi-lan-ip>` on `wlan0` with this command:

```
ip a
```

We install the software  `hostapd` that will allow us to create a Wifi networks:
```
apt install hostapd -y
```

We are now going to configure the hotspot by editing this file `/etc/hostapd/hostapd.conf`

For that we will use the `nano` text editor :

```
nano /etc/hostapd/hostapd.conf
```

You are going to replace all the contents of the file with the contents of `conf/hostapd.conf` from this repo:
```
interface=wlan0
hw_mode=g
channel=6
country_code=MY
ieee80211d=1
ieee80211n=1
wmm_enabled=1
macaddr_acl=0
auth_algs=1
ignore_broadcast_ssid=0
wpa=2
wpa_key_mgmt=WPA-PSK
rsn_pairwise=CCMP
ssid=TeslaCP
wpa_passphrase=CHANGE_ME_AP_PSK
```
Adjust `country_code`, `channel`, SSID and passphrase to taste. CCMP-only (`rsn_pairwise=CCMP`, no TKIP) is required for 802.11n rates. The Pi 4 radio supports 5 GHz (use `hw_mode=a`, channel 36 for much better throughput); the original Pi Zero 2 W was 2.4 GHz only.
You can now save the file with `CTRL + O` then `Enter`. And quit `nano` text editor with `CTRL + X`

We restart the software for the new configuration under apply with :

```
systemctl unmask hostapd
systemctl enable hostapd
systemctl restart hostapd
```

Your Wi-Fi network is ready, you should see it in the list of your Wi-Fi networks on your PC or smartphone. It does not have internet access — that's intentional; the next two steps make Tesla stay on it anyway.


DHCP + DNS + captive-portal answer | dnsmasq
------

`dnsmasq` plays three roles at once: DHCP server (replaces `udhcpd`), DNS server, and a wildcard A-record provider that points every name at `240.3.3.4`. The `240.3.3.4` IP is then DNAT'd by iptables back to the Pi's nginx (next section), so a Tesla request for *any* hostname — including the connectivity probe URL Tesla's MCU contacts after associating — lands on local nginx, which answers with a "yes, internet's fine" response.

```
apt install dnsmasq -y
```

If `systemd-resolved` is running and bound to :53, disable its stub listener so dnsmasq can bind. On DietPi this is usually already the case; check with `ss -lntp 'sport = :53'`.

Drop `conf/dnsmasq.conf` from this repo to `/etc/dnsmasq.conf`:

```
interface=wlan0
bind-interfaces
listen-address=<pi-lan-ip>

dhcp-range=<lan-host>,<lan-host>,255.255.255.0,24h
dhcp-option=3,<pi-lan-ip>
dhcp-option=6,<pi-lan-ip>

no-resolv
no-hosts
domain-needed
bogus-priv

address=/#/240.3.3.4

log-queries
log-dhcp
```

Note what is *not* in that file: the resolver policy. `scripts/net-share.sh` owns it and regenerates `/etc/dnsmasq.d/10-tesla-pi-mode.conf` whenever the uplink appears or goes away — see "Internet sharing" below. A wildcard put back into `dnsmasq.conf` would shadow that snippet for every name and pin the AP to the offline behaviour. Disable the log lines once you're past the bring-up phase.

```
systemctl enable dnsmasq
systemctl restart dnsmasq
```

Bypass Tesla's private-IP block | iptables
------

The Tesla browser refuses to load anything served from RFC1918 space (192.168.0.0/16, 10.0.0.0/8, 172.16.0.0/12). The trick from the original marcraft2 fork is to give the CarPlay site a public-looking IP — `240.3.3.4` (an unassigned, non-routable but technically public range) — and DNAT inbound traffic on that address back to the Pi. We keep that trick. The DNAT itself terminates locally and needs no forwarding; forwarding and MASQUERADE are enabled separately, for internet sharing (below).

```
apt install iptables iptables-persistent -y
```

Drop `conf/sysctl-ip-forward.conf` from this repo to `/etc/sysctl.d/99-ip-forward.conf`, and delete any `99-no-forward.conf` an older install left behind — both files would be read, and `no` sorts after `ip`, so the stale one wins and quietly disables sharing.

```
sysctl -p /etc/sysctl.d/99-ip-forward.conf
```

Drop `conf/iptables.ipv4.nat` from this repo to `/etc/iptables/rules.v4`:

```
*filter
:INPUT ACCEPT [0:0]
:FORWARD DROP [0:0]
:OUTPUT ACCEPT [0:0]
-A FORWARD -i wlan0 ! -o wlan0 -j ACCEPT
-A FORWARD -m conntrack --ctstate ESTABLISHED,RELATED -j ACCEPT
COMMIT

*nat
:PREROUTING ACCEPT [0:0]
:INPUT ACCEPT [0:0]
:OUTPUT ACCEPT [0:0]
:POSTROUTING ACCEPT [0:0]
-A PREROUTING -d 240.3.3.4/32 -i wlan0 -p tcp -m tcp --dport 80 -j DNAT --to-destination <pi-lan-ip>
-A PREROUTING -d 240.3.3.4/32 -i wlan0 -p tcp -m tcp --dport 443 -j DNAT --to-destination <pi-lan-ip>
-A POSTROUTING -s 192.168.4.0/24 ! -o wlan0 -j MASQUERADE
COMMIT
```

The `FORWARD` policy stays `DROP`: only AP traffic leaving on some other interface, and the return path for connections the car opened, are allowed. Nothing can be initiated *towards* the AP subnet from the uplink side. The rules name interfaces rather than a specific uplink, so eth0, wlan1 and a USB tether are all covered without regenerating anything.

`netfilter-persistent` (installed by `iptables-persistent`) restores these on boot. `wlan0` is brought up with a static IP via `/etc/network/interfaces.d/wlan0`:
```
auto wlan0
iface wlan0 inet static
    address <pi-lan-ip>/24
```
No `iptables-restore` hook needed — `netfilter-persistent` handles it.



Internet sharing | net-share.sh
------

With forwarding and MASQUERADE in place, AP clients can reach whatever the Pi can reach. DNS is the piece that cannot be static, because the two states want opposite answers:

| Pi state | What the car needs from DNS |
| --- | --- |
| uplink up (eth0 / wlan1 / USB tether) | real upstream lookups, so it can actually use the internet |
| no uplink | every name → `240.3.3.4`, or the connectivity probe fails and Tesla drops the SSID |

`scripts/net-share.sh` (unit `tesla-pi-netshare.service`) polls every 20 s and rewrites `/etc/dnsmasq.d/10-tesla-pi-mode.conf`, restarting dnsmasq only when the file actually changes.

Shared mode has to be **earned, not assumed**. The watcher first asks `uplink_iface()` (from `cert-renew-lib.sh`, so there is one definition of "has an uplink") and then actually resolves `www.google.com` through the upstream resolvers with `busybox nslookup`. A default route is not the same as a working path — after a reboot `wlan1` can hold a route for minutes while the link is still unusable — and that distinction is not cosmetic:

> On 2026-08-15 the car repeatedly associated, completed WPA, took a DHCP lease, and then **refused to join** with *"The Internet is unreachable"*. `log-queries` showed why: current firmware probes `www.google.com`, `www.apple.com`, `www.microsoft.com` and `www.tesla.com` as well as connman, and every one of those was forwarded upstream with no reply. Shared mode had been entered on the strength of a route alone. The walled garden could never fail that check, because every name resolved to `240.3.3.4` and nginx answered `X-ConnMan-Status: online` — so the regression cost CarPlay, not merely internet.

The streaks are asymmetric. One successful probe is enough to start sharing (a probe that answered is real evidence, unlike a bare route); giving sharing up takes `NETSHARE_DOWN_STREAK` consecutive failures, default 3, because each change costs a dnsmasq restart and a single blip must not tear it down. Losing the interface entirely skips the streak and drops to walled at once. If a future image ships without `busybox nslookup` the watcher logs once and reverts to route-only detection, rather than being pinned offline by a probe that can never pass.

Two names stay pinned at the Pi even in shared mode:

- **`CARPLAY_DOMAIN`** has no public A record. Left to an upstream resolver it returns NXDOMAIN and the car cannot load the app at all.
- **`connman.vn.tesla.services`** (and the `.cloud.tesla.cn` variant) stays local so that holding the SSID never depends on the uplink being healthy — the point of the nginx bypass — and so the probe behaves identically either side of a mode flip.

Offline mode is deliberately byte-identical to the pre-sharing behaviour: a single `address=/#/240.3.3.4` and nothing else. dnsmasq prefers the most specific match, so the wildcard is only ever consulted in the mode that has no specific entries.

Upstream resolvers are named explicitly (`1.1.1.1`, `8.8.8.8`, override with `NETSHARE_UPSTREAM_DNS`) rather than inherited from the uplink's DHCP lease, which on a hotel or tethered network is often a resolver that only answers for its own clients. The lease's own resolver is then appended *after* those, not instead of them: a network that blackholes the public resolvers almost always still runs one that works, and without the fallback the car has no DNS there at all.

One consequence worth knowing: the car gets the same reach as any other device on the uplink's network, the home LAN included. That is ordinary router behaviour, but it matters if the AP passphrase is ever shared.

```
systemctl enable --now tesla-pi-netshare
journalctl -u tesla-pi-netshare -f
```

Web server + captive-portal bypass | nginx
------

nginx plays two roles:

1. **Captive-portal bypass on :80.** A `default_server` that answers Tesla's connectivity probe with a 204 / "Success" response, so Tesla considers the SSID "internet OK" and stays associated.
2. **CarPlay site on :443.** Reverse-proxies HTTPS to the Node server on :8080, terminating TLS with a real Let's Encrypt cert.

```
apt install nginx -y
```

Drop `conf/nginx-carplay.conf` from this repo into `/etc/nginx/conf.d/carplay.conf` and replace `CARPLAY_DOMAIN` with your real domain:
```
sed -i "s/CARPLAY_DOMAIN/your-domain.example/g" /etc/nginx/conf.d/carplay.conf
```

### One-time domain + DNS setup (off-Pi)

Set the public A record for your domain to `240.3.3.4`. Pi-side dnsmasq overrides this for clients on the AP, but a matching public record keeps debugging from any other network consistent.

### Initial cert (off-Pi, one-time)

Run this once on a laptop or home server with internet to seed the Pi's `/etc/letsencrypt/`:
```
certbot certonly --dns-cloudflare \
  --dns-cloudflare-credentials ~/.secrets/cloudflare.ini \
  -d your-domain.example \
  -m you@your-domain.example --agree-tos -n

scp -r /etc/letsencrypt/live/your-domain.example/{fullchain.pem,privkey.pem,chain.pem,cert.pem} \
  pi-host:/etc/letsencrypt/live/your-domain.example/
ssh pi-host 'chmod 0755 /etc/letsencrypt/{live,archive} && \
             chmod 0644 /etc/letsencrypt/archive/your-domain.example/{cert,fullchain,chain}*.pem && \
             nginx -s reload'
```
The chmod step lets the unprivileged `dietpi` user (running the Node app) read the leaf cert so it can compute `cert_days_remaining`. Privkey stays root-only.

### Auto-renewal on home Wi-Fi (primary)

The Pi runs `cert-renew-watch.service` which polls `hostapd_cli list_sta` every 60 s. After 10 minutes with no STA, it concludes "I'm probably indoors" and:
1. tears down `hostapd` + `dnsmasq`,
2. brings up `wlan0` in client mode against your home SSID via `wpa_supplicant`,
3. runs `certbot renew` via Cloudflare DNS-01,
4. restores the AP and reloads nginx.

Setup:

```
apt install certbot python3-certbot-dns-cloudflare wpa_supplicant isc-dhcp-client -y

# Cloudflare API token — Edit zone DNS, scoped to your CarPlay domain only.
# https://dash.cloudflare.com/profile/api-tokens
mkdir -p /root/.secrets && chmod 700 /root/.secrets
cp /home/dietpi/tesla-pi/conf/cloudflare.ini.template /root/.secrets/cloudflare.ini
chmod 600 /root/.secrets/cloudflare.ini
nano /root/.secrets/cloudflare.ini    # paste the token

# Home Wi-Fi credentials.
cp /home/dietpi/tesla-pi/conf/wpa_supplicant-wlan0-home.conf.template \
   /etc/wpa_supplicant/wpa_supplicant-wlan0-home.conf
chmod 600 /etc/wpa_supplicant/wpa_supplicant-wlan0-home.conf
nano /etc/wpa_supplicant/wpa_supplicant-wlan0-home.conf   # set ssid + psk

# Shared env file for both services.
cp /home/dietpi/tesla-pi/conf/tesla-pi.env.template /etc/default/tesla-pi
nano /etc/default/tesla-pi   # set CARPLAY_DOMAIN

# Watcher script + service. cert-renew-lib.sh holds the helpers both renewal
# entry points share and is sourced from their own directory — copy it too.
mkdir -p /opt/tesla-pi/scripts
cp /home/dietpi/tesla-pi/scripts/cert-renew-watch.sh /opt/tesla-pi/scripts/
cp /home/dietpi/tesla-pi/scripts/cert-renew-lib.sh   /opt/tesla-pi/scripts/
chmod +x /opt/tesla-pi/scripts/cert-renew-watch.sh
cp /home/dietpi/tesla-pi/systemd/cert-renew-watch.service /etc/systemd/system/

# On-demand renewal, available at any time. With an uplink that isn't our
# own AP (eth0, second Wi-Fi adapter, USB tether) it syncs the cert in
# place; without one it uses the same teardown→home-Wi-Fi→sync→restore flow
# as the watcher, bypassing its 10-min-idle gate. Triggered from the in-car
# Settings page (POST /cert/renew → sudo systemctl start
# cert-renew-now.service). Serialized with the watcher via flock on
# /var/lock/tesla-pi-cert-flip so the two can't double-tear-down the AP.
cp /home/dietpi/tesla-pi/scripts/cert-renew-now.sh /opt/tesla-pi/scripts/
chmod +x /opt/tesla-pi/scripts/cert-renew-now.sh
cp /home/dietpi/tesla-pi/systemd/cert-renew-now.service /etc/systemd/system/

# Sudoers — allow the tesla-pi service user (<user>) to start the oneshot
# without a password. Scope locked to this exact invocation so an
# escalation via /cert/renew can't run anything else.
cat <<'SUDO' > /etc/sudoers.d/tesla-pi-cert-renew
<user> ALL=(root) NOPASSWD: /bin/systemctl start --no-block cert-renew-now.service
SUDO
chmod 0440 /etc/sudoers.d/tesla-pi-cert-renew
visudo -c

systemctl daemon-reload
systemctl enable --now cert-renew-watch.service
# Note: cert-renew-now.service is intentionally NOT enabled — it's a
# oneshot, started on demand only.
```

Automatic renewal, no interaction: give the Pi internet on any interface other than wlan0 — plug in eth0, add a second Wi-Fi adapter, tether. The watcher notices the default route within 60 s and syncs the cert in place; nothing is torn down and the Tesla stays associated. The `nginx -s reload` that activates the new cert is held while `/healthz` reports video clients (i.e. CarPlay is on screen) and fires as soon as the stream ends, so renewal can never interrupt playback; `/run/cert-renew.deployed` is the pending-reload marker. `journalctl -u cert-renew-watch -f` shows progress.

Automatic renewal, no uplink: bring the Pi indoors, plug into wall power, wait ~12 minutes (10 min idle + ~60 s flip + sync). Same log.

On demand, from the car: open the in-car launcher → Settings → Certificate → "Renew now". The button is available at any time. With an uplink it is a quiet in-place check and the page stays up. Without one it needs the Pi parked within range of the home Wi-Fi configured in `wpa_supplicant-wlan0-home.conf`, and the CarPlay page loses its connection for ~3–5 min while the AP is torn down and restored; `journalctl -u cert-renew-now -f` (over SSH from the home network during the flip window) shows progress.

The Node app's `/healthz` exposes `cert_days_remaining`, and the in-car CarPlay page shows a dismissable banner once that number drops to ≤10.

### Manual renewal (fallback, when on-Pi automation is broken)

If the watcher misbehaves or your Cloudflare token expires, fall back to the off-Pi flow:
```
certbot renew --dns-cloudflare \
  --dns-cloudflare-credentials ~/.secrets/cloudflare.ini

scp -r /etc/letsencrypt/live/your-domain.example/{fullchain.pem,privkey.pem,chain.pem,cert.pem} \
  pi-host:/etc/letsencrypt/live/your-domain.example/
ssh pi-host 'chmod 0644 /etc/letsencrypt/archive/your-domain.example/{cert,fullchain,chain}*.pem && \
             nginx -s reload'
```

### Apply and verify

```
systemctl enable nginx
systemctl restart nginx
```

Sanity checks:
```
# Captive bypass — should be 204
curl -i http://<pi-lan-ip>/generate_204
curl -i http://<pi-lan-ip>/anything-else

# Apple-style probe — should be 200 with Success body
curl http://<pi-lan-ip>/hotspot-detect.html

# CarPlay site — should validate cert and 200
curl --resolve your-domain.example:443:<pi-lan-ip> -v https://your-domain.example/

# Cert days remaining — should be a number
curl -s http://<pi-lan-ip>:8080/healthz | jq .cert_days_remaining
```


Bluetooth connection | bluez-alsa
------

```
apt install bluez bluez-tools git libglib2.0-dev libasound2-dev build-essential autoconf libbluetooth-dev libtool libsbc-dev libdbus-1-dev libspandsp-dev ffmpeg -y
cd && git clone https://github.com/Arkq/bluez-alsa.git
cd bluez-alsa
mkdir -p m4
autoreconf --install
mkdir build && cd build
../configure CFLAGS="-g -O0" LDFLAGS="-g" --enable-debug
make && sudo make install
adduser root bluetooth
adduser root audio
```


You can startup bluealsa by it to `/etc/rc.local`:

```
nano /etc/rc.local
```

Now add this before the exit line :
```
export LIBASOUND_THREAD_SAFE=0
/usr/bin/bluealsa -S &
```


There is a `a2dp` plugin for our bluetooth agent. So we'll change the services' `ExecStart` parameter like so:
```
nano /etc/systemd/system/bluetooth.target.wants/bluetooth.service
```

And while we're here we'll disable sap since this may cause some errors:

```
ExecStart=/usr/libexec/bluetooth/bluetoothd --noplugin=sap --plugin=a2dp,avrcp
```

Rename raspberry pi bluetooth name:  
```
nano /etc/bluetooth/main.conf
```
Remove `#` in front of `Name` (line 5), and set it to whatever you want, I'll use `Carplay` :

```
[...]
Name = CarPlay
[...]
```


Now reload and restart the agent:
```
systemctl daemon-reload
systemctl restart bluetooth
```


Now we will connect the bluetooth
This operation must be carried out in the tesla, you can power your raspberry on the usb port of your tesla.


Enter bluetooth configuration mode :
```
bluetoothctl
```

Now run
```
power on
agent on
default-agent
scan on
discoverable on
```

Go to your tesla in the bluetooth settings, to add a new device. Then select your raspberry, me it's called `CarPlay`

Answer us `yes` all the questions you ask the raspberry


The `trust` command will enable to auto-pair the device again later on. (replace the Bluetooth MAC address with that of your Tesla, it should be displayed when you have accepted the connection with `yes`)
```
trust AA:BB:CC:DD:EE:FF
exit
```

Now create this file `/etc/asound.conf` to set the tesla as the default audio device on the alsa audio controller. (replace the Bluetooth MAC address with that of your Tesla, it should be displayed when you have accepted the connection with `yes`)
```
pcm.!default {
 type plug
 slave {
     pcm {
         type bluealsa
         device AA:BB:CC:DD:EE:FF
         profile "a2dp"
     }
 }
 hint {
     show on
     description "Tesla"
 }
}
```

Setup on reboot, for this edit `/etc/environment`

```
SDL_AUDIODRIVER="alsa"
```

And apply this command :
```
alsactl init
```
(Do not pay attention to the message that it returns to you, it is very often an error for another interface)

Now reboot
```
reboot
```

Reconnect bluetooth from your tesla screen after restarting and we will now test the bluetooth:

```
wget http://cd.textfiles.com/10000soundssongs/WAV/BANJO.WAV
ffplay -nodisp -vn -autoexit -i BANJO.WAV
```
This is the music of victory.

You can either play with the auto connection in your tesla settings, or you can do this if that's not enough:


Create Node Carplay Server | tesla-carplay
------
```
apt install git libudev-dev ffmpeg -y
curl -fsSL https://deb.nodesource.com/setup_17.x | bash -
apt-get install -y nodejs
npm install -g npm@latest
npm i -g pm2
cd /root/
git clone https://github.com/marcraft2/tesla-carplay.git
cd tesla-carplay
mkdir /var/www/carplay/
cp static/* /var/www/carplay/
npm i
pm2 start index.js
pm2 startup
pm2 save
```

For check log
```
pm2 logs
```

If you open Carplay in a browser on a computer, you must simulate a touch screen, otherwise you cannot control Carplay.


Enjoy
------

- Reboot the Pi so hostapd / dnsmasq / nginx / iptables / `tesla-pi.service` all start cleanly
- Connect your Tesla to the `TeslaCP` Wi-Fi (it should stay on the SSID despite no internet)
- Plug in your iPhone (or skip if wireless CarPlay is already paired with the dongle)
- Open the Tesla browser on your domain (`https://your-domain.example/`)
- Enjoy

If a step of this tutorial does not work for you, do not hesitate to [open an issue](https://github.com/marcraft2/tesla-carplay/issues/new/choose), it will be with pleasure that I will answer you.

It was not easy, congratulations if it works, if you see bugs, or if you want to help the project, or if you simply have questions, it is with great pleasure.


About Tesla Security
------
 - **Tesla disconnects from Wi-Fi networks with no internet.** It probes a URL after associating; if the probe fails, the SSID is dropped. Bypassed in this build by dnsmasq + nginx default-server returning a synthetic 204 / "Success" to any probe URL (covers Chromium-style `generate_204`, Apple's `hotspot-detect.html`, Microsoft's `ncsi.txt`). If a future Highland firmware uses a stricter probe (e.g. checks an exact body hash against a Tesla-controlled URL), this will need to be revisited — capture a `tcpdump` trace of the probe and adapt nginx accordingly.
 - **SSL certificate must be a real one** — Tesla browser doesn't let you accept invalid certs. With no Pi-side internet, the cert is issued and renewed off-Pi via DNS-01 and copied in manually every ~60 days (see "Cert issue + renew workflow" above).
 - **Tesla's browser blocks access to private IPs** (192.168.X.X, 10.X.X.X, 172.X.X.X). Bypassed by serving from the public-but-non-routable IP `240.3.3.4`, with iptables DNAT'ing inbound traffic on that IP back to the Pi at `<pi-lan-ip>`.
 - **240.3.3.0/24 is non-routed public space** — safe to use as a local shim; no real host on the internet uses it.
